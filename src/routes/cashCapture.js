import crypto from 'node:crypto';
import express from 'express';
import { randomToken, requireRole, sha256Hex, tokenMatches } from '../auth.js';
import { loadReconciliation } from '../access.js';
import { HttpError } from '../errors.js';
import { inspectJpeg } from '../services/jpegInspect.js';
import { DENOMINATIONS, DENOMINATION_IDS, formatSar, normaliseCounts, totalHalalas } from '../services/denominations.js';

/**
 * Stage 4 — Physical Cash Count. Camera-only.
 *
 * Flow:
 *   1. POST /reconciliations/:id/cash-count/sessions      → short-lived capture session + secret capture token
 *   2. POST /cash-capture/sessions/:sid/images             → raw image/jpeg frame grabbed from the live <video>
 *      DELETE /cash-capture/sessions/:sid/images/:imageId  → retake (soft-delete, kept for audit)
 *   3. POST /cash-capture/sessions/:sid/finalize           → closes the session, runs AI denomination count
 *   4. POST /reconciliations/:id/cash-count/confirm        → employee reviews and confirms counts (required)
 *
 * There is deliberately no multipart / file-upload route for cash photographs anywhere in the API.
 */
export function cashCaptureRoutes({ db, audit, config, cashCounter, attestationVerifier, files }) {
  const r = express.Router();

  const q = {
    session: (id) => db.get('SELECT * FROM capture_sessions WHERE id = ?', id),
    reconciliation: (id) => db.get('SELECT * FROM reconciliations WHERE id = ?', id),
    openSessionsFor: (recId, userId) => db.all("SELECT id FROM capture_sessions WHERE reconciliation_id = ? AND user_id = ? AND status = 'open'", recId, userId),
    activeImages: (sid) => db.all("SELECT * FROM cash_images WHERE session_id = ? AND status = 'active' ORDER BY seq", sid),
    imageCount: async (sid) => (await db.get('SELECT COUNT(*) AS n FROM cash_images WHERE session_id = ?', sid)).n,
    image: (id) => db.get('SELECT * FROM cash_images WHERE id = ?', id),
    analysis: (id) => db.get('SELECT * FROM cash_analyses WHERE id = ?', id),
    latestAnalysis: (recId) => db.get('SELECT * FROM cash_analyses WHERE reconciliation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', recId),
    cashCount: (recId) => db.get('SELECT * FROM cash_counts WHERE reconciliation_id = ?', recId),
  };

  // ---------------------------------------------------------------- helpers

  async function assertStageOpen(rec) {
    if (await q.cashCount(rec.id)) {
      throw new HttpError(409, 'CASH_COUNT_ALREADY_CONFIRMED', 'تم تأكيد عدّ النقد لهذا اليوم مسبقًا.');
    }
  }

  /**
   * Validate that the caller may use this capture session: correct secret token, same employee,
   * same branch, reconciliation still open, session open and unexpired. Every failure is audited.
   */
  async function authoriseSession(req, { requireOpen = true } = {}) {
    const session = await q.session(req.params.sid);
    if (!session) throw new HttpError(404, 'CAPTURE_SESSION_NOT_FOUND', 'جلسة التصوير غير موجودة.');

    const deny = async (status, code, message, reason) => {
      await audit.record({ req, action: 'cash_capture.request_denied', reconciliationId: session.reconciliation_id, entityType: 'capture_session', entityId: session.id, details: { reason } });
      return new HttpError(status, code, message);
    };

    if (!tokenMatches(req.get('x-capture-token'), session.token_hash)) {
      throw await deny(401, 'INVALID_CAPTURE_TOKEN', 'رمز جلسة التصوير مفقود أو غير صالح.', 'bad_token');
    }
    if (session.user_id !== req.user.id) {
      throw await deny(403, 'CAPTURE_SESSION_NOT_YOURS', 'جلسة التصوير هذه تخص موظفًا آخر.', 'wrong_user');
    }
    if (session.branch_id !== req.user.branchId) {
      throw await deny(403, 'CAPTURE_SESSION_WRONG_BRANCH', 'جلسة التصوير هذه تخص فرعًا آخر.', 'wrong_branch');
    }
    const rec = await q.reconciliation(session.reconciliation_id);
    if (!rec || rec.branch_id !== session.branch_id) {
      throw await deny(403, 'CAPTURE_SESSION_MISMATCH', 'جلسة التصوير لا تطابق التسوية.', 'reconciliation_mismatch');
    }
    if (rec.status !== 'open') throw new HttpError(409, 'RECONCILIATION_CLOSED', 'تم إرسال تسوية هذا اليوم مسبقًا ولا يمكن تعديلها.');
    if (requireOpen) {
      if (session.status !== 'open') throw new HttpError(409, 'CAPTURE_SESSION_CLOSED', 'جلسة التصوير مغلقة. ابدأ تصويرًا جديدًا.');
      if (Date.parse(session.expires_at) <= Date.now()) {
        throw await deny(410, 'CAPTURE_SESSION_EXPIRED', 'انتهت مهلة جلسة التصوير. ابدأ تصويرًا جديدًا.', 'expired');
      }
    }
    await assertStageOpen(rec);
    return { session, rec };
  }

  function imageView(img) {
    return { imageId: img.id, seq: img.seq, capturedAt: img.captured_at, sha256: img.sha256, width: img.width, height: img.height, flags: JSON.parse(img.flags_json), status: img.status };
  }

  function analysisView(a) {
    return {
      analysisId: a.id, sessionId: a.session_id, provider: a.provider, model: a.model, status: a.status,
      counts: JSON.parse(a.counts_json), totalHalalas: a.total_halalas, total: formatSar(a.total_halalas), issues: JSON.parse(a.issues_json),
      imageIds: JSON.parse(a.image_ids_json), createdAt: a.created_at,
    };
  }

  function parseClientMeta(req) {
    // Client-reported camera details are recorded for the audit trail only; they are never trusted for authorisation.
    const raw = req.get('x-capture-meta');
    if (!raw || raw.length > 2000) return null;
    try {
      const m = JSON.parse(raw);
      return {
        videoWidth: Number.isInteger(m.videoWidth) ? m.videoWidth : null,
        videoHeight: Number.isInteger(m.videoHeight) ? m.videoHeight : null,
        facingMode: typeof m.facingMode === 'string' ? m.facingMode.slice(0, 20) : null,
        trackLabel: typeof m.trackLabel === 'string' ? m.trackLabel.slice(0, 120) : null,
      };
    } catch {
      return null;
    }
  }

  /** Shared by the browser and native-attested channels. `body` is the raw JPEG. */
  async function storeCapture(req, { session, rec }, body, { attestation = null } = {}) {
    if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'EMPTY_IMAGE', 'لم تصل أي صورة.');
    if ((await q.activeImages(session.id)).length >= session.max_images) {
      throw new HttpError(409, 'CAPTURE_LIMIT_REACHED', `الحد الأقصى ${session.max_images} صور في كل تصوير. أعد التقاط صورة بدلًا من ذلك.`);
    }

    const info = inspectJpeg(body);
    if (!info.valid) throw new HttpError(422, 'INVALID_IMAGE', `الصورة غير مكتملة أو تالفة (${info.reason}).`);
    if (info.cameraExifTags.length) {
      await audit.record({ req, action: 'cash_capture.gallery_upload_rejected', reconciliationId: rec.id, entityType: 'capture_session', entityId: session.id,
        details: { via: 'capture_session', reason: 'camera_exif_present', tags: info.cameraExifTags } });
      throw new HttpError(422, 'NOT_A_LIVE_CAPTURE', 'هذه الصورة لم تُلتقط من الكاميرا المباشرة. استخدم الكاميرا داخل التطبيق.');
    }
    if (Math.min(info.width, info.height) < config.captureMinShortSide) {
      throw new HttpError(422, 'IMAGE_TOO_SMALL', `دقة الصورة منخفضة (${info.width}×${info.height}). اقترب أكثر أو استخدم كاميرا أفضل.`);
    }

    const meta = parseClientMeta(req);
    const flags = [];
    if (meta?.videoWidth && meta?.videoHeight) {
      const same = meta.videoWidth === info.width && meta.videoHeight === info.height;
      const rotated = meta.videoWidth === info.height && meta.videoHeight === info.width;
      if (!same && !rotated) flags.push('dimensions_differ_from_video_track');
    } else {
      flags.push('no_client_camera_metadata');
    }

    const id = crypto.randomUUID();
    const capturedAt = new Date().toISOString();
    const sha256 = sha256Hex(body);
    const seq = (await q.imageCount(session.id)) + 1;
    const key = `cash-images/${id}.jpg`;
    await files.put(key, body);
    await db.run(`INSERT INTO cash_images
      (id, session_id, reconciliation_id, branch_id, user_id, seq, captured_at, sha256, size_bytes, width, height, storage_path, flags_json, attestation_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, session.id, rec.id, session.branch_id, session.user_id, seq, capturedAt, sha256, body.length,
    info.width, info.height, key, JSON.stringify(flags), attestation ? JSON.stringify(attestation) : null);
    await audit.record({ req, action: 'cash_capture.image_captured', reconciliationId: rec.id, entityType: 'cash_image', entityId: id,
      details: { sessionId: session.id, seq, sha256, sizeBytes: body.length, width: info.width, height: info.height, flags, clientMeta: meta, channel: session.channel, attested: Boolean(attestation) } });
    return imageView(await q.image(id));
  }

  // Any request to the capture endpoints that is not a raw JPEG body (multipart forms, base64 JSON, etc.)
  // is refused outright. That is the "ordinary upload" shape and employees have no permission for it.
  async function requireRawJpeg(req, _res, next) {
    const type = (req.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'image/jpeg') {
      await audit.record({ req, action: 'cash_capture.gallery_upload_rejected', details: { via: 'capture_session', reason: 'wrong_content_type', contentType: type.slice(0, 80), sessionId: req.params.sid } });
      throw new HttpError(415, 'CAMERA_CAPTURE_ONLY', 'صور النقد يجب أن تُلتقط بالكاميرا المباشرة. رفع الملفات غير مسموح.');
    }
    next();
  }
  const rawJpeg = express.raw({ type: 'image/jpeg', limit: config.captureMaxBytes });

  // ---------------------------------------------------------------- routes

  r.get('/reconciliations/:id/cash-count', async (req, res) => {
    const rec = await loadReconciliation(db, req.params.id, req.user);
    const confirmed = await q.cashCount(rec.id);
    const latest = await q.latestAnalysis(rec.id);
    res.json({
      denominations: DENOMINATIONS,
      confirmed: confirmed ? { totalHalalas: confirmed.total_halalas, total: formatSar(confirmed.total_halalas), confirmedAt: confirmed.confirmed_at, counts: JSON.parse(confirmed.counts_json) } : null,
      latestAnalysis: latest ? analysisView(latest) : null,
    });
  });

  r.post('/reconciliations/:id/cash-count/sessions', requireRole('employee'), express.json({ limit: '4kb' }), async (req, res) => {
    const rec = await loadReconciliation(db, req.params.id, req.user, { write: true });
    await assertStageOpen(rec);
    const channel = req.body?.channel === 'native_attested' ? 'native_attested' : 'browser';
    if (channel === 'native_attested' && !attestationVerifier) {
      throw new HttpError(501, 'ATTESTATION_NOT_CONFIGURED', 'التصوير عبر التطبيق الموثّق غير مفعّل على الخادم.');
    }
    const cam = req.body?.camera ?? {};
    const cameraInfo = {
      facingMode: typeof cam.facingMode === 'string' ? cam.facingMode.slice(0, 20) : null,
      width: Number.isInteger(cam.width) ? cam.width : null,
      height: Number.isInteger(cam.height) ? cam.height : null,
      label: typeof cam.label === 'string' ? cam.label.slice(0, 120) : null,
    };

    const now = new Date();
    // Only one open capture session per employee per reconciliation.
    for (const s of await q.openSessionsFor(rec.id, req.user.id)) {
      await db.run("UPDATE capture_sessions SET status = 'superseded', finalized_at = ? WHERE id = ?", now.toISOString(), s.id);
      await audit.record({ req, action: 'cash_capture.session_superseded', reconciliationId: rec.id, entityType: 'capture_session', entityId: s.id });
    }
    const id = crypto.randomUUID();
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + config.captureSessionTtlSeconds * 1000).toISOString();
    await db.run(`INSERT INTO capture_sessions
      (id, reconciliation_id, branch_id, user_id, token_hash, status, channel, max_images, camera_info_json, client_ip, user_agent, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
    id, rec.id, rec.branch_id, req.user.id, sha256Hex(token), channel, config.captureMaxImages,
    JSON.stringify(cameraInfo), req.ip ?? null, req.get('user-agent') ?? null, now.toISOString(), expiresAt);
    await audit.record({ req, action: 'cash_capture.session_started', reconciliationId: rec.id, entityType: 'capture_session', entityId: id, details: { channel, expiresAt, camera: cameraInfo } });

    res.set('Cache-Control', 'no-store');
    res.status(201).json({
      sessionId: id,
      captureToken: token, // shown once; only its hash is stored
      reconciliationId: rec.id,
      branchId: rec.branch_id,
      employeeId: req.user.id,
      channel,
      issuedAt: now.toISOString(),
      expiresAt,
      maxImages: config.captureMaxImages,
      maxBytes: config.captureMaxBytes,
    });
  });

  r.post('/cash-capture/sessions/:sid/images', requireRole('employee'), requireRawJpeg, rawJpeg, async (req, res) => {
    const ctx = await authoriseSession(req);
    if (ctx.session.channel !== 'browser') throw new HttpError(409, 'WRONG_CHANNEL', 'هذه الجلسة تتطلب التصوير الموثّق.');
    const image = await storeCapture(req, ctx, req.body);
    res.status(201).json({ ...image, sessionId: ctx.session.id, reconciliationId: ctx.rec.id, branchId: ctx.session.branch_id, employeeId: ctx.session.user_id });
  });

  // Optional native-app channel. Returns 501 unless an attestation verifier is configured.
  r.post('/cash-capture/sessions/:sid/attested-images', requireRole('employee'), requireRawJpeg, rawJpeg, async (req, res) => {
    if (!attestationVerifier) throw new HttpError(501, 'ATTESTATION_NOT_CONFIGURED', 'التصوير عبر التطبيق الموثّق غير مفعّل على الخادم.');
    const ctx = await authoriseSession(req);
    if (ctx.session.channel !== 'native_attested') throw new HttpError(409, 'WRONG_CHANNEL', 'هذه الجلسة ليست جلسة تصوير موثّق.');
    const imageSha256 = sha256Hex(req.body ?? Buffer.alloc(0));
    const result = await attestationVerifier.verify({
      attestation: req.get('x-device-attestation') ?? '',
      // The client knows the capture token; the challenge binds the attestation to this session, slot and image.
      challenge: `${ctx.session.token_hash}:${(await q.imageCount(ctx.session.id)) + 1}:${imageSha256}`,
      imageSha256, sessionId: ctx.session.id, userId: req.user.id,
    });
    if (!result?.ok) {
      await audit.record({ req, action: 'cash_capture.attestation_failed', reconciliationId: ctx.rec.id, entityType: 'capture_session', entityId: ctx.session.id, details: { reason: result?.reason ?? 'unknown', verifier: attestationVerifier.name } });
      throw new HttpError(403, 'ATTESTATION_FAILED', 'فشل التحقق من الجهاز.');
    }
    const image = await storeCapture(req, ctx, req.body, { attestation: { verifier: attestationVerifier.name, deviceId: result.deviceId, platform: result.platform, details: result.details ?? null } });
    res.status(201).json({ ...image, sessionId: ctx.session.id, reconciliationId: ctx.rec.id, attested: true });
  });

  r.delete('/cash-capture/sessions/:sid/images/:imageId', requireRole('employee'), async (req, res) => {
    const { session, rec } = await authoriseSession(req);
    const img = await q.image(req.params.imageId);
    if (!img || img.session_id !== session.id) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة في هذا التصوير.');
    if (img.status !== 'active') throw new HttpError(409, 'ALREADY_RETAKEN', 'هذه الصورة محذوفة مسبقًا.');
    await db.run("UPDATE cash_images SET status = 'retaken', retaken_at = ? WHERE id = ?", new Date().toISOString(), img.id);
    // The file is kept: discarded captures stay in the audit trail.
    await audit.record({ req, action: 'cash_capture.image_retaken', reconciliationId: rec.id, entityType: 'cash_image', entityId: img.id, details: { sessionId: session.id, seq: img.seq } });
    res.json({ images: (await q.activeImages(session.id)).map(imageView) });
  });

  r.post('/cash-capture/sessions/:sid/finalize', requireRole('employee'), async (req, res) => {
    const { session, rec } = await authoriseSession(req);
    const images = await q.activeImages(session.id);
    if (images.length === 0) throw new HttpError(409, 'NO_PHOTOGRAPHS', 'التقط صورة واحدة للنقد على الأقل.');
    const now = new Date().toISOString();
    const done = await db.run("UPDATE capture_sessions SET status = 'finalized', finalized_at = ? WHERE id = ? AND status = 'open'", now, session.id);
    if (done.changes !== 1) throw new HttpError(409, 'CAPTURE_SESSION_CLOSED', 'جلسة التصوير مغلقة.');
    await audit.record({ req, action: 'cash_capture.session_finalized', reconciliationId: rec.id, entityType: 'capture_session', entityId: session.id, details: { imageIds: images.map((i) => i.id) } });

    const loaded = [];
    for (const i of images) loaded.push({ id: i.id, bytes: await files.get(i.storage_path) });
    const result = await cashCounter.analyze(loaded);
    const counts = normaliseCounts(result.counts);
    const id = crypto.randomUUID();
    await db.run(`INSERT INTO cash_analyses
      (id, session_id, reconciliation_id, provider, model, status, counts_json, total_halalas, issues_json, image_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, session.id, rec.id, cashCounter.provider ?? 'custom', result.model ?? null, result.status,
    JSON.stringify(counts), totalHalalas(counts), JSON.stringify(result.issues ?? []), JSON.stringify(images.map((i) => i.id)), new Date().toISOString());
    await audit.record({ req, action: 'cash_count.ai_analysis', reconciliationId: rec.id, entityType: 'cash_analysis', entityId: id,
      details: { provider: cashCounter.provider, model: result.model, status: result.status, totalHalalas: totalHalalas(counts) } });
    res.json({ analysis: analysisView(await q.analysis(id)), denominations: DENOMINATIONS });
  });

  r.post('/reconciliations/:id/cash-count/confirm', requireRole('employee'), express.json({ limit: '8kb' }), async (req, res) => {
    const rec = await loadReconciliation(db, req.params.id, req.user, { write: true });
    await assertStageOpen(rec);
    if (req.body?.confirmed !== true) {
      throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'أكّد أنك راجعت عدد كل فئة مقابل النقد الفعلي.');
    }
    const analysis = await q.analysis(String(req.body?.analysisId ?? ''));
    if (!analysis || analysis.reconciliation_id !== rec.id) throw new HttpError(404, 'ANALYSIS_NOT_FOUND', 'لم يتم العثور على نتيجة عدّ النقد لهذه التسوية.');
    if ((await q.latestAnalysis(rec.id)).id !== analysis.id) throw new HttpError(409, 'ANALYSIS_STALE', 'يوجد تصوير أحدث. راجع آخر تصوير.');
    const session = await q.session(analysis.session_id);
    if (session.user_id !== req.user.id || session.status !== 'finalized') {
      throw new HttpError(403, 'CAPTURE_SESSION_NOT_YOURS', 'فقط الموظف الذي صوّر النقد يمكنه تأكيد العدّ.');
    }
    const imageIds = JSON.parse(analysis.image_ids_json);
    const stillActive = (await q.activeImages(session.id)).map((i) => i.id);
    if (imageIds.length === 0 || imageIds.some((i) => !stillActive.includes(i))) {
      throw new HttpError(409, 'NO_PHOTOGRAPHS', 'هذا العدّ غير مدعوم بصور من الكاميرا المباشرة.');
    }

    let counts;
    try {
      counts = normaliseCounts(req.body?.counts ?? {});
    } catch (e) {
      throw new HttpError(400, 'INVALID_COUNTS', e.message);
    }
    const aiCounts = JSON.parse(analysis.counts_json);
    const adjustments = DENOMINATION_IDS.filter((d) => counts[d] !== aiCounts[d]).map((d) => ({ denomination: d, ai: aiCounts[d], confirmed: counts[d] }));
    const total = totalHalalas(counts);
    const now = new Date().toISOString();
    try {
      await db.run(`INSERT INTO cash_counts
        (reconciliation_id, session_id, analysis_id, confirmed_by, confirmed_at, counts_json, total_halalas, ai_counts_json, ai_total_halalas, adjustments_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id, session.id, analysis.id, req.user.id, now, JSON.stringify(counts), total, analysis.counts_json, analysis.total_halalas, JSON.stringify(adjustments));
    } catch (err) {
      if (/UNIQUE|PRIMARY KEY/i.test(String(err?.message))) throw new HttpError(409, 'CASH_COUNT_ALREADY_CONFIRMED', 'تم تأكيد عدّ النقد لهذا اليوم مسبقًا.');
      throw err;
    }
    await audit.record({ req, action: 'cash_count.confirmed', reconciliationId: rec.id, entityType: 'cash_count', entityId: rec.id,
      details: { analysisId: analysis.id, sessionId: session.id, imageIds, totalHalalas: total, aiTotalHalalas: analysis.total_halalas, adjustments } });
    res.status(201).json({ totalHalalas: total, total: formatSar(total), counts, adjustments, confirmedAt: now });
  });

  r.get('/cash-capture/images/:imageId', async (req, res) => {
    const img = await q.image(req.params.imageId);
    const allowed = img && (req.user.role === 'manager' || img.user_id === req.user.id);
    if (!allowed) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة.');
    await audit.record({ req, action: 'cash_capture.image_viewed', reconciliationId: img.reconciliation_id, entityType: 'cash_image', entityId: img.id });
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
    res.type('image/jpeg').send(await files.get(img.storage_path));
  });

  return r;
}
