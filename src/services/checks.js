/**
 * Reconciliation rules. Pure function of what was read from the photographs.
 *
 *  - Differences smaller than 0.30 SAR (30 halalas) count as matching and are not mentioned.
 *  - A check whose two sides are both known is either "مطابق" (green) or "غير مطابق" (red) with the difference.
 *  - Empty fields, unclear readings and missing documents are yellow warnings.
 *  - The result is "matched" only when every required photograph is present and every check matches.
 */

export const TOLERANCE_HALALAS = 30;

export const FIELD_LABELS = {
  daily_closing_form: {
    gross_sales: 'إجمالي المبيعات', returns: 'المرتجعات', net_sales: 'صافي المبيعات', mada: 'شبكة (مدى)', mastercard: 'ماستر كارد',
    visa: 'فيزا', tamara: 'تمارا', tabby: 'تابي', cash_sales: 'كاش / نقدي', overage_shortage: 'الزيادة / العجز',
    opening_cash_balance: 'رصيد الصندوق أول اليوم', cash_inflow: 'الوارد', cash_outflow: 'المنصرف (مصاريف)', closing_cash_balance: 'رصيد الصندوق آخر اليوم',
  },
  z_report: { gross_sales: 'إجمالي المبيعات', discount: 'الخصم', net_sales: 'صافي المبيعات', cash: 'نقدي', mada: 'مدى', visa: 'فيزا' },
  bank_settlement: { mada_total: 'إجمالي مدى', visa_total: 'إجمالي فيزا', mastercard_total: 'إجمالي ماستر كارد' },
  deposit_receipt: { amount: 'المبلغ المودع' },
  expense_invoice: { amount: 'إجمالي الفاتورة' },
};

export const DOC_NAMES = {
  daily_closing_form: 'اليومية', z_report: 'تقرير Z', bank_settlement: 'إيصال تسوية البنك',
  deposit_receipt: 'إيصال إيداع الكاش (يومية أمس)', expense_invoice: 'فواتير المصروفات', cash: 'عدّ النقد',
};

const PAYMENT_FIELDS = ['mada', 'mastercard', 'visa', 'tamara', 'tabby', 'cash_sales'];
const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const sumOf = (vals) => (vals.some((v) => v === null || v === undefined) ? null : vals.reduce((a, b) => a + b, 0));
const sar = (h) => (h / 100).toFixed(2);
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
export const weekdayOf = (iso) => WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()];
const normaliseDay = (s) => String(s ?? '').replace(/[ًٌٍَُِّْـ\s]/g, '').replace(/^ال/, '').replace(/[أإآ]/g, 'ا').replace(/ة$/, 'ه');

/**
 * @param {object} input
 *   docs: { daily_closing_form, z_report, bank_settlement, deposit_receipt } → reading | null
 *         reading = { fields, extras, lowConfidence, issues, status }
 *   expenses: reading[]
 *   cash: { totalHalalas } | null      (confirmed cash count)
 *   yesterday: { number, closingCashHalalas } | null
 *   businessDate: 'YYYY-MM-DD'
 */
export function evaluate({ docs, expenses = [], cash = null, cashClashes = [], yesterday = null, businessDate }) {
  const checks = [];
  const warnings = [];
  const missing = [];
  const form = docs.daily_closing_form?.fields ?? {};
  const f = (k) => form[k] ?? null;

  const add = (id, title, leftLabel, left, rightLabel, right) => {
    if (left === null || right === null) return; // an empty side is reported as a warning instead
    const diff = left - right;
    const ok = Math.abs(diff) < TOLERANCE_HALALAS;
    checks.push({ id, title, left: { label: leftLabel, halalas: left }, right: { label: rightLabel, halalas: right }, diffHalalas: ok ? 0 : diff, ok,
      text: ok ? `${title}: مطابق` : `${title}: غير مطابق — الفرق ${sar(diff)} ريال` });
  };

  // ---- required photographs
  for (const kind of ['daily_closing_form', 'z_report', 'bank_settlement', 'deposit_receipt']) {
    if (!docs[kind]) missing.push({ kind, text: `لم يتم تصوير ${DOC_NAMES[kind]}.` });
  }
  const outflow = f('cash_outflow');
  const expensesRequired = outflow !== null && outflow >= TOLERANCE_HALALAS;
  if (expensesRequired && expenses.length === 0) missing.push({ kind: 'expense_invoice', text: `يوجد مصروف ${sar(outflow)} ريال في اليومية: صوّر فاتورة المصروف.` });
  if (!cash) missing.push({ kind: 'cash', text: 'لم يتم عدّ النقد بالكاميرا.' });

  // ---- reading quality → yellow
  for (const [kind, r] of Object.entries(docs)) {
    if (!r) continue;
    const labels = FIELD_LABELS[kind];
    if (r.status !== 'completed') { warnings.push({ kind, text: `${DOC_NAMES[kind]}: ${r.issues[0] ?? 'تعذّرت القراءة. أعد التصوير.'}` }); continue; }
    for (const [k, v] of Object.entries(r.fields)) if (v === null && labels[k]) warnings.push({ kind, field: k, text: `${DOC_NAMES[kind]}: خانة «${labels[k]}» فارغة.` });
    for (const k of r.lowConfidence ?? []) if (labels[k]) warnings.push({ kind, field: k, text: `${DOC_NAMES[kind]}: خانة «${labels[k]}» غير واضحة في الصورة.` });
    for (const i of r.issues ?? []) warnings.push({ kind, text: `${DOC_NAMES[kind]}: ${i}` });
  }
  expenses.forEach((r, i) => {
    if (r.status !== 'completed' || r.fields.amount === null) warnings.push({ kind: 'expense_invoice', text: `فاتورة المصروف ${i + 1}: لم يُقرأ إجمالي الفاتورة. أعد تصويرها.` });
    for (const t of r.issues ?? []) warnings.push({ kind: 'expense_invoice', text: `فاتورة المصروف ${i + 1}: ${t}` });
  });

  // ---- dates
  const formExtras = docs.daily_closing_form?.extras ?? {};
  if (formExtras.day_name && businessDate && normaliseDay(formExtras.day_name) !== normaliseDay(weekdayOf(businessDate))) {
    warnings.push({ kind: 'daily_closing_form', text: `اليومية: اليوم المكتوب «${formExtras.day_name}» لا يوافق التاريخ ${businessDate} (${weekdayOf(businessDate)}).` });
  }
  for (const kind of ['z_report', 'bank_settlement']) {
    const d = docs[kind]?.extras?.date;
    if (d && businessDate && Math.abs(dayDiff(d, businessDate)) > 1) warnings.push({ kind, text: `${DOC_NAMES[kind]}: التاريخ ${d} لا يوافق تاريخ اليومية ${businessDate}.` });
  }
  const depDate = docs.deposit_receipt?.extras?.date;
  if (depDate && businessDate && (dayDiff(depDate, businessDate) < -1 || dayDiff(depDate, businessDate) > 1)) {
    warnings.push({ kind: 'deposit_receipt', text: `إيصال الإيداع: تاريخ الإيداع ${depDate} بعيد عن تاريخ المطابقة ${businessDate}.` });
  }

  // ---- the closing form itself
  if (docs.daily_closing_form) {
    add('sales', 'إجمالي المبيعات − المرتجعات = صافي المبيعات',
      'إجمالي المبيعات − المرتجعات', f('gross_sales') === null ? null : f('gross_sales') - (f('returns') ?? 0), 'صافي المبيعات', f('net_sales'));
    add('payments', 'مجموع طرق الدفع = صافي المبيعات',
      'مجموع طرق الدفع', f('net_sales') === null ? null : PAYMENT_FIELDS.reduce((a, k) => a + (f(k) ?? 0), 0), 'صافي المبيعات', f('net_sales'));
  }

  // ---- Z report vs closing form
  const z = docs.z_report?.fields;
  if (z && docs.daily_closing_form) {
    add('z_net', 'صافي المبيعات (تقرير Z ↔ اليومية)', 'تقرير Z', z.net_sales, 'اليومية', f('net_sales'));
    add('z_cash', 'النقدي (تقرير Z ↔ اليومية)', 'تقرير Z', z.cash, 'اليومية', f('cash_sales'));
    add('z_mada', 'مدى (تقرير Z ↔ اليومية)', 'تقرير Z', z.mada, 'اليومية', f('mada'));
    add('z_visa', 'فيزا وماستر كارد (تقرير Z ↔ اليومية)', 'تقرير Z', z.visa, 'اليومية', sumOf([f('visa') ?? 0, f('mastercard') ?? 0]));
  }

  // ---- bank settlement vs closing form
  const bank = docs.bank_settlement?.fields;
  if (bank && docs.daily_closing_form) {
    add('bank_mada', 'مدى (إيصال البنك ↔ اليومية)', 'إيصال البنك', bank.mada_total, 'اليومية', f('mada'));
    add('bank_cards', 'فيزا وماستر كارد (إيصال البنك ↔ اليومية)', 'إيصال البنك',
      bank.visa_total === null && bank.mastercard_total === null ? null : (bank.visa_total ?? 0) + (bank.mastercard_total ?? 0),
      'اليومية', (f('visa') ?? 0) + (f('mastercard') ?? 0));
  }

  // ---- yesterday's cash deposit
  if (docs.deposit_receipt) {
    if (!yesterday) warnings.push({ kind: 'deposit_receipt', text: 'لا توجد مطابقة ليوم أمس لهذا الفرع لمقارنة مبلغ الإيداع.' });
    else if (yesterday.closingCashHalalas === null) warnings.push({ kind: 'deposit_receipt', text: `رصيد الصندوق آخر اليوم فارغ في مطابقة أمس رقم ${yesterday.number}.` });
    else add('deposit', 'الإيداع ↔ رصيد الصندوق آخر يوم أمس', 'إيصال الإيداع', docs.deposit_receipt.fields.amount, `يومية أمس (رقم ${yesterday.number})`, yesterday.closingCashHalalas);
  }

  // ---- expenses
  if (expensesRequired && expenses.length) {
    const amounts = expenses.map((r) => r.fields?.amount ?? null);
    add('expenses', 'فواتير المصروفات ↔ المنصرف في اليومية', `مجموع ${expenses.length} فاتورة`, amounts.some((a) => a === null) ? null : amounts.reduce((a, b) => a + b, 0), 'المنصرف', outflow);
  } else if (!expensesRequired && expenses.length) {
    warnings.push({ kind: 'expense_invoice', text: 'توجد فواتير مصروفات لكن خانة المنصرف في اليومية فارغة أو صفر.' });
  }

  // ---- cash count vs closing balance
  if (cash && docs.daily_closing_form) add('cash', 'النقد المعدود ↔ رصيد الصندوق آخر اليوم', 'النقد المعدود', cash.totalHalalas, 'اليومية', f('closing_cash_balance'));
  for (const i of cash?.issues ?? []) warnings.push({ kind: 'cash', text: `عدّ النقد: ${i}` });
  // The same banknotes in another branch's cash count: the cash may have been shown twice.
  if (cashClashes.length) {
    const seen = [...new Map(cashClashes.map((c) => [`${c.number}`, c])).values()];
    checks.push({ id: 'cash_serials', ok: false, title: 'تكرار أوراق نقدية', flag: true,
      text: `تكرار أوراق نقدية: ${cashClashes.length} ورقة بنفس الأرقام التسلسلية ظهرت في عدّ نقد ${seen.map((c) => `فرع ${c.branch} (مطابقة ${c.number} بتاريخ ${c.business_date})`).join('، ')}. الأرقام: ${cashClashes.slice(0, 5).map((c) => c.serial).join('، ')}${cashClashes.length > 5 ? '…' : ''}` });
  }

  const complete = missing.length === 0;
  return { checks, warnings, missing, complete, result: complete && checks.every((c) => c.ok) ? 'matched' : 'unmatched' };
}
