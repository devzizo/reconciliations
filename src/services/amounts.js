const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

/**
 * Parse an amount in SAR ("4,567.00", "٤٥٦٧", "-108.91", "4567٫5") into halalas.
 * Returns null for empty input and undefined when the text is not a valid amount.
 */
export function parseAmountToHalalas(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') value = String(value);
  let s = String(value).trim().replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d]);
  if (s === '') return null;
  s = s.replace(/[٫]/g, '.').replace(/[,،٬\s]/g, '').replace(/^\((.*)\)$/, '-$1').replace(/(SAR|ر\.?س\.?|ريال)$/i, '');
  if (!/^-?\d{1,9}(\.\d{1,2})?$/.test(s)) return undefined;
  const negative = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const v = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -v : v;
}
