import { sha256Hex } from './auth.js';

const GENESIS = '0'.repeat(64);
const hashOf = (prev, e) => sha256Hex([prev, e.at, e.actor, e.action, e.reconciliationId, e.entityType, e.entityId, e.ip, e.ua, e.detailsJson].join('\u001f'));

/**
 * Append-only, hash-chained audit trail. Each entry's hash covers the previous entry's hash, so any
 * after-the-fact edit breaks verification. prev_hash is UNIQUE, so two concurrent writers cannot both
 * extend the same entry; the loser re-reads the head and retries.
 */
export function createAudit(db) {
  async function record({ req, actorUserId, action, reconciliationId = null, entityType = null, entityId = null, details = {} }) {
    const e = {
      at: new Date().toISOString(),
      actor: actorUserId ?? req?.user?.id ?? null,
      action, reconciliationId, entityType, entityId,
      ip: req?.ip ?? null,
      ua: req?.get?.('user-agent') ?? null,
      detailsJson: JSON.stringify(details),
    };
    for (let attempt = 0; ; attempt++) {
      const prev = (await db.get('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1'))?.hash ?? GENESIS;
      const hash = hashOf(prev, e);
      try {
        await db.run(`INSERT INTO audit_log (at, actor_user_id, action, reconciliation_id, entity_type, entity_id, ip, user_agent, details_json, prev_hash, hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, e.at, e.actor, action, reconciliationId, entityType, entityId, e.ip, e.ua, e.detailsJson, prev, hash);
        return hash;
      } catch (err) {
        if (attempt >= 5 || !/UNIQUE/i.test(String(err?.message))) throw err;
      }
    }
  }

  async function verify() {
    let prev = GENESIS;
    for (const r of await db.all('SELECT * FROM audit_log ORDER BY seq')) {
      const expect = hashOf(prev, { at: r.at, actor: r.actor_user_id, action: r.action, reconciliationId: r.reconciliation_id, entityType: r.entity_type, entityId: r.entity_id, ip: r.ip, ua: r.user_agent, detailsJson: r.details_json });
      if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, brokenAtSeq: r.seq };
      prev = r.hash;
    }
    return { ok: true };
  }

  return { record, verify };
}
