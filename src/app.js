import path from 'node:path';
import express from 'express';
import { createAudit } from './audit.js';
import { HttpError } from './errors.js';
import { createMatches } from './routes/matches.js';
import { cameraRoutes } from './routes/camera.js';
import { createCashCounter } from './services/cashCounter.js';
import { createDocumentReader } from './services/documentReader.js';
import { createAttestationVerifier } from './services/attestation.js';
import { createFileStore } from './fileStore.js';

export function createApp({ db, config }) {
  const app = express();
  const audit = createAudit(db);
  const cashCounter = createCashCounter(config);
  const documentReader = createDocumentReader(config);
  const attestationVerifier = createAttestationVerifier(config);
  const files = createFileStore(db);
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  // Camera access (getUserMedia) only works in a secure context, so production must be HTTPS end to end.
  app.use((req, res, next) => {
    if (config.requireHttps && !req.secure) {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.redirect(308, `https://${req.hostname}${req.originalUrl}`);
      return next(new HttpError(403, 'HTTPS_REQUIRED', 'هذه الخدمة متاحة عبر اتصال آمن (HTTPS) فقط.'));
    }
    if (req.secure || config.alwaysHsts) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' blob: data:",
        "media-src 'self' blob: mediastream:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
        "frame-ancestors 'none'", "form-action 'self'",
      ].join('; '),
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), display-capture=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/_headers', (_req, res) => res.status(404).end()); // header config for the Worker build, not content

  const matches = createMatches({ db, audit, files });
  const api = express.Router();
  api.get('/features', (_req, res) => res.json({ aiReading: documentReader.provider !== 'none', aiCounting: cashCounter.provider !== 'none', attestedCapture: Boolean(attestationVerifier) }));
  api.use('/', matches.router);
  api.use('/', cameraRoutes({ db, audit, config, cashCounter, documentReader, attestationVerifier, files, matches }));
  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'غير موجود.')));

  // On Cloudflare, src/worker.js serves the bundled public/ files; under Node, Express does.
  if (config.serveStatic) {
    const pub = path.join(config.root, 'public');
    app.use(express.static(pub, { index: 'index.html', maxAge: 0, dotfiles: 'ignore' }));
    app.get(/^\/m\/[\w-]+$/, (_req, res) => res.sendFile(path.join(pub, 'index.html'))); // share links
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.too.large') err = new HttpError(413, 'TOO_LARGE', 'حجم الصورة كبير جدًا.');
    if (err?.type === 'entity.parse.failed') err = new HttpError(400, 'BAD_REQUEST', 'طلب غير صالح.');
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: { code: err.code ?? 'INTERNAL', message: status === 500 ? 'حدث خطأ غير متوقع في الخادم.' : err.message, details: err.details } });
  });

  return app;
}
