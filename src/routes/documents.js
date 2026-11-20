import crypto from 'node:crypto';
import express from 'express';
import { loadReconciliation } from '../access.js';
import { HttpError } from '../errors.js';
import { detail } from './reconciliations.js';

// Stages 1-3 accept PDFs and images through ordinary file upload.
export const DOCUMENT_TYPES = new Set(['daily_closing_form', 'z_report', 'bank_settlement']);
// Anything that looks like a Stage 4 cash photograph is refused here: those only arrive through
// an authenticated live-camera capture session (routes/cashCapture.js).
const CASH_TYPES = new Set(['cash_count', 'cash_photo', 'cash', 'physical_cash_count', 'stage4', 'stage_4']);

const ALLOWED_MIME = new Map([
  ['application/pdf', (b) => b.subarray(0, 5).toString('latin1') === '%PDF-'],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8],
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['image/heic', (b) => b.subarray(4, 8).toString('latin1') === 'ftyp'],
  ['image/heif', (b) => b.subarray(4, 8).toString('latin1') === 'ftyp'],
]);

export function documentRoutes({ db, audit, config, files }) {
  const r = express.Router({ mergeParams: true });
  // Multipart is parsed with the standard Web API (Response.formData), which works in Node and Workers.
  const rawMultipart = express.raw({ type: 'multipart/form-data', limit: config.documentMaxBytes + 64 * 1024 });

  // Check the requested type *before* reading the body, so a cash photo is refused without being stored.
  async function guardType(req, _res, next) {
    const type = String(req.query.type ?? '').toLowerCase();
    if (CASH_TYPES.has(type)) {
      await audit.record({ req, action: 'cash_capture.gallery_upload_rejected', reconciliationId: req.params.id, details: { via: 'documents', requestedType: type } });
      throw new HttpError(403, 'CASH_PHOTOS_CAMERA_ONLY',
        'Cash count photographs can only be taken with the live camera in the cash-counting stage. File uploads are not accepted.');
    }
    if (!DOCUMENT_TYPES.has(type)) throw new HttpError(400, 'INVALID_DOCUMENT_TYPE', `type must be one of: ${[...DOCUMENT_TYPES].join(', ')}.`);
    await loadReconciliation(db, req.params.id, req.user, { write: true });
    req.docType = type;
    next();
  }

  r.post('/', guardType, rawMultipart, async (req, res) => {
    const rec = await loadReconciliation(db, req.params.id, req.user, { write: true });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'FILE_REQUIRED', 'Attach a PDF or image in the "file" field.');
    let file;
    try {
      const form = await new Response(req.body, { headers: { 'content-type': req.get('content-type') } }).formData();
      file = form.get('file');
    } catch {
      throw new HttpError(400, 'UPLOAD_FAILED', 'Could not read the uploaded form.');
    }
    if (!file || typeof file === 'string') throw new HttpError(400, 'FILE_REQUIRED', 'Attach a PDF or image in the "file" field.');
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > config.documentMaxBytes) throw new HttpError(413, 'TOO_LARGE', 'The upload is too large.');
    const mime = (file.type || '').toLowerCase();
    const check = ALLOWED_MIME.get(mime);
    if (!check || !check(buf)) throw new HttpError(415, 'UNSUPPORTED_FILE', 'Upload a PDF, JPEG, PNG, WebP or HEIC file.');

    const id = crypto.randomUUID();
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const key = `documents/${id}`;
    await files.put(key, buf);
    await db.run(`INSERT INTO documents (id, reconciliation_id, doc_type, original_name, mime_type, size_bytes, sha256, storage_path, uploaded_by, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, rec.id, req.docType, String(file.name ?? '').slice(0, 200), mime, buf.length, sha256, key, req.user.id, new Date().toISOString());
    await audit.record({ req, action: 'document.uploaded', reconciliationId: rec.id, entityType: 'document', entityId: id, details: { docType: req.docType, mimeType: mime, size: buf.length, sha256 } });
    res.status(201).json({ documentId: id, ...(await detail(db, rec)) });
  });

  r.get('/:docId', async (req, res) => {
    const rec = await loadReconciliation(db, req.params.id, req.user);
    const doc = await db.get('SELECT * FROM documents WHERE id = ? AND reconciliation_id = ?', req.params.docId, rec.id);
    if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');
    res.set('Cache-Control', 'private, no-store');
    res.type(doc.mime_type).send(await files.get(doc.storage_path));
  });

  return r;
}
