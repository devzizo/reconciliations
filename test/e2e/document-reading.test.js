// Browser test: uploading a Z report fills the form from the AI reading; the employee reviews and saves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startTestServer, USERS } from '../helpers/server.js';
import { MINIMAL_PDF } from '../helpers/jpeg.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* skipped below */ }

let srv;
let browser;
before(async () => {
  if (!chromium) return;
  srv = await startTestServer({
    documentReader: {
      provider: 'test-ai',
      async read() {
        return { status: 'completed', model: 'm', fields: { gross_sales: 467800, discount: -10891, net_sales: 456700, cash: 58400, mada: 279300, visa: 119000 }, lowConfidence: ['visa'], issues: ['Two Z reports were added together.'] };
      },
    },
  });
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.close(); });

test('upload fills the Z report figures for review; saving stores the checked values', { skip: !chromium && 'playwright not installed' }, async () => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(srv.base);
  await page.fill('input[name=username]', USERS.tabuk[0]);
  await page.fill('input[name=password]', USERS.tabuk[1]);
  await page.click('button[type=submit]');
  await page.fill('input[type=date]', '2026-11-19');
  await page.click('text=Open day');

  const z = page.locator('section.stage', { has: page.locator('h3', { hasText: '2. Z report' }) });
  await z.locator('input[type=file]').setInputFiles({ name: 'z.pdf', mimeType: 'application/pdf', buffer: MINIMAL_PDF });
  await page.waitForSelector('section.stage:has(h3:has-text("2. Z report")) input.suggested');
  const zs = page.locator('section.stage', { has: page.locator('h3', { hasText: '2. Z report' }) });
  assert.equal(await zs.locator('input[name=net_sales]').inputValue(), '4567.00');
  assert.equal(await zs.locator('input[name=discount]').inputValue(), '-108.91');
  assert.match(await zs.locator('input[name=visa]').getAttribute('class'), /low/);
  assert.match(await zs.textContent(), /Two Z reports were added together/);

  // Nothing saved yet.
  assert.equal(await srv.db.get("SELECT 1 FROM stage_figures WHERE stage = 'z_report'"), null);

  await zs.locator('input[name=visa]').fill('1145.00');
  await zs.locator('button', { hasText: 'Checked — save figures' }).click();
  await page.waitForSelector('section.stage:has(h3:has-text("2. Z report")) .check:has-text("✓")');
  const row = await srv.db.get("SELECT data_json FROM stage_figures WHERE stage = 'z_report'");
  assert.equal(JSON.parse(row.data_json).visa, 114500);
  assert.equal(JSON.parse(row.data_json).net_sales, 456700);
});
