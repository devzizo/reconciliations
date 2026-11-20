// Node.js adapter (built-in node:sqlite) exposing the same async interface as the D1 adapter.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedDemoData } from './seed.js';

export async function openSqlite(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const raw = new DatabaseSync(config.dbFile);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  raw.exec(fs.readFileSync(path.join(config.root, 'migrations', '0001_init.sql'), 'utf8'));
  const plain = (r) => (r ? { ...r } : null);
  const db = {
    kind: 'sqlite',
    async get(sql, ...p) { return plain(raw.prepare(sql).get(...p)); },
    async all(sql, ...p) { return raw.prepare(sql).all(...p).map(plain); },
    async run(sql, ...p) { return { changes: Number(raw.prepare(sql).run(...p).changes) }; },
    close() { raw.close(); },
  };
  if (config.seedDemoData) await seedDemoData(db, config);
  return db;
}
