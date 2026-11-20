// Stores binary files as base64 chunks in the database, so the same code works on SQLite and
// Cloudflare D1 (D1 caps a single value at ~2 MB, and base64 text avoids slow BLOB array conversion).
const CHUNK = 1_000_000; // raw bytes per chunk → ~1.33 MB of base64

export function createFileStore(db) {
  return {
    async put(key, buf) {
      await db.run('DELETE FROM file_chunks WHERE file_key = ?', key);
      let idx = 0;
      for (let i = 0; i < buf.length; i += CHUNK) {
        await db.run('INSERT INTO file_chunks (file_key, idx, data) VALUES (?, ?, ?)', key, idx++, buf.subarray(i, i + CHUNK).toString('base64'));
      }
    },
    async get(key) {
      const rows = await db.all('SELECT data FROM file_chunks WHERE file_key = ? ORDER BY idx', key);
      return rows.length ? Buffer.concat(rows.map((r) => Buffer.from(r.data, 'base64'))) : null;
    },
  };
}
