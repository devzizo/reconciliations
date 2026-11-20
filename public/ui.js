// Small DOM + API helpers. No inline scripts or styles (CSP).

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'hidden') el.hidden = Boolean(v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

let authToken = null;
try { authToken = sessionStorage.getItem('authToken'); } catch { /* storage may be blocked */ }

export function setAuthToken(t) {
  authToken = t;
  try { t ? sessionStorage.setItem('authToken', t) : sessionStorage.removeItem('authToken'); } catch { /* ignore */ }
}
export const hasAuthToken = () => Boolean(authToken);

export async function api(path, { method = 'GET', body, rawBody, formData, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, cache: 'no-store' };
  if (authToken) init.headers.Authorization = `Bearer ${authToken}`;
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  if (rawBody !== undefined) init.body = rawBody;
  if (formData !== undefined) init.body = formData;
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, 'NETWORK', 'تعذّر الاتصال. تحقق من الإنترنت وحاول مرة أخرى.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data?.error?.code === 'UNAUTHENTICATED') {
      setAuthToken(null);
      window.dispatchEvent(new Event('auth-expired'));
    }
    throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `فشل الطلب (${res.status}).`);
  }
  return data;
}

export const formatSar = (halalas) => (halalas === null || halalas === undefined ? '—' : (halalas / 100).toFixed(2));

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  host.append(el);
  setTimeout(() => el.remove(), 5000);
}

const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

/** Same parsing as the server: halalas, null when empty, undefined when invalid. Accepts Arabic digits. */
export function parseAmount(value) {
  let s = String(value ?? '').trim().replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d]);
  if (s === '') return null;
  s = s.replace(/[٫]/g, '.').replace(/[,،٬\s]/g, '');
  if (!/^-?\d{1,9}(\.\d{1,2})?$/.test(s)) return undefined;
  const neg = s.startsWith('-');
  const [w, f = ''] = s.replace('-', '').split('.');
  const v = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return neg ? -v : v;
}
