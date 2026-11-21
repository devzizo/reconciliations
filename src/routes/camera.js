import crypto from 'node:crypto';
import express from 'express';
import { randomToken, sha256Hex, tokenMatches } from '../auth.js';
import { HttpError } from '../errors.js';
import { inspectJpeg } from '../services/jpegInspect.js';
import { normaliseCounts, totalHalalas } from '../services/denominations.js';
import { DOCUMENT_KINDS } from '../services/documentReader.js';

/**
 * Live-camera capture for every photograph in the system: the daily closing form, Z report, bank
 * settlement receipt, yesterday's cash deposit receipt, expense invoices and the physical cash.
 * There is no file / PDF / gallery upload anywhere in the API.
 *
 *   POST   /camera/sessions                      { kind, publicId? }  → short-lived session + capture token
 *   POST   /camera/sessions/:sid/captures        raw image/jpeg frame from the live <video>
 *   DELETE /camera/sessions/:sid/captures/:cid   retake (kept for audit)
 *   POST   /camera/sessions/:sid/finalize        AI reads the document / counts the cash
 *
 * A session for a new closing form has no reconciliation yet: the branch and date are read from the
 * form, and the reconciliation is created (or found) when the session is finalized.
 */
export const KINDS = [...DOCUMENT_KINDS, 'cash'];
const SESSIONS_PER_IP_PER_HOUR = 60;

export function cameraRoutes({ db, audit, config, cashCounter, documentReader, attestationVerifier, files, matches }) {
  const r = express.Router();
  const json = express.json({ limit: '4kb' });
  const rawJpeg = express.raw({ type: 'image/jpeg', limit: config.captureMaxBytes });

  const q = {
    session: (id) => db.get('SELECT * FROM camera_sessions WHERE id = ?', id),
    active: (sid) => db.all("SELECT * FROM captures WHERE session_id = ? AND status = 'active' ORDER BY seq", sid),
    count: async (sid) => (await db.get('SELECT COUNT(*) AS n FROM captures WHERE session_id = ?', sid)).n,
    capture: (id) => db.get('SELECT * FROM captures WHERE id = ?', id),
  };

  const view = (c) => ({ captureId: c.id, seq: c.seq, capturedAt: c.captured_at, sha256: c.sha256, width: c.width, height: c.height, flags: JSON.parse(c.flags_json), status: c.status });

  /** Session must exist, be presented with its secret token, be open and unexpired, and its reconciliation must still be open. */
  async function authoriseSession(req) {
    const session = await q.session(req.params.sid);
    if (!session) throw new HttpError(404, 'CAPTURE_SESSION_NOT_FOUND', 'جلسة التصوير غير موجودة.');
    const deny = async (status, code, message, reason) => {
      await audit.record({ req, action: 'camera.request_denied', reconciliationId: session.match_id, entityType: 'camera_session', entityId: session.id, details: { reason } });
      return new HttpError(status, code, message);
    };
    if (!tokenMatches(req.get('x-capture-token'), session.token_hash)) throw await deny(401, 'INVALID_CAPTURE_TOKEN', 'رمز جلسة التصوير مفقود أو غير صالح.', 'bad_token');
    if (session.status !== 'open') throw new HttpError(409, 'CAPTURE_SESSION_CLOSED', 'جلسة التصوير مغلقة. ابدأ تصويرًا جديدًا.');
    if (Date.parse(session.expires_at) <= Date.now()) throw await deny(410, 'CAPTURE_SESSION_EXPIRED', 'انتهت مهلة جلسة التصوير. ابدأ تصويرًا جديدًا.', 'expired');
    if (session.match_id) {
      const m = await db.get('SELECT * FROM matches WHERE id = ?', session.match_id);
      if (m.status !== 'open') throw new HttpError(409, 'MATCH_SUBMITTED', 'تم اعتماد هذه المطابقة ولا يمكن تعديلها.');
    }
    return session;
  }

  async function requireRawJpeg(req, _res, next) {
    const type = (req.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'image/jpeg') {
      await audit.record({ req, action: 'camera.file_upload_rejected', details: { reason: 'wrong_content_type', contentType: type.slice(0, 80), sessionId: req.params.sid } });
      throw new HttpError(415, 'CAMERA_CAPTURE_ONLY', 'كل الصور تُلتقط بالكاميرا المباشرة داخل التطبيق. رفع الملفات (ومنها PDF) غير مسموح.');
    }
    next();
  }

  function parseClientMeta(req) {
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

  async function storeCapture(req, session, body, { attestation = null } = {}) {
    if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'EMPTY_IMAGE', 'لم تصل أي صورة.');
    if ((await q.active(session.id)).length >= session.max_images) {
      throw new HttpError(409, 'CAPTURE_LIMIT_REACHED', session.max_images === 1 ? 'تم التقاط الصورة. أعد التقاطها بدلًا من ذلك.' : `الحد الأقصى ${session.max_images} صور. أعد التقاط صورة بدلًا من ذلك.`);
    }
    const info = inspectJpeg(body);
    if (!info.valid) throw new HttpError(422, 'INVALID_IMAGE', `الصورة غير مكتملة أو تالفة (${info.reason}).`);
    if (info.cameraExifTags.length) {
      await audit.record({ req, action: 'camera.gallery_upload_rejected', reconciliationId: session.match_id, entityType: 'camera_session', entityId: session.id, details: { reason: 'camera_exif_present', tags: info.cameraExifTags } });
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
    const sha256 = sha256Hex(body);
    const seq = (await q.count(session.id)) + 1;
    const key = `captures/${id}.jpg`;
    await files.put(key, body);
    await db.run(`INSERT INTO captures (id, session_id, match_id, kind, seq, captured_at, sha256, size_bytes, width, height, storage_key, flags_json, attestation_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, session.id, session.match_id, session.kind, seq, new Date().toISOString(), sha256, body.length,
    info.width, info.height, key, JSON.stringify(flags), attestation ? JSON.stringify(attestation) : null);
    await audit.record({ req, action: 'camera.captured', reconciliationId: session.match_id, entityType: 'capture', entityId: id,
      details: { sessionId: session.id, kind: session.kind, seq, sha256, sizeBytes: body.length, width: info.width, height: info.height, flags, clientMeta: meta, attested: Boolean(attestation) } });
    return view(await q.capture(id));
  }

  // ------------------------------------------------------------------ routes

  r.post('/camera/sessions', json, async (req, res) => {
    const kind = String(req.body?.kind ?? '');
    if (!KINDS.includes(kind)) throw new HttpError(400, 'INVALID_KIND', 'نوع التصوير غير معروف.');
    const since = new Date(Date.now() - 3_600_000).toISOString();
    if ((await db.get('SELECT COUNT(*) AS n FROM camera_sessions WHERE client_ip = ? AND created_at > ?', req.ip ?? '', since)).n >= SESSIONS_PER_IP_PER_HOUR) {
      throw new HttpError(429, 'TOO_MANY_CAPTURES', 'عدد كبير من محاولات التصوير. حاول بعد قليل.');
    }
    let match = null;
    if (req.body?.publicId) {
      match = await matches.requireEditable(req, String(req.body.publicId));
      if (kind === 'cash' && await db.get('SELECT 1 FROM cash_confirmations WHERE match_id = ?', match.id)) {
        throw new HttpError(409, 'CASH_COUNT_ALREADY_CONFIRMED', 'تم تأكيد عدّ النقد لهذه المطابقة مسبقًا.');
      }
    } else if (kind !== 'daily_closing_form') {
      throw new HttpError(400, 'MATCH_REQUIRED', 'ابدأ بتصوير اليومية أولًا.');
    }
    const channel = req.body?.channel === 'native_attested' ? 'native_attested' : 'browser';
    if (channel === 'native_attested' && !attestationVerifier) throw new HttpError(501, 'ATTESTATION_NOT_CONFIGURED', 'التصوير عبر التطبيق الموثّق غير مفعّل على الخادم.');
    const cam = req.body?.camera ?? {};
    const cameraInfo = {
      facingMode: typeof cam.facingMode === 'string' ? cam.facingMode.slice(0, 20) : null,
      width: Number.isInteger(cam.width) ? cam.width : null,
      height: Number.isInteger(cam.height) ? cam.height : null,
      label: typeof cam.label === 'string' ? cam.label.slice(0, 120) : null,
    };
    const now = new Date();
    if (match) {
      for (const s of await db.all("SELECT id FROM camera_sessions WHERE match_id = ? AND kind = ? AND status = 'open'", match.id, kind)) {
        await db.run("UPDATE camera_sessions SET status = 'superseded', finalized_at = ? WHERE id = ?", now.toISOString(), s.id);
      }
    }
    const id = crypto.randomUUID();
    const token = randomToken();
    const maxImages = kind === 'cash' ? config.captureMaxImages : 1;
    const expiresAt = new Date(now.getTime() + config.captureSessionTtlSeconds * 1000).toISOString();
    await db.run(`INSERT INTO camera_sessions (id, match_id, kind, token_hash, status, channel, max_images, camera_info_json, client_ip, user_agent, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`, id, match?.id ?? null, kind, sha256Hex(token), channel, maxImages, JSON.stringify(cameraInfo),
    req.ip ?? null, req.get('user-agent') ?? null, now.toISOString(), expiresAt);
    await audit.record({ req, action: 'camera.session_started', reconciliationId: match?.id ?? null, entityType: 'camera_session', entityId: id, details: { kind, channel, expiresAt, camera: cameraInfo } });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ sessionId: id, captureToken: token, kind, publicId: match?.public_id ?? null, issuedAt: now.toISOString(), expiresAt, maxImages, maxBytes: config.captureMaxBytes });
  });

  r.post('/camera/sessions/:sid/captures', requireRawJpeg, rawJpeg, async (req, res) => {
    const session = await authoriseSession(req);
    if (session.channel !== 'browser') throw new HttpError(409, 'WRONG_CHANNEL', 'هذه الجلسة تتطلب التصوير الموثّق.');
    res.status(201).json({ ...(await storeCapture(req, session, req.body)), sessionId: session.id });
  });

  // Optional native-app channel with device attestation (see docs). 501 unless a verifier is configured.
  r.post('/camera/sessions/:sid/attested-captures', requireRawJpeg, rawJpeg, async (req, res) => {
    if (!attestationVerifier) throw new HttpError(501, 'ATTESTATION_NOT_CONFIGURED', 'التصوير عبر التطبيق الموثّق غير مفعّل على الخادم.');
    const session = await authoriseSession(req);
    if (session.channel !== 'native_attested') throw new HttpError(409, 'WRONG_CHANNEL', 'هذه الجلسة ليست جلسة تصوير موثّق.');
    const imageSha256 = sha256Hex(req.body ?? Buffer.alloc(0));
    const result = await attestationVerifier.verify({ attestation: req.get('x-device-attestation') ?? '',
      challenge: `${session.token_hash}:${(await q.count(session.id)) + 1}:${imageSha256}`, imageSha256, sessionId: session.id });
    if (!result?.ok) {
      await audit.record({ req, action: 'camera.attestation_failed', reconciliationId: session.match_id, entityType: 'camera_session', entityId: session.id, details: { reason: result?.reason ?? 'unknown' } });
      throw new HttpError(403, 'ATTESTATION_FAILED', 'فشل التحقق من الجهاز.');
    }
    res.status(201).json({ ...(await storeCapture(req, session, req.body, { attestation: { verifier: attestationVerifier.name, deviceId: result.deviceId, platform: result.platform } })), attested: true });
  });

  r.delete('/camera/sessions/:sid/captures/:cid', async (req, res) => {
    const session = await authoriseSession(req);
    const c = await q.capture(req.params.cid);
    if (!c || c.session_id !== session.id) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة في هذا التصوير.');
    if (c.status !== 'active') throw new HttpError(409, 'ALREADY_RETAKEN', 'هذه الصورة محذوفة مسبقًا.');
    await db.run("UPDATE captures SET status = 'retaken', status_at = ? WHERE id = ?", new Date().toISOString(), c.id);
    await audit.record({ req, action: 'camera.retaken', reconciliationId: session.match_id, entityType: 'capture', entityId: c.id, details: { sessionId: session.id, seq: c.seq } });
    res.json({ captures: (await q.active(session.id)).map(view) });
  });

  r.post('/camera/sessions/:sid/finalize', async (req, res) => {
    const session = await authoriseSession(req);
    const captures = await q.active(session.id);
    if (captures.length === 0) throw new HttpError(409, 'NO_PHOTOGRAPHS', 'التقط صورة أولًا.');
    // An existing reconciliation can only be changed from the device holding its edit token.
    if (session.match_id) await matches.requireEditableById(req, session.match_id);
    const done = await db.run("UPDATE camera_sessions SET status = 'finalized', finalized_at = ? WHERE id = ? AND status = 'open'", new Date().toISOString(), session.id);
    if (done.changes !== 1) throw new HttpError(409, 'CAPTURE_SESSION_CLOSED', 'جلسة التصوير مغلقة.');
    const images = [];
    for (const c of captures) images.push({ id: c.id, bytes: await files.get(c.storage_key) });

    let result;
    if (session.kind === 'cash') {
      const a = await cashCounter.analyze(images);
      const counts = normaliseCounts(a.counts);
      result = { status: a.status, model: a.model, fields: counts, extras: { totalHalalas: totalHalalas(counts) }, lowConfidence: [], issues: a.issues ?? [] };
    } else {
      const branches = await db.all('SELECT id, name, name_ar FROM branches WHERE active = 1 ORDER BY id');
      result = await documentReader.read({ kind: session.kind, bytes: images[0].bytes, branches });
    }
    const outcome = await matches.applyReading(req, session, result, { provider: session.kind === 'cash' ? cashCounter.provider : documentReader.provider });
    res.status(outcome.status ?? 200).json(outcome.body);
  });

  return r;
}
