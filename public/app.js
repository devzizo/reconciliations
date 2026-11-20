import { h, api, setAuthToken, hasAuthToken, formatSar, toast } from './ui.js';
import { openCashCount } from './cash-camera.js';

const root = document.getElementById('app');
let me = null;
const suggestions = new Map(); // `${reconciliationId}:${stage}` → AI extraction awaiting review

window.addEventListener('auth-expired', () => { me = null; renderLogin('Your session expired. Sign in again.'); });

async function boot() {
  if (!hasAuthToken()) return renderLogin();
  try {
    me = await api('/me');
    renderHome();
  } catch {
    renderLogin();
  }
}

function renderLogin(message) {
  const user = h('input', { name: 'username', autocomplete: 'username', required: true, autocapitalize: 'off' });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const form = h('form', { class: 'card narrow' },
    h('h1', {}, 'Branch Reconciliation'),
    h('p', { class: 'muted', dir: 'rtl' }, 'تسوية الفرع اليومية'),
    message ? h('p', { class: 'note warn' }, message) : null,
    h('label', {}, 'Username', user),
    h('label', {}, 'Password', pass),
    h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/auth/login', { method: 'POST', body: { username: user.value, password: pass.value } });
      setAuthToken(res.token);
      me = await api('/me');
      renderHome();
    } catch (err) { toast(err.message, 'error'); }
  });
  root.replaceChildren(form);
}

function topBar() {
  return h('header', { class: 'topbar' },
    h('strong', {}, 'Reconciliation'),
    h('span', { class: 'muted' }, `${me.user.displayName}${me.user.branchId ? ` · ${me.user.branchId}` : ''}`),
    h('span', {},
      h('button', { class: 'btn ghost small', type: 'button', onclick: renderChangePassword }, 'Change password'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: async () => {
        try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
        setAuthToken(null); renderLogin();
      } }, 'Sign out')));
}

function renderChangePassword() {
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '10' });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '10' });
  const form = h('form', { class: 'card narrow' },
    h('h2', {}, 'Change password · تغيير كلمة المرور'),
    h('label', {}, 'Current password', current),
    h('label', {}, 'New password (at least 10 characters)', next),
    h('label', {}, 'Repeat new password', again),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', type: 'button', onclick: renderHome }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (next.value !== again.value) return toast('The new passwords do not match.', 'error');
    try {
      await api('/auth/password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value } });
      toast('Password changed.', 'ok');
      renderHome();
    } catch (err) { toast(err.message, 'error'); }
  });
  root.replaceChildren(topBar(), form);
}

async function renderHome() {
  const { reconciliations } = await api('/reconciliations');
  const today = new Date();
  const dateInput = h('input', { type: 'date', value: today.toISOString().slice(0, 10), required: true });
  const createForm = me.user.role === 'employee'
    ? h('form', { class: 'card row' }, h('label', {}, 'Business date', dateInput), h('button', { class: 'btn primary', type: 'submit' }, 'Open day'))
    : null;
  createForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { reconciliation } = await api('/reconciliations', { method: 'POST', body: { businessDate: dateInput.value } });
      renderReconciliation(reconciliation.id);
    } catch (err) { toast(err.message, 'error'); }
  });
  root.replaceChildren(
    topBar(),
    createForm,
    h('section', { class: 'card' }, h('h2', {}, 'Recent days'),
      reconciliations.length === 0 ? h('p', { class: 'muted' }, 'No reconciliations yet.') : h('ul', { class: 'list' },
        ...reconciliations.map((r) => h('li', {}, h('button', { class: 'link', type: 'button', onclick: () => renderReconciliation(r.id) },
          `${r.businessDate} · ${r.branchId}`), h('span', { class: `pill ${r.status}` }, r.status))))),
  );
}

const STAGES = [
  { key: 'daily_closing_form', n: 1, title: 'Daily closing form', ar: 'نموذج الإقفال اليومي',
    fields: [['gross_sales', 'Gross sales'], ['returns', 'Returns / refunds'], ['net_sales', 'Net sales'], ['mada', 'Mada / POS'], ['mastercard', 'Mastercard'], ['visa', 'Visa'],
      ['tamara', 'Tamara'], ['tabby', 'Tabby'], ['cash_sales', 'Cash sales'], ['opening_cash_balance', 'Opening cash balance'], ['cash_inflow', 'Cash inflow'],
      ['cash_outflow', 'Cash outflow / expenses'], ['closing_cash_balance', 'Closing cash balance']] },
  { key: 'z_report', n: 2, title: 'Z report', ar: 'تقرير Z',
    fields: [['gross_sales', 'Gross sales'], ['discount', 'Discount'], ['net_sales', 'Total net sales'], ['cash', 'Cash'], ['mada', 'Mada'], ['visa', 'Visa']] },
  { key: 'bank_settlement', n: 3, title: 'Bank settlement receipt', ar: 'إيصال تسوية البنك',
    fields: [['mada_total', 'mada total'], ['visa_total', 'Visa total'], ['mastercard_total', 'Mastercard total'], ['transaction_count', 'Transaction count']] },
];

async function renderReconciliation(id) {
  let data;
  try { data = await api(`/reconciliations/${id}`); } catch (err) { toast(err.message, 'error'); return renderHome(); }
  const { reconciliation: rec, stages, summary } = data;
  const editable = rec.status === 'open';

  const docStage = (s) => {
    const st = stages[s.key];
    // AI reading waiting for review (pre-fills the form; nothing is saved until the employee presses Save).
    const sug = suggestions.get(`${id}:${s.key}`);
    const fmt = (f, v) => (v === null || v === undefined ? '' : (f === 'transaction_count' ? String(v) : formatSar(v)));
    const inputs = s.fields.map(([f, label]) => {
      const suggested = sug && sug.status === 'completed' && f in sug.fields;
      const value = suggested ? fmt(f, sug.fields[f]) : fmt(f, st.figures?.[f]);
      const low = suggested && sug.lowConfidence.includes(f);
      const input = h('input', { name: f, inputmode: 'decimal', disabled: !editable, value,
        class: suggested ? (low ? 'suggested low' : 'suggested') : null, title: low ? 'Hard to read — check this one carefully' : null });
      return h('label', { class: 'field' }, low ? `${label} ⚠` : label, input);
    });
    const figForm = h('form', { class: 'grid' }, ...inputs, editable ? h('button', { class: 'btn primary', type: 'submit' }, sug ? 'Checked — save figures' : 'Save figures') : null);
    figForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(figForm).entries());
      if (sug?.extractionId) body.extractionId = sug.extractionId;
      try {
        await api(`/reconciliations/${id}/stages/${s.key}`, { method: 'PUT', body });
        suggestions.delete(`${id}:${s.key}`);
        toast('Saved.', 'ok'); renderReconciliation(id);
      } catch (err) { toast(err.message, 'error'); }
    });

    const readDocument = async (docId) => {
      toast('Reading the numbers from the document… · جاري قراءة الأرقام', 'info');
      try {
        const { extraction } = await api(`/reconciliations/${id}/documents/${docId}/extract`, { method: 'POST' });
        suggestions.set(`${id}:${s.key}`, extraction);
        if (extraction.status === 'completed') toast('Numbers filled in. Check each one against the document, then save.', 'ok');
        else toast(extraction.issues[0] ?? 'Could not read the document. Enter the figures by hand.', 'warn');
      } catch (err) { toast(err.message, 'error'); }
      renderReconciliation(id);
    };

    // Stages 1-3 accept ordinary PDF / image uploads (this is NOT the cash-count stage).
    const file = h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png,image/webp,image/heic', disabled: !editable });
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      const fd = new FormData();
      fd.append('file', file.files[0]);
      let uploaded;
      try { uploaded = await api(`/reconciliations/${id}/documents?type=${s.key}`, { method: 'POST', formData: fd }); toast('Uploaded.', 'ok'); }
      catch (err) { toast(err.message, 'error'); return; }
      if (me.features.aiReading) return readDocument(uploaded.documentId);
      renderReconciliation(id);
    });

    const canRead = editable && me.features.aiReading;
    const reviewNote = sug ? h('div', { class: `note ${sug.status === 'completed' ? '' : 'warn'}` },
      sug.status === 'completed'
        ? h('p', {}, 'The highlighted numbers were read by AI from the document. Compare each one with the document, correct anything wrong, then save. ⚠ marks values that were hard to read. · راجع الأرقام قبل الحفظ')
        : h('p', {}, 'The document could not be read automatically. Enter the figures by hand.'),
      sug.issues.length ? h('ul', { class: 'issues' }, ...sug.issues.map((i) => h('li', {}, i))) : null,
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => { suggestions.delete(`${id}:${s.key}`); renderReconciliation(id); } }, 'Discard AI values')) : null;

    return h('section', { class: `card stage ${st.complete ? 'done' : ''}` },
      h('h3', {}, `${s.n}. ${s.title} `, h('span', { class: 'muted', dir: 'rtl' }, s.ar), h('span', { class: 'check' }, st.complete ? '✓' : '')),
      h('div', { class: 'docs' },
        st.documents.length ? h('ul', { class: 'list small' }, ...st.documents.map((d) => h('li', {},
          h('span', {}, `${d.name || d.docType} · ${(d.size / 1024).toFixed(0)} KB`),
          canRead ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => readDocument(d.id) }, 'Read numbers · قراءة الأرقام') : null)))
          : h('p', { class: 'muted small' }, 'No document uploaded yet.'),
        editable ? h('label', { class: 'upload' }, me.features.aiReading ? 'Upload PDF or photo — the numbers are read automatically' : 'Upload PDF or photo', file) : null),
      reviewNote,
      figForm);
  };

  const cash = stages.cash_count;
  const cashCard = h('section', { class: `card stage ${cash.complete ? 'done' : ''}` },
    h('h3', {}, '4. Physical cash count ', h('span', { class: 'muted', dir: 'rtl' }, 'عدّ النقد'), h('span', { class: 'check' }, cash.complete ? '✓' : '')),
    cash.confirmed
      ? h('div', {}, h('p', {}, h('strong', {}, `${cash.confirmed.total} SAR`), ` confirmed ${new Date(cash.confirmed.confirmedAt).toLocaleString()}`),
        cash.confirmed.adjustments.length ? h('p', { class: 'muted small' }, `${cash.confirmed.adjustments.length} denomination(s) corrected from the AI count.`) : null)
      : h('div', {},
        h('p', { class: 'muted small' }, 'Photograph the cash with the live camera. Photos from the gallery cannot be used.'),
        editable && me.user.role === 'employee'
          ? h('button', { class: 'btn primary', type: 'button', onclick: () => openCashCount({ root, recon: { ...rec, id }, onClose: () => renderReconciliation(id) }) }, '📷 Open camera to count cash')
          : null));

  const diffLine = (label, v) => h('tr', {}, h('td', {}, label), h('td', { class: `num ${v ? 'bad' : ''}` }, formatSar(v)));
  const allDone = Object.values(stages).every((s) => s.complete);
  const summaryCard = h('section', { class: 'card stage' },
    h('h3', {}, '5. Summary ', h('span', { class: 'muted', dir: 'rtl' }, 'الملخص')),
    h('table', { class: 'summary' },
      h('tr', {}, h('td', {}, 'Expected closing cash (form)'), h('td', { class: 'num' }, formatSar(summary.expectedClosingCashHalalas))),
      h('tr', {}, h('td', {}, 'Counted cash (Stage 4)'), h('td', { class: 'num' }, formatSar(summary.countedCashHalalas))),
      diffLine('Cash variance', summary.cashVarianceHalalas),
      diffLine('Z report cash − form cash', summary.zReportVsFormCashHalalas),
      diffLine('Bank mada − form mada', summary.bankVsFormMadaHalalas)),
    editable && me.user.role === 'employee'
      ? h('button', { class: 'btn primary', type: 'button', disabled: !allDone, onclick: async () => {
        try { await api(`/reconciliations/${id}/submit`, { method: 'POST' }); toast('Submitted.', 'ok'); renderReconciliation(id); } catch (err) { toast(err.message, 'error'); }
      } }, 'Submit reconciliation')
      : h('p', { class: 'muted' }, `Status: ${rec.status}`));

  root.replaceChildren(
    topBar(),
    h('div', { class: 'crumbs' }, h('button', { class: 'link', type: 'button', onclick: renderHome }, '← All days'),
      h('span', {}, `${rec.branchName} · ${rec.businessDate}`), h('span', { class: `pill ${rec.status}` }, rec.status)),
    ...STAGES.map(docStage), cashCard, summaryCard);
}

boot();
