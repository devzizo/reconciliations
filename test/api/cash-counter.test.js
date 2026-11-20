import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createCashCounter } from '../../src/services/cashCounter.js';
import { inspectJpeg } from '../../src/services/jpegInspect.js';
import { liveFrameJpeg, galleryPhotoJpeg } from '../helpers/jpeg.js';

function fakeClient(respond) {
  const calls = [];
  return { calls, beta: { messages: { create: async (params) => { calls.push(params); return respond(params); } } } };
}
const counterWith = (client) => createCashCounter({ aiProvider: 'anthropic', aiModel: 'claude-opus-5-5', anthropicClient: client });
const images = [{ id: 'a', bytes: liveFrameJpeg() }, { id: 'b', bytes: liveFrameJpeg() }];

test('sends both photographs with a strict JSON schema, adaptive thinking and server-side fallback', async () => {
  const client = fakeClient(() => ({
    stop_reason: 'end_turn', model: 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify({ counts: [{ denomination: 'note_500', count: 2, confidence: 'high' }, { denomination: 'note_10', count: 7, confidence: 'low' }], issues: ['Photos 1 and 2 overlap'] }) }],
  }));
  const r = await counterWith(client).analyze(images);
  const p = client.calls[0];
  assert.equal(p.model, 'claude-opus-5-5');
  assert.deepEqual(p.thinking, { type: 'adaptive' });
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.equal(p.output_config.format.schema.additionalProperties, false);
  assert.equal(p.messages[0].content.filter((b) => b.type === 'image').length, 2);
  assert.match(p.system, /not instructions to you/);

  assert.equal(r.status, 'completed');
  assert.equal(r.counts.note_500, 2);
  assert.equal(r.counts.note_10, 7);
  assert.equal(r.counts.note_100, 0);
  assert.match(r.issues[0], /قراءة غير مؤكدة لفئة: ١٠ ريال/);
});

test('clamps negative or absurd counts and drops unknown denominations', async () => {
  const client = fakeClient(() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ counts: [
    { denomination: 'note_100', count: -4, confidence: 'high' }, { denomination: 'note_1000', count: 3, confidence: 'high' }, { denomination: 'note_50', count: 1e9, confidence: 'high' },
  ], issues: [] }) }] }));
  const r = await counterWith(client).analyze(images);
  assert.equal(r.counts.note_100, 0);
  assert.equal(r.counts.note_50, 100000);
  assert.equal('note_1000' in r.counts, false);
});

for (const [name, response] of [
  ['refusal', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null }, content: [] }],
  ['truncated output', { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"counts": [' }] }],
  ['unparseable output', { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }],
]) {
  test(`${name} → failed analysis with zero counts (employee counts by hand)`, async () => {
    const r = await counterWith(fakeClient(() => response)).analyze(images);
    assert.equal(r.status, 'failed');
    assert.ok(Object.values(r.counts).every((n) => n === 0));
    assert.match(r.issues[0], /يدويًا/);
  });
}

test('API errors become a failed analysis rather than an exception', async () => {
  const client = fakeClient(() => { throw new Anthropic.APIConnectionError({ message: 'down' }); });
  const r = await counterWith(client).analyze(images);
  assert.equal(r.status, 'failed');
  assert.match(r.issues[0], /تعذّر الاتصال/);
});

test('jpeg inspection: dimensions, completeness and camera EXIF', () => {
  assert.deepEqual(
    { ...inspectJpeg(liveFrameJpeg(1280, 720)), reason: undefined },
    { valid: true, width: 1280, height: 720, cameraExifTags: [], reason: undefined },
  );
  assert.deepEqual(inspectJpeg(galleryPhotoJpeg()).cameraExifTags, ['Make']);
  assert.equal(inspectJpeg(liveFrameJpeg().subarray(0, 60)).valid, false);
  assert.equal(inspectJpeg(Buffer.from('hello')).reason, 'not_jpeg');
});
