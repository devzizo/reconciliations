-- One current document per type per day. Re-uploading replaces it; the old file is kept for the audit trail.
ALTER TABLE documents ADD COLUMN status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'replaced'));
ALTER TABLE documents ADD COLUMN replaced_at TEXT;
-- If a day already has several files of one type, keep only the newest as current.
UPDATE documents SET status = 'replaced', replaced_at = uploaded_at
  WHERE EXISTS (SELECT 1 FROM documents d2 WHERE d2.reconciliation_id = documents.reconciliation_id AND d2.doc_type = documents.doc_type
                AND (d2.uploaded_at > documents.uploaded_at OR (d2.uploaded_at = documents.uploaded_at AND d2.id > documents.id)));
CREATE UNIQUE INDEX IF NOT EXISTS documents_one_current ON documents (reconciliation_id, doc_type) WHERE status = 'current';
