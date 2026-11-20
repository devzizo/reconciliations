// Browser tests for stages 1-3: photograph → numbers read → review against the balance rules → save.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startTestServer, USERS } from '../helpers/server.js';
import { liveFrameJpeg, MINIMAL_PDF } from '../helpers/jpeg.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* skipped below */ }

const READINGS = {
  z_report: { gross_sales: 467800, discount: -10891, net_sales: 456700, cash: 58400, mada: 279300, visa: 119000 },
  // As written on the Tabuk form, but with visa misread as 1100 → payments don't add up.
  daily_closing_form: { gross_sales: 456700, returns: 0, net_sales: 456700, mada: 279300, mastercard: 4500, visa: 110000, tamara: 0, tabby: 0, cash_sales: 58400,
    overage_shortage: 0, opening_cash_balance: null, cash_inflow: 58400, cash_outflow: 2000, closing_cash_balance: 67000 },
};

let srv;
let browser;
before(async () => {
  if (!chromium) return;
  srv = await startTestServer({
    documentReader: {
      provider: 'test-ai',
      async read({ docType }) {
        return { status: 'completed', model: 'm', fields: READINGS[docType], lowConfidence: docType === 'z_report' ? ['visa'] : ['visa'], issues: docType === 'z_report' ? ['تم جمع تقريري Z.'] : [] };
      },
    },
  });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.close(); });

async function openDay(date) {
  const page = await (await browser.newContext({ locale: 'ar-SA' })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(srv.base);
  await page.fill('input[name=username]', USERS.tabuk[0]);
  await page.fill('input[name=password]', USERS.tabuk[1]);
  await page.click('[data-testid=login]');
  await page.fill('input[type=date]', date);
  await page.click('[data-testid=open-day]');
  await page.waitForSelector('section[data-stage=daily_closing_form]');
  return { page, errors };
}

test('page is Arabic, right-to-left and light', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page } = await openDay('2026-11-10');
  assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
  assert.equal(await page.getAttribute('html', 'lang'), 'ar');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, 'rgb(245, 246, 248)');
  // Paper-form sections in order.
  const bars = await page.locator('section[data-stage=daily_closing_form] .section-bar > span:first-child').allTextContents();
  assert.deepEqual(bars, ['المبيعات الإجمالية والتسويات', 'تفاصيل وسائل الدفع (POS & Online)', 'حركة صندوق النقدية (الكاش)', 'ملاحظات']);
  assert.match(await page.textContent('.day-head'), /الفرع: تبوك/);
});

test('photographing the closing form fills the fields; save waits until both rules balance', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page, errors } = await openDay('2026-11-19');
  const form = page.locator('section[data-stage=daily_closing_form]');
  // The camera button opens the phone camera (capture=environment); here we hand it a photo.
  assert.equal(await form.locator('[data-testid=camera-daily_closing_form]').getAttribute('capture'), 'environment');
  await form.locator('[data-testid=camera-daily_closing_form]').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: liveFrameJpeg() });
  await page.waitForSelector('section[data-stage=daily_closing_form] input.suggested');

  assert.equal(await form.locator('input[name=net_sales]').inputValue(), '4567.00');
  assert.equal(await form.locator('[data-testid=payments-total]').textContent(), '4522.00');
  const checks = await form.locator('[data-testid=checks] p').allTextContents();
  assert.match(checks[0], /^✓/);
  assert.match(checks[1], /^✗ مجموع طرق الدفع = 4522\.00/);
  assert.equal(await form.locator('[data-testid=save-daily_closing_form]').isDisabled(), true, 'cannot save while unbalanced');

  // Employee compares with the paper and fixes visa (typing Arabic digits on the phone keyboard).
  await form.locator('input[name=visa]').fill('١١٤٥');
  assert.match((await form.locator('[data-testid=checks] p').allTextContents())[1], /^✓/);
  await form.locator('[data-testid=save-daily_closing_form]').click();
  await page.waitForSelector('section[data-stage=daily_closing_form] .check:has-text("✓")');
  const row = await srv.db.get("SELECT data_json FROM stage_figures WHERE stage = 'daily_closing_form'");
  assert.equal(JSON.parse(row.data_json).visa, 114500);

  // One file per day: replacing asks for confirmation and keeps a single current file.
  page.once('dialog', (d) => d.accept());
  await form.locator('[data-testid=file-daily_closing_form]').setInputFiles({ name: 'form.pdf', mimeType: 'application/pdf', buffer: MINIMAL_PDF });
  await page.waitForSelector('section[data-stage=daily_closing_form] .doc-name:has-text("form.pdf")');
  assert.equal((await srv.db.get("SELECT COUNT(*) AS n FROM documents WHERE doc_type = 'daily_closing_form' AND status = 'current'")).n, 1);
  assert.deepEqual(errors, []);
});

test('Z report upload fills figures for review and saves', { skip: !chromium && 'playwright not installed' }, async () => {
  const { page } = await openDay('2026-11-18');
  const z = page.locator('section[data-stage=z_report]');
  await z.locator('[data-testid=file-z_report]').setInputFiles({ name: 'z.pdf', mimeType: 'application/pdf', buffer: MINIMAL_PDF });
  await page.waitForSelector('section[data-stage=z_report] input.suggested');
  assert.equal(await z.locator('input[name=discount]').inputValue(), '-108.91');
  assert.match(await z.locator('input[name=visa]').getAttribute('class'), /low/);
  assert.match(await z.textContent(), /تم جمع تقريري Z/);
  assert.equal(await srv.db.get("SELECT 1 FROM stage_figures WHERE stage = 'z_report'"), null, 'nothing saved before review');
  await z.locator('input[name=visa]').fill('1145.00');
  await z.locator('[data-testid=save-z_report]').click();
  await page.waitForSelector('section[data-stage=z_report] .check:has-text("✓")');
  assert.equal(JSON.parse((await srv.db.get("SELECT data_json FROM stage_figures WHERE stage = 'z_report'")).data_json).visa, 114500);
});
