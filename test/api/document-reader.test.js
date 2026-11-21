import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentReader, toResult } from '../../src/services/documentReader.js';
import { parseAmountToHalalas } from '../../src/services/amounts.js';
import { liveFrameJpeg } from '../helpers/jpeg.js';

const fakeClient = (respond) => { const calls = []; return { calls, beta: { messages: { create: async (p) => { calls.push(p); return respond(p); } } } }; };
const reader = (client) => createDocumentReader({ aiProvider: 'anthropic', aiModel: 'claude-opus-5-5', anthropicClient: client });
const BRANCHES = [{ id: 'najran', name: 'Najran', name_ar: 'نجران' }, { id: 'tabuk', name: 'Tabuk', name_ar: 'تبوك' }];

test('closing form: photo sent as an image, branch limited to known branches, header fields returned', async () => {
  const client = fakeClient(() => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify({
    values: [{ field: 'gross_sales', amount: '١٠٦٩٠', confidence: 'high' }, { field: 'cash_sales', amount: '6797', confidence: 'low' }],
    issues: [], branch: 'najran', date: '2026-11-18', day_name: 'الأربعاء', notes: '' }) }] }));
  const r = await reader(client).read({ kind: 'daily_closing_form', bytes: liveFrameJpeg(), branches: BRANCHES });
  const p = client.calls[0];
  assert.equal(p.messages[0].content[0].type, 'image');
  assert.deepEqual(p.output_config.format.schema.properties.branch.enum, ['najran', 'tabuk', 'unknown']);
  assert.ok(p.output_config.format.schema.required.includes('date'));
  assert.match(p.messages[0].content[1].text, /najran: نجران \/ Najran/);
  assert.equal(p.fallbacks, 'default');
  assert.equal(r.fields.gross_sales, 1069000);
  assert.deepEqual(r.lowConfidence, ['cash_sales']);
  assert.deepEqual(r.extras, { branch: 'najran', date: '2026-11-18', day_name: 'الأربعاء', notes: null });
});

test('unknown branch / bad date become null', () => {
  const r = toResult('daily_closing_form', { values: [], issues: [], branch: 'unknown', date: '18/11/2026', day_name: '', notes: '' }, 'm');
  assert.equal(r.extras.branch, null);
  assert.equal(r.extras.date, null);
});

test('unreadable values are reported in Arabic', () => {
  const r = toResult('deposit_receipt', { values: [{ field: 'amount', amount: 'غير واضح', confidence: 'low' }], issues: [], date: '' }, 'm');
  assert.equal(r.fields.amount, null);
  assert.match(r.issues[0], /تعذّر فهم القيمة المقروءة لخانة المبلغ المودع/);
});

test('refusal and API errors → failed with an Arabic message', async () => {
  const a = await reader(fakeClient(() => ({ stop_reason: 'refusal', content: [] }))).read({ kind: 'z_report', bytes: liveFrameJpeg() });
  assert.equal(a.status, 'failed');
  assert.match(a.issues[0], /أعد التصوير/);
  const b = await reader(fakeClient(() => { throw new Error('x'); })).read({ kind: 'z_report', bytes: liveFrameJpeg() });
  assert.equal(b.status, 'failed');
});

test('amount parsing', () => {
  assert.equal(parseAmountToHalalas('٤٥٦٧'), 456700);
  assert.equal(parseAmountToHalalas('4,567.00'), 456700);
  assert.equal(parseAmountToHalalas('-108.91'), -10891);
  assert.equal(parseAmountToHalalas(''), null);
  assert.equal(parseAmountToHalalas('abc'), undefined);
});
