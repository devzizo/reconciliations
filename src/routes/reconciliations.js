import crypto from 'node:crypto';
import express from 'express';
import { requireRole } from '../auth.js';
import { loadReconciliation } from '../access.js';
import { HttpError } from '../errors.js';
import { formatSar } from '../services/denominations.js';
import { parseAmountToHalalas } from '../services/amounts.js';

// Declared figures per stage. Amounts are entered in SAR with up to 2 decimals and stored in halalas.
// The daily closing form follows the paper form FIN-DCF-01 section by section.
export const STAGE_FIELDS = {
  daily_closing_form: ['gross_sales', 'returns', 'net_sales', 'mada', 'mastercard', 'visa', 'tamara', 'tabby', 'cash_sales',
    'overage_shortage', 'opening_cash_balance', 'cash_inflow', 'cash_outflow', 'closing_cash_balance', 'notes'],
  z_report: ['gross_sales', 'discount', 'net_sales', 'cash', 'mada', 'visa'],
  bank_settlement: ['mada_total', 'visa_total', 'mastercard_total', 'transaction_count'],
};

export const STAGE_NAMES_AR = { daily_closing_form: 'نموذج الإقفال اليومي', z_report: 'تقرير Z', bank_settlement: 'إيصال تسوية البنك', cash_count: 'عدّ النقد' };
// Payment methods on the closing form; together they must equal net sales.
export const PAYMENT_FIELDS = ['mada', 'mastercard', 'visa', 'tamara', 'tabby', 'cash_sales'];
const sar = (h) => (h / 100).toFixed(2);

/**
 * Balance checks for the daily closing form:
 *   gross sales − returns = net sales
 *   mada + mastercard + visa + tamara + tabby + cash = net sales
 * Empty amounts count as zero; gross and net sales are required.
 */
export function closingFormChecks(f) {
  const v = (k) => f?.[k] ?? 0;
  const checks = [];
  const missing = ['gross_sales', 'net_sales'].filter((k) => f?.[k] === null || f?.[k] === undefined);
  const salesOk = v('gross_sales') - v('returns') === v('net_sales');
  checks.push({ id: 'net_sales', ok: missing.length === 0 && salesOk, expectedHalalas: v('gross_sales') - v('returns'), actualHalalas: v('net_sales'),
    message: missing.length ? 'أدخل إجمالي المبيعات وصافي المبيعات.'
      : salesOk ? 'إجمالي المبيعات − المرتجعات = صافي المبيعات'
        : `إجمالي المبيعات − المرتجعات = ${sar(v('gross_sales') - v('returns'))} لا يساوي صافي المبيعات ${sar(v('net_sales'))} (الفرق ${sar(v('gross_sales') - v('returns') - v('net_sales'))})` });
  const payments = PAYMENT_FIELDS.reduce((a, k) => a + v(k), 0);
  const payOk = missing.length === 0 && payments === v('net_sales');
  checks.push({ id: 'payments', ok: payOk, expectedHalalas: v('net_sales'), actualHalalas: payments,
    message: payOk ? 'مجموع طرق الدفع = صافي المبيعات'
      : `مجموع طرق الدفع ${sar(payments)} لا يساوي صافي المبيعات ${sar(v('net_sales'))} (الفرق ${sar(payments - v('net_sales'))})` });
  return checks;
}

function amountField(value, field) {
  const v = parseAmountToHalalas(value);
  if (v === undefined) throw new HttpError(400, 'INVALID_AMOUNT', `قيمة غير صحيحة في الحقل ${field}: أدخل رقمًا بخانتين عشريتين كحد أقصى.`);
  return v;
}

export function reconciliationRoutes({ db, audit }) {
  const r = express.Router();
  const byId = (id) => db.get('SELECT * FROM reconciliations WHERE id = ?', id);

  r.get('/', async (req, res) => {
    const rows = req.user.role === 'employee'
      ? await db.all('SELECT * FROM reconciliations WHERE branch_id = ? ORDER BY business_date DESC LIMIT 60', req.user.branchId)
      : await db.all('SELECT * FROM reconciliations ORDER BY business_date DESC, branch_id LIMIT 200');
    res.json({ reconciliations: rows.map(summaryRow) });
  });

  r.post('/', requireRole('employee'), express.json(), async (req, res) => {
    const date = String(req.body?.businessDate ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
      throw new HttpError(400, 'INVALID_DATE', 'التاريخ غير صحيح.');
    }
    const existing = await db.get('SELECT * FROM reconciliations WHERE branch_id = ? AND business_date = ?', req.user.branchId, date);
    if (existing) return res.status(200).json({ reconciliation: summaryRow(existing) });
    const id = crypto.randomUUID();
    await db.run('INSERT INTO reconciliations (id, branch_id, business_date, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      id, req.user.branchId, date, req.user.id, new Date().toISOString());
    await audit.record({ req, action: 'reconciliation.created', reconciliationId: id, entityType: 'reconciliation', entityId: id, details: { businessDate: date } });
    res.status(201).json({ reconciliation: summaryRow(await byId(id)) });
  });

  r.get('/:id', async (req, res) => {
    const rec = await loadReconciliation(db, req.params.id, req.user);
    res.json(await detail(db, rec));
  });

  r.put('/:id/stages/:stage', express.json(), async (req, res) => {
    const fields = STAGE_FIELDS[req.params.stage];
    if (!fields) throw new HttpError(404, 'UNKNOWN_STAGE', 'مرحلة غير معروفة.');
    const rec = await loadReconciliation(db, req.params.id, req.user, { write: true });
    const data = {};
    for (const f of fields) {
      if (f === 'notes') data[f] = String(req.body?.[f] ?? '').trim().slice(0, 1000) || null;
      else if (f === 'transaction_count') {
        const n = parseAmountToHalalas(req.body?.[f]);
        if (n === undefined || (n !== null && (n < 0 || n % 100 !== 0))) throw new HttpError(400, 'INVALID_AMOUNT', 'عدد العمليات يجب أن يكون رقمًا صحيحًا.');
        data[f] = n === null ? null : n / 100;
      } else data[f] = amountField(req.body?.[f], f);
    }
    if (req.params.stage === 'daily_closing_form') {
      const failedChecks = closingFormChecks(data).filter((c) => !c.ok);
      if (failedChecks.length) {
        throw new HttpError(422, 'FIGURES_UNBALANCED', failedChecks.map((c) => c.message).join(' — '), { checks: closingFormChecks(data) });
      }
    }
    await db.run(`INSERT INTO stage_figures (reconciliation_id, stage, data_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (reconciliation_id, stage) DO UPDATE SET data_json = excluded.data_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    rec.id, req.params.stage, JSON.stringify(data), req.user.id, new Date().toISOString());
    // When the figures were pre-filled from an AI reading, record what the employee changed.
    let fromExtraction = null;
    if (req.body?.extractionId) {
      const ex = await db.get('SELECT * FROM document_extractions WHERE id = ? AND reconciliation_id = ? AND doc_type = ?', String(req.body.extractionId), rec.id, req.params.stage);
      if (ex) {
        const read = JSON.parse(ex.fields_json);
        fromExtraction = { extractionId: ex.id, adjustments: fields.filter((f) => f in read && read[f] !== data[f]).map((f) => ({ field: f, ai: read[f], saved: data[f] })) };
      }
    }
    await audit.record({ req, action: 'stage.figures_saved', reconciliationId: rec.id, entityType: 'stage', entityId: req.params.stage, details: { figures: data, fromExtraction } });
    res.json(await detail(db, rec));
  });

  r.post('/:id/submit', requireRole('employee'), async (req, res) => {
    const rec = await loadReconciliation(db, req.params.id, req.user, { write: true });
    const d = await detail(db, rec);
    const missing = Object.entries(d.stages).filter(([, s]) => !s.complete).map(([k]) => k);
    if (missing.length) throw new HttpError(409, 'STAGES_INCOMPLETE', `أكمل المراحل التالية أولًا: ${missing.map((k) => STAGE_NAMES_AR[k] ?? k).join('، ')}.`, { missing });
    const now = new Date().toISOString();
    await db.run("UPDATE reconciliations SET status = 'submitted', submitted_at = ? WHERE id = ?", now, rec.id);
    await audit.record({ req, action: 'reconciliation.submitted', reconciliationId: rec.id, entityType: 'reconciliation', entityId: rec.id, details: d.summary });
    res.json(await detail(db, { ...rec, status: 'submitted', submitted_at: now }));
  });

  r.get('/:id/audit', requireRole('manager'), async (req, res) => {
    const rec = await loadReconciliation(db, req.params.id, req.user);
    const rows = await db.all('SELECT * FROM audit_log WHERE reconciliation_id = ? ORDER BY seq', rec.id);
    res.json({
      chain: await audit.verify(),
      entries: rows.map((e) => ({ ...e, details: JSON.parse(e.details_json), details_json: undefined })),
    });
  });

  return r;
}

function summaryRow(rec) {
  return { id: rec.id, branchId: rec.branch_id, businessDate: rec.business_date, status: rec.status, createdAt: rec.created_at, submittedAt: rec.submitted_at };
}

export async function detail(db, rec) {
  const branch = await db.get('SELECT * FROM branches WHERE id = ?', rec.branch_id);
  const figures = Object.fromEntries(
    (await db.all('SELECT stage, data_json, updated_at FROM stage_figures WHERE reconciliation_id = ?', rec.id))
      .map((f) => [f.stage, { ...JSON.parse(f.data_json), updatedAt: f.updated_at }]),
  );
  const documents = (await db.all('SELECT id, doc_type, original_name, mime_type, size_bytes, uploaded_at FROM documents WHERE reconciliation_id = ? AND status = \'current\' ORDER BY uploaded_at', rec.id))
    .map((d) => ({ id: d.id, docType: d.doc_type, name: d.original_name, mimeType: d.mime_type, size: d.size_bytes, uploadedAt: d.uploaded_at }));
  const cash = await db.get('SELECT * FROM cash_counts WHERE reconciliation_id = ?', rec.id);

  // One current document per type per day (re-uploading replaces it).
  const docStage = (type) => {
    const checks = type === 'daily_closing_form' && figures[type] ? closingFormChecks(figures[type]) : [];
    const document = documents.find((d) => d.docType === type) ?? null;
    return {
      complete: Boolean(figures[type]) && Boolean(document) && checks.every((c) => c.ok),
      figures: figures[type] ?? null,
      document,
      checks,
    };
  };
  const stages = {
    daily_closing_form: docStage('daily_closing_form'),
    z_report: docStage('z_report'),
    bank_settlement: docStage('bank_settlement'),
    cash_count: {
      complete: Boolean(cash),
      confirmed: cash ? {
        totalHalalas: cash.total_halalas, total: formatSar(cash.total_halalas), confirmedAt: cash.confirmed_at, confirmedBy: cash.confirmed_by,
        counts: JSON.parse(cash.counts_json), aiTotalHalalas: cash.ai_total_halalas, adjustments: JSON.parse(cash.adjustments_json),
      } : null,
    },
  };

  const expected = figures.daily_closing_form?.closing_cash_balance ?? null;
  const counted = cash?.total_halalas ?? null;
  const diff = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : a - b);
  const summary = {
    expectedClosingCashHalalas: expected,
    countedCashHalalas: counted,
    cashVarianceHalalas: diff(counted, expected),
    zReportVsFormCashHalalas: diff(figures.z_report?.cash, figures.daily_closing_form?.cash_sales),
    bankVsFormMadaHalalas: diff(figures.bank_settlement?.mada_total, figures.daily_closing_form?.mada),
  };

  return {
    reconciliation: { ...summaryRow(rec), branchName: branch?.name, branchNameAr: branch?.name_ar },
    stages,
    summary,
  };
}
