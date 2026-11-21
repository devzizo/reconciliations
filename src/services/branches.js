import crypto from 'node:crypto';

/**
 * Branches come from what is written on the paper form — nothing needs to be set up in advance.
 * Names are matched loosely so that "فرع تبوك", "تبوك" and "تَبوك" are the same branch.
 */
export function normaliseBranchName(name) {
  let s = String(name ?? '').normalize('NFKC').toLowerCase();
  s = s.replace(/[ً-ٰٟـ]/g, '');            // diacritics, tatweel
  s = s.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const words = s.split(/\s+/).filter(Boolean)
    .filter((w) => !['فرع', 'الفرع', 'branch'].includes(w))
    .map((w) => (w.length > 3 && w.startsWith('ال') ? w.slice(2) : w));
  return words.join(' ');
}

/** Find the branch with this (normalised) name, or create it. Returns the branch row, or null for an empty name. */
export async function findOrCreateBranch(db, writtenName) {
  const display = String(writtenName ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const norm = normaliseBranchName(display);
  if (!norm) return null;
  const existing = await db.get('SELECT * FROM branches WHERE norm_name = ?', norm);
  if (existing) return existing;
  const id = `b-${crypto.randomBytes(5).toString('hex')}`;
  try {
    await db.run('INSERT INTO branches (id, name, name_ar, active, norm_name) VALUES (?, ?, ?, 1, ?)', id, display, display, norm);
  } catch (err) {
    if (!/UNIQUE/i.test(String(err?.message))) throw err; // created concurrently
  }
  return db.get('SELECT * FROM branches WHERE norm_name = ?', norm);
}
