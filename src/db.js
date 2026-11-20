import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './auth.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_ar TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('employee', 'manager')),
  branch_id TEXT REFERENCES branches(id)
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliations (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  business_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  UNIQUE (branch_id, business_date)
);

-- Declared figures for stages 1-3 (closing form, Z report, bank settlement).
CREATE TABLE IF NOT EXISTS stage_figures (
  reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id),
  stage TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (reconciliation_id, stage)
);

-- Ordinary uploads for stages 1-3 only. Stage 4 cash photographs never live here.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('daily_closing_form', 'z_report', 'bank_settlement')),
  original_name TEXT,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL
);

-- Stage 4: short-lived, server-issued capture sessions.
CREATE TABLE IF NOT EXISTS capture_sessions (
  id TEXT PRIMARY KEY,
  reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'finalized', 'superseded')),
  channel TEXT NOT NULL DEFAULT 'browser' CHECK (channel IN ('browser', 'native_attested')),
  max_images INTEGER NOT NULL,
  camera_info_json TEXT,
  client_ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finalized_at TEXT
);

CREATE TABLE IF NOT EXISTS cash_images (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES capture_sessions(id),
  reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  seq INTEGER NOT NULL,
  captured_at TEXT NOT NULL,            -- server clock, never client-supplied
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retaken')),
  retaken_at TEXT,
  flags_json TEXT NOT NULL DEFAULT '[]',
  attestation_json TEXT
);

CREATE TABLE IF NOT EXISTS cash_analyses (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES capture_sessions(id),
  reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id),
  provider TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'unavailable', 'failed')),
  counts_json TEXT NOT NULL,
  total_halalas INTEGER NOT NULL,
  issues_json TEXT NOT NULL DEFAULT '[]',
  image_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Human-confirmed Stage 4 result. One per reconciliation.
CREATE TABLE IF NOT EXISTS cash_counts (
  reconciliation_id TEXT PRIMARY KEY REFERENCES reconciliations(id),
  session_id TEXT NOT NULL REFERENCES capture_sessions(id),
  analysis_id TEXT NOT NULL REFERENCES cash_analyses(id),
  confirmed_by TEXT NOT NULL REFERENCES users(id),
  confirmed_at TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  total_halalas INTEGER NOT NULL,
  ai_counts_json TEXT NOT NULL,
  ai_total_halalas INTEGER NOT NULL,
  adjustments_json TEXT NOT NULL
);

-- Append-only, hash-chained audit trail.
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  reconciliation_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  ip TEXT,
  user_agent TEXT,
  details_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`;

export function openDatabase(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(config.dbFile);
  db.exec(SCHEMA);
  if (config.seedDemoData) seed(db);
  return db;
}

/** Demo branches and accounts so the app is usable out of the box. Change passwords before real use. */
function seed(db) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (existing.n > 0) return;
  const branches = [
    ['tabuk', 'Tabuk', 'تبوك'],
    ['najran', 'Najran', 'نجران'],
  ];
  const insertBranch = db.prepare('INSERT INTO branches (id, name, name_ar) VALUES (?, ?, ?)');
  for (const b of branches) insertBranch.run(...b);
  const insertUser = db.prepare(
    'INSERT INTO users (id, username, display_name, password_hash, role, branch_id) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertUser.run('u-emp-tabuk', 'tabuk.employee', 'Tabuk Employee', hashPassword('change-me-tabuk'), 'employee', 'tabuk');
  insertUser.run('u-emp-najran', 'najran.employee', 'Najran Employee', hashPassword('change-me-najran'), 'employee', 'najran');
  insertUser.run('u-manager', 'finance.manager', 'Finance Manager', hashPassword('change-me-manager'), 'manager', null);
}
