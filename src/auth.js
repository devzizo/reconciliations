import crypto from 'node:crypto';
import { HttpError } from './errors.js';

const enc = new TextEncoder();

async function pbkdf2(password, salt, iterations) {
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return Buffer.from(await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/** PBKDF2-SHA256 via WebCrypto (works in Node and Cloudflare Workers). Iterations are stored with the hash. */
export async function hashPassword(password, iterations = 100_000) {
  const salt = crypto.randomBytes(16);
  const key = await pbkdf2(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  let expected;
  let actual;
  if (parts[0] === 'pbkdf2-sha256' && parts.length === 4) {
    expected = Buffer.from(parts[3], 'base64');
    actual = await pbkdf2(password, Buffer.from(parts[2], 'base64'), Number(parts[1]));
  } else if (parts[0] === 'scrypt' && parts.length === 3) { // hashes from earlier local databases
    expected = Buffer.from(parts[2], 'base64');
    actual = crypto.scryptSync(password, Buffer.from(parts[1], 'base64'), expected.length);
  } else {
    return false;
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
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

export async function issueAuthToken(db, config, userId) {
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + config.authTokenTtlMinutes * 60_000);
  await db.run('DELETE FROM auth_tokens WHERE expires_at <= ?', now.toISOString());
  await db.run('INSERT INTO auth_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    sha256Hex(token), userId, now.toISOString(), expires.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

export async function revokeAuthToken(db, token) {
  await db.run('DELETE FROM auth_tokens WHERE token_hash = ?', sha256Hex(token));
}

/** Express middleware: resolves `Authorization: Bearer <token>` to req.user. */
export function authenticate(db) {
  return async (req, _res, next) => {
    try {
      const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
      if (!match) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required.');
      const row = await db.get(`SELECT u.id, u.username, u.display_name, u.role, u.branch_id, t.expires_at
        FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`, sha256Hex(match[1]));
      if (!row || Date.parse(row.expires_at) <= Date.now()) throw new HttpError(401, 'UNAUTHENTICATED', 'Session expired. Sign in again.');
      req.user = { id: row.id, username: row.username, displayName: row.display_name, role: row.role, branchId: row.branch_id };
      req.authToken = match[1];
      next();
    } catch (e) {
      next(e);
    }
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
