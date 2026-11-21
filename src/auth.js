import crypto from 'node:crypto';

// There are no user accounts. A reconciliation can only be changed from the device that started it,
// which holds its secret edit token; camera sessions have their own short-lived tokens.

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison of a presented secret against a stored SHA-256 hex digest. */
export function tokenMatches(presented, storedHashHex) {
  if (typeof presented !== 'string' || presented.length === 0 || !storedHashHex) return false;
  const a = Buffer.from(sha256Hex(presented), 'hex');
  const b = Buffer.from(storedHashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
