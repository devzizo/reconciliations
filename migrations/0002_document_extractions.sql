-- AI readings of figures from Stage 1-3 documents. Always reviewed by a person before saving.
CREATE TABLE IF NOT EXISTS document_extractions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id),
  doc_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'unavailable', 'failed')),
  fields_json TEXT NOT NULL,      -- {field: halalas | null}
  low_confidence_json TEXT NOT NULL DEFAULT '[]',
  issues_json TEXT NOT NULL DEFAULT '[]',
  requested_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
