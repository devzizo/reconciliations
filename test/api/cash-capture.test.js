import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestServer, USERS } from '../helpers/server.js';
import { liveFrameJpeg, galleryPhotoJpeg, MINIMAL_PDF } from '../helpers/jpeg.js';

const fakeCounter = {
  provider: 'test-ai',
  calls: 0,
  async analyze(images) {
    this.calls += 1;
    this.lastImageCount = images.length;
    return { status: 'completed', model: 'test-model', counts: { note_100: 3, note_50: 1, coin_1: 2 }, issues: ['two notes overlap'] };
  },
};

let srv;
let emp;
let other;
let mgr;

before(async () => {
  srv = await startTestServer({ cashCounter: fakeCounter });
  emp = await srv.login(...USERS.tabuk);
  other = await srv.login(...USERS.najran);
  mgr = await srv.login(...USERS.manager);
});
after(() => srv.close());

let dateSeq = 1;
async function newReconciliation(token = emp) {
  const d = `2026-11-${String(dateSeq++).padStart(2, '0')}`;
  const r = await srv.call('POST', '/api/reconciliations', { token, json: { businessDate: d } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.reconciliation;
}

async function startSession(recId, token = emp) {
  const r = await srv.call('POST', `/api/reconciliations/${recId}/cash-count/sessions`, {
    token, json: { camera: { facingMode: 'environment', width: 1920, height: 1080, label: 'Back Camera' } },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

function uploadFrame(session, { token = emp, captureToken = session.captureToken, body = liveFrameJpeg(), contentType = 'image/jpeg', meta = { videoWidth: 1920, videoHeight: 1080, facingMode: 'environment' } } = {}) {
  const headers = { 'Content-Type': contentType };
  if (captureToken) headers['X-Capture-Token'] = captureToken;
  if (meta) headers['X-Capture-Meta'] = JSON.stringify(meta);
  return srv.call('POST', `/api/cash-capture/sessions/${session.sessionId}/images`, { token, body, headers });
}

describe('capture sessions', () => {
  test('issues a short-lived, server-signed session bound to employee, branch and reconciliation', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    assert.equal(s.reconciliationId, rec.id);
    assert.equal(s.branchId, 'tabuk');
    assert.equal(s.employeeId, 'u-emp-tabuk');
    assert.match(s.captureToken, /^[A-Za-z0-9_-]{40,}$/);
    const ttl = Date.parse(s.expiresAt) - Date.parse(s.issuedAt);
    assert.equal(ttl, srv.config.captureSessionTtlSeconds * 1000);
    // Only the hash is stored.
    const row = (await srv.db.get('SELECT token_hash FROM capture_sessions WHERE id = ?', s.sessionId));
    assert.notEqual(row.token_hash, s.captureToken);
  });

  test('managers cannot start a cash capture; employees of another branch cannot see the reconciliation', async () => {
    const rec = await newReconciliation();
    assert.equal((await srv.call('POST', `/api/reconciliations/${rec.id}/cash-count/sessions`, { token: mgr, json: {} })).status, 403);
    assert.equal((await srv.call('POST', `/api/reconciliations/${rec.id}/cash-count/sessions`, { token: other, json: {} })).status, 404);
  });

  test('starting a new session supersedes the previous open one', async () => {
    const rec = await newReconciliation();
    const s1 = await startSession(rec.id);
    await startSession(rec.id);
    const r = await uploadFrame(s1);
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'CAPTURE_SESSION_CLOSED');
  });

  test('native attested channel is refused when no verifier is configured', async () => {
    const rec = await newReconciliation();
    const r = await srv.call('POST', `/api/reconciliations/${rec.id}/cash-count/sessions`, { token: emp, json: { channel: 'native_attested' } });
    assert.equal(r.status, 501);
  });
});

describe('live capture upload', () => {
  test('accepts a live frame and records server timestamp, ids and hash', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    const before = Date.now();
    const r = await uploadFrame(s);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.imageId, /^[0-9a-f-]{36}$/);
    assert.equal(r.data.sessionId, s.sessionId);
    assert.equal(r.data.reconciliationId, rec.id);
    assert.equal(r.data.branchId, 'tabuk');
    assert.equal(r.data.employeeId, 'u-emp-tabuk');
    assert.ok(Date.parse(r.data.capturedAt) >= before - 1000);
    assert.deepEqual(r.data.flags, []);
    const row = (await srv.db.get('SELECT * FROM cash_images WHERE id = ?', r.data.imageId));
    // Stored in the database file store, never under the public web root.
    assert.equal(row.storage_path, `cash-images/${r.data.imageId}.jpg`);
    assert.equal((await srv.db.get('SELECT COUNT(*) AS n FROM file_chunks WHERE file_key = ?', row.storage_path)).n, 1);
  });

  test('ignores any client-supplied timestamp', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    const r = await srv.call('POST', `/api/cash-capture/sessions/${s.sessionId}/images`, {
      token: emp, body: liveFrameJpeg(), headers: { 'Content-Type': 'image/jpeg', 'X-Capture-Token': s.captureToken, 'X-Captured-At': '2020-01-01T00:00:00Z', Date: 'Wed, 01 Jan 2020 00:00:00 GMT' },
    });
    assert.equal(r.status, 201);
    assert.ok(Date.parse(r.data.capturedAt) > Date.parse('2026-01-01'));
  });

  test('rejects multipart / ordinary file upload to the capture endpoint (415)', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    const fd = new FormData();
    fd.append('file', new Blob([liveFrameJpeg()], { type: 'image/jpeg' }), 'cash.jpg');
    const res = await fetch(`${srv.base}/api/cash-capture/sessions/${s.sessionId}/images`, {
      method: 'POST', body: fd, headers: { Authorization: `Bearer ${emp}`, 'X-Capture-Token': s.captureToken },
    });
    assert.equal(res.status, 415);
    assert.equal((await res.json()).error.code, 'CAMERA_CAPTURE_ONLY');
  });

  test('rejects JSON/base64 and PNG bodies', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    assert.equal((await uploadFrame(s, { contentType: 'application/json', body: JSON.stringify({ image: 'AAAA' }) })).status, 415);
    assert.equal((await uploadFrame(s, { contentType: 'image/png' })).status, 415);
  });

  test('rejects a gallery photo carrying camera EXIF', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    const r = await uploadFrame(s, { body: galleryPhotoJpeg() });
    assert.equal(r.status, 422);
    assert.equal(r.data.error.code, 'NOT_A_LIVE_CAPTURE');
    const audit = (await srv.db.get("SELECT * FROM audit_log WHERE action = 'cash_capture.gallery_upload_rejected' AND entity_id = ?", s.sessionId));
    assert.ok(audit);
    assert.deepEqual(JSON.parse(audit.details_json).tags, ['Make']);
  });

  test('rejects non-JPEG bytes and tiny images', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    assert.equal((await uploadFrame(s, { body: MINIMAL_PDF })).data.error.code, 'INVALID_IMAGE');
    assert.equal((await uploadFrame(s, { body: liveFrameJpeg(320, 240) })).data.error.code, 'IMAGE_TOO_SMALL');
  });

  test('requires the capture token', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    assert.equal((await uploadFrame(s, { captureToken: null })).status, 401);
    assert.equal((await uploadFrame(s, { captureToken: 'x'.repeat(43) })).status, 401);
  });

  test('requires an authenticated employee', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    assert.equal((await uploadFrame(s, { token: null })).status, 401);
    assert.equal((await uploadFrame(s, { token: mgr })).status, 403);
  });

  test('another employee cannot use a leaked session token', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    const r = await uploadFrame(s, { token: other });
    assert.equal(r.status, 403);
    assert.equal(r.data.error.code, 'CAPTURE_SESSION_NOT_YOURS');
  });

  test('expired sessions are refused', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    await srv.db.run('UPDATE capture_sessions SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), s.sessionId);
    const r = await uploadFrame(s);
    assert.equal(r.status, 410);
    assert.equal(r.data.error.code, 'CAPTURE_SESSION_EXPIRED');
  });

  test('flags frames whose size does not match the reported video track', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    const r = await uploadFrame(s, { body: liveFrameJpeg(1280, 720) });
    assert.equal(r.status, 201);
    assert.deepEqual(r.data.flags, ['dimensions_differ_from_video_track']);
    const rotated = await uploadFrame(s, { body: liveFrameJpeg(1080, 1920) });
    assert.deepEqual(rotated.data.flags, []);
  });

  test('enforces the per-session photograph limit', async () => {
    const small = await startTestServer({ cashCounter: fakeCounter, captureMaxImages: 2 });
    try {
      const t = await small.login(...USERS.tabuk);
      const rec = (await small.call('POST', '/api/reconciliations', { token: t, json: { businessDate: '2026-11-19' } })).data.reconciliation;
      const s = (await small.call('POST', `/api/reconciliations/${rec.id}/cash-count/sessions`, { token: t, json: {} })).data;
      const up = () => small.call('POST', `/api/cash-capture/sessions/${s.sessionId}/images`, { token: t, body: liveFrameJpeg(), headers: { 'Content-Type': 'image/jpeg', 'X-Capture-Token': s.captureToken } });
      assert.equal((await up()).status, 201);
      assert.equal((await up()).status, 201);
      assert.equal((await up()).data.error.code, 'CAPTURE_LIMIT_REACHED');
    } finally {
      await small.close();
    }
  });
});

describe('ordinary upload endpoints refuse cash photographs', () => {
  for (const type of ['cash_count', 'cash_photo', 'stage4']) {
    test(`documents?type=${type} → 403`, async () => {
      const rec = await newReconciliation();
      const fd = new FormData();
      fd.append('file', new Blob([liveFrameJpeg()], { type: 'image/jpeg' }), 'cash.jpg');
      const res = await fetch(`${srv.base}/api/reconciliations/${rec.id}/documents?type=${type}`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${emp}` } });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error.code, 'CASH_PHOTOS_CAMERA_ONLY');
      assert.equal((await srv.db.get('SELECT COUNT(*) AS n FROM documents WHERE reconciliation_id = ?', rec.id)).n, 0);
    });
  }

  test('a cash photo uploaded as another document type does not complete Stage 4', async () => {
    const rec = await newReconciliation();
    const fd = new FormData();
    fd.append('file', new Blob([liveFrameJpeg()], { type: 'image/jpeg' }), 'cash.jpg');
    const res = await fetch(`${srv.base}/api/reconciliations/${rec.id}/documents?type=z_report`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${emp}` } });
    assert.equal(res.status, 201);
    const d = await srv.call('GET', `/api/reconciliations/${rec.id}`, { token: emp });
    assert.equal(d.data.stages.cash_count.complete, false);
  });

  test('stages 1-3 still accept PDF and image uploads', async () => {
    const rec = await newReconciliation();
    for (const [type, blob, name] of [
      ['daily_closing_form', new Blob([MINIMAL_PDF], { type: 'application/pdf' }), 'form.pdf'],
      ['z_report', new Blob([galleryPhotoJpeg()], { type: 'image/jpeg' }), 'z.jpg'],
      ['bank_settlement', new Blob([MINIMAL_PDF], { type: 'application/pdf' }), 'receipt.pdf'],
    ]) {
      const fd = new FormData();
      fd.append('file', blob, name);
      const res = await fetch(`${srv.base}/api/reconciliations/${rec.id}/documents?type=${type}`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${emp}` } });
      assert.equal(res.status, 201, `${type}: ${await res.text()}`);
    }
  });
});

describe('retake, AI analysis and human confirmation', () => {
  test('full flow: capture → retake → finalize → review → confirm', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    const a = (await uploadFrame(s, { body: liveFrameJpeg(1920, 1080, 1) })).data;
    const b = (await uploadFrame(s, { body: liveFrameJpeg(1920, 1080, 2) })).data;

    const del = await srv.call('DELETE', `/api/cash-capture/sessions/${s.sessionId}/images/${a.imageId}`, { token: emp, headers: { 'X-Capture-Token': s.captureToken } });
    assert.equal(del.status, 200);
    assert.deepEqual(del.data.images.map((i) => i.imageId), [b.imageId]);
    const c = (await uploadFrame(s, { body: liveFrameJpeg(1920, 1080, 3) })).data;
    assert.equal(c.seq, 3);

    const fin = await srv.call('POST', `/api/cash-capture/sessions/${s.sessionId}/finalize`, { token: emp, headers: { 'X-Capture-Token': s.captureToken } });
    assert.equal(fin.status, 200, JSON.stringify(fin.data));
    assert.equal(fakeCounter.lastImageCount, 2);
    const an = fin.data.analysis;
    assert.deepEqual(an.imageIds, [b.imageId, c.imageId]);
    assert.equal(an.counts.note_100, 3);
    assert.equal(an.totalHalalas, 30000 + 5000 + 200);
    assert.ok(fin.data.denominations.length > 0);

    // No more photographs once finalized.
    assert.equal((await uploadFrame(s)).status, 409);

    // Human confirmation is mandatory.
    const noConfirm = await srv.call('POST', `/api/reconciliations/${rec.id}/cash-count/confirm`, { token: emp, json: { analysisId: an.analysisId, counts: an.counts } });
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.data.error.code, 'CONFIRMATION_REQUIRED');

    const corrected = { ...an.counts, note_100: 4 };
    const ok = await srv.call('POST', `/api/reconciliations/${rec.id}/cash-count/confirm`, { token: emp, json: { analysisId: an.analysisId, counts: corrected, confirmed: true } });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(ok.data.totalHalalas, 40000 + 5000 + 200);
    assert.deepEqual(ok.data.adjustments, [{ denomination: 'note_100', ai: 3, confirmed: 4 }]);

    const d = await srv.call('GET', `/api/reconciliations/${rec.id}`, { token: emp });
    assert.equal(d.data.stages.cash_count.complete, true);

    // Cannot start another capture after confirmation.
    assert.equal((await srv.call('POST', `/api/reconciliations/${rec.id}/cash-count/sessions`, { token: emp, json: {} })).status, 409);
  });

  test('cannot finalize without photographs', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    const r = await srv.call('POST', `/api/cash-capture/sessions/${s.sessionId}/finalize`, { token: emp, headers: { 'X-Capture-Token': s.captureToken } });
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'NO_PHOTOGRAPHS');
  });

  test('confirm rejects a stale analysis after recapture', async () => {
    const rec = await newReconciliation();
    const finalize = async () => {
      const s = await startSession(rec.id);
      await uploadFrame(s);
      return (await srv.call('POST', `/api/cash-capture/sessions/${s.sessionId}/finalize`, { token: emp, headers: { 'X-Capture-Token': s.captureToken } })).data.analysis;
    };
    const first = await finalize();
    await finalize();
    const r = await srv.call('POST', `/api/reconciliations/${rec.id}/cash-count/confirm`, { token: emp, json: { analysisId: first.analysisId, counts: first.counts, confirmed: true } });
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'ANALYSIS_STALE');
  });

  test('rejects malformed counts', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    await uploadFrame(s);
    const an = (await srv.call('POST', `/api/cash-capture/sessions/${s.sessionId}/finalize`, { token: emp, headers: { 'X-Capture-Token': s.captureToken } })).data.analysis;
    for (const counts of [{ note_100: -1 }, { note_100: 1.5 }, { note_999: 1 }, { note_100: '3' }]) {
      const r = await srv.call('POST', `/api/reconciliations/${rec.id}/cash-count/confirm`, { token: emp, json: { analysisId: an.analysisId, counts, confirmed: true } });
      assert.equal(r.status, 400, JSON.stringify(counts));
    }
  });

  test('without an AI provider the review starts at zero and still requires confirmation', async () => {
    const plain = await startTestServer();
    try {
      const t = await plain.login(...USERS.tabuk);
      const rec = (await plain.call('POST', '/api/reconciliations', { token: t, json: { businessDate: '2026-11-19' } })).data.reconciliation;
      const s = (await plain.call('POST', `/api/reconciliations/${rec.id}/cash-count/sessions`, { token: t, json: {} })).data;
      await plain.call('POST', `/api/cash-capture/sessions/${s.sessionId}/images`, { token: t, body: liveFrameJpeg(), headers: { 'Content-Type': 'image/jpeg', 'X-Capture-Token': s.captureToken } });
      const an = (await plain.call('POST', `/api/cash-capture/sessions/${s.sessionId}/finalize`, { token: t, headers: { 'X-Capture-Token': s.captureToken } })).data.analysis;
      assert.equal(an.status, 'unavailable');
      assert.equal(an.totalHalalas, 0);
    } finally {
      await plain.close();
    }
  });
});

describe('audit trail', () => {
  test('records every step, is hash-chained, and is append-only', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    await uploadFrame(s, { captureToken: 'wrong-token' });
    await uploadFrame(s);
    const r = await srv.call('GET', `/api/reconciliations/${rec.id}/audit`, { token: mgr });
    assert.equal(r.status, 200);
    assert.equal(r.data.chain.ok, true);
    const actions = r.data.entries.map((e) => e.action);
    assert.deepEqual(actions, ['reconciliation.created', 'cash_capture.session_started', 'cash_capture.request_denied', 'cash_capture.image_captured']);
    await assert.rejects(srv.db.run('UPDATE audit_log SET action = ? WHERE seq = 1', 'tampered'), /append-only/);
    await assert.rejects(srv.db.run('DELETE FROM audit_log'), /append-only/);
    assert.equal((await srv.call('GET', `/api/reconciliations/${rec.id}/audit`, { token: emp })).status, 403);
  });

  test('captured images are only visible to their owner and managers, never cached', async () => {
    const rec = await newReconciliation();
    const s = await startSession(rec.id);
    const img = (await uploadFrame(s)).data;
    const own = await fetch(`${srv.base}/api/cash-capture/images/${img.imageId}`, { headers: { Authorization: `Bearer ${emp}` } });
    assert.equal(own.status, 200);
    assert.match(own.headers.get('cache-control'), /no-store/);
    assert.equal((await fetch(`${srv.base}/api/cash-capture/images/${img.imageId}`, { headers: { Authorization: `Bearer ${other}` } })).status, 404);
    assert.equal((await fetch(`${srv.base}/api/cash-capture/images/${img.imageId}`, { headers: { Authorization: `Bearer ${mgr}` } })).status, 200);
  });
});

describe('security headers and HTTPS', () => {
  test('camera permission policy and CSP are sent', async () => {
    const res = await fetch(`${srv.base}/`);
    assert.match(res.headers.get('permissions-policy'), /camera=\(self\)/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  });

  test('REQUIRE_HTTPS refuses plain-HTTP API calls', async () => {
    const strict = await startTestServer({ requireHttps: true });
    try {
      const r = await strict.call('POST', '/api/auth/login', { json: { username: 'x', password: 'y' } });
      assert.equal(r.status, 403);
      assert.equal(r.data.error.code, 'HTTPS_REQUIRED');
    } finally {
      await strict.close();
    }
  });
});

describe('front-end has no gallery path for Stage 4', () => {
  const src = fs.readFileSync(new URL('../../public/cash-camera.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  test('no file input, file reader, or download link', () => {
    assert.doesNotMatch(code, /type:\s*['"]file['"]|type="file"|FileReader|showOpenFilePicker|capture=|download/i);
    assert.doesNotMatch(code, /createObjectURL/);
  });
  test('uses getUserMedia with the rear camera preferred', () => {
    assert.match(code, /getUserMedia\(/);
    assert.match(code, /facingMode:\s*\{\s*ideal:\s*'environment'/);
  });
});
