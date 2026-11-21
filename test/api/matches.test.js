import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/server.js';
import { fakeReader, photograph, TABUK_FORM, TABUK_Z, TABUK_BANK } from '../helpers/flow.js';
import { liveFrameJpeg, galleryPhotoJpeg, MINIMAL_PDF } from '../helpers/jpeg.js';

const reader = fakeReader();
const counter = { provider: 'test-ai', next: null, async analyze() { return this.next ?? { status: 'completed', model: 'm', counts: { note_500: 1, note_100: 1, note_50: 1, note_10: 2 }, issues: [] }; } };
let srv;
before(async () => { srv = await startTestServer({ documentReader: reader, cashCounter: counter }); });
after(() => srv.close());

const form = (date, branch = 'tabuk', fields = TABUK_FORM.fields) => ({ fields, extras: { ...TABUK_FORM.extras, date, branch } });
async function newMatch(date, branch = 'tabuk', fields) {
  reader.next('daily_closing_form', form(date, branch, fields));
  const r = await photograph(srv, 'daily_closing_form');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

test('photographing the closing form creates the reconciliation: branch and date come from the form', async () => {
  const m = await newMatch('2026-11-19');
  assert.equal(m.number, 1001);
  assert.ok(m.editToken);
  assert.equal(m.detail.match.branchName, 'تبوك');
  assert.equal(m.detail.match.businessDate, '2026-11-19');
  assert.equal(m.detail.match.weekday, 'الخميس');
  assert.equal(m.detail.canEdit, true);
  assert.equal(m.detail.documents.daily_closing_form.fields.net_sales, 456700);
  // The reader was given the list of active branches to pick from.
  assert.deepEqual(reader.calls.at(-1).branches.map((b) => b.id), ['najran', 'tabuk']);

  // No public list: older reconciliations open only through their own link / QR.
  assert.equal((await srv.call('GET', '/api/matches')).status, 404);
  const pub = await srv.call('GET', `/api/matches/${m.publicId}`);
  assert.equal(pub.data.canEdit, false, 'viewers without the token cannot edit');
});

test('unreadable branch or date → asked to photograph again, nothing created', async () => {
  reader.next('daily_closing_form', { fields: TABUK_FORM.fields, extras: { branch: null, date: '2026-11-18' } });
  const r = await photograph(srv, 'daily_closing_form');
  assert.equal(r.status, 422);
  assert.equal(r.data.error.code, 'FORM_HEADER_UNREADABLE');
  assert.match(r.data.error.message, /تعذّر قراءة اسم الفرع/);
  assert.equal((await srv.db.get("SELECT COUNT(*) AS n FROM matches WHERE business_date = '2026-11-18'")).n, 0);
});

test('one reconciliation per branch per day', async () => {
  const m = await newMatch('2026-11-17');
  reader.next('daily_closing_form', form('2026-11-17'));
  const other = await photograph(srv, 'daily_closing_form'); // another phone, no edit token
  assert.equal(other.status, 409);
  assert.equal(other.data.error.code, 'MATCH_EXISTS');
  assert.equal(other.data.error.details.number, m.number);
  // The same phone re-photographing replaces the form.
  reader.next('daily_closing_form', form('2026-11-17', 'tabuk', { ...TABUK_FORM.fields, cash_outflow: 0 }));
  const again = await photograph(srv, 'daily_closing_form', { publicId: m.publicId, editToken: m.editToken });
  assert.equal(again.status, 200);
  assert.equal(again.data.detail.documents.daily_closing_form.fields.cash_outflow, 0);
  // …but only with a form for the same branch and day.
  reader.next('daily_closing_form', form('2026-11-16'));
  const wrong = await photograph(srv, 'daily_closing_form', { publicId: m.publicId, editToken: m.editToken });
  assert.equal(wrong.data.error.code, 'FORM_MISMATCH');
});

test('figures cannot be typed: no edit endpoint, no file or PDF upload, gallery photos refused', async () => {
  const m = await newMatch('2026-11-15');
  for (const [method, url] of [['PUT', `/api/matches/${m.publicId}/figures`], ['PATCH', `/api/matches/${m.publicId}`], ['POST', `/api/matches/${m.publicId}/documents`]]) {
    assert.equal((await srv.call(method, url, { editToken: m.editToken, json: { net_sales: '1' } })).status, 404, `${method} ${url}`);
  }
  const s = (await srv.call('POST', '/api/camera/sessions', { editToken: m.editToken, json: { kind: 'z_report', publicId: m.publicId } })).data;
  const fd = new FormData();
  fd.append('file', new Blob([MINIMAL_PDF], { type: 'application/pdf' }), 'z.pdf');
  const pdf = await fetch(`${srv.base}/api/camera/sessions/${s.sessionId}/captures`, { method: 'POST', body: fd, headers: { 'X-Capture-Token': s.captureToken } });
  assert.equal(pdf.status, 415);
  assert.match((await pdf.json()).error.message, /PDF/);
  const gal = await srv.call('POST', `/api/camera/sessions/${s.sessionId}/captures`, { body: galleryPhotoJpeg(), headers: { 'Content-Type': 'image/jpeg', 'X-Capture-Token': s.captureToken } });
  assert.equal(gal.data.error.code, 'NOT_A_LIVE_CAPTURE');
  const bad = await srv.call('POST', `/api/camera/sessions/${s.sessionId}/captures`, { body: liveFrameJpeg(), headers: { 'Content-Type': 'image/jpeg', 'X-Capture-Token': 'x'.repeat(43) } });
  assert.equal(bad.status, 401);
});

test('only the device that started a reconciliation can add photographs', async () => {
  const m = await newMatch('2026-11-14');
  assert.equal((await srv.call('POST', '/api/camera/sessions', { json: { kind: 'z_report', publicId: m.publicId } })).status, 403);
  assert.equal((await srv.call('POST', '/api/camera/sessions', { editToken: 'nope', json: { kind: 'cash', publicId: m.publicId } })).status, 403);
  assert.equal((await srv.call('POST', '/api/camera/sessions', { json: { kind: 'z_report' } })).data.error.code, 'MATCH_REQUIRED');
});

test('full day: every document photographed → matched → submitted; QR and link work', async () => {
  // Yesterday (for the deposit check): closing cash 4750.
  await newMatch('2026-11-12', 'tabuk', { ...TABUK_FORM.fields, closing_cash_balance: 475000 });
  const m = await newMatch('2026-11-13');
  const auth = { publicId: m.publicId, editToken: m.editToken };

  let d = (await srv.call('GET', `/api/matches/${m.publicId}`, { editToken: m.editToken })).data;
  assert.equal(d.result, 'unmatched');
  assert.deepEqual(d.missing.map((x) => x.kind), ['z_report', 'bank_settlement', 'deposit_receipt', 'expense_invoice', 'cash']);
  assert.equal(d.expensesRequired, true);
  assert.equal((await srv.call('POST', `/api/matches/${m.publicId}/submit`, { editToken: m.editToken })).data.error.code, 'MATCH_INCOMPLETE');

  reader.next('z_report', TABUK_Z);
  assert.equal((await photograph(srv, 'z_report', auth)).status, 200);
  reader.next('bank_settlement', TABUK_BANK);
  await photograph(srv, 'bank_settlement', auth);
  reader.next('deposit_receipt', { fields: { amount: 475000 }, extras: { date: '2026-11-13' } });
  await photograph(srv, 'deposit_receipt', auth);
  // A wrong invoice, then removed and replaced.
  reader.next('expense_invoice', { fields: { amount: 1500 }, extras: { vendor: 'بقالة', date: '2026-11-13' } });
  d = (await photograph(srv, 'expense_invoice', auth)).data.detail;
  assert.match(d.checks.find((c) => c.id === 'expenses').text, /غير مطابق — الفرق -5\.00/);
  d = (await srv.call('DELETE', `/api/matches/${m.publicId}/expenses/${d.expenses[0].readingId}`, { editToken: m.editToken })).data;
  reader.next('expense_invoice', { fields: { amount: 2000 }, extras: { vendor: 'بقالة', date: '2026-11-13' } });
  await photograph(srv, 'expense_invoice', auth);

  // Cash: 500 + 100 + 50 + 2×10 = 670 → pending until confirmed; counts cannot be sent by the client.
  d = (await photograph(srv, 'cash', { ...auth, frames: 2 })).data.detail;
  assert.equal(d.cash.pending.totalHalalas, 67000);
  assert.equal(d.cash.confirmed, null);
  const noConfirm = await srv.call('POST', `/api/matches/${m.publicId}/cash/confirm`, { editToken: m.editToken, json: { readingId: d.cash.pending.readingId } });
  assert.equal(noConfirm.data.error.code, 'CONFIRMATION_REQUIRED');
  d = (await srv.call('POST', `/api/matches/${m.publicId}/cash/confirm`, { editToken: m.editToken, json: { readingId: d.cash.pending.readingId, confirmed: true, counts: { note_500: 99 } } })).data;
  assert.equal(d.cash.confirmed.totalHalalas, 67000, 'client-sent counts are ignored');

  assert.deepEqual(d.missing, []);
  assert.deepEqual(d.checks.filter((c) => !c.ok).map((c) => c.text), []);
  assert.equal(d.result, 'matched');
  const sub = await srv.call('POST', `/api/matches/${m.publicId}/submit`, { editToken: m.editToken });
  assert.equal(sub.data.match.status, 'submitted');
  assert.equal(sub.data.match.result, 'matched');
  assert.equal((await srv.call('POST', '/api/camera/sessions', { editToken: m.editToken, json: { kind: 'z_report', publicId: m.publicId } })).data.error.code, 'MATCH_SUBMITTED');

  assert.equal((await srv.call('GET', `/api/matches/${m.publicId}`)).data.match.result, 'matched');
  const qr = await fetch(`${srv.base}/api/matches/${m.publicId}/qr.svg`);
  assert.equal(qr.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(await qr.text(), /^<svg/);
  // Share link serves the app.
  assert.match(await (await fetch(`${srv.base}/m/${m.publicId}`)).text(), /<html lang="ar" dir="rtl">/);
  // Document photos are public; cash photos are not.
  const pub = (await srv.call('GET', `/api/matches/${m.publicId}`)).data;
  assert.equal((await fetch(`${srv.base}/api/matches/${m.publicId}/captures/${pub.documents.z_report.captureIds[0]}`)).status, 200);
  const cashCapture = await srv.db.get("SELECT id FROM captures WHERE match_id = (SELECT id FROM matches WHERE public_id = ?) AND kind = 'cash'", m.publicId);
  assert.equal((await fetch(`${srv.base}/api/matches/${m.publicId}/captures/${cashCapture.id}`)).status, 404);
});

test('a reading that fails asks for a new photograph and changes nothing', async () => {
  const m = await newMatch('2026-11-11');
  reader.next('z_report', { status: 'failed', fields: {}, issues: ['الصورة غير واضحة. أعد التصوير.'] });
  const r = await photograph(srv, 'z_report', { publicId: m.publicId, editToken: m.editToken });
  assert.equal(r.status, 422);
  assert.equal(r.data.error.message, 'الصورة غير واضحة. أعد التصوير.');
  assert.equal((await srv.call('GET', `/api/matches/${m.publicId}`)).data.documents.z_report, null);
});

test('audit trail is hash-chained', async () => {
  const { createAudit } = await import('../../src/audit.js');
  assert.deepEqual(await createAudit(srv.db).verify(), { ok: true });
  assert.ok(await srv.db.get("SELECT 1 FROM audit_log WHERE action = 'match.created'"));
  await assert.rejects(srv.db.run('DELETE FROM audit_log'), /append-only/);
});

test('messages are Arabic', async () => {
  const r = await srv.call('GET', '/api/matches/nope');
  assert.equal(r.data.error.message, 'المطابقة غير موجودة.');
});
