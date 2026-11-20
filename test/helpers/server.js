import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db.js';
import { createApp } from '../../src/app.js';

/** Start an isolated server on an ephemeral port with a throwaway data directory. */
export async function startTestServer(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-test-'));
  const config = loadConfig({ dataDir, requireHttps: false, aiProvider: 'none', ...overrides });
  const db = openDatabase(config);
  const app = createApp({ db, config });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, { token, json, body, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload = body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }

  async function login(username, password) {
    const r = await call('POST', '/api/auth/login', { json: { username, password } });
    if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.data)}`);
    return r.data.token;
  }

  return {
    base, db, config, call, login,
    async close() { await new Promise((r) => server.close(r)); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

export const USERS = {
  tabuk: ['tabuk.employee', 'change-me-tabuk'],
  najran: ['najran.employee', 'change-me-najran'],
  manager: ['finance.manager', 'change-me-manager'],
};
