import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createCashCounter, toResult, normaliseSerial } from '../../src/services/cashCounter.js';
import { liveFrameJpeg } from '../helpers/jpeg.js';

const fakeClient = (respond) => { const calls = []; return { calls, beta: { messages: { create: async (p) => { calls.push(p); return respond(p); } } } }; };
const counter = (client) => createCashCounter({ aiProvider: 'anthropic', aiModel: 'claude-opus-5-5', anthropicClient: client });
const images = [{ id: 'a', bytes: liveFrameJpeg() }, { id: 'b', bytes: liveFrameJpeg() }];

test('asks for every banknote with its serial number, sends all photos', async () => {
  const client = fakeClient(() => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify({ banknotes: [], coins: [], issues: [] }) }] }));
  await counter(client).analyze(images);
  const p = client.calls[0];
  assert.equal(p.messages[0].content.filter((b) => b.type === 'image').length, 2);
  assert.ok(p.output_config.format.schema.properties.banknotes.items.required.includes('serial'));
  assert.match(p.system, /serial number/);
  assert.equal(p.fallbacks, 'default');
});

test('a note seen in two photographs (same serial) is counted once and reported', () => {
  const r = toResult({ banknotes: [
    { photo: 1, denomination: 'note_100', serial: '123456789' },
    { photo: 2, denomination: 'note_100', serial: '123 456 789' }, // same note, second photo
    { photo: 2, denomination: 'note_100', serial: '987654321' },
    { photo: 1, denomination: 'note_50', serial: '١١١٢٢٢٣٣٣' },
  ], coins: [{ denomination: 'coin_1', count: 3 }], issues: [] }, 'm');
  assert.equal(r.counts.note_100, 2);
  assert.equal(r.counts.note_50, 1);
  assert.equal(r.counts.coin_1, 3);
  assert.equal(r.duplicatesRemoved, 1);
  assert.match(r.issues[0], /رقمها التسلسلي 123456789 ظهرت في الصور 1 و 2 وحُسبت مرة واحدة/);
  assert.deepEqual(r.serials.map((s) => s.serial).sort(), ['111222333', '123456789', '987654321']);
});

test('notes without a readable serial are counted but reported', () => {
  const r = toResult({ banknotes: [{ photo: 1, denomination: 'note_10', serial: '' }, { photo: 1, denomination: 'note_10', serial: '??' }], coins: [], issues: [] }, 'm');
  assert.equal(r.counts.note_10, 2);
  assert.equal(r.unreadableSerials, 2);
  assert.match(r.issues[0], /2 ورقة نقدية لم يُقرأ رقمها التسلسلي/);
});

test('serial normalisation', () => {
  assert.equal(normaliseSerial(' ٠١٢-345 ab '), '012345AB');
});

test('refusal / cut-off / bad JSON / API error → failed', async () => {
  for (const respond of [() => ({ stop_reason: 'refusal', content: [] }), () => ({ stop_reason: 'max_tokens', content: [] }),
    () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] }), () => { throw new Anthropic.APIConnectionError({ message: 'down' }); }]) {
    const r = await counter(fakeClient(respond)).analyze(images);
    assert.equal(r.status, 'failed');
    assert.ok(Object.values(r.counts).every((n) => n === 0));
  }
});
