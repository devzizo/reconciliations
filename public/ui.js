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
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

export async function api(path, { method = 'GET', body, rawBody, headers = {}, editToken } = {}) {
  const init = { method, headers: { ...headers }, cache: 'no-store' };
  if (editToken) init.headers['X-Edit-Token'] = editToken;
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  if (rawBody !== undefined) init.body = rawBody;
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch (err) {
    // Only call it a connection problem when it is one; otherwise show what actually went wrong.
    if (navigator.onLine === false) throw new ApiError(0, 'OFFLINE', 'الجوال غير متصل بالإنترنت. تحقق من الاتصال وحاول مرة أخرى.');
    if (/fetch|load failed|network/i.test(String(err?.message))) throw new ApiError(0, 'NETWORK', 'تعذّر الوصول إلى الخادم. حاول مرة أخرى.');
    throw new ApiError(0, 'CLIENT', `تعذّر إرسال الطلب: ${err?.message ?? err}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `فشل الطلب (${res.status}).`, data?.error?.details);
  return data;
}

// The device that starts a reconciliation keeps its edit token. It never leaves this browser except to the server.
const KEY = (pid) => `edit-token:${pid}`;
export const editTokens = {
  get(pid) { try { return localStorage.getItem(KEY(pid)); } catch { return null; } },
  set(pid, token) { try { localStorage.setItem(KEY(pid), token); } catch { /* storage blocked */ } },
};

// The latest reconciliation started on this phone (the only one shown on the home page).
export const lastMatch = {
  get() { try { return localStorage.getItem('last-match'); } catch { return null; } },
  set(pid) { try { localStorage.setItem('last-match', pid); } catch { /* storage blocked */ } },
};

export const formatSar = (halalas) => (halalas === null || halalas === undefined ? '—' : (halalas / 100).toFixed(2));

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  host.append(el);
  setTimeout(() => el.remove(), 5000);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = h('textarea', { readonly: true, class: 'offscreen' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

/** JSON that is safe in an HTTP header: non-ASCII (e.g. an Arabic camera name) is \u-escaped. */
export function headerJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
