import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentReader, toResult } from '../../src/services/documentReader.js';
import { parseAmountToHalalas } from '../../src/services/amounts.js';
import { startTestServer, USERS } from '../helpers/server.js';
import { liveFrameJpeg, MINIMAL_PDF } from '../helpers/jpeg.js';

const fakeClient = (respond) => {
  const calls = [];
  return { calls, beta: { messages: { create: async (p) => { calls.push(p); return respond(p); } } } };
};
const reply = (values, issues = []) => () => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify({ values, issues }) }] });
const reader = (client) => createDocumentReader({ aiProvider: 'anthropic', aiModel: 'claude-opus-5-5', anthropicClient: client });

test('amount parsing handles Arabic-Indic digits, separators and signs', () => {
  assert.equal(parseAmountToHalalas('٤٥٦٧'), 456700);
  assert.equal(parseAmountToHalalas('4,567.00'), 456700);
  assert.equal(parseAmountToHalalas('-108.91'), -10891);
  assert.equal(parseAmountToHalalas('١٠٦٩٠ ريال'), 1069000);
  assert.equal(parseAmountToHalalas('584٫5'), 58450);
  assert.equal(parseAmountToHalalas(''), null);
  assert.equal(parseAmountToHalalas('abc'), undefined);
  assert.equal(parseAmountToHalalas('1.234'), undefined);
});

test('PDF is sent as a document block, photo as an image block, with a strict schema for that form', async () => {
  const client = fakeClient(reply([{ field: 'mada_total', amount: '2793.00', confidence: 'high' }, { field: 'transaction_count', amount: '5', confidence: 'high' }]));
  const r = await reader(client).read({ docType: 'bank_settlement', mimeType: 'application/pdf', bytes: MINIMAL_PDF });
  const p = client.calls[0];
  assert.equal(p.messages[0].content[0].type, 'document');
  assert.equal(p.messages[0].content[0].source.media_type, 'application/pdf');
  assert.deepEqual(p.output_config.format.schema.properties.values.items.properties.field.enum, ['mada_total', 'visa_total', 'mastercard_total', 'transaction_count']);
  assert.equal(p.fallbacks, 'default');
  assert.equal(r.fields.mada_total, 279300);
  assert.equal(r.fields.transaction_count, 5);
  assert.equal(r.fields.visa_total, null);

  const c2 = fakeClient(reply([]));
  await reader(c2).read({ docType: 'daily_closing_form', mimeType: 'image/jpeg', bytes: liveFrameJpeg() });
  assert.equal(c2.calls[0].messages[0].content[0].type, 'image');
  assert.match(c2.calls[0].messages[0].content[1].text, /رصيد الصندوق آخر اليوم/);
});

test('HEIC cannot be read and does not call the API', async () => {
  const client = fakeClient(reply([]));
  const r = await reader(client).read({ docType: 'z_report', mimeType: 'image/heic', bytes: Buffer.from('x') });
  assert.equal(r.status, 'unavailable');
  assert.equal(client.calls.length, 0);
});

test('handwritten closing form values: Arabic digits, low confidence, unreadable values reported', () => {
  const r = toResult('daily_closing_form', { values: [
    { field: 'gross_sales', amount: '١٠٦٩٠', confidence: 'high' },
    { field: 'cash_sales', amount: '٦٧٩٧', confidence: 'low' },
    { field: 'returns', amount: '0', confidence: 'high' },
    { field: 'closing_cash_balance', amount: 'illegible', confidence: 'low' },
    { field: 'not_a_field', amount: '1', confidence: 'high' },
  ], issues: ['Notes line is crossed out'] }, 'm');
  assert.equal(r.fields.gross_sales, 1069000);
  assert.equal(r.fields.cash_sales, 679700);
  assert.equal(r.fields.returns, 0);
  assert.equal(r.fields.closing_cash_balance, null);
  assert.deepEqual(r.lowConfidence, ['cash_sales']);
  assert.ok(r.issues.some((i) => /رصيد الصندوق آخر اليوم/.test(i)));
});

test('refusal / API error → failed, employee enters by hand', async () => {
  assert.equal((await reader(fakeClient(() => ({ stop_reason: 'refusal', content: [] }))).read({ docType: 'z_report', mimeType: 'image/png', bytes: Buffer.from('x') })).status, 'failed');
  assert.equal((await reader(fakeClient(() => { throw new Error('boom'); })).read({ docType: 'z_report', mimeType: 'image/png', bytes: Buffer.from('x') })).status, 'failed');
});

// ---------------------------------------------------------------- endpoint

let srv;
let emp;
let other;
before(async () => {
  srv = await startTestServer({
    documentReader: {
      provider: 'test-ai',
      async read({ docType, mimeType }) {
        assert.equal(mimeType, 'application/pdf');
        return docType === 'z_report'
          ? { status: 'completed', model: 'm', fields: { gross_sales: 467800, discount: -10891, net_sales: 456700, cash: 58400, mada: 279300, visa: 119000 }, lowConfidence: ['visa'], issues: ['Two Z reports added together'] }
          : { status: 'unavailable', model: null, fields: {}, lowConfidence: [], issues: ['n/a'] };
      },
    },
  });
  emp = await srv.login(...USERS.tabuk);
  other = await srv.login(...USERS.najran);
});
after(() => srv.close());

async function upload(recId, type) {
  const fd = new FormData();
  fd.append('file', new Blob([MINIMAL_PDF], { type: 'application/pdf' }), 'z.pdf');
  const res = await fetch(`${srv.base}/api/reconciliations/${recId}/documents?type=${type}`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${emp}` } });
  return (await res.json()).documentId;
}

test('extract returns proposed figures without saving them; save records corrections in the audit trail', async () => {
  const rec = (await srv.call('POST', '/api/reconciliations', { token: emp, json: { businessDate: '2026-11-19' } })).data.reconciliation;
  const docId = await upload(rec.id, 'z_report');
  const r = await srv.call('POST', `/api/reconciliations/${rec.id}/documents/${docId}/extract`, { token: emp });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ex = r.data.extraction;
  assert.equal(ex.fields.net_sales, 456700);
  assert.deepEqual(ex.lowConfidence, ['visa']);

  const before = await srv.call('GET', `/api/reconciliations/${rec.id}`, { token: emp });
  assert.equal(before.data.stages.z_report.figures, null, 'reading does not save');

  // Employee corrects visa, keeps the rest.
  const body = { gross_sales: '4678.00', discount: '-108.91', net_sales: '4567.00', cash: '584.00', mada: '2793.00', visa: '1145.00', extractionId: ex.extractionId };
  const saved = await srv.call('PUT', `/api/reconciliations/${rec.id}/stages/z_report`, { token: emp, json: body });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.stages.z_report.figures.visa, 114500);
  const entry = await srv.db.get("SELECT details_json FROM audit_log WHERE action = 'stage.figures_saved' AND reconciliation_id = ?", rec.id);
  assert.deepEqual(JSON.parse(entry.details_json).fromExtraction, { extractionId: ex.extractionId, adjustments: [{ field: 'visa', ai: 119000, saved: 114500 }] });
  assert.ok(await srv.db.get("SELECT 1 FROM audit_log WHERE action = 'document.ai_read' AND reconciliation_id = ?", rec.id));
});

test('other branches cannot read your documents', async () => {
  const rec = (await srv.call('POST', '/api/reconciliations', { token: emp, json: { businessDate: '2026-11-18' } })).data.reconciliation;
  const docId = await upload(rec.id, 'daily_closing_form');
  assert.equal((await srv.call('POST', `/api/reconciliations/${rec.id}/documents/${docId}/extract`, { token: other })).status, 404);
  const own = await srv.call('POST', `/api/reconciliations/${rec.id}/documents/${docId}/extract`, { token: emp });
  assert.equal(own.data.extraction.status, 'unavailable');
});

test('save accepts Arabic-Indic digits typed on a phone keyboard', async () => {
  const rec = (await srv.call('POST', '/api/reconciliations', { token: emp, json: { businessDate: '2026-11-17' } })).data.reconciliation;
  const r = await srv.call('PUT', `/api/reconciliations/${rec.id}/stages/daily_closing_form`, { token: emp, json: { gross_sales: '١٠٬٦٩٠', returns: '٠', net_sales: '١٠٦٩٠', mada: '٣٨٩٣', cash_sales: '٦٧٩٧' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.stages.daily_closing_form.figures.gross_sales, 1069000);
});
