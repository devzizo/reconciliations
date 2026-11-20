import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
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

export function documentRoutes({ db, audit, config }) {
  const r = express.Router({ mergeParams: true });
  const dir = path.join(config.dataDir, 'documents');
  fs.mkdirSync(dir, { recursive: true });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.documentMaxBytes, files: 1, fields: 5 } });

  // Check the requested type *before* reading the body, so a cash photo is refused without being stored.
  function guardType(req, _res, next) {
    const type = String(req.query.type ?? '').toLowerCase();
    if (CASH_TYPES.has(type)) {
      audit.record({ req, action: 'cash_capture.gallery_upload_rejected', reconciliationId: req.params.id, details: { via: 'documents', requestedType: type } });
      return next(new HttpError(403, 'CASH_PHOTOS_CAMERA_ONLY',
        'Cash count photographs can only be taken with the live camera in the cash-counting stage. File uploads are not accepted.'));
    }
    if (!DOCUMENT_TYPES.has(type)) return next(new HttpError(400, 'INVALID_DOCUMENT_TYPE', `type must be one of: ${[...DOCUMENT_TYPES].join(', ')}.`));
    req.docType = type;
    next();
  }

  r.post('/', guardType, (req, res, next) => {
    loadReconciliation(db, req.params.id, req.user, { write: true });
    upload.single('file')(req, res, (err) => {
      if (err) return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'UPLOAD_FAILED', err.message));
      next();
    });
  }, (req, res) => {
    const rec = loadReconciliation(db, req.params.id, req.user, { write: true });
    const f = req.file;
    if (!f) throw new HttpError(400, 'FILE_REQUIRED', 'Attach a PDF or image in the "file" field.');
    const check = ALLOWED_MIME.get(f.mimetype);
    if (!check || !check(f.buffer)) throw new HttpError(415, 'UNSUPPORTED_FILE', 'Upload a PDF, JPEG, PNG, WebP or HEIC file.');
    const id = crypto.randomUUID();
    const sha256 = crypto.createHash('sha256').update(f.buffer).digest('hex');
    const storagePath = path.join(dir, id);
    fs.writeFileSync(storagePath, f.buffer, { mode: 0o600 });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO documents (id, reconciliation_id, doc_type, original_name, mime_type, size_bytes, sha256, storage_path, uploaded_by, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, rec.id, req.docType, String(f.originalname ?? '').slice(0, 200), f.mimetype, f.size, sha256, storagePath, req.user.id, now);
    audit.record({ req, action: 'document.uploaded', reconciliationId: rec.id, entityType: 'document', entityId: id, details: { docType: req.docType, mimeType: f.mimetype, size: f.size, sha256 } });
    res.status(201).json({ documentId: id, ...detail(db, rec) });
  });

  r.get('/:docId', (req, res) => {
    const rec = loadReconciliation(db, req.params.id, req.user);
    const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND reconciliation_id = ?').get(req.params.docId, rec.id);
    if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');
    res.set('Cache-Control', 'private, no-store');
    res.type(doc.mime_type).send(fs.readFileSync(doc.storage_path));
  });

  return r;
}
