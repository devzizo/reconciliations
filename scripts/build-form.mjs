#!/usr/bin/env node
// Renders forms/daily-closing-form.html to public/daily-closing-form.pdf with Chromium (fonts embedded,
// so the PDF prints correctly on any device). Run after editing the form: node scripts/build-form.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontDir = path.join(root, 'node_modules/@fontsource/noto-sans-arabic/files');
const face = (weight) => `@font-face { font-family: "Noto Sans Arabic"; font-weight: ${weight}; src: url(data:font/woff2;base64,${fs.readFileSync(path.join(fontDir, `noto-sans-arabic-arabic-${weight}-normal.woff2`)).toString('base64')}) format("woff2"); }`;
const html = fs.readFileSync(path.join(root, 'forms/daily-closing-form.html'), 'utf8')
  .replace('/* Fonts are inlined by scripts/build-form.mjs */', `${face(400)}\n${face(700)}`);

const { chromium } = require('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.pdf({ path: path.join(root, 'public/daily-closing-form.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
await page.setViewportSize({ width: 794, height: 1123 });
await page.screenshot({ path: process.argv[2] ?? '/dev/null', fullPage: true });
await browser.close();
console.log(`public/daily-closing-form.pdf (${fs.statSync(path.join(root, 'public/daily-closing-form.pdf')).size} bytes)`);
