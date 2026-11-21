// Browser tests (Chromium with a fake camera): open home page → photograph the closing form → the
// reconciliation is created from the form → photograph the rest → confirm cash → submit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startTestServer } from '../helpers/server.js';
import { fakeReader, TABUK_FORM, TABUK_Z, TABUK_BANK } from '../helpers/flow.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* skipped below */ }
const skip = !chromium && 'playwright not installed';

const reader = fakeReader();
const counter = { provider: 'test-ai', async analyze() { return { status: 'completed', model: 'm', counts: { note_500: 1, note_100: 1, note_50: 1, note_10: 2 }, issues: [] }; } };
let srv;
let browser;
before(async () => {
  if (!chromium) return;
  srv = await startTestServer({ documentReader: reader, cashCounter: counter });
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
});
after(async () => { await browser?.close(); await srv?.close(); });

async function newPage(opts = {}) {
  const context = await browser.newContext({ permissions: ['camera'], ...opts });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
}

async function shoot(page, { frames = 1 } = {}) {
  await page.waitForFunction(() => document.querySelector('video.cam-video')?.videoWidth > 0);
  for (let i = 0; i < frames; i++) {
    await page.waitForSelector('[data-testid=shutter]:not([disabled])');
    await page.click('[data-testid=shutter]');
    await page.waitForFunction((n) => document.querySelectorAll('.thumb').length === n, i + 1);
  }
  assert.equal(await page.locator('input[type=file]').count(), 0, 'no file input');
  assert.equal(await page.locator('.cam-view img').count(), 0, 'no <img> of a captured frame');
  await page.click('[data-testid=camera-done]');
}

test('full flow from the home page; figures are read-only; viewers get QR and link', { skip }, async () => {
  const page = await newPage();
  await page.goto(srv.base);
  assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
  assert.doesNotMatch(await page.textContent('body'), /HOVEN/i, 'no logo on the open home page');
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(246, 247, 251)');

  reader.next('daily_closing_form', TABUK_FORM);
  await page.click('[data-testid=new-match]');
  await shoot(page);
  await page.waitForURL(/\/m\/[\w-]+$/);
  await page.waitForSelector('.big-number');
  assert.equal(await page.textContent('.big-number'), '#1001');
  assert.match(await page.textContent('.facts'), /تبوك.*الخميس.*2026-11-19/s);
  assert.match(await page.textContent('.note.info'), /صحّح الكتابة بخط اليد/);
  assert.equal(await page.locator('main input:not([type=checkbox]), main textarea').count(), 0, 'no editable figures');
  assert.match(await page.textContent('[data-testid=checks]'), /مجموع طرق الدفع = صافي المبيعات/);
  assert.match(await page.textContent('[data-testid=alerts]'), /لم يتم تصوير تقرير Z/);
  assert.match(await page.textContent('[data-testid=share-url]'), /\/m\/[\w-]+$/);

  const doc = async (kind, result, label) => {
    reader.next(kind, result);
    await page.click(`[data-testid=photo-${kind}]`);
    await shoot(page);
    await page.waitForSelector(`[data-doc=${kind}] ${label}`);
  };
  await doc('z_report', TABUK_Z, 'td.num');
  await doc('bank_settlement', TABUK_BANK, 'td.num');
  await doc('deposit_receipt', { fields: { amount: 475000 }, extras: { date: '2026-11-19' } }, 'td.num');
  await doc('expense_invoice', { fields: { amount: 1500 }, extras: { vendor: 'بقالة' } }, '.expense-list');
  // Expense total 15.00 vs 20.00 written → red with the difference.
  assert.match(await page.textContent('[data-testid=checks] li.bad'), /الفرق: -5\.00 ريال/);

  await page.click('[data-testid=photo-cash]');
  await shoot(page, { frames: 2 });
  await page.waitForSelector('[data-testid=cash-total]');
  assert.equal(await page.textContent('[data-testid=cash-total]'), '670.00');
  assert.equal(await page.isDisabled('[data-testid=confirm-cash]'), true);
  await page.check('#confirm-cash');
  await page.click('[data-testid=confirm-cash]');
  await page.waitForSelector('text=النقد المعدود:');

  page.once('dialog', (d) => d.accept());
  await page.click('[data-testid=submit]');
  await page.waitForSelector('.match-head .chip.bad');
  assert.match(await page.textContent('.match-head'), /غير مطابقة/);

  // Someone else opening the link: read-only, QR + copy link, no camera buttons.
  const url = page.url();
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(url);
  await viewer.waitForSelector('.big-number');
  assert.equal(await viewer.locator('[data-testid^=photo-]').count(), 0);
  assert.equal(await viewer.locator('.share img.qr').count(), 1);

  // Another phone's home page shows no reconciliations at all.
  await viewer.goto(srv.base);
  await viewer.waitForSelector('[data-testid=new-match]');
  assert.equal(await viewer.locator('[data-testid=match-card]').count(), 0);

  // The phone that made it sees only its latest reconciliation: number, red status, QR and copy link.
  await page.goto(srv.base);
  await page.waitForSelector('[data-testid=match-card]');
  const card = page.locator('[data-testid=match-card]');
  assert.equal(await card.count(), 1);
  assert.match(await card.textContent(), /#1001.*تبوك.*غير مطابقة/s);
  assert.equal(await card.locator('img.qr').count(), 1);
  assert.equal(await card.locator('[data-testid=copy-link]').count(), 1);
  assert.deepEqual(page.errors, []);
});

for (const [name, init, text] of [
  ['camera permission denied', () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); }, 'تم رفض إذن الكاميرا'],
  ['no camera', () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('none', 'NotFoundError')); }, 'لا توجد كاميرا'],
  ['browser without camera API', () => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined }); }, 'الكاميرا غير مدعومة'],
]) {
  test(`${name} → blocked, no upload alternative`, { skip }, async () => {
    const page = await newPage({ permissions: [] });
    await page.addInitScript(init);
    await page.goto(srv.base);
    await page.click('[data-testid=new-match]');
    await page.waitForSelector(`text=${text}`);
    assert.equal(await page.isDisabled('[data-testid=shutter]'), true);
    assert.equal(await page.isDisabled('[data-testid=camera-done]'), true);
    assert.equal(await page.locator('input[type=file]').count(), 0);
  });
}

test('camera stops mid-capture → capture and sending disabled', { skip }, async () => {
  const page = await newPage();
  await page.goto(srv.base);
  await page.click('[data-testid=new-match]');
  await page.waitForSelector('[data-testid=shutter]:not([disabled])');
  await page.click('[data-testid=shutter]');
  await page.waitForSelector('.thumb canvas');
  await page.evaluate(() => { const t = document.querySelector('video.cam-video').srcObject.getVideoTracks()[0]; t.stop(); t.dispatchEvent(new Event('ended')); });
  await page.waitForSelector('text=توقفت الكاميرا');
  assert.equal(await page.isDisabled('[data-testid=camera-done]'), true);
});

test('unreadable form header → told to photograph again', { skip }, async () => {
  const page = await newPage();
  await page.goto(srv.base);
  reader.next('daily_closing_form', { fields: TABUK_FORM.fields, extras: { branch: 'tabuk', date: null } });
  await page.click('[data-testid=new-match]');
  await shoot(page);
  await page.waitForSelector('.cam-result:not([hidden])');
  assert.match(await page.textContent('.cam-result'), /تعذّر قراءة التاريخ/);
  await page.waitForSelector('[data-testid=shutter]:not([disabled])'); // ready to photograph again
});

test('Arabic camera name (Arabic-language phones) does not break taking a photo', { skip }, async () => {
  const page = await newPage();
  await page.addInitScript(() => { Object.defineProperty(MediaStreamTrack.prototype, 'label', { get: () => 'الكاميرا الخلفية' }); });
  await page.goto(srv.base);
  await page.click('[data-testid=new-match]');
  await page.waitForSelector('[data-testid=shutter]:not([disabled])');
  await page.click('[data-testid=shutter]');
  await page.waitForSelector('.thumb canvas');
  assert.equal(await page.locator('.toast.error').count(), 0);
  const c = await srv.db.get("SELECT id FROM captures ORDER BY captured_at DESC LIMIT 1");
  const audit = await srv.db.get("SELECT details_json FROM audit_log WHERE action = 'camera.captured' AND entity_id = ?", c.id);
  assert.equal(JSON.parse(audit.details_json).clientMeta.trackLabel, 'الكاميرا الخلفية');
});
