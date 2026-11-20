import { h, api, setAuthToken, hasAuthToken, formatSar, parseAmount, toast } from './ui.js';
import { openCashCount } from './cash-camera.js';

const root = document.getElementById('app');
let me = null;
const suggestions = new Map(); // `${reconciliationId}:${stage}` → AI reading awaiting review

window.addEventListener('auth-expired', () => { me = null; renderLogin('انتهت الجلسة. سجّل الدخول مرة أخرى.'); });

const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const dayName = (iso) => WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()];
const STATUS = { open: 'مفتوحة', submitted: 'مُرسلة' };

async function boot() {
  if (!hasAuthToken()) return renderLogin();
  try {
    me = await api('/me');
    renderHome();
  } catch {
    renderLogin();
  }
}

// ------------------------------------------------------------------ login & account

function renderLogin(message) {
  const user = h('input', { name: 'username', autocomplete: 'username', required: true, autocapitalize: 'off', dir: 'ltr' });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, dir: 'ltr' });
  const form = h('form', { class: 'card narrow' },
    h('div', { class: 'brand' }, 'HOVEN'),
    h('h1', {}, 'التسوية اليومية للفروع'),
    message ? h('p', { class: 'note warn' }, message) : null,
    h('label', {}, 'اسم المستخدم', user),
    h('label', {}, 'كلمة المرور', pass),
    h('button', { class: 'btn primary', type: 'submit', 'data-testid': 'login' }, 'تسجيل الدخول'));
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
    h('strong', { class: 'brand small' }, 'HOVEN'),
    h('span', { class: 'muted' }, me.user.displayName),
    h('span', { class: 'top-actions' },
      h('button', { class: 'btn ghost small', type: 'button', onclick: renderChangePassword }, 'تغيير كلمة المرور'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: async () => {
        try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
        setAuthToken(null); renderLogin();
      } }, 'خروج')));
}

function renderChangePassword() {
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true, dir: 'ltr' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '10', dir: 'ltr' });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '10', dir: 'ltr' });
  const form = h('form', { class: 'card narrow' },
    h('h2', {}, 'تغيير كلمة المرور'),
    h('label', {}, 'كلمة المرور الحالية', current),
    h('label', {}, 'كلمة المرور الجديدة (10 أحرف على الأقل)', next),
    h('label', {}, 'أعد كتابة كلمة المرور الجديدة', again),
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', type: 'button', onclick: renderHome }, 'إلغاء'),
      h('button', { class: 'btn primary', type: 'submit' }, 'حفظ')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (next.value !== again.value) return toast('كلمتا المرور الجديدتان غير متطابقتين.', 'error');
    try {
      await api('/auth/password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value } });
      toast('تم تغيير كلمة المرور.', 'ok');
      renderHome();
    } catch (err) { toast(err.message, 'error'); }
  });
  root.replaceChildren(topBar(), form);
}

// ------------------------------------------------------------------ home

async function renderHome() {
  const { reconciliations } = await api('/reconciliations');
  const dateInput = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10), required: true });
  const createForm = me.user.role === 'employee'
    ? h('form', { class: 'card row' }, h('label', {}, 'تاريخ اليوم', dateInput), h('button', { class: 'btn primary', type: 'submit', 'data-testid': 'open-day' }, 'فتح اليوم'))
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
    h('section', { class: 'card' }, h('h2', {}, 'الأيام السابقة'),
      reconciliations.length === 0 ? h('p', { class: 'muted' }, 'لا توجد تسويات بعد.') : h('ul', { class: 'list' },
        ...reconciliations.map((r) => h('li', {},
          h('button', { class: 'link', type: 'button', onclick: () => renderReconciliation(r.id) }, `${dayName(r.businessDate)} ${r.businessDate} · ${r.branchId}`),
          h('span', { class: `pill ${r.status}` }, STATUS[r.status] ?? r.status))))),
  );
}

// ------------------------------------------------------------------ stage definitions

// Same sections, order and wording as the paper form FIN-DCF-01.
const CLOSING_FORM = [
  { title: 'المبيعات الإجمالية والتسويات', en: 'SALES SUMMARY & ADJUSTMENTS', rows: [
    ['gross_sales', 'إجمالي المبيعات', 'Gross Sales'],
    ['returns', 'المرتجعات', 'Returns / Refunds'],
    ['net_sales', 'صافي المبيعات', 'Net Sales'],
  ] },
  { title: 'تفاصيل وسائل الدفع (POS & Online)', en: 'PAYMENT METHODS BREAKDOWN', payments: true, rows: [
    ['mada', 'شبكة (مدى / POS)', 'Mada / POS Terminal'],
    ['mastercard', 'ماستر كارد', 'Mastercard'],
    ['visa', 'فيزا', 'Visa'],
    ['tamara', 'تمارا', 'Tamara'],
    ['tabby', 'تابي', 'Tabby'],
    ['cash_sales', 'كاش / نقدي', 'Cash Sales'],
    ['overage_shortage', 'الزيادة / العجز', 'Overage / Shortage'],
  ] },
  { title: 'حركة صندوق النقدية (الكاش)', en: 'CASH MOVEMENT & PETTY CASH', rows: [
    ['opening_cash_balance', 'رصيد الصندوق أول اليوم', 'Opening Cash Balance'],
    ['cash_inflow', 'الوارد (إيداعات / نقدي)', 'Cash Inflow'],
    ['cash_outflow', 'المنصرف (مصاريف / استرجاع)', 'Cash Outflow / Expenses'],
    ['closing_cash_balance', 'رصيد الصندوق آخر اليوم', 'Closing Cash Balance'],
  ] },
];
const PAYMENT_FIELDS = ['mada', 'mastercard', 'visa', 'tamara', 'tabby', 'cash_sales'];

const STAGES = [
  { key: 'daily_closing_form', n: 1, title: 'نموذج الإقفال اليومي', docName: 'اليومية', sections: CLOSING_FORM },
  { key: 'z_report', n: 2, title: 'تقرير Z', docName: 'تقرير Z', sections: [{ rows: [
    ['gross_sales', 'إجمالي المبيعات', 'Gross Sales'], ['discount', 'الخصم', 'Discount'], ['net_sales', 'صافي المبيعات', 'Total Net Sales'],
    ['cash', 'نقدي', 'Cash'], ['mada', 'مدى', 'MADA'], ['visa', 'فيزا', 'VISA'],
  ] }] },
  { key: 'bank_settlement', n: 3, title: 'إيصال تسوية البنك', docName: 'إيصال البنك', sections: [{ rows: [
    ['mada_total', 'إجمالي مدى', 'mada'], ['visa_total', 'إجمالي فيزا', 'Visa'], ['mastercard_total', 'إجمالي ماستر كارد', 'Mastercard'],
    ['transaction_count', 'عدد العمليات', 'Count'],
  ] }] },
];

/** Same rules as the server: gross − returns = net, and payment methods = net. */
function closingChecks(v) {
  const n = (k) => v[k] ?? 0;
  const missing = v.gross_sales === null || v.net_sales === null;
  const expectedNet = n('gross_sales') - n('returns');
  const payments = PAYMENT_FIELDS.reduce((a, k) => a + n(k), 0);
  return [
    { ok: !missing && expectedNet === n('net_sales'), text: missing ? 'أدخل إجمالي المبيعات وصافي المبيعات'
      : `إجمالي المبيعات − المرتجعات = ${formatSar(expectedNet)}  ${expectedNet === n('net_sales') ? '=' : '≠'}  صافي المبيعات ${formatSar(n('net_sales'))}` },
    { ok: !missing && payments === n('net_sales'), text: `مجموع طرق الدفع = ${formatSar(payments)}  ${payments === n('net_sales') ? '=' : '≠'}  صافي المبيعات ${formatSar(n('net_sales'))}` },
  ];
}

// ------------------------------------------------------------------ photo → JPEG

/** Phone photos (including iPhone HEIC) are converted to a JPEG of reasonable size before upload. */
async function normaliseImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.9));
    return blob ? new File([blob], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------------------------ day screen

async function renderReconciliation(id) {
  let data;
  try { data = await api(`/reconciliations/${id}`); } catch (err) { toast(err.message, 'error'); return renderHome(); }
  const { reconciliation: rec, stages, summary } = data;
  const editable = rec.status === 'open';

  const docStage = (s) => {
    const st = stages[s.key];
    const sugKey = `${id}:${s.key}`;
    const sug = suggestions.get(sugKey);
    const isClosing = s.key === 'daily_closing_form';
    const fmt = (f, v) => (v === null || v === undefined ? '' : (f === 'transaction_count' ? String(v) : formatSar(v)));

    // ---- document (one per day)
    const readDocument = async (docId) => {
      busy.hidden = false;
      try {
        const { extraction } = await api(`/reconciliations/${id}/documents/${docId}/extract`, { method: 'POST' });
        suggestions.set(sugKey, extraction);
        if (extraction.status === 'completed') toast('تمت قراءة الأرقام. راجع كل رقم مقابل المستند ثم احفظ.', 'ok');
        else toast(extraction.issues[0] ?? 'تعذّرت القراءة. أدخل الأرقام يدويًا.', 'warn');
      } catch (err) { toast(err.message, 'error'); }
      renderReconciliation(id);
    };
    const upload = async (picked) => {
      if (!picked) return;
      if (st.document && !window.confirm(`يوجد ${s.docName} مرفوعة لهذا اليوم. سيتم استبدالها بالملف الجديد. متابعة؟`)) return;
      busy.hidden = false;
      busy.textContent = 'جاري رفع الملف…';
      const file = await normaliseImage(picked);
      const fd = new FormData();
      fd.append('file', file);
      let uploaded;
      try { uploaded = await api(`/reconciliations/${id}/documents?type=${s.key}`, { method: 'POST', formData: fd }); }
      catch (err) { busy.hidden = true; toast(err.message, 'error'); return; }
      suggestions.delete(sugKey);
      if (me.features.aiReading) { busy.textContent = 'جاري قراءة الأرقام من المستند…'; return readDocument(uploaded.documentId); }
      toast('تم رفع الملف.', 'ok');
      renderReconciliation(id);
    };
    // Camera button opens the phone camera directly; the file button accepts PDF or a saved image.
    const cameraInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, 'data-testid': `camera-${s.key}` });
    const fileInput = h('input', { type: 'file', accept: 'application/pdf,image/*', hidden: true, 'data-testid': `file-${s.key}` });
    cameraInput.addEventListener('change', () => upload(cameraInput.files[0]));
    fileInput.addEventListener('change', () => upload(fileInput.files[0]));
    const busy = h('p', { class: 'busy', hidden: true, role: 'status' }, 'جاري قراءة الأرقام من المستند…');

    const docBox = h('div', { class: 'doc-box' },
      st.document
        ? h('p', { class: 'doc-name' }, `📄 ${st.document.name || s.docName} · ${(st.document.size / 1024).toFixed(0)} ك.ب`)
        : h('p', { class: 'muted' }, `لم تُرفع ${s.docName} لهذا اليوم بعد.`),
      editable ? h('div', { class: 'doc-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => cameraInput.click() }, st.document ? `📷 إعادة تصوير ${s.docName}` : `📷 تصوير ${s.docName} بالجوال`),
        h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, st.document ? '📁 استبدال بملف' : '📁 رفع ملف (PDF أو صورة)'),
        st.document && me.features.aiReading ? h('button', { class: 'btn ghost', type: 'button', onclick: () => readDocument(st.document.id) }, '🔍 قراءة الأرقام') : null,
        cameraInput, fileInput) : null,
      busy);

    // ---- figures, laid out like the paper form
    const inputs = new Map();
    const tables = s.sections.map((sec) => {
      const rows = sec.rows.map(([f, ar, en]) => {
        const suggested = sug && sug.status === 'completed' && f in sug.fields;
        const low = suggested && sug.lowConfidence.includes(f);
        const input = h('input', { name: f, inputmode: 'decimal', dir: 'ltr', disabled: !editable, 'aria-label': ar,
          value: suggested ? fmt(f, sug.fields[f]) : fmt(f, st.figures?.[f]),
          class: suggested ? (low ? 'suggested low' : 'suggested') : null, title: low ? 'قراءة غير مؤكدة — راجع هذا الرقم بعناية' : null });
        inputs.set(f, input);
        return h('tr', {}, h('th', { scope: 'row' }, ar, low ? ' ⚠' : '', h('span', { class: 'en' }, en)), h('td', {}, input));
      });
      if (sec.payments) {
        const totalCell = h('td', { class: 'num total', 'data-testid': 'payments-total' });
        rows.push(h('tr', { class: 'sum-row' }, h('th', { scope: 'row' }, 'مجموع طرق الدفع'), totalCell));
        sec.totalCell = totalCell;
      }
      return h('div', { class: 'form-section' },
        sec.title ? h('div', { class: 'section-bar' }, h('span', {}, sec.title), h('span', { class: 'en' }, sec.en)) : null,
        h('table', { class: 'paper' }, h('tbody', {}, ...rows)));
    });

    let notes = null;
    if (isClosing) {
      notes = h('textarea', { name: 'notes', rows: '2', disabled: !editable, 'aria-label': 'ملاحظات' });
      notes.value = st.figures?.notes ?? '';
    }
    const checksBox = isClosing ? h('div', { class: 'checks', 'data-testid': 'checks' }) : null;
    const saveBtn = editable ? h('button', { class: 'btn primary', type: 'submit', 'data-testid': `save-${s.key}` }, sug ? 'راجعت الأرقام — حفظ' : 'حفظ الأرقام') : null;

    const refresh = () => {
      if (!isClosing) return;
      const vals = {};
      let valid = true;
      for (const [f, input] of inputs) {
        const v = parseAmount(input.value);
        input.classList.toggle('invalid', v === undefined);
        if (v === undefined) valid = false;
        vals[f] = v ?? null;
      }
      const payments = PAYMENT_FIELDS.reduce((a, k) => a + (vals[k] ?? 0), 0);
      for (const sec of s.sections) if (sec.totalCell) sec.totalCell.textContent = formatSar(payments);
      const checks = closingChecks(vals);
      checksBox.replaceChildren(...checks.map((c) => h('p', { class: c.ok ? 'ok' : 'bad' }, `${c.ok ? '✓' : '✗'} ${c.text}`)));
      if (saveBtn) saveBtn.disabled = !valid || !checks.every((c) => c.ok);
    };
    for (const input of inputs.values()) input.addEventListener('input', refresh);

    const figForm = h('form', { class: 'figures' }, ...tables,
      isClosing ? h('div', { class: 'form-section' }, h('div', { class: 'section-bar' }, h('span', {}, 'ملاحظات'), h('span', { class: 'en' }, 'NOTES / REMARKS')), notes) : null,
      checksBox,
      saveBtn ? h('div', { class: 'actions' }, saveBtn) : null);
    figForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(figForm).entries());
      if (sug?.extractionId) body.extractionId = sug.extractionId;
      try {
        await api(`/reconciliations/${id}/stages/${s.key}`, { method: 'PUT', body });
        suggestions.delete(sugKey);
        toast('تم الحفظ.', 'ok');
        renderReconciliation(id);
      } catch (err) { toast(err.message, 'error'); }
    });

    const reviewNote = sug ? h('div', { class: `note ${sug.status === 'completed' ? '' : 'warn'}` },
      h('p', {}, sug.status === 'completed'
        ? 'الأرقام المظللة قرأها الذكاء الاصطناعي من المستند. قارن كل رقم بالمستند وصحّح أي خطأ ثم احفظ. علامة ⚠ تعني أن الرقم صعب القراءة.'
        : 'تعذّرت قراءة المستند آليًا. أدخل الأرقام يدويًا.'),
      sug.issues.length ? h('ul', { class: 'issues' }, ...sug.issues.map((i) => h('li', {}, i))) : null,
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => { suggestions.delete(sugKey); renderReconciliation(id); } }, 'تجاهل الأرقام المقروءة')) : null;

    const section = h('section', { class: `card stage ${st.complete ? 'done' : ''}`, 'data-stage': s.key },
      h('h3', {}, `${s.n}. ${s.title}`, h('span', { class: 'check' }, st.complete ? '✓' : '')),
      docBox, reviewNote, figForm);
    refresh();
    return section;
  };

  const cash = stages.cash_count;
  const cashCard = h('section', { class: `card stage ${cash.complete ? 'done' : ''}`, 'data-stage': 'cash_count' },
    h('h3', {}, '4. عدّ النقد', h('span', { class: 'check' }, cash.complete ? '✓' : '')),
    cash.confirmed
      ? h('div', {}, h('p', {}, h('strong', {}, `${cash.confirmed.total} ريال`), ` · تم التأكيد ${new Date(cash.confirmed.confirmedAt).toLocaleString('ar-SA')}`),
        cash.confirmed.adjustments.length ? h('p', { class: 'muted small' }, `تم تصحيح ${cash.confirmed.adjustments.length} فئة عن عدّ الذكاء الاصطناعي.`) : null)
      : h('div', {},
        h('p', { class: 'muted small' }, 'صوّر النقد بالكاميرا المباشرة. لا يمكن استخدام صور من المعرض.'),
        editable && me.user.role === 'employee'
          ? h('button', { class: 'btn primary', type: 'button', 'data-testid': 'open-camera', onclick: () => openCashCount({ root, recon: { ...rec, id }, onClose: () => renderReconciliation(id) }) }, '📷 فتح الكاميرا لعدّ النقد')
          : null));

  const diffLine = (label, v) => h('tr', {}, h('td', {}, label), h('td', { class: `num ${v ? 'bad' : ''}`, dir: 'ltr' }, formatSar(v)));
  const allDone = Object.values(stages).every((s) => s.complete);
  const summaryCard = h('section', { class: 'card stage', 'data-stage': 'summary' },
    h('h3', {}, '5. الملخص'),
    h('table', { class: 'summary' },
      h('tr', {}, h('td', {}, 'رصيد الصندوق المتوقع (من اليومية)'), h('td', { class: 'num', dir: 'ltr' }, formatSar(summary.expectedClosingCashHalalas))),
      h('tr', {}, h('td', {}, 'النقد المعدود'), h('td', { class: 'num', dir: 'ltr' }, formatSar(summary.countedCashHalalas))),
      diffLine('فرق النقد', summary.cashVarianceHalalas),
      diffLine('نقدي تقرير Z − كاش اليومية', summary.zReportVsFormCashHalalas),
      diffLine('مدى البنك − مدى اليومية', summary.bankVsFormMadaHalalas)),
    editable && me.user.role === 'employee'
      ? h('button', { class: 'btn primary', type: 'button', disabled: !allDone, onclick: async () => {
        if (!window.confirm('بعد الإرسال لا يمكن تعديل تسوية هذا اليوم. متابعة؟')) return;
        try { await api(`/reconciliations/${id}/submit`, { method: 'POST' }); toast('تم إرسال التسوية.', 'ok'); renderReconciliation(id); } catch (err) { toast(err.message, 'error'); }
      } }, 'إرسال التسوية')
      : h('p', { class: 'muted' }, `الحالة: ${STATUS[rec.status] ?? rec.status}`));

  root.replaceChildren(
    topBar(),
    h('div', { class: 'crumbs' }, h('button', { class: 'link', type: 'button', onclick: renderHome }, '→ كل الأيام')),
    h('div', { class: 'card day-head' },
      h('div', {}, h('span', { class: 'muted' }, 'الفرع: '), h('strong', {}, rec.branchNameAr || rec.branchName)),
      h('div', {}, h('span', { class: 'muted' }, 'اليوم: '), h('strong', {}, dayName(rec.businessDate))),
      h('div', {}, h('span', { class: 'muted' }, 'التاريخ: '), h('strong', { dir: 'ltr' }, rec.businessDate)),
      h('span', { class: `pill ${rec.status}` }, STATUS[rec.status] ?? rec.status)),
    ...STAGES.map(docStage), cashCard, summaryCard);
}

boot();
