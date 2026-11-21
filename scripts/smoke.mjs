#!/usr/bin/env node
// Smoke test against a running deployment (wrangler dev or the live Worker). Creates no reconciliation
// unless the AI reader is configured AND READ_FORM=1 (then it needs a real form, so normally leave it off).
//   BASE=https://reconciliations.dev-zizo.workers.dev node scripts/smoke.mjs
import assert from 'node:assert/strict';
import { liveFrameJpeg, galleryPhotoJpeg, MINIMAL_PDF } from '../test/helpers/jpeg.js';

const BASE = process.env.BASE ?? 'http://localhost:8787';
let failed = 0;
async function step(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
const j = async (method, url, { json, body, headers = {} } = {}) => {
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(BASE + url, { method, headers, body });
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
};

let s;
await step('home page: Arabic RTL, camera permission policy, no logo', async () => {
  const r = await fetch(`${BASE}/`);
  const html = await r.text();
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.doesNotMatch(html, /HOVEN/i);
  assert.match(r.headers.get('permissions-policy') ?? '', /camera=\(self\)/);
});
await step('latest reconciliations list is public', async () => { const r = await j('GET', '/api/matches'); assert.equal(r.status, 200); assert.ok(Array.isArray(r.data.matches)); });
await step('share link route serves the app', async () => { assert.match(await (await fetch(`${BASE}/m/abc`)).text(), /dir="rtl"/); });
await step('no login endpoint any more', async () => { assert.equal((await j('POST', '/api/auth/login', { json: {} })).status, 404); });
await step('camera session for a new closing form', async () => {
  const r = await j('POST', '/api/camera/sessions', { json: { kind: 'daily_closing_form', camera: { width: 1920, height: 1080 } } });
  assert.equal(r.status, 201, JSON.stringify(r.data)); s = r.data;
});
await step('other documents need a reconciliation first', async () => { assert.equal((await j('POST', '/api/camera/sessions', { json: { kind: 'z_report' } })).data.error.code, 'MATCH_REQUIRED'); });
await step('PDF / file upload refused (415)', async () => {
  const fd = new FormData(); fd.append('file', new Blob([MINIMAL_PDF], { type: 'application/pdf' }), 'f.pdf');
  const r = await fetch(`${BASE}/api/camera/sessions/${s.sessionId}/captures`, { method: 'POST', body: fd, headers: { 'X-Capture-Token': s.captureToken } });
  assert.equal(r.status, 415);
});
await step('gallery photo with camera EXIF refused (422)', async () => {
  const r = await j('POST', `/api/camera/sessions/${s.sessionId}/captures`, { body: galleryPhotoJpeg(), headers: { 'Content-Type': 'image/jpeg', 'X-Capture-Token': s.captureToken } });
  assert.equal(r.data.error.code, 'NOT_A_LIVE_CAPTURE');
});
await step('live frame accepted', async () => {
  const r = await j('POST', `/api/camera/sessions/${s.sessionId}/captures`, { body: liveFrameJpeg(), headers: { 'Content-Type': 'image/jpeg', 'X-Capture-Token': s.captureToken } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
});
await step('a test frame is not a readable form → asked to photograph again (nothing created)', async () => {
  const r = await j('POST', `/api/camera/sessions/${s.sessionId}/finalize`, { headers: { 'X-Capture-Token': s.captureToken } });
  assert.equal(r.status, 422, JSON.stringify(r.data));
  console.log(`     → ${r.data.error.message}`);
});
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
