/** Saudi riyal denominations. Values are held in halalas (1 SAR = 100 halalas) to avoid float drift. */
export const DENOMINATIONS = Object.freeze([
  { id: 'note_500', kind: 'note', label: '500 SAR', labelAr: '٥٠٠ ريال', halalas: 50000 },
  { id: 'note_200', kind: 'note', label: '200 SAR', labelAr: '٢٠٠ ريال', halalas: 20000 },
  { id: 'note_100', kind: 'note', label: '100 SAR', labelAr: '١٠٠ ريال', halalas: 10000 },
  { id: 'note_50', kind: 'note', label: '50 SAR', labelAr: '٥٠ ريال', halalas: 5000 },
  { id: 'note_20', kind: 'note', label: '20 SAR', labelAr: '٢٠ ريال', halalas: 2000 },
  { id: 'note_10', kind: 'note', label: '10 SAR', labelAr: '١٠ ريال', halalas: 1000 },
  { id: 'note_5', kind: 'note', label: '5 SAR', labelAr: '٥ ريال', halalas: 500 },
  { id: 'note_1', kind: 'note', label: '1 SAR note', labelAr: '١ ريال (ورقي)', halalas: 100 },
  { id: 'coin_2', kind: 'coin', label: '2 SAR coin', labelAr: '٢ ريال (معدني)', halalas: 200 },
  { id: 'coin_1', kind: 'coin', label: '1 SAR coin', labelAr: '١ ريال (معدني)', halalas: 100 },
  { id: 'coin_50h', kind: 'coin', label: '50 halala', labelAr: '٥٠ هللة', halalas: 50 },
  { id: 'coin_25h', kind: 'coin', label: '25 halala', labelAr: '٢٥ هللة', halalas: 25 },
  { id: 'coin_10h', kind: 'coin', label: '10 halala', labelAr: '١٠ هللات', halalas: 10 },
  { id: 'coin_5h', kind: 'coin', label: '5 halala', labelAr: '٥ هللات', halalas: 5 },
]);

export const DENOMINATION_IDS = DENOMINATIONS.map((d) => d.id);
const BY_ID = new Map(DENOMINATIONS.map((d) => [d.id, d]));

export const MAX_PIECES_PER_DENOMINATION = 100_000;

/** Normalise a {id: count} map: every denomination present, non-negative integers only. Throws on bad input. */
export function normaliseCounts(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('counts must be an object keyed by denomination id');
  }
  for (const key of Object.keys(input)) {
    if (!BY_ID.has(key)) throw new TypeError(`unknown denomination: ${key}`);
  }
  const out = {};
  for (const id of DENOMINATION_IDS) {
    const v = input[id] ?? 0;
    if (!Number.isInteger(v) || v < 0 || v > MAX_PIECES_PER_DENOMINATION) {
      throw new TypeError(`count for ${id} must be an integer between 0 and ${MAX_PIECES_PER_DENOMINATION}`);
    }
    out[id] = v;
  }
  return out;
}

export function zeroCounts() {
  return Object.fromEntries(DENOMINATION_IDS.map((id) => [id, 0]));
}

export function totalHalalas(counts) {
  let sum = 0;
  for (const id of DENOMINATION_IDS) sum += (counts[id] ?? 0) * BY_ID.get(id).halalas;
  return sum;
}

export function formatSar(halalas) {
  return (halalas / 100).toFixed(2);
}
