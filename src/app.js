import path from 'node:path';
import express from 'express';
import { authenticate, issueAuthToken, revokeAuthToken, verifyPassword } from './auth.js';
import { createAudit } from './audit.js';
import { HttpError } from './errors.js';
import { reconciliationRoutes } from './routes/reconciliations.js';
import { documentRoutes } from './routes/documents.js';
import { cashCaptureRoutes } from './routes/cashCapture.js';
import { createCashCounter } from './services/cashCounter.js';
import { createAttestationVerifier } from './services/attestation.js';

export function createApp({ db, config }) {
  const app = express();
  const audit = createAudit(db);
  const cashCounter = createCashCounter(config);
  const attestationVerifier = createAttestationVerifier(config);
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  // Camera access (getUserMedia) only works in a secure context, so production must be HTTPS end to end.
  app.use((req, res, next) => {
    if (config.requireHttps && !req.secure) {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.redirect(308, `https://${req.hostname}${req.originalUrl}`);
      return next(new HttpError(403, 'HTTPS_REQUIRED', 'This service is only available over HTTPS.'));
    }
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' blob: data:",
        "media-src 'self' blob: mediastream:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
        "frame-ancestors 'none'", "form-action 'self'",
      ].join('; '),
      // Camera for this origin only; everything else that could leak media is off.
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), display-capture=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', express.json({ limit: '2kb' }), (req, res) => {
    const { username, password } = req.body ?? {};
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? ''));
    if (!user || !verifyPassword(String(password ?? ''), user.password_hash)) {
      audit.record({ req, actorUserId: null, action: 'auth.login_failed', details: { username: String(username ?? '').slice(0, 80) } });
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password.');
    }
    const { token, expiresAt } = issueAuthToken(db, config, user.id);
    audit.record({ req, actorUserId: user.id, action: 'auth.login' });
    res.set('Cache-Control', 'no-store');
    res.json({ token, expiresAt, user: { id: user.id, displayName: user.display_name, role: user.role, branchId: user.branch_id } });
  });

  const api = express.Router();
  api.use(authenticate(db));
  api.post('/auth/logout', (req, res) => { revokeAuthToken(db, req.authToken); res.status(204).end(); });
  api.get('/me', (req, res) => res.json({ user: req.user, features: { aiCounting: cashCounter.provider !== 'none', attestedCapture: Boolean(attestationVerifier) } }));
  api.use('/reconciliations/:id/documents', documentRoutes({ db, audit, config }));
  api.use('/reconciliations', reconciliationRoutes({ db, audit }));
  api.use('/', cashCaptureRoutes({ db, audit, config, cashCounter, attestationVerifier }));
  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Not found.')));

  app.use(express.static(path.join(config.root, 'public'), { index: 'index.html', maxAge: 0 }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.too.large') err = new HttpError(413, 'TOO_LARGE', 'The upload is too large.');
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: { code: err.code ?? 'INTERNAL', message: status === 500 ? 'Unexpected server error.' : err.message, details: err.details } });
  });

  return app;
}
