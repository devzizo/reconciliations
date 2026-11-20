// Browser test of Stage 4 using Chromium's fake camera device.
// Run with: npm run test:e2e   (needs Playwright + Chromium available on the machine)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startTestServer, USERS } from '../helpers/server.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* skipped below */ }

const fakeCounter = {
  provider: 'test-ai',
  async analyze() { return { status: 'completed', model: 'test', counts: { note_100: 2, note_10: 3 }, issues: [] }; },
};

let srv;
let browser;
before(async () => {
  if (!chromium) return;
  srv = await startTestServer({ cashCounter: fakeCounter });
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
});
after(async () => { await browser?.close(); await srv?.close(); });

async function openCashStage(context, date) {
  const page = await context.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.goto(srv.base);
  await page.fill('input[name=username]', USERS.tabuk[0]);
  await page.fill('input[name=password]', USERS.tabuk[1]);
  await page.click('button[type=submit]');
  await page.fill('input[type=date]', date);
  await page.click('text=Open day');
  await page.click('text=Open camera to count cash');
  return page;
}

test('live camera launches, capture uploads, review screen requires confirmation', { skip: !chromium && 'playwright not installed' }, async () => {
  const context = await browser.newContext({ permissions: ['camera'] });
  const page = await openCashStage(context, '2026-11-18');

  // Camera is live: video has frames and the shutter is enabled.
  await page.waitForFunction(() => document.querySelector('video.cam-video')?.videoWidth > 0);
  await page.waitForSelector('button.shutter:not([disabled])');
  assert.equal(await page.locator('.cash-view input[type=file]').count(), 0, 'no file input in Stage 4');
  assert.equal(await page.locator('.cash-view img').count(), 0, 'no <img> that could be saved to Photos');

  // Review is disabled until at least one photograph exists.
  assert.equal(await page.isDisabled('text=Review count'), true);
  await page.click('button.shutter');
  await page.waitForSelector('.thumb canvas');
  await page.click('button.shutter');
  await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 2);

  // Retake removes one.
  await page.locator('.thumb button', { hasText: 'Retake' }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.thumb').length === 1);

  const imgs = srv.db.prepare('SELECT status FROM cash_images ORDER BY seq').all().map((r) => r.status);
  assert.deepEqual(imgs, ['retaken', 'active']);

  await page.click('text=Review count');
  await page.waitForSelector('table.denoms');
  // Camera released after capture.
  assert.equal(await page.evaluate(() => document.querySelector('video.cam-video')?.srcObject ?? null), null);

  const submit = page.locator('button', { hasText: 'Confirm cash count' });
  assert.equal(await submit.isDisabled(), true, 'confirm disabled until checkbox ticked');
  await page.fill('input[aria-label="Count of 10 SAR"]', '4');
  await page.check('#confirm-count');
  assert.match(await page.textContent('.grand-total'), /240\.00 SAR/);
  await submit.click();
  await page.waitForSelector('text=240.00 SAR');

  const row = srv.db.prepare('SELECT * FROM cash_counts').get();
  assert.equal(row.total_halalas, 24000);
  assert.deepEqual(JSON.parse(row.adjustments_json), [{ denomination: 'note_10', ai: 3, confirmed: 4 }]);
  await context.close();
});

test('camera permission denied → capture and submission blocked', { skip: !chromium && 'playwright not installed' }, async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  const page = await openCashStage(context, '2026-11-17');
  await page.waitForSelector('text=Camera permission denied');
  assert.equal(await page.isDisabled('button.shutter'), true);
  assert.equal(await page.isDisabled('text=Review count'), true);
  assert.equal(await page.locator('input[type=file]').count(), 0, 'no upload fallback offered');
  assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM capture_sessions cs JOIN reconciliations r ON r.id = cs.reconciliation_id WHERE r.business_date = '2026-11-17'").get().n, 0);
  await context.close();
});

test('no camera on the device → blocked', { skip: !chromium && 'playwright not installed' }, async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));
  });
  const page = await openCashStage(context, '2026-11-16');
  await page.waitForSelector('text=No camera found');
  assert.equal(await page.isDisabled('button.shutter'), true);
  await context.close();
});

test('browser without camera API → blocked', { skip: !chromium && 'playwright not installed' }, async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined }); });
  const page = await openCashStage(context, '2026-11-15');
  await page.waitForSelector('text=Camera not supported');
  assert.equal(await page.isDisabled('button.shutter'), true);
  await context.close();
});

test('camera stops mid-capture → capture and review disabled', { skip: !chromium && 'playwright not installed' }, async () => {
  const context = await browser.newContext({ permissions: ['camera'] });
  const page = await openCashStage(context, '2026-11-14');
  await page.waitForSelector('button.shutter:not([disabled])');
  await page.click('button.shutter');
  await page.waitForSelector('.thumb canvas');
  assert.equal(await page.isDisabled('text=Review count'), false);
  // Simulate the camera being taken away (e.g. another app grabbed it).
  await page.evaluate(() => {
    const t = document.querySelector('video.cam-video').srcObject.getVideoTracks()[0];
    t.stop();
    t.dispatchEvent(new Event('ended'));
  });
  await page.waitForSelector('text=Camera stopped');
  assert.equal(await page.isDisabled('text=Review count'), true);
  assert.equal(await page.isDisabled('button.shutter'), true);
  await context.close();
});
