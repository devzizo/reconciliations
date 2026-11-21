import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../../src/services/checks.js';
import { TABUK_FORM, TABUK_Z, TABUK_BANK } from '../helpers/flow.js';

const rd = (r) => ({ status: 'completed', lowConfidence: [], issues: [], extras: {}, ...r });
const base = (over = {}) => ({
  docs: { daily_closing_form: rd(TABUK_FORM), z_report: rd(TABUK_Z), bank_settlement: rd(TABUK_BANK), deposit_receipt: rd({ fields: { amount: 475000 }, extras: { date: '2026-11-19' } }) },
  expenses: [rd({ fields: { amount: 2000 } })],
  cash: { totalHalalas: 67000 },
  yesterday: { number: 1000, closingCashHalalas: 475000 },
  businessDate: '2026-11-19',
  ...over,
});

test('the Tabuk documents all match', () => {
  const e = evaluate(base());
  assert.deepEqual(e.checks.filter((c) => !c.ok), []);
  assert.deepEqual(e.missing, []);
  assert.deepEqual(e.warnings, []);
  assert.equal(e.result, 'matched');
});

test('differences under 0.30 SAR are matched and not mentioned; 0.30 and above are red with the difference', () => {
  const small = evaluate(base({ cash: { totalHalalas: 67000 - 29 } }));
  const c1 = small.checks.find((c) => c.id === 'cash');
  assert.equal(c1.ok, true);
  assert.equal(c1.diffHalalas, 0);
  assert.doesNotMatch(c1.text, /الفرق/);
  assert.equal(small.result, 'matched');

  const big = evaluate(base({ cash: { totalHalalas: 67000 - 30 } }));
  const c2 = big.checks.find((c) => c.id === 'cash');
  assert.equal(c2.ok, false);
  assert.equal(c2.diffHalalas, -30);
  assert.equal(c2.text, 'النقد المعدود ↔ رصيد الصندوق آخر اليوم: غير مطابق — الفرق -0.30 ريال');
  assert.equal(big.result, 'unmatched');
});

test('gross − returns = net and payments = net', () => {
  const f = { ...TABUK_FORM.fields, returns: 1000 };
  const e = evaluate(base({ docs: { ...base().docs, daily_closing_form: rd({ ...TABUK_FORM, fields: f }) } }));
  assert.equal(e.checks.find((c) => c.id === 'sales').text, 'إجمالي المبيعات − المرتجعات = صافي المبيعات: غير مطابق — الفرق -10.00 ريال');
  const g = { ...TABUK_FORM.fields, visa: 110000 };
  const e2 = evaluate(base({ docs: { ...base().docs, daily_closing_form: rd({ ...TABUK_FORM, fields: g }) } }));
  assert.match(e2.checks.find((c) => c.id === 'payments').text, /الفرق -45\.00/);
});

test('empty and unclear fields are yellow warnings', () => {
  const f = { ...TABUK_FORM.fields, tamara: null };
  const e = evaluate(base({ docs: { ...base().docs, daily_closing_form: rd({ ...TABUK_FORM, fields: f, lowConfidence: ['visa'] }) } }));
  assert.ok(e.warnings.some((w) => w.text === 'اليومية: خانة «تمارا» فارغة.'));
  assert.ok(e.warnings.some((w) => w.text === 'اليومية: خانة «فيزا» غير واضحة في الصورة.'));
});

test('expense invoices are required when an expense is written, and must add up', () => {
  const none = evaluate(base({ expenses: [] }));
  assert.ok(none.missing.some((m) => m.kind === 'expense_invoice'));
  const short = evaluate(base({ expenses: [rd({ fields: { amount: 1500 } })] }));
  assert.match(short.checks.find((c) => c.id === 'expenses').text, /الفرق -5\.00/);
  // A 0.20 SAR expense does not require an invoice.
  const tiny = evaluate(base({ expenses: [], docs: { ...base().docs, daily_closing_form: rd({ ...TABUK_FORM, fields: { ...TABUK_FORM.fields, cash_outflow: 20 } }) } }));
  assert.ok(!tiny.missing.some((m) => m.kind === 'expense_invoice'));
});

test('deposit is compared with yesterday\'s closing cash; no yesterday → warning', () => {
  const off = evaluate(base({ yesterday: { number: 1000, closingCashHalalas: 470000 } }));
  assert.match(off.checks.find((c) => c.id === 'deposit').text, /الفرق 50\.00/);
  const noY = evaluate(base({ yesterday: null }));
  assert.ok(noY.warnings.some((w) => /لا توجد مطابقة ليوم أمس/.test(w.text)));
  assert.equal(noY.checks.find((c) => c.id === 'deposit'), undefined);
});

test('weekday written on the form must agree with the date', () => {
  const e = evaluate(base({ docs: { ...base().docs, daily_closing_form: rd({ ...TABUK_FORM, extras: { ...TABUK_FORM.extras, day_name: 'الجمعة' } }) } }));
  assert.ok(e.warnings.some((w) => /لا يوافق التاريخ/.test(w.text)));
  const ok = evaluate(base({ docs: { ...base().docs, daily_closing_form: rd({ ...TABUK_FORM, extras: { ...TABUK_FORM.extras, day_name: 'خميس' } }) } }));
  assert.ok(!ok.warnings.some((w) => /لا يوافق التاريخ/.test(w.text)));
});
