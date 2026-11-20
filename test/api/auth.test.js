import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, USERS } from '../helpers/server.js';

test('change password: requires current password, enforces length, signs out other sessions', async () => {
  const srv = await startTestServer();
  try {
    const t1 = await srv.login(...USERS.tabuk);
    const t2 = await srv.login(...USERS.tabuk);
    const bad = await srv.call('POST', '/api/auth/password', { token: t1, json: { currentPassword: 'wrong', newPassword: 'a-long-new-password' } });
    assert.equal(bad.status, 400);
    const weak = await srv.call('POST', '/api/auth/password', { token: t1, json: { currentPassword: USERS.tabuk[1], newPassword: 'short' } });
    assert.equal(weak.data.error.code, 'WEAK_PASSWORD');
    const ok = await srv.call('POST', '/api/auth/password', { token: t1, json: { currentPassword: USERS.tabuk[1], newPassword: 'a-long-new-password' } });
    assert.equal(ok.status, 204);
    assert.equal((await srv.call('GET', '/api/me', { token: t1 })).status, 200, 'current session stays signed in');
    assert.equal((await srv.call('GET', '/api/me', { token: t2 })).status, 401, 'other sessions are signed out');
    assert.equal((await srv.call('POST', '/api/auth/login', { json: { username: USERS.tabuk[0], password: USERS.tabuk[1] } })).status, 401);
    assert.ok(await srv.login(USERS.tabuk[0], 'a-long-new-password'));
  } finally {
    await srv.close();
  }
});
