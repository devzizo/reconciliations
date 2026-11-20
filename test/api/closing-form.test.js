import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, USERS } from '../helpers/server.js';
import { MINIMAL_PDF } from '../helpers/jpeg.js';
import { closingFormChecks } from '../../src/routes/reconciliations.js';

let srv;
let emp;
let n = 0;
before(async () => { srv = await startTestServer(); emp = await srv.login(...USERS.tabuk); });
after(() => srv.close());

const newDay = async () => (await srv.call('POST', '/api/reconciliations', { token: emp, json: { businessDate: `2026-10-${String(++n).padStart(2, '0')}` } })).data.reconciliation;
// The Tabuk form from 19/11/2026: 4567 = 2793 + 45 + 1145 + 584.
const TABUK = { gross_sales: '4567', returns: '', net_sales: '4567', mada: '2793', mastercard: '45', visa: '1145', tamara: '', tabby: '', cash_sales: '584',
  overage_shortage: '', opening_cash_balance: '', cash_inflow: '584', cash_outflow: '20', closing_cash_balance: '670', notes: 'إيداع كاش الصندوق 4750 ريال' };

test('a balanced closing form saves, with notes and overage/shortage', async () => {
  const rec = await newDay();
  const r = await srv.call('PUT', `/api/reconciliations/${rec.id}/stages/daily_closing_form`, { token: emp, json: TABUK });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = r.data.stages.daily_closing_form;
  assert.equal(f.figures.net_sales, 456700);
  assert.equal(f.figures.notes, 'إيداع كاش الصندوق 4750 ريال');
  assert.ok(f.checks.every((c) => c.ok));
});

test('gross − returns ≠ net is rejected with an Arabic explanation', async () => {
  const rec = await newDay();
  const r = await srv.call('PUT', `/api/reconciliations/${rec.id}/stages/daily_closing_form`, { token: emp, json: { ...TABUK, returns: '100' } });
  assert.equal(r.status, 422);
  assert.equal(r.data.error.code, 'FIGURES_UNBALANCED');
  assert.match(r.data.error.message, /إجمالي المبيعات − المرتجعات = 4467\.00 لا يساوي صافي المبيعات 4567\.00/);
});

test('payment methods ≠ net sales is rejected', async () => {
  const rec = await newDay();
  const r = await srv.call('PUT', `/api/reconciliations/${rec.id}/stages/daily_closing_form`, { token: emp, json: { ...TABUK, visa: '1100' } });
  assert.equal(r.status, 422);
  assert.match(r.data.error.message, /مجموع طرق الدفع 4522\.00 لا يساوي صافي المبيعات 4567\.00 \(الفرق -45\.00\)/);
  // Overage/shortage is not a payment method.
  const ok = await srv.call('PUT', `/api/reconciliations/${rec.id}/stages/daily_closing_form`, { token: emp, json: { ...TABUK, overage_shortage: '-5' } });
  assert.equal(ok.status, 200);
});

test('gross and net sales are required', async () => {
  const rec = await newDay();
  const r = await srv.call('PUT', `/api/reconciliations/${rec.id}/stages/daily_closing_form`, { token: emp, json: { mada: '0' } });
  assert.equal(r.status, 422);
  assert.match(r.data.error.message, /أدخل إجمالي المبيعات وصافي المبيعات/);
});

test('check helper', () => {
  assert.deepEqual(closingFormChecks({ gross_sales: 1000, returns: 100, net_sales: 900, mada: 900 }).map((c) => c.ok), [true, true]);
  assert.deepEqual(closingFormChecks({ gross_sales: 1000, returns: 100, net_sales: 900, mada: 800 }).map((c) => c.ok), [true, false]);
});

test('one document per day: uploading again replaces the current file', async () => {
  const rec = await newDay();
  const up = async (name) => {
    const fd = new FormData();
    fd.append('file', new Blob([MINIMAL_PDF], { type: 'application/pdf' }), name);
    const res = await fetch(`${srv.base}/api/reconciliations/${rec.id}/documents?type=daily_closing_form`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${emp}` } });
    return res.json();
  };
  const first = await up('first.pdf');
  const second = await up('second.pdf');
  assert.equal(second.stages.daily_closing_form.document.name, 'second.pdf');
  const rows = await srv.db.all('SELECT original_name, status FROM documents WHERE reconciliation_id = ? ORDER BY uploaded_at, rowid', rec.id);
  assert.deepEqual(rows.map((r) => [r.original_name, r.status]), [['first.pdf', 'replaced'], ['second.pdf', 'current']]);
  // The replaced file cannot be read again for figures.
  assert.equal((await srv.call('POST', `/api/reconciliations/${rec.id}/documents/${first.documentId}/extract`, { token: emp })).status, 404);
  assert.ok(await srv.db.get("SELECT 1 FROM audit_log WHERE action = 'document.replaced' AND reconciliation_id = ?", rec.id));
  // The database refuses two current files of the same type.
  await assert.rejects(srv.db.run("UPDATE documents SET status = 'current' WHERE reconciliation_id = ?", rec.id), /UNIQUE/);
});

test('server error messages are Arabic', async () => {
  const r = await srv.call('POST', '/api/auth/login', { json: { username: 'x', password: 'y' } });
  assert.equal(r.data.error.message, 'اسم المستخدم أو كلمة المرور غير صحيحة.');
});
