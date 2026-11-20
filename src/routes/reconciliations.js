import crypto from 'node:crypto';
import express from 'express';
import { requireRole } from '../auth.js';
import { loadReconciliation } from '../access.js';
import { HttpError } from '../errors.js';
import { formatSar } from '../services/denominations.js';

// Declared figures per stage. Amounts are entered in SAR with up to 2 decimals and stored in halalas.
export const STAGE_FIELDS = {
  daily_closing_form: ['gross_sales', 'returns', 'net_sales', 'mada', 'mastercard', 'visa', 'tamara', 'tabby', 'cash_sales',
    'opening_cash_balance', 'cash_inflow', 'cash_outflow', 'closing_cash_balance'],
  z_report: ['gross_sales', 'discount', 'net_sales', 'cash', 'mada', 'visa'],
  bank_settlement: ['mada_total', 'visa_total', 'mastercard_total', 'transaction_count'],
};

function toHalalas(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (!/^-?\d{1,9}(\.\d{1,2})?$/.test(s)) throw new HttpError(400, 'INVALID_AMOUNT', `${field} must be a number with up to 2 decimals.`);
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const v = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return s.startsWith('-') ? -v : v;
}

export function reconciliationRoutes({ db, audit }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const rows = req.user.role === 'employee'
      ? db.prepare('SELECT * FROM reconciliations WHERE branch_id = ? ORDER BY business_date DESC LIMIT 60').all(req.user.branchId)
      : db.prepare('SELECT * FROM reconciliations ORDER BY business_date DESC, branch_id LIMIT 200').all();
    res.json({ reconciliations: rows.map(summaryRow) });
  });

  r.post('/', requireRole('employee'), express.json(), (req, res) => {
    const date = String(req.body?.businessDate ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
      throw new HttpError(400, 'INVALID_DATE', 'businessDate must be YYYY-MM-DD.');
    }
    const existing = db.prepare('SELECT * FROM reconciliations WHERE branch_id = ? AND business_date = ?').get(req.user.branchId, date);
    if (existing) return res.status(200).json({ reconciliation: summaryRow(existing) });
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO reconciliations (id, branch_id, business_date, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, req.user.branchId, date, req.user.id, new Date().toISOString());
    audit.record({ req, action: 'reconciliation.created', reconciliationId: id, entityType: 'reconciliation', entityId: id, details: { businessDate: date } });
    res.status(201).json({ reconciliation: summaryRow(db.prepare('SELECT * FROM reconciliations WHERE id = ?').get(id)) });
  });

  r.get('/:id', (req, res) => {
    const rec = loadReconciliation(db, req.params.id, req.user);
    res.json(detail(db, rec));
  });

  r.put('/:id/stages/:stage', express.json(), (req, res) => {
    const fields = STAGE_FIELDS[req.params.stage];
    if (!fields) throw new HttpError(404, 'UNKNOWN_STAGE', 'Unknown stage.');
    const rec = loadReconciliation(db, req.params.id, req.user, { write: true });
    const data = {};
    for (const f of fields) {
      data[f] = f === 'transaction_count'
        ? (req.body?.[f] === undefined || req.body[f] === '' ? null : Number.parseInt(req.body[f], 10))
        : toHalalas(req.body?.[f], f);
    }
    db.prepare(`INSERT INTO stage_figures (reconciliation_id, stage, data_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (reconciliation_id, stage) DO UPDATE SET data_json = excluded.data_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(rec.id, req.params.stage, JSON.stringify(data), req.user.id, new Date().toISOString());
    audit.record({ req, action: 'stage.figures_saved', reconciliationId: rec.id, entityType: 'stage', entityId: req.params.stage, details: data });
    res.json(detail(db, rec));
  });

  r.post('/:id/submit', requireRole('employee'), (req, res) => {
    const rec = loadReconciliation(db, req.params.id, req.user, { write: true });
    const d = detail(db, rec);
    const missing = Object.entries(d.stages).filter(([, s]) => !s.complete).map(([k]) => k);
    if (missing.length) throw new HttpError(409, 'STAGES_INCOMPLETE', `Complete these stages first: ${missing.join(', ')}.`, { missing });
    const now = new Date().toISOString();
    db.prepare("UPDATE reconciliations SET status = 'submitted', submitted_at = ? WHERE id = ?").run(now, rec.id);
    audit.record({ req, action: 'reconciliation.submitted', reconciliationId: rec.id, entityType: 'reconciliation', entityId: rec.id, details: d.summary });
    res.json(detail(db, { ...rec, status: 'submitted', submitted_at: now }));
  });

  r.get('/:id/audit', requireRole('manager'), (req, res) => {
    const rec = loadReconciliation(db, req.params.id, req.user);
    const rows = db.prepare('SELECT * FROM audit_log WHERE reconciliation_id = ? ORDER BY seq').all(rec.id);
    res.json({
      chain: audit.verify(),
      entries: rows.map((e) => ({ ...e, details: JSON.parse(e.details_json), details_json: undefined })),
    });
  });

  return r;
}

function summaryRow(rec) {
  return { id: rec.id, branchId: rec.branch_id, businessDate: rec.business_date, status: rec.status, createdAt: rec.created_at, submittedAt: rec.submitted_at };
}

export function detail(db, rec) {
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(rec.branch_id);
  const figures = Object.fromEntries(
    db.prepare('SELECT stage, data_json, updated_at FROM stage_figures WHERE reconciliation_id = ?').all(rec.id)
      .map((f) => [f.stage, { ...JSON.parse(f.data_json), updatedAt: f.updated_at }]),
  );
  const documents = db.prepare('SELECT id, doc_type, original_name, mime_type, size_bytes, uploaded_at FROM documents WHERE reconciliation_id = ? ORDER BY uploaded_at')
    .all(rec.id).map((d) => ({ id: d.id, docType: d.doc_type, name: d.original_name, mimeType: d.mime_type, size: d.size_bytes, uploadedAt: d.uploaded_at }));
  const cash = db.prepare('SELECT * FROM cash_counts WHERE reconciliation_id = ?').get(rec.id);

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
  const zCash = figures.z_report?.cash ?? null;
  const formCash = figures.daily_closing_form?.cash_sales ?? null;
  const formMada = figures.daily_closing_form?.mada ?? null;
  const bankMada = figures.bank_settlement?.mada_total ?? null;
  const diff = (a, b) => (a === null || b === null ? null : a - b);
  const summary = {
    expectedClosingCashHalalas: expected,
    countedCashHalalas: counted,
    cashVarianceHalalas: diff(counted, expected),
    zReportVsFormCashHalalas: diff(zCash, formCash),
    bankVsFormMadaHalalas: diff(bankMada, formMada),
  };

  return {
    reconciliation: { ...summaryRow(rec), branchName: branch?.name, branchNameAr: branch?.name_ar },
    stages,
    summary,
  };
}
