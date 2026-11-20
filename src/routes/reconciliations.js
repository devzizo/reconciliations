import crypto from 'node:crypto';
import express from 'express';
import { requireRole } from '../auth.js';
import { loadReconciliation } from '../access.js';
import { HttpError } from '../errors.js';
import { formatSar } from '../services/denominations.js';
import { parseAmountToHalalas } from '../services/amounts.js';

// Declared figures per stage. Amounts are entered in SAR with up to 2 decimals and stored in halalas.
export const STAGE_FIELDS = {
  daily_closing_form: ['gross_sales', 'returns', 'net_sales', 'mada', 'mastercard', 'visa', 'tamara', 'tabby', 'cash_sales',
    'opening_cash_balance', 'cash_inflow', 'cash_outflow', 'closing_cash_balance'],
  z_report: ['gross_sales', 'discount', 'net_sales', 'cash', 'mada', 'visa'],
  bank_settlement: ['mada_total', 'visa_total', 'mastercard_total', 'transaction_count'],
};

function amountField(value, field) {
  const v = parseAmountToHalalas(value);
  if (v === undefined) throw new HttpError(400, 'INVALID_AMOUNT', `${field} must be a number with up to 2 decimals.`);
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
      throw new HttpError(400, 'INVALID_DATE', 'businessDate must be YYYY-MM-DD.');
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
    if (!fields) throw new HttpError(404, 'UNKNOWN_STAGE', 'Unknown stage.');
    const rec = await loadReconciliation(db, req.params.id, req.user, { write: true });
    const data = {};
    for (const f of fields) {
      data[f] = f === 'transaction_count'
        ? (req.body?.[f] === undefined || req.body[f] === '' ? null : Number.parseInt(req.body[f], 10))
        : amountField(req.body?.[f], f);
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
    if (missing.length) throw new HttpError(409, 'STAGES_INCOMPLETE', `Complete these stages first: ${missing.join(', ')}.`, { missing });
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
  const documents = (await db.all('SELECT id, doc_type, original_name, mime_type, size_bytes, uploaded_at FROM documents WHERE reconciliation_id = ? ORDER BY uploaded_at', rec.id))
    .map((d) => ({ id: d.id, docType: d.doc_type, name: d.original_name, mimeType: d.mime_type, size: d.size_bytes, uploadedAt: d.uploaded_at }));
  const cash = await db.get('SELECT * FROM cash_counts WHERE reconciliation_id = ?', rec.id);

  const docStage = (type) => ({
    complete: Boolean(figures[type]) && documents.some((d) => d.docType === type),
    figures: figures[type] ?? null,
    documents: documents.filter((d) => d.docType === type),
  });
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
