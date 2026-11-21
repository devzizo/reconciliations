import { h, api, copyText, editTokens, lastMatch, formatSar, toast } from './ui.js';
import { openCamera } from './camera.js';

const root = document.getElementById('app');

// ------------------------------------------------------------------ routing

function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  route();
}
window.addEventListener('popstate', route);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

function route() {
  const m = /^\/m\/([\w-]+)$/.exec(location.pathname);
  if (m) return renderMatch(m[1]);
  return renderHome();
}

const shareUrl = (pid) => `${location.origin}/m/${pid}`;

function statusChip(item, { large = false } = {}) {
  if (item.status === 'open') return h('span', { class: `chip pending ${large ? 'large' : ''}` }, 'قيد الإعداد');
  return item.result === 'matched'
    ? h('span', { class: `chip ok ${large ? 'large' : ''}` }, '✓ مطابقة')
    : h('span', { class: `chip bad ${large ? 'large' : ''}` }, '✗ غير مطابقة');
}

function copyButton(pid) {
  const btn = h('button', { class: 'btn small', type: 'button', 'data-testid': 'copy-link' }, '🔗 نسخ الرابط');
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    toast(await copyText(shareUrl(pid)) ? 'تم نسخ الرابط.' : shareUrl(pid), 'ok');
  });
  return btn;
}

// ------------------------------------------------------------------ home (open to everyone)

async function renderHome() {
  document.title = 'مطابقة الإقفال اليومي';
  const start = h('button', { class: 'btn primary hero-btn', type: 'button', 'data-testid': 'new-match' }, '＋ مطابقة جديدة');
  start.addEventListener('click', startNewMatch);
  const latest = h('section', { class: 'latest' });
  root.replaceChildren(
    h('section', { class: 'hero' },
      h('h1', {}, 'مطابقة الإقفال اليومي'),
      h('p', {}, 'صوّر اليومية بالجوال، ويقرأ النظام الأرقام والفرع والتاريخ ويطابقها مع تقرير Z وإيصال البنك والنقد.'),
      start,
      h('div', { class: 'hero-links' },
        h('a', { class: 'btn hero-link', href: '/daily-closing-form.pdf', download: 'نموذج-الإقفال-اليومي.pdf', 'data-testid': 'download-form' }, '⬇ تحميل نموذج الإقفال اليومي للطباعة (PDF)')),
      h('p', { class: 'hero-note' }, 'اطبع النموذج واملأه بخط اليد، ثم صوّره من هنا.'),
      h('ol', { class: 'steps' },
        h('li', {}, h('span', {}, '١'), 'صوّر اليومية'),
        h('li', {}, h('span', {}, '٢'), 'صوّر التقارير والإيصالات'),
        h('li', {}, h('span', {}, '٣'), 'عدّ النقد بالكاميرا'))),
    latest);

  // Only the latest reconciliation started on this phone is shown here. Older ones (and everyone
  // else's) stay in the database and open only through their own link or QR code.
  const pid = lastMatch.get();
  if (!pid) return;
  let d;
  try { d = await api(`/matches/${pid}`, { editToken: editTokens.get(pid) }); } catch { return; }
  const m = d.match;
  latest.replaceChildren(h('h2', {}, 'آخر مطابقة'),
    h('article', { class: `match-card ${m.status === 'open' ? 'is-open' : m.result}`, 'data-testid': 'match-card' },
      h('a', { class: 'match-main', href: `/m/${pid}`, 'data-link': '' },
        h('div', { class: 'match-number' }, h('small', {}, 'رقم المطابقة'), h('strong', {}, `#${m.number}`)),
        h('div', { class: 'match-info' },
          h('strong', {}, m.branchName),
          h('span', { class: 'muted small' }, `${m.weekday} ${m.businessDate}`),
          statusChip(m),
          d.canEdit ? h('span', { class: 'chip mine' }, 'متابعة من هذا الجهاز') : null),
        h('img', { class: 'qr', src: `/api/matches/${pid}/qr.svg`, alt: `رمز QR للمطابقة ${m.number}`, width: '84', height: '84' })),
      h('div', { class: 'match-actions' }, copyButton(pid), h('a', { class: 'btn small ghost', href: `/m/${pid}`, 'data-link': '' }, 'استعراض'))),
    h('p', { class: 'muted small center' }, 'المطابقات السابقة تُفتح فقط من رابطها أو رمز QR الخاص بها.'));
}

function startNewMatch() {
  openCamera({
    root, kind: 'daily_closing_form', title: 'تصوير اليومية',
    subtitle: 'سيُقرأ الفرع والتاريخ والأرقام من النموذج.',
    hint: 'ضع النموذج كاملًا داخل الإطار بإضاءة جيدة وبدون ظل، وتأكد أن الفرع والتاريخ مكتوبان بوضوح.',
    doneLabel: 'قراءة اليومية',
    onResult(res) {
      if (res.editToken) editTokens.set(res.publicId, res.editToken);
      lastMatch.set(res.publicId);
      toast(`تم إنشاء المطابقة رقم ${res.number}`, 'ok');
      navigate(`/m/${res.publicId}`);
    },
    onClose: () => renderHome(),
  });
}

// ------------------------------------------------------------------ reconciliation page

const CLOSING_FORM = [
  { title: 'المبيعات الإجمالية والتسويات', en: 'SALES SUMMARY & ADJUSTMENTS', rows: [
    ['gross_sales', 'إجمالي المبيعات', 'Gross Sales'], ['returns', 'المرتجعات', 'Returns / Refunds'], ['net_sales', 'صافي المبيعات', 'Net Sales']] },
  { title: 'تفاصيل وسائل الدفع (POS & Online)', en: 'PAYMENT METHODS BREAKDOWN', rows: [
    ['mada', 'شبكة (مدى / POS)', 'Mada / POS Terminal'], ['mastercard', 'ماستر كارد', 'Mastercard'], ['visa', 'فيزا', 'Visa'], ['tamara', 'تمارا', 'Tamara'],
    ['tabby', 'تابي', 'Tabby'], ['cash_sales', 'كاش / نقدي', 'Cash Sales'], ['overage_shortage', 'الزيادة / العجز', 'Overage / Shortage']] },
  { title: 'حركة صندوق النقدية (الكاش)', en: 'CASH MOVEMENT & PETTY CASH', rows: [
    ['opening_cash_balance', 'رصيد الصندوق أول اليوم', 'Opening Cash Balance'], ['cash_inflow', 'الوارد (إيداعات / نقدي)', 'Cash Inflow'],
    ['cash_outflow', 'المنصرف (مصاريف / استرجاع)', 'Cash Outflow / Expenses'], ['closing_cash_balance', 'رصيد الصندوق آخر اليوم', 'Closing Cash Balance']] },
];
const DOCS = [
  { kind: 'z_report', title: 'تقرير Z', hint: 'صوّر الإيصال كاملًا من الأعلى إلى الأسفل. إذا كان هناك أكثر من تقرير Z فضعها جنبًا إلى جنب.',
    rows: [['gross_sales', 'إجمالي المبيعات'], ['discount', 'الخصم'], ['net_sales', 'صافي المبيعات'], ['cash', 'نقدي'], ['mada', 'مدى'], ['visa', 'فيزا']] },
  { kind: 'bank_settlement', title: 'إيصال تسوية البنك', hint: 'صوّر إيصال الموازنة من جهاز الشبكة بحيث تظهر الإجماليات.',
    rows: [['mada_total', 'إجمالي مدى'], ['visa_total', 'إجمالي فيزا'], ['mastercard_total', 'إجمالي ماستر كارد']] },
  { kind: 'deposit_receipt', title: 'إيصال إيداع الكاش (يومية أمس)', hint: 'صوّر إيصال إيداع نقدية يوم أمس في البنك.', rows: [['amount', 'المبلغ المودع']] },
];

async function renderMatch(pid) {
  const editToken = editTokens.get(pid);
  let d;
  try {
    d = await api(`/matches/${pid}`, { editToken });
  } catch (err) {
    root.replaceChildren(backLink(), h('p', { class: 'note bad' }, err.message));
    return;
  }
  const m = d.match;
  document.title = `مطابقة #${m.number} — ${m.branchName}`;
  const edit = d.canEdit;
  const reload = () => renderMatch(pid);
  const camera = (kind, title, hint, doneLabel) => openCamera({
    root, kind, title, subtitle: `${m.branchName} · ${m.weekday} ${m.businessDate}`, hint, publicId: pid, editToken, doneLabel,
    onResult: () => { toast('تمت القراءة.', 'ok'); reload(); }, onClose: reload,
  });
  const photoBtn = (kind, title, hint, has, label) => (edit
    ? h('button', { class: `btn ${has ? '' : 'primary'}`, type: 'button', 'data-testid': `photo-${kind}`, onclick: () => camera(kind, title, hint, label) }, has ? '📷 إعادة التصوير' : '📷 تصوير')
    : null);
  const photoLinks = (doc) => (doc?.captureIds?.length ? h('div', { class: 'photos' }, ...doc.captureIds.map((id) => h('a', { href: `/api/matches/${pid}/captures/${id}`, target: '_blank', rel: 'noopener' },
    h('img', { src: `/api/matches/${pid}/captures/${id}`, alt: 'صورة المستند', loading: 'lazy' })))) : null);
  const warnFields = (kind) => new Set(d.warnings.filter((w) => w.kind === kind && w.field).map((w) => w.field));

  const valueCell = (doc, f, kind) => {
    const v = doc?.fields?.[f];
    const flagged = warnFields(kind).has(f);
    return h('td', { class: `num ${flagged ? 'warn-cell' : ''}`, dir: 'ltr' }, v === null || v === undefined ? (doc ? 'فارغة' : '—') : formatSar(v));
  };

  // ---- header
  const header = h('section', { class: `card match-head ${m.status === 'open' ? 'is-open' : m.result}` },
    h('div', { class: 'head-main' },
      h('div', {}, h('small', { class: 'muted' }, 'رقم المطابقة'), h('div', { class: 'big-number' }, `#${m.number}`)),
      statusChip(m, { large: true })),
    h('dl', { class: 'facts' },
      h('div', {}, h('dt', {}, 'الفرع'), h('dd', {}, m.branchName)),
      h('div', {}, h('dt', {}, 'اليوم'), h('dd', {}, m.weekday)),
      h('div', {}, h('dt', {}, 'التاريخ'), h('dd', { dir: 'ltr' }, m.businessDate))),
    h('div', { class: 'share' },
      h('img', { class: 'qr', src: `/api/matches/${pid}/qr.svg`, alt: 'رمز QR لاستعراض المطابقة', width: '112', height: '112' }),
      h('div', { class: 'share-text' },
        h('small', { class: 'muted' }, 'رابط الاستعراض'),
        h('code', { dir: 'ltr', 'data-testid': 'share-url' }, shareUrl(pid)),
        copyButton(pid))));

  const rule = edit ? h('p', { class: 'note info' }, '✋ لا يمكن تعديل الأرقام في التطبيق. إذا أردت تعديل رقم: صحّح الكتابة بخط اليد على المستند الورقي ثم أعد تصويره.') : null;

  // ---- notes report on the closing (shown to anyone opening the link / QR; frozen when approved)
  const checkItem = (c) => h('li', { class: c.ok ? 'ok' : 'bad' },
    h('div', { class: 'check-title' }, h('span', { class: 'mark' }, c.ok ? '✓' : '✗'), h('span', {}, c.title), h('span', { class: 'chip small' }, c.ok ? 'مطابق' : 'غير مطابق')),
    c.flag ? h('div', { class: 'check-values' }, h('span', { class: 'diff' }, c.text.replace(/^[^:]+:\s*/, '')))
      : h('div', { class: 'check-values' },
        h('span', {}, `${c.left.label}: `, h('b', { dir: 'ltr' }, formatSar(c.left.halalas))),
        h('span', {}, `${c.right.label}: `, h('b', { dir: 'ltr' }, formatSar(c.right.halalas))),
        c.ok ? null : h('span', { class: 'diff' }, 'الفرق: ', h('b', { dir: 'ltr' }, formatSar(c.diffHalalas)), ' ريال')));
  const bad = d.checks.filter((c) => !c.ok);
  const good = d.checks.filter((c) => c.ok);
  const alerts = [...d.missing.map((x) => x.text), ...d.warnings.map((w) => w.text)];
  const printBtn = h('button', { class: 'btn small ghost no-print', type: 'button', onclick: () => window.print() }, '🖨 طباعة');
  const results = h('section', { class: 'card report', 'data-testid': 'report' },
    h('div', { class: 'doc-head' }, h('h2', {}, 'تقرير الملاحظات على الإقفال'), printBtn),
    d.report?.frozen ? h('p', { class: 'muted small' }, `محفوظ عند الاعتماد: ${new Date(d.report.generatedAt).toLocaleString('ar-SA')}`) : null,
    h('div', { class: 'report-summary' },
      h('span', { class: 'chip bad' }, `غير مطابق: ${bad.length}`),
      h('span', { class: 'chip warn' }, `تنبيهات: ${alerts.length}`),
      h('span', { class: 'chip ok' }, `مطابق: ${good.length}`)),
    bad.length ? h('ul', { class: 'checks', 'data-testid': 'checks' }, ...bad.map(checkItem)) : null,
    alerts.length ? h('div', { class: 'alerts', 'data-testid': 'alerts' }, h('h3', {}, 'تنبيهات'), h('ul', {}, ...alerts.map((t) => h('li', {}, t)))) : null,
    good.length ? h('details', { class: 'good-list', open: bad.length === 0 ? true : null },
      h('summary', {}, `✓ المقارنات المطابقة (${good.length})`), h('ul', { class: 'checks' }, ...good.map(checkItem))) : null,
    d.checks.length === 0 && alerts.length === 0 ? h('p', { class: 'muted' }, 'تظهر الملاحظات بعد تصوير المستندات.') : null,
    d.report?.formNotes ? h('div', { class: 'form-notes' }, h('h3', {}, 'ملاحظات مكتوبة في اليومية'), h('p', {}, d.report.formNotes)) : null);
  // ---- closing form (read-only, paper layout)
  const form = d.documents.daily_closing_form;
  const formCard = h('section', { class: 'card doc', 'data-doc': 'daily_closing_form' },
    h('div', { class: 'doc-head' }, h('h2', {}, 'اليومية'),
      photoBtn('daily_closing_form', 'إعادة تصوير اليومية', 'ضع النموذج كاملًا داخل الإطار. يجب أن يكون لنفس الفرع ونفس التاريخ.', Boolean(form), 'قراءة اليومية')),
    ...CLOSING_FORM.map((sec) => h('div', { class: 'form-section' },
      h('div', { class: 'section-bar' }, h('span', {}, sec.title), h('span', { class: 'en' }, sec.en)),
      h('table', { class: 'paper' }, h('tbody', {}, ...sec.rows.map(([f, ar, en]) => h('tr', {},
        h('th', { scope: 'row' }, ar, h('span', { class: 'en' }, en)), valueCell(form, f, 'daily_closing_form'))))))),
    h('div', { class: 'form-section' }, h('div', { class: 'section-bar' }, h('span', {}, 'ملاحظات'), h('span', { class: 'en' }, 'NOTES / REMARKS')),
      h('p', { class: 'notes-text' }, form?.extras?.notes || '—')),
    photoLinks(form));

  const docCard = (doc) => {
    const r = d.documents[doc.kind];
    return h('section', { class: 'card doc', 'data-doc': doc.kind },
      h('div', { class: 'doc-head' }, h('h2', {}, doc.title), photoBtn(doc.kind, `تصوير ${doc.title}`, doc.hint, Boolean(r))),
      r ? h('table', { class: 'paper plain' }, h('tbody', {}, ...doc.rows.map(([f, ar]) => h('tr', {}, h('th', { scope: 'row' }, ar), valueCell(r, f, doc.kind)))))
        : h('p', { class: 'muted' }, 'لم يتم التصوير بعد.'),
      doc.kind === 'deposit_receipt' && d.yesterday ? h('p', { class: 'muted small' }, `تُقارن مع رصيد الصندوق في مطابقة أمس رقم ${d.yesterday.number}.`) : null,
      photoLinks(r));
  };

  // ---- expenses
  const expensesCard = d.expensesRequired || d.expenses.length ? h('section', { class: 'card doc', 'data-doc': 'expense_invoice' },
    h('div', { class: 'doc-head' }, h('h2', {}, 'فواتير المصروفات'),
      edit ? h('button', { class: 'btn primary', type: 'button', 'data-testid': 'photo-expense_invoice', onclick: () => camera('expense_invoice', 'تصوير فاتورة مصروف', 'صوّر فاتورة المصروف كاملة بحيث يظهر الإجمالي.', 'قراءة الفاتورة') }, '📷 تصوير فاتورة') : null),
    h('p', { class: 'muted small' }, `المنصرف في اليومية: ${formatSar(form?.fields?.cash_outflow)} ريال. صوّر فاتورة لكل مصروف.`),
    d.expenses.length ? h('ul', { class: 'expense-list' }, ...d.expenses.map((x, i) => h('li', {},
      h('span', {}, `فاتورة ${i + 1}${x.extras?.vendor ? ` — ${x.extras.vendor}` : ''}`),
      h('b', { dir: 'ltr' }, formatSar(x.fields.amount)),
      photoLinks(x),
      edit ? h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
        if (!window.confirm('حذف هذه الفاتورة؟')) return;
        try { await api(`/matches/${pid}/expenses/${x.readingId}`, { method: 'DELETE', editToken }); reload(); } catch (err) { toast(err.message, 'error'); }
      } }, 'حذف') : null))) : h('p', { class: 'muted' }, 'لم تُصوّر أي فاتورة بعد.')) : null;

  // ---- cash (confirm only; no editing)
  const cashCard = h('section', { class: 'card doc', 'data-doc': 'cash' },
    h('div', { class: 'doc-head' }, h('h2', {}, 'عدّ النقد'),
      edit && !d.cash.confirmed ? h('button', { class: `btn ${d.cash.pending ? '' : 'primary'}`, type: 'button', 'data-testid': 'photo-cash',
        onclick: () => camera('cash', 'عدّ النقد', 'افرد الأوراق النقدية بحيث يظهر الرقم التسلسلي لكل ورقة، والعملات المعدنية بدون تداخل. يمكنك التقاط أكثر من صورة؛ الورقة المكررة تُحسب مرة واحدة. الصور لا تُحفظ على الجوال.', 'عدّ النقد') }, d.cash.pending ? '📷 إعادة التصوير' : '📷 فتح الكاميرا لعدّ النقد') : null),
    d.cash.confirmed ? h('p', { class: 'cash-total' }, 'النقد المعدود: ', h('b', { dir: 'ltr' }, d.cash.confirmed.total), ' ريال')
      : d.cash.pending ? cashReview(d, pid, editToken, reload)
        : h('p', { class: 'muted' }, 'لم يتم عدّ النقد بعد.'));

  const submit = edit ? h('section', { class: `card submit ${d.complete ? 'ready' : ''}` },
    h('button', { class: 'btn primary wide', type: 'button', disabled: !d.complete, 'data-testid': 'submit', onclick: async () => {
      if (!window.confirm('بعد الاعتماد لا يمكن تعديل المطابقة. متابعة؟')) return;
      try { await api(`/matches/${pid}/submit`, { method: 'POST', editToken }); toast('تم اعتماد المطابقة.', 'ok'); reload(); } catch (err) { toast(err.message, 'error'); }
    } }, 'اعتماد المطابقة'),
    d.complete ? null : h('p', { class: 'muted small center' }, 'يُفعّل بعد تصوير كل المستندات المطلوبة.')) : null;

  root.replaceChildren(backLink(), header, results, rule, formCard, ...DOCS.map(docCard), expensesCard, cashCard, submit);
}

function cashReview(d, pid, editToken, reload) {
  const p = d.cash.pending;
  const rows = d.denominations.filter((x) => p.counts[x.id] > 0).map((x) => h('tr', {}, h('td', {}, x.labelAr), h('td', { class: 'num' }, String(p.counts[x.id])), h('td', { class: 'num', dir: 'ltr' }, formatSar(p.counts[x.id] * x.halalas))));
  const box = h('input', { type: 'checkbox', id: 'confirm-cash' });
  const btn = h('button', { class: 'btn primary', type: 'button', disabled: true, 'data-testid': 'confirm-cash' }, 'تأكيد العدّ');
  box.addEventListener('change', () => { btn.disabled = !box.checked; });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await api(`/matches/${pid}/cash/confirm`, { method: 'POST', editToken, body: { readingId: p.readingId, confirmed: true } }); toast('تم تأكيد عدّ النقد.', 'ok'); reload(); }
    catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  });
  return h('div', { class: 'cash-review' },
    h('p', { class: 'note info' }, 'هذه الأعداد من الذكاء الاصطناعي ولا يمكن تعديلها. قارنها بالنقد أمامك: إذا كانت صحيحة أكّدها، وإذا كانت خاطئة أعد التصوير بعد فرد النقد بشكل أوضح.'),
    p.issues.length ? h('ul', { class: 'issues' }, ...p.issues.map((i) => h('li', {}, i))) : null,
    rows.length ? h('table', { class: 'paper plain' }, h('thead', {}, h('tr', {}, h('th', {}, 'الفئة'), h('th', { class: 'num' }, 'العدد'), h('th', { class: 'num' }, 'ريال'))), h('tbody', {}, ...rows))
      : h('p', { class: 'muted' }, 'لم يُعثر على نقد في الصور.'),
    h('p', { class: 'muted small', 'data-testid': 'serial-stats' }, `أوراق قُرئ رقمها التسلسلي: ${p.serialsRead}`,
      p.duplicatesRemoved ? ` · أوراق مكررة استُبعدت: ${p.duplicatesRemoved}` : '', p.unreadableSerials ? ` · أوراق بدون رقم مقروء: ${p.unreadableSerials}` : ''),
    h('p', { class: 'cash-total' }, 'الإجمالي: ', h('b', { dir: 'ltr', 'data-testid': 'cash-total' }, formatSar(p.totalHalalas)), ' ريال'),
    h('label', { class: 'confirm-line', for: 'confirm-cash' }, box, ' عددت النقد وأؤكد أن الأعداد أعلاه صحيحة.'),
    h('div', { class: 'actions' }, btn));
}

function backLink() {
  return h('nav', { class: 'crumbs' }, h('a', { href: '/', 'data-link': '' }, '→ الصفحة الرئيسية'));
}

route();
