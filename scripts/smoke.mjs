#!/usr/bin/env node
// End-to-end smoke test against a running deployment (e.g. wrangler dev or the live Worker).
//   BASE=https://... EMP_USER=.. EMP_PASS=.. OTHER_USER=.. OTHER_PASS=.. MGR_USER=.. MGR_PASS=.. node scripts/smoke.mjs
// Creates a reconciliation dated SMOKE_DATE (default 2000-01-01) on the employee's branch.
import assert from 'node:assert/strict';
import { liveFrameJpeg, galleryPhotoJpeg, MINIMAL_PDF } from '../test/helpers/jpeg.js';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['ok', name]); console.log(`ok   ${name}`); } catch (e) { results.push(['FAIL', name]); console.log(`FAIL ${name}\n     ${e.message}`); }
}
async function call(method, url, { token, json, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(BASE + url, { method, headers: h, body, redirect: 'manual' });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const login = async (u, p) => { const r = await call('POST', '/api/auth/login', { json: { username: u, password: p } }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.token; };

let emp, other, mgr, rec, s, img1, analysis;
await step('static page served with camera permission policy', async () => {
  const r = await fetch(BASE + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Branch Reconciliation/);
  assert.match(r.headers.get('permissions-policy') ?? '', /camera=\(self\)/);
});
await step('login (employee, other branch, manager)', async () => {
  emp = await login(process.env.EMP_USER, process.env.EMP_PASS);
  other = await login(process.env.OTHER_USER, process.env.OTHER_PASS);
  mgr = await login(process.env.MGR_USER, process.env.MGR_PASS);
});
await step('wrong password rejected', async () => { assert.equal((await call('POST', '/api/auth/login', { json: { username: process.env.EMP_USER, password: 'nope' } })).status, 401); });
await step('open reconciliation', async () => {
  const r = await call('POST', '/api/reconciliations', { token: emp, json: { businessDate: process.env.SMOKE_DATE ?? '2000-01-01' } });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
  rec = r.data.reconciliation;
});
await step('stage 1 PDF upload accepted', async () => {
  const fd = new FormData(); fd.append('file', new Blob([MINIMAL_PDF], { type: 'application/pdf' }), 'form.pdf');
  const r = await call('POST', `/api/reconciliations/${rec.id}/documents?type=daily_closing_form`, { token: emp, body: fd });
  assert.equal(r.status, 201, JSON.stringify(r.data));
});
await step('cash photo via ordinary upload → 403', async () => {
  const fd = new FormData(); fd.append('file', new Blob([liveFrameJpeg()], { type: 'image/jpeg' }), 'cash.jpg');
  const r = await call('POST', `/api/reconciliations/${rec.id}/documents?type=cash_count`, { token: emp, body: fd });
  assert.equal(r.status, 403); assert.equal(r.data.error.code, 'CASH_PHOTOS_CAMERA_ONLY');
});
await step('capture session issued', async () => {
  const r = await call('POST', `/api/reconciliations/${rec.id}/cash-count/sessions`, { token: emp, json: { camera: { facingMode: 'environment', width: 1920, height: 1080 } } });
  assert.equal(r.status, 201, JSON.stringify(r.data)); s = r.data;
});
const up = (body, extra = {}) => call('POST', `/api/cash-capture/sessions/${s.sessionId}/images`, { token: extra.token ?? emp, body, headers: { 'Content-Type': extra.type ?? 'image/jpeg', 'X-Capture-Token': extra.captureToken ?? s.captureToken, 'X-Capture-Meta': JSON.stringify({ videoWidth: 1920, videoHeight: 1080 }) } });
await step('multipart to capture endpoint → 415', async () => {
  const fd = new FormData(); fd.append('file', new Blob([liveFrameJpeg()], { type: 'image/jpeg' }), 'c.jpg');
  const r = await call('POST', `/api/cash-capture/sessions/${s.sessionId}/images`, { token: emp, body: fd, headers: { 'X-Capture-Token': s.captureToken } });
  assert.equal(r.status, 415);
});
await step('gallery photo with camera EXIF → 422', async () => { assert.equal((await up(galleryPhotoJpeg())).data.error?.code, 'NOT_A_LIVE_CAPTURE'); });
await step('bad capture token → 401', async () => { assert.equal((await up(liveFrameJpeg(), { captureToken: 'x'.repeat(43) })).status, 401); });
await step('other employee with leaked token → 403', async () => { assert.equal((await up(liveFrameJpeg(), { token: other })).status, 403); });
await step('live frame accepted (1.6 MB, multi-chunk)', async () => {
  const big = Buffer.concat([liveFrameJpeg(1920, 1080, 9).subarray(0, -2), Buffer.alloc(1_600_000, 5), Buffer.from([0xff, 0xd9])]);
  const r = await up(big); assert.equal(r.status, 201, JSON.stringify(r.data)); img1 = r.data;
  const back = await fetch(`${BASE}/api/cash-capture/images/${img1.imageId}`, { headers: { Authorization: `Bearer ${emp}` } });
  assert.equal(Buffer.from(await back.arrayBuffer()).length, big.length);
});
await step('retake + second frame', async () => {
  const r2 = await up(liveFrameJpeg(1920, 1080, 2)); assert.equal(r2.status, 201);
  const d = await call('DELETE', `/api/cash-capture/sessions/${s.sessionId}/images/${img1.imageId}`, { token: emp, headers: { 'X-Capture-Token': s.captureToken } });
  assert.equal(d.status, 200); assert.equal(d.data.images.length, 1);
});
await step('finalize → analysis for review', async () => {
  const r = await call('POST', `/api/cash-capture/sessions/${s.sessionId}/finalize`, { token: emp, headers: { 'X-Capture-Token': s.captureToken } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); analysis = r.data.analysis;
});
await step('confirm requires explicit confirmation', async () => {
  assert.equal((await call('POST', `/api/reconciliations/${rec.id}/cash-count/confirm`, { token: emp, json: { analysisId: analysis.analysisId, counts: {} } })).status, 400);
});
await step('confirm count', async () => {
  const r = await call('POST', `/api/reconciliations/${rec.id}/cash-count/confirm`, { token: emp, json: { analysisId: analysis.analysisId, counts: { note_100: 3, note_5: 1 }, confirmed: true } });
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.total, '305.00');
});
await step('audit trail hash chain verifies (manager)', async () => {
  const r = await call('GET', `/api/reconciliations/${rec.id}/audit`, { token: mgr });
  assert.equal(r.status, 200); assert.equal(r.data.chain.ok, true);
  assert.ok(r.data.entries.some((e) => e.action === 'cash_count.confirmed'));
  assert.ok(r.data.entries.every((e) => e.ip !== null && e.ip !== ''), 'client IP recorded');
});
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
