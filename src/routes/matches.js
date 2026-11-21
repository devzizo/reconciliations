import crypto from 'node:crypto';
import express from 'express';
import qrcode from 'qrcode-generator';
import { randomToken, sha256Hex, tokenMatches } from '../auth.js';
import { HttpError } from '../errors.js';
import { DOC_NAMES, evaluate, weekdayOf } from '../services/checks.js';
import { DENOMINATIONS, formatSar } from '../services/denominations.js';

/**
 * Reconciliations ("مطابقات"). Open to everyone for viewing (list, link, QR). Changes are only accepted
 * from the device that started the reconciliation (it holds the edit token), and only through
 * photographs — there is no endpoint to type or edit a figure.
 */
export function createMatches({ db, audit, files }) {
  const r = express.Router();

  const byPublicId = (pid) => db.get('SELECT * FROM matches WHERE public_id = ?', pid);
  const canEdit = (req, m) => m.status === 'open' && tokenMatches(req.get('x-edit-token'), m.edit_token_hash);

  async function requireEditableMatch(req, m) {
    if (!m) throw new HttpError(404, 'NOT_FOUND', 'المطابقة غير موجودة.');
    if (!tokenMatches(req.get('x-edit-token'), m.edit_token_hash)) {
      await audit.record({ req, action: 'match.edit_denied', reconciliationId: m.id, entityType: 'match', entityId: m.id });
      throw new HttpError(403, 'NOT_EDITOR', 'يمكن متابعة هذه المطابقة فقط من الجهاز الذي بدأها.');
    }
    if (m.status !== 'open') throw new HttpError(409, 'MATCH_SUBMITTED', 'تم اعتماد هذه المطابقة ولا يمكن تعديلها.');
    return m;
  }
  const requireEditable = async (req, pid) => requireEditableMatch(req, await byPublicId(pid));
  const requireEditableById = async (req, id) => requireEditableMatch(req, await db.get('SELECT * FROM matches WHERE id = ?', id));

  const parseReading = (row) => (row ? {
    id: row.id, kind: row.kind, status: row.status, createdAt: row.created_at, sessionId: row.session_id,
    fields: JSON.parse(row.fields_json), extras: JSON.parse(row.extras_json), lowConfidence: JSON.parse(row.low_confidence_json), issues: JSON.parse(row.issues_json),
  } : null);

  async function load(m) {
    const rows = await db.all("SELECT * FROM readings WHERE match_id = ? AND state = 'current' ORDER BY created_at, rowid", m.id);
    const docs = { daily_closing_form: null, z_report: null, bank_settlement: null, deposit_receipt: null };
    const expenses = [];
    let cashReading = null;
    for (const row of rows) {
      const rd = parseReading(row);
      if (rd.kind === 'expense_invoice') expenses.push(rd);
      else if (rd.kind === 'cash') cashReading = rd;
      else docs[rd.kind] = rd;
    }
    const confirmation = await db.get('SELECT * FROM cash_confirmations WHERE match_id = ?', m.id);
    const prevDate = new Date(Date.parse(`${m.business_date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const prev = await db.get('SELECT * FROM matches WHERE branch_id = ? AND business_date = ?', m.branch_id, prevDate);
    let yesterday = null;
    if (prev) {
      const prevForm = parseReading(await db.get("SELECT * FROM readings WHERE match_id = ? AND kind = 'daily_closing_form' AND state = 'current'", prev.id));
      yesterday = { number: prev.number, publicId: prev.public_id, closingCashHalalas: prevForm?.fields?.closing_cash_balance ?? null };
    }
    const evaluation = evaluate({ docs, expenses, cash: confirmation ? { totalHalalas: confirmation.total_halalas } : null, yesterday, businessDate: m.business_date });
    return { docs, expenses, cashReading, confirmation, yesterday, evaluation };
  }

  async function refreshResult(m) {
    const { evaluation } = await load(m);
    await db.run('UPDATE matches SET result = ?, updated_at = ? WHERE id = ?', evaluation.result, new Date().toISOString(), m.id);
  }

  async function captureIds(sessionId) {
    return (await db.all("SELECT id FROM captures WHERE session_id = ? AND status = 'active' ORDER BY seq", sessionId)).map((c) => c.id);
  }

  async function detail(req, m) {
    const branch = await db.get('SELECT * FROM branches WHERE id = ?', m.branch_id);
    const { docs, expenses, cashReading, confirmation, yesterday, evaluation } = await load(m);
    const editable = canEdit(req, m);
    const docView = async (rd) => (rd ? { readingId: rd.id, readAt: rd.createdAt, fields: rd.fields, extras: rd.extras, lowConfidence: rd.lowConfidence, captureIds: await captureIds(rd.sessionId) } : null);
    const documents = {};
    for (const [k, rd] of Object.entries(docs)) documents[k] = await docView(rd);
    const expenseViews = [];
    for (const rd of expenses) expenseViews.push(await docView(rd));
    return {
      match: {
        number: m.number, publicId: m.public_id, branchId: m.branch_id, branchName: branch?.name_ar || branch?.name, businessDate: m.business_date,
        weekday: weekdayOf(m.business_date), status: m.status, result: evaluation.result, createdAt: m.created_at, updatedAt: m.updated_at, submittedAt: m.submitted_at,
      },
      canEdit: editable,
      documents,
      expenses: expenseViews,
      expensesRequired: (docs.daily_closing_form?.fields?.cash_outflow ?? 0) >= 30,
      cash: {
        confirmed: confirmation ? { totalHalalas: confirmation.total_halalas, total: formatSar(confirmation.total_halalas), confirmedAt: confirmation.confirmed_at } : null,
        // Pending AI count awaiting confirmation; photos of cash are only shown to the editing device.
        pending: !confirmation && cashReading && editable ? { readingId: cashReading.id, status: cashReading.status, counts: cashReading.fields, totalHalalas: cashReading.extras.totalHalalas, issues: cashReading.issues } : null,
      },
      yesterday: yesterday ? { number: yesterday.number, publicId: yesterday.publicId } : null,
      denominations: DENOMINATIONS,
      ...evaluation,
    };
  }

  // ---------------------------------------------------------------- reading → reconciliation

  const reject = async (readingId, status, code, message, details) => {
    await db.run("UPDATE readings SET state = 'rejected' WHERE id = ?", readingId);
    return { status, body: { error: { code, message, details } } };
  };

  /** Called by the camera routes when a session is finalized. */
  async function applyReading(req, session, result, { provider }) {
    const readingId = crypto.randomUUID();
    const now = new Date().toISOString();
    // Insert as rejected first; promoted to current below once it is accepted.
    await db.run(`INSERT INTO readings (id, session_id, match_id, kind, state, provider, model, status, fields_json, extras_json, low_confidence_json, issues_json, created_at)
      VALUES (?, ?, ?, ?, 'rejected', ?, ?, ?, ?, ?, ?, ?, ?)`, readingId, session.id, session.match_id, session.kind, provider ?? 'custom', result.model ?? null, result.status,
    JSON.stringify(result.fields ?? {}), JSON.stringify(result.extras ?? {}), JSON.stringify(result.lowConfidence ?? []), JSON.stringify(result.issues ?? []), now);
    await audit.record({ req, action: 'reading.created', reconciliationId: session.match_id, entityType: 'reading', entityId: readingId,
      details: { kind: session.kind, provider, model: result.model, status: result.status, fields: result.fields, extras: result.extras } });

    if (result.status !== 'completed') {
      return reject(readingId, 422, 'READING_FAILED', result.issues?.[0] ?? 'تعذّرت قراءة الصورة. أعد التصوير.', { issues: result.issues ?? [] });
    }

    let m = session.match_id ? await db.get('SELECT * FROM matches WHERE id = ?', session.match_id) : null;
    let editToken = null;

    if (session.kind === 'daily_closing_form') {
      const branchId = result.extras?.branch;
      const date = result.extras?.date;
      const branch = branchId ? await db.get('SELECT * FROM branches WHERE id = ? AND active = 1', branchId) : null;
      const age = date ? (Date.now() - Date.parse(`${date}T00:00:00Z`)) / 86_400_000 : NaN;
      if (!branch || !date || Number.isNaN(age) || age < -1 || age > 120) {
        const what = [!branch && 'اسم الفرع', (!date || Number.isNaN(age) || age < -1 || age > 120) && 'التاريخ'].filter(Boolean).join(' و');
        return reject(readingId, 422, 'FORM_HEADER_UNREADABLE', `تعذّر قراءة ${what} من اليومية. تأكد أنه مكتوب بوضوح في أعلى النموذج ثم أعد التصوير.`, { issues: result.issues ?? [], read: { branch: branchId ?? null, date: date ?? null } });
      }
      if (m) {
        if (m.branch_id !== branch.id || m.business_date !== date) {
          return reject(readingId, 409, 'FORM_MISMATCH', `اليومية المصوّرة لفرع ${branch.name_ar || branch.name} بتاريخ ${date}، وهذه المطابقة لتاريخ ${m.business_date}. صوّر يومية هذا اليوم.`);
        }
      } else {
        const existing = await db.get('SELECT * FROM matches WHERE branch_id = ? AND business_date = ?', branch.id, date);
        if (existing) {
          if (!canEdit(req, existing)) {
            return reject(readingId, 409, 'MATCH_EXISTS', `توجد مطابقة رقم ${existing.number} لفرع ${branch.name_ar || branch.name} بتاريخ ${date}. كل يوم له مطابقة واحدة.`, { number: existing.number, publicId: existing.public_id });
          }
          m = existing;
        } else {
          editToken = randomToken();
          m = await createMatch(req, branch, date, editToken);
          if (!m) return reject(readingId, 409, 'MATCH_EXISTS', 'توجد مطابقة لهذا الفرع وهذا التاريخ.');
        }
        await db.run('UPDATE camera_sessions SET match_id = ? WHERE id = ?', m.id, session.id);
        await db.run('UPDATE captures SET match_id = ? WHERE session_id = ?', m.id, session.id);
        await db.run('UPDATE readings SET match_id = ? WHERE id = ?', m.id, readingId);
      }
    }

    // Promote: one current reading per kind (expense invoices accumulate).
    if (session.kind !== 'expense_invoice') {
      await db.run("UPDATE readings SET state = 'replaced' WHERE match_id = ? AND kind = ? AND state = 'current'", m.id, session.kind);
    }
    await db.run("UPDATE readings SET state = 'current' WHERE id = ?", readingId);
    await refreshResult(m);
    m = await db.get('SELECT * FROM matches WHERE id = ?', m.id);
    await audit.record({ req, action: 'reading.accepted', reconciliationId: m.id, entityType: 'reading', entityId: readingId, details: { kind: session.kind } });
    if (editToken) req.headers['x-edit-token'] = editToken; // so the detail below shows the editor view
    return { status: editToken ? 201 : 200, body: { publicId: m.public_id, number: m.number, editToken, readingId, detail: await detail(req, m) } };
  }

  async function createMatch(req, branch, date, editToken) {
    const now = new Date().toISOString();
    for (let attempt = 0; attempt < 5; attempt++) {
      const number = ((await db.get('SELECT MAX(number) AS n FROM matches'))?.n ?? 1000) + 1;
      const id = crypto.randomUUID();
      try {
        await db.run(`INSERT INTO matches (id, number, public_id, edit_token_hash, branch_id, business_date, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`, id, number, randomToken(8), sha256Hex(editToken), branch.id, date, now, now);
        await audit.record({ req, action: 'match.created', reconciliationId: id, entityType: 'match', entityId: id, details: { number, branchId: branch.id, businessDate: date } });
        return db.get('SELECT * FROM matches WHERE id = ?', id);
      } catch (err) {
        if (!/UNIQUE/i.test(String(err?.message))) throw err;
        if (await db.get('SELECT 1 FROM matches WHERE branch_id = ? AND business_date = ?', branch.id, date)) return null;
      }
    }
    throw new HttpError(503, 'BUSY', 'حاول مرة أخرى.');
  }

  // ---------------------------------------------------------------- routes

  r.get('/matches', async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 100);
    const rows = await db.all(`SELECT m.*, b.name, b.name_ar FROM matches m JOIN branches b ON b.id = m.branch_id
      ORDER BY m.business_date DESC, m.number DESC LIMIT ?`, limit);
    res.set('Cache-Control', 'no-store');
    res.json({ matches: rows.map((m) => ({ number: m.number, publicId: m.public_id, branchName: m.name_ar || m.name, businessDate: m.business_date,
      weekday: weekdayOf(m.business_date), status: m.status, result: m.result, updatedAt: m.updated_at, submittedAt: m.submitted_at })) });
  });

  r.get('/matches/:pid', async (req, res) => {
    const m = await byPublicId(req.params.pid);
    if (!m) throw new HttpError(404, 'NOT_FOUND', 'المطابقة غير موجودة.');
    res.set('Cache-Control', 'no-store');
    res.json(await detail(req, m));
  });

  r.get('/matches/:pid/qr.svg', async (req, res) => {
    const m = await byPublicId(req.params.pid);
    if (!m) throw new HttpError(404, 'NOT_FOUND', 'المطابقة غير موجودة.');
    const qr = qrcode(0, 'M');
    qr.addData(`${req.protocol}://${req.get('host')}/m/${m.public_id}`);
    qr.make();
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/svg+xml').send(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
  });

  r.get('/matches/:pid/captures/:cid', async (req, res) => {
    const m = await byPublicId(req.params.pid);
    const c = m ? await db.get('SELECT * FROM captures WHERE id = ? AND match_id = ?', req.params.cid, m.id) : null;
    if (!c || (c.kind === 'cash' && !canEdit(req, m))) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة.');
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
    res.type('image/jpeg').send(await files.get(c.storage_key));
  });

  r.post('/matches/:pid/cash/confirm', express.json({ limit: '2kb' }), async (req, res) => {
    const m = await requireEditable(req, req.params.pid);
    if (req.body?.confirmed !== true) throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'أكّد أنك راجعت عدد كل فئة مقابل النقد الفعلي.');
    if (await db.get('SELECT 1 FROM cash_confirmations WHERE match_id = ?', m.id)) throw new HttpError(409, 'CASH_COUNT_ALREADY_CONFIRMED', 'تم تأكيد عدّ النقد مسبقًا.');
    const rd = parseReading(await db.get("SELECT * FROM readings WHERE id = ? AND match_id = ? AND kind = 'cash' AND state = 'current'", String(req.body?.readingId ?? ''), m.id));
    if (!rd) throw new HttpError(409, 'ANALYSIS_STALE', 'يوجد تصوير أحدث للنقد. راجع آخر تصوير.');
    if ((await captureIds(rd.sessionId)).length === 0) throw new HttpError(409, 'NO_PHOTOGRAPHS', 'هذا العدّ غير مدعوم بصور من الكاميرا المباشرة.');
    const now = new Date().toISOString();
    await db.run('INSERT INTO cash_confirmations (match_id, reading_id, total_halalas, confirmed_at) VALUES (?, ?, ?, ?)', m.id, rd.id, rd.extras.totalHalalas, now);
    await audit.record({ req, action: 'cash.confirmed', reconciliationId: m.id, entityType: 'reading', entityId: rd.id, details: { totalHalalas: rd.extras.totalHalalas, counts: rd.fields } });
    await refreshResult(m);
    res.status(201).json(await detail(req, m));
  });

  r.delete('/matches/:pid/expenses/:rid', async (req, res) => {
    const m = await requireEditable(req, req.params.pid);
    const done = await db.run("UPDATE readings SET state = 'replaced' WHERE id = ? AND match_id = ? AND kind = 'expense_invoice' AND state = 'current'", req.params.rid, m.id);
    if (done.changes !== 1) throw new HttpError(404, 'NOT_FOUND', 'الفاتورة غير موجودة.');
    await audit.record({ req, action: 'expense.removed', reconciliationId: m.id, entityType: 'reading', entityId: req.params.rid });
    await refreshResult(m);
    res.json(await detail(req, m));
  });

  r.post('/matches/:pid/submit', async (req, res) => {
    const m = await requireEditable(req, req.params.pid);
    const { evaluation } = await load(m);
    if (!evaluation.complete) {
      throw new HttpError(409, 'MATCH_INCOMPLETE', `أكمل التصوير أولًا: ${evaluation.missing.map((x) => DOC_NAMES[x.kind]).join('، ')}.`, { missing: evaluation.missing });
    }
    const now = new Date().toISOString();
    await db.run("UPDATE matches SET status = 'submitted', result = ?, submitted_at = ?, updated_at = ? WHERE id = ? AND status = 'open'", evaluation.result, now, now, m.id);
    await audit.record({ req, action: 'match.submitted', reconciliationId: m.id, entityType: 'match', entityId: m.id, details: { result: evaluation.result, checks: evaluation.checks } });
    res.json(await detail(req, await byPublicId(m.public_id)));
  });

  return { router: r, requireEditable, requireEditableById, applyReading };
}
