import crypto from 'node:crypto';
import { HttpError } from './errors.js';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Constant-time comparison of a presented secret against a stored SHA-256 hex digest. */
export function tokenMatches(presented, storedHashHex) {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = Buffer.from(sha256Hex(presented), 'hex');
  const b = Buffer.from(storedHashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function issueAuthToken(db, config, userId) {
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + config.authTokenTtlMinutes * 60_000);
  db.prepare('INSERT INTO auth_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256Hex(token), userId, now.toISOString(), expires.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

export function revokeAuthToken(db, token) {
  db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(sha256Hex(token));
}

/** Express middleware: resolves `Authorization: Bearer <token>` to req.user. */
export function authenticate(db) {
  const lookup = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.branch_id, t.expires_at
    FROM auth_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?`);
  return (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in required.'));
    const row = lookup.get(sha256Hex(match[1]));
    if (!row || Date.parse(row.expires_at) <= Date.now()) {
      return next(new HttpError(401, 'UNAUTHENTICATED', 'Session expired. Sign in again.'));
    }
    req.user = { id: row.id, username: row.username, displayName: row.display_name, role: row.role, branchId: row.branch_id };
    req.authToken = match[1];
    next();
  };
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new HttpError(403, 'FORBIDDEN', 'You do not have permission for this action.'));
    }
    next();
  };
}
