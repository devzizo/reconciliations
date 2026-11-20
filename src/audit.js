import { sha256Hex } from './auth.js';

const GENESIS = '0'.repeat(64);

/**
 * Append-only, hash-chained audit trail. Each entry's hash covers the previous entry's hash,
 * so any after-the-fact edit to the database breaks verification.
 */
export function createAudit(db) {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  const insert = db.prepare(`INSERT INTO audit_log
    (at, actor_user_id, action, reconciliation_id, entity_type, entity_id, ip, user_agent, details_json, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function record({ req, actorUserId, action, reconciliationId = null, entityType = null, entityId = null, details = {} }) {
    const at = new Date().toISOString();
    const actor = actorUserId ?? req?.user?.id ?? null;
    const ip = req?.ip ?? null;
    const ua = req?.get?.('user-agent') ?? null;
    const detailsJson = JSON.stringify(details);
    const prev = last.get()?.hash ?? GENESIS;
    const hash = sha256Hex([prev, at, actor, action, reconciliationId, entityType, entityId, ip, ua, detailsJson].join('\u001f'));
    insert.run(at, actor, action, reconciliationId, entityType, entityId, ip, ua, detailsJson, prev, hash);
    return hash;
  }

  function verify() {
    let prev = GENESIS;
    for (const r of db.prepare('SELECT * FROM audit_log ORDER BY seq').iterate()) {
      const expect = sha256Hex([prev, r.at, r.actor_user_id, r.action, r.reconciliation_id, r.entity_type, r.entity_id, r.ip, r.user_agent, r.details_json].join('\u001f'));
      if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, brokenAtSeq: r.seq };
      prev = r.hash;
    }
    return { ok: true };
  }

  return { record, verify };
}
