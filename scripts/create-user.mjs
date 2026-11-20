#!/usr/bin/env node
// Create a branch and/or user on the Cloudflare D1 database (or print the SQL).
//
//   node scripts/create-user.mjs --username tabuk.employee --name "Tabuk Employee" --role employee \
//        --branch tabuk --branch-name Tabuk --branch-name-ar تبوك [--password ...] [--iterations 30000] [--local]
//
// Without --password a strong random one is generated and printed once. Runs
// `wrangler d1 execute reconciliations-db --remote` unless --print-sql is given.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hashPassword } from '../src/auth.js';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  args[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}
const need = (k) => { if (!args[k] || args[k] === true) { console.error(`--${k} is required`); process.exit(1); } return args[k]; };
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);

const username = need('username');
const role = need('role');
if (!['employee', 'manager'].includes(role)) { console.error('--role must be employee or manager'); process.exit(1); }
const branch = args.branch && args.branch !== true ? args.branch : null;
if (role === 'employee' && !branch) { console.error('employees need --branch'); process.exit(1); }
const password = args.password && args.password !== true ? args.password : crypto.randomBytes(12).toString('base64url');
const iterations = Number(args.iterations ?? 30000);

const sql = [];
if (branch && args['branch-name']) {
  sql.push(`INSERT INTO branches (id, name, name_ar) VALUES (${q(branch)}, ${q(args['branch-name'])}, ${q(args['branch-name-ar'] ?? null)}) ON CONFLICT (id) DO NOTHING;`);
}
sql.push(`INSERT INTO users (id, username, display_name, password_hash, role, branch_id) VALUES (${q(`u-${crypto.randomUUID()}`)}, ${q(username)}, ${q(args.name ?? username)}, ${q(await hashPassword(password, iterations))}, ${q(role)}, ${q(branch)});`);

if (args['print-sql']) {
  console.log(sql.join('\n'));
} else {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recon-user-')), 'user.sql');
  fs.writeFileSync(file, sql.join('\n'), { mode: 0o600 });
  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'reconciliations-db', args.local ? '--local' : '--remote', '--file', file, '--yes'], { stdio: ['ignore', 'ignore', 'inherit'] });
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}
if (!args.password) console.log(`Created ${username} (${role}${branch ? `, ${branch}` : ''}). Password: ${password}`);
else console.log(`Created ${username} (${role}${branch ? `, ${branch}` : ''}).`);
