// Cloudflare D1 adapter. Same interface as ./sqlite.js.
export function openD1(binding) {
  const bind = (sql, p) => binding.prepare(sql).bind(...p.map((v) => (v === undefined ? null : v)));
  return {
    kind: 'd1',
    async get(sql, ...p) { return (await bind(sql, p).first()) ?? null; },
    async all(sql, ...p) { return (await bind(sql, p).all()).results; },
    async run(sql, ...p) { const r = await bind(sql, p).run(); return { changes: r.meta?.changes ?? 0 }; },
    close() {},
  };
}
