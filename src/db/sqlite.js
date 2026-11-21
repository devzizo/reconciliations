// Node.js adapter (built-in node:sqlite) exposing the same async interface as the D1 adapter.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedDemoData } from './seed.js';

export async function openSqlite(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(config.dbFile);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  // Apply each migration once, like `wrangler d1 migrations apply`.
  raw.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY)');
  const dir = path.join(config.root, 'migrations');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    if (raw.prepare('SELECT 1 FROM _local_migrations WHERE name = ?').get(f)) continue;
    raw.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    raw.prepare('INSERT INTO _local_migrations (name) VALUES (?)').run(f);
  }
  const plain = (r) => (r ? { ...r } : null);
  const db = {
    kind: 'sqlite',
    async get(sql, ...p) { return plain(raw.prepare(sql).get(...p)); },
    async all(sql, ...p) { return raw.prepare(sql).all(...p).map(plain); },
    async run(sql, ...p) { return { changes: Number(raw.prepare(sql).run(...p).changes) }; },
    close() { raw.close(); },
  };
  if (config.seedDemoData) await seedDemoData(db);
  return db;
}
