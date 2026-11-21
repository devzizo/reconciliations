#!/usr/bin/env node
// Add (or rename) a branch on the Cloudflare D1 database. The AI picks the branch written on the
// daily closing form from this list, so use the name as it is written on the forms.
//   node scripts/create-branch.mjs --id jeddah --name Jeddah --name-ar جدة [--local]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) { const k = argv[i].replace(/^--/, ''); args[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
for (const k of ['id', 'name', 'name-ar']) if (!args[k] || args[k] === true) { console.error(`--${k} is required`); process.exit(1); }
if (!/^[a-z0-9-]{2,40}$/.test(args.id)) { console.error('--id: lowercase letters, digits and dashes'); process.exit(1); }
const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
const sql = `INSERT INTO branches (id, name, name_ar, active) VALUES (${q(args.id)}, ${q(args.name)}, ${q(args['name-ar'])}, 1)
  ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_ar = excluded.name_ar, active = 1;`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-'));
const file = path.join(dir, 'branch.sql');
fs.writeFileSync(file, sql);
try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'reconciliations-db', args.local ? '--local' : '--remote', '--file', file, '--yes'], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`Branch ${args.id} (${args['name-ar']}) saved.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
