-- Open (login-free) reconciliation flow. Everything is photographed with the live camera and read by AI;
-- figures cannot be typed or edited. Earlier tables are left in place untouched.

ALTER TABLE branches ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
UPDATE branches SET active = 0 WHERE id LIKE 'smoke-test%';

-- One reconciliation ("مطابقة") per branch per day. Branch and date come from the photographed form.
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,                 -- رقم المطابقة
  public_id TEXT NOT NULL UNIQUE,                 -- used in the share link / QR
  edit_token_hash TEXT NOT NULL,                  -- held only by the device that started it
  branch_id TEXT NOT NULL REFERENCES branches(id),
  business_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted')),
  result TEXT CHECK (result IN ('matched', 'unmatched')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  UNIQUE (branch_id, business_date)
);

-- Short-lived, server-issued live-camera sessions. match_id is NULL while photographing a new closing form.
CREATE TABLE IF NOT EXISTS camera_sessions (
  id TEXT PRIMARY KEY,
  match_id TEXT REFERENCES matches(id),
  kind TEXT NOT NULL CHECK (kind IN ('daily_closing_form', 'z_report', 'bank_settlement', 'deposit_receipt', 'expense_invoice', 'cash')),
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
CREATE INDEX IF NOT EXISTS camera_sessions_ip ON camera_sessions (client_ip, created_at);

CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES camera_sessions(id),
  match_id TEXT REFERENCES matches(id),
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  captured_at TEXT NOT NULL,                       -- server clock
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retaken')),
  status_at TEXT,
  flags_json TEXT NOT NULL DEFAULT '[]',
  attestation_json TEXT
);

-- AI reading of one camera session (a document, an invoice, or the cash).
CREATE TABLE IF NOT EXISTS readings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES camera_sessions(id),
  match_id TEXT REFERENCES matches(id),
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'current' CHECK (state IN ('current', 'replaced', 'rejected')),
  provider TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'unavailable', 'failed')),
  fields_json TEXT NOT NULL,
  extras_json TEXT NOT NULL DEFAULT '{}',
  low_confidence_json TEXT NOT NULL DEFAULT '[]',
  issues_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
-- One current document of each kind per reconciliation (expense invoices may be several).
CREATE UNIQUE INDEX IF NOT EXISTS readings_one_current ON readings (match_id, kind)
  WHERE state = 'current' AND kind <> 'expense_invoice' AND match_id IS NOT NULL;

-- Cash count confirmed by the employee (no editing: confirm, or photograph again).
CREATE TABLE IF NOT EXISTS cash_confirmations (
  match_id TEXT PRIMARY KEY REFERENCES matches(id),
  reading_id TEXT NOT NULL REFERENCES readings(id),
  total_halalas INTEGER NOT NULL,
  confirmed_at TEXT NOT NULL
);
