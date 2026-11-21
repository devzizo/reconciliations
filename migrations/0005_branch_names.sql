-- Branches are taken from the name written on the form; norm_name is its normalised form
-- (see src/services/branches.js) and identifies the branch.
ALTER TABLE branches ADD COLUMN norm_name TEXT;
UPDATE branches SET norm_name = 'تبوك' WHERE id = 'tabuk';
UPDATE branches SET norm_name = 'نجران' WHERE id = 'najran';
CREATE UNIQUE INDEX IF NOT EXISTS branches_norm_name ON branches (norm_name) WHERE norm_name IS NOT NULL;
-- Cash count details (banknote serial numbers, duplicates) and the stored notes report.
ALTER TABLE matches ADD COLUMN report_json TEXT;

-- Banknote serial numbers read in each cash count, to detect the same notes shown in another branch's count.
CREATE TABLE IF NOT EXISTS cash_serials (
  reading_id TEXT NOT NULL REFERENCES readings(id),
  match_id TEXT NOT NULL REFERENCES matches(id),
  serial TEXT NOT NULL,
  denomination TEXT NOT NULL,
  PRIMARY KEY (reading_id, serial)
);
CREATE INDEX IF NOT EXISTS cash_serials_serial ON cash_serials (serial);
