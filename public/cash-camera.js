// Stage 4 — Physical Cash Count. Live camera only.
//
// Security notes (see docs/stage4-camera-capture.md):
//  * There is no file input, gallery picker, drag-and-drop or paste path in this module.
//  * Frames are grabbed from a live getUserMedia() <video> into a <canvas> and uploaded immediately.
//  * Nothing is written to the device photo library: we never create a download link, never put a
//    captured image in an <img> (iOS long-press offers "Save to Photos" on images), and drop every
//    frame buffer after upload. Thumbnails are small canvases.
//  * If the camera is unavailable, denied, or stops, the capture and review buttons are disabled.

import { h, api, ApiError, formatSar, toast } from './ui.js';

const MAX_LONG_SIDE = 2560;

export function openCashCount({ root, recon, onClose }) {
  const state = {
    stream: null,
    track: null,
    session: null,
    images: [], // { imageId, seq, thumb: <canvas> }
    busy: false,
    cameraLive: false,
    closed: false,
  };

  const video = h('video', { class: 'cam-video', autoplay: true, muted: true, playsinline: true, 'aria-label': 'معاينة الكاميرا المباشرة' });
  // iOS Safari needs these as properties as well as attributes.
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('webkit-playsinline', '');

  const status = h('div', { class: 'cam-status', role: 'status', 'aria-live': 'polite' });
  const shutter = h('button', { class: 'shutter', type: 'button', disabled: true, 'aria-label': 'التقاط صورة', 'data-testid': 'shutter' });
  const reviewBtn = h('button', { class: 'btn primary', type: 'button', disabled: true, 'data-testid': 'review-count' }, 'مراجعة العدّ');
  const strip = h('div', { class: 'thumb-strip', 'aria-label': 'الصور الملتقطة' });
  const counter = h('span', { class: 'muted' });
  const blocked = h('div', { class: 'blocked', hidden: true });
  const closeBtn = h('button', { class: 'btn ghost', type: 'button' }, '✕ إغلاق');

  const view = h('section', { class: 'cash-view' },
    h('header', { class: 'cash-head' },
      h('div', {}, h('h2', {}, 'عدّ النقد'), h('p', { class: 'muted' }, `${recon.branchNameAr || recon.branchName} · ${recon.businessDate}`)),
      closeBtn),
    h('div', { class: 'cam-frame' }, video, status, blocked),
    h('div', { class: 'cam-controls' }, h('div', { class: 'spacer' }), shutter, h('div', { class: 'spacer' })),
    h('div', { class: 'strip-head' }, h('strong', {}, 'الصور'), counter),
    strip,
    h('p', { class: 'muted small' }, 'افرد الأوراق النقدية والعملات بحيث تظهر كل قطعة. يمكنك التقاط أكثر من صورة. الصور تُرسل مباشرة للتسوية ولا تُحفظ على الجوال.'),
    h('div', { class: 'actions' }, reviewBtn),
  );

  // No paste / drag-and-drop of images anywhere in Stage 4.
  for (const evt of ['paste', 'drop', 'dragover', 'dragenter']) {
    view.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); }, true);
  }

  root.replaceChildren(view);

  // ------------------------------------------------------------------ camera

  function setStatus(text) { status.textContent = text ?? ''; status.hidden = !text; }

  function showBlocked(title, body, { retry = true } = {}) {
    state.cameraLive = false;
    blocked.replaceChildren(
      h('strong', {}, title),
      h('p', {}, body),
      h('p', { class: 'small' }, 'لا يمكن إرسال عدّ النقد حتى تتوفر الكاميرا المباشرة. لا يوجد بديل لرفع الصور.'),
      retry ? h('button', { class: 'btn primary', type: 'button', onclick: () => startCamera() }, 'إعادة محاولة فتح الكاميرا') : null,
    );
    blocked.hidden = false;
    refreshButtons();
  }

  function stopCamera() {
    if (state.stream) for (const t of state.stream.getTracks()) t.stop();
    state.stream = null;
    state.track = null;
    state.cameraLive = false;
    video.srcObject = null;
    refreshButtons();
  }

  async function startCamera() {
    blocked.hidden = true;
    if (!window.isSecureContext) {
      return showBlocked('يلزم اتصال آمن', 'الكاميرا تعمل فقط عبر HTTPS. افتح التطبيق من رابط يبدأ بـ https://', { retry: false });
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return showBlocked('الكاميرا غير مدعومة', 'هذا المتصفح لا يستطيع فتح الكاميرا. استخدم Safari على الآيفون أو Chrome على أندرويد.', { retry: false });
    }
    setStatus('جاري فتح الكاميرا…');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (err) {
      setStatus('');
      const name = err?.name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return showBlocked('تم رفض إذن الكاميرا', 'اسمح لهذا الموقع باستخدام الكاميرا من إعدادات المتصفح ثم حاول مرة أخرى.');
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
        return showBlocked('لا توجد كاميرا', 'هذا الجهاز لا يحتوي على كاميرا قابلة للاستخدام.');
      }
      if (name === 'NotSupportedError' || name === 'TypeError') {
        return showBlocked('الكاميرا غير مدعومة', 'هذا المتصفح لا يستطيع فتح الكاميرا. استخدم Safari على الآيفون أو Chrome على أندرويد.', { retry: false });
      }
      if (name === 'NotReadableError' || name === 'AbortError') {
        return showBlocked('الكاميرا مشغولة', 'تطبيق آخر يستخدم الكاميرا. أغلقه وحاول مرة أخرى.');
      }
      return showBlocked('الكاميرا غير متاحة', 'تعذّر فتح الكاميرا.');
    }
    if (state.closed) { for (const t of stream.getTracks()) t.stop(); return; }

    state.stream = stream;
    state.track = stream.getVideoTracks()[0] ?? null;
    if (!state.track) { stopCamera(); return showBlocked('الكاميرا غير متاحة', 'لم تُرسل الكاميرا أي صورة.'); }
    state.track.addEventListener('ended', () => {
      if (!state.closed) showBlocked('توقفت الكاميرا', 'توقف بث الكاميرا. أعد فتحها للمتابعة.');
    });
    video.srcObject = stream;
    try { await video.play(); } catch { /* autoplay is allowed for muted inline video; ignore */ }
    await waitForFrames();
    if (!video.videoWidth) { stopCamera(); return showBlocked('الكاميرا غير متاحة', 'لم تُظهر الكاميرا أي صورة.'); }

    state.cameraLive = true;
    setStatus('');
    if (!state.session || Date.parse(state.session.expiresAt) <= Date.now()) await startSession();
    refreshButtons();
  }

  function waitForFrames() {
    if (video.readyState >= 2 && video.videoWidth) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { video.removeEventListener('loadeddata', done); clearTimeout(t); resolve(); };
      const t = setTimeout(done, 5000);
      video.addEventListener('loadeddata', done);
    });
  }

  async function startSession() {
    const s = state.track?.getSettings?.() ?? {};
    try {
      state.session = await api(`/reconciliations/${recon.id}/cash-count/sessions`, {
        method: 'POST',
        body: { camera: { facingMode: s.facingMode ?? null, width: video.videoWidth, height: video.videoHeight, label: state.track?.label ?? null } },
      });
    } catch (err) {
      state.session = null;
      showBlocked('تعذّر بدء التصوير', err.message, { retry: true });
      return;
    }
    clearThumbs();
  }

  function clearThumbs() {
    state.images = [];
    strip.replaceChildren();
    refreshButtons();
  }

  function refreshButtons() {
    const live = state.cameraLive && state.track?.readyState === 'live';
    shutter.disabled = !live || state.busy || !state.session || state.images.length >= (state.session?.maxImages ?? 0);
    reviewBtn.disabled = !live || state.busy || state.images.length === 0;
    counter.textContent = state.session ? `${state.images.length} / ${state.session.maxImages}` : '';
  }

  // ------------------------------------------------------------------ capture

  async function capture() {
    if (shutter.disabled) return;
    state.busy = true;
    refreshButtons();
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const scale = Math.min(1, MAX_LONG_SIDE / Math.max(vw, vh));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vw * scale);
      canvas.height = Math.round(vh * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      flash();

      let blob = await toJpeg(canvas, 0.88);
      if (blob.size > state.session.maxBytes) blob = await toJpeg(canvas, 0.7);
      const thumb = makeThumb(canvas);
      canvas.width = 0; // release the full-size frame

      const image = await uploadFrame(blob, vw, vh);
      blob = null;
      if (image) addThumb(image, thumb);
    } catch (err) {
      toast(err.message || 'فشل التصوير.', 'error');
    } finally {
      state.busy = false;
      refreshButtons();
    }
  }

  async function uploadFrame(blob, vw, vh) {
    const s = state.track?.getSettings?.() ?? {};
    try {
      return await api(`/cash-capture/sessions/${state.session.sessionId}/images`, {
        method: 'POST',
        rawBody: blob,
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Capture-Token': state.session.captureToken,
          'X-Capture-Meta': JSON.stringify({ videoWidth: vw, videoHeight: vh, facingMode: s.facingMode ?? null, trackLabel: state.track?.label ?? null }),
        },
      });
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'CAPTURE_SESSION_EXPIRED' || err.code === 'CAPTURE_SESSION_CLOSED')) {
        toast('انتهت مهلة التصوير. بدأ تصوير جديد — صوّر النقد مرة أخرى.', 'warn');
        await startSession();
        return null;
      }
      throw err;
    }
  }

  function toJpeg(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('تعذّر حفظ الصورة.'))), 'image/jpeg', quality));
  }

  function makeThumb(src) {
    const t = document.createElement('canvas');
    const w = 160;
    t.width = w;
    t.height = Math.round((src.height / src.width) * w);
    t.getContext('2d').drawImage(src, 0, 0, t.width, t.height);
    t.className = 'thumb-canvas';
    t.addEventListener('contextmenu', (e) => e.preventDefault());
    return t;
  }

  function addThumb(image, thumb) {
    const item = h('figure', { class: 'thumb' },
      thumb,
      h('figcaption', {}, `#${image.seq}`),
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => retake(image.imageId, item) }, 'إعادة'));
    state.images.push({ imageId: image.imageId, seq: image.seq });
    strip.append(item);
  }

  async function retake(imageId, item) {
    if (state.busy) return;
    state.busy = true;
    refreshButtons();
    try {
      await api(`/cash-capture/sessions/${state.session.sessionId}/images/${imageId}`, {
        method: 'DELETE', headers: { 'X-Capture-Token': state.session.captureToken },
      });
      state.images = state.images.filter((i) => i.imageId !== imageId);
      item.remove();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      state.busy = false;
      refreshButtons();
    }
  }

  function flash() {
    view.classList.add('flash');
    setTimeout(() => view.classList.remove('flash'), 120);
  }

  // ------------------------------------------------------------------ review

  async function finishCapture() {
    if (reviewBtn.disabled) return;
    state.busy = true;
    refreshButtons();
    setStatus('جاري عدّ النقد… قد يستغرق ذلك دقيقة.');
    try {
      const { analysis, denominations } = await api(`/cash-capture/sessions/${state.session.sessionId}/finalize`, {
        method: 'POST', headers: { 'X-Capture-Token': state.session.captureToken },
      });
      state.session = null;
      stopCamera();
      showReview(analysis, denominations);
    } catch (err) {
      setStatus('');
      toast(err.message, 'error');
    } finally {
      state.busy = false;
      refreshButtons();
    }
  }

  function showReview(analysis, denominations) {
    const inputs = new Map();
    const lineTotals = new Map();
    const totalEl = h('strong', { class: 'grand-total' });
    const confirmBox = h('input', { type: 'checkbox', id: 'confirm-count' });
    const submit = h('button', { class: 'btn primary', type: 'button', disabled: true, 'data-testid': 'confirm-count-btn' }, 'تأكيد عدّ النقد');

    const recompute = () => {
      let sum = 0;
      let valid = true;
      for (const d of denominations) {
        const raw = inputs.get(d.id).value.trim();
        const n = raw === '' ? 0 : Number(raw);
        const ok = Number.isInteger(n) && n >= 0;
        inputs.get(d.id).classList.toggle('invalid', !ok);
        inputs.get(d.id).closest('tr').classList.toggle('changed', ok && n !== analysis.counts[d.id]);
        valid &&= ok;
        const line = ok ? n * d.halalas : 0;
        lineTotals.get(d.id).textContent = formatSar(line);
        sum += line;
      }
      totalEl.textContent = `${formatSar(sum)} ريال`;
      submit.disabled = !valid || !confirmBox.checked;
    };

    const rows = denominations.map((d) => {
      const input = h('input', { type: 'number', inputmode: 'numeric', min: '0', step: '1', value: String(analysis.counts[d.id] ?? 0), 'aria-label': `عدد ${d.labelAr}` });
      input.addEventListener('input', recompute);
      inputs.set(d.id, input);
      const line = h('td', { class: 'num' });
      lineTotals.set(d.id, line);
      return h('tr', {}, h('td', {}, d.labelAr), h('td', { class: 'num muted' }, String(analysis.counts[d.id] ?? 0)), h('td', {}, input), line);
    });

    const aiNote = analysis.status === 'completed'
      ? h('p', { class: 'note' }, 'هذه الأعداد اقترحها الذكاء الاصطناعي من صورك. قد يخطئ في الأوراق المتداخلة أو المطوية — راجع كل سطر مقابل النقد أمامك وصحّحه.')
      : h('p', { class: 'note warn' }, 'العدّ الآلي غير متاح لهذا التصوير. أدخل كل عدد يدويًا.');

    confirmBox.addEventListener('change', recompute);
    submit.addEventListener('click', async () => {
      submit.disabled = true;
      const counts = Object.fromEntries(denominations.map((d) => [d.id, Number(inputs.get(d.id).value.trim() || 0)]));
      try {
        const res = await api(`/reconciliations/${recon.id}/cash-count/confirm`, { method: 'POST', body: { analysisId: analysis.analysisId, counts, confirmed: true } });
        toast(`تم تأكيد عدّ النقد: ${res.total} ريال`, 'ok');
        close();
      } catch (err) {
        toast(err.message, 'error');
        recompute();
      }
    });

    const review = h('section', { class: 'cash-view review' },
      h('header', { class: 'cash-head' }, h('div', {}, h('h2', {}, 'مراجعة عدّ النقد'), h('p', { class: 'muted' }, `${analysis.imageIds.length} صورة · ${recon.branchNameAr || recon.branchName} · ${recon.businessDate}`)), closeBtn),
      aiNote,
      analysis.issues.length ? h('ul', { class: 'issues' }, ...analysis.issues.map((i) => h('li', {}, i))) : null,
      h('table', { class: 'denoms' },
        h('thead', {}, h('tr', {}, h('th', {}, 'الفئة'), h('th', { class: 'num' }, 'الآلي'), h('th', {}, 'المؤكد'), h('th', { class: 'num' }, 'ريال'))),
        h('tbody', {}, ...rows),
        h('tfoot', {}, h('tr', {}, h('td', { colspan: '3' }, 'إجمالي النقد المعدود'), h('td', { class: 'num' }, totalEl)))),
      h('label', { class: 'confirm-line', for: 'confirm-count' }, confirmBox, ' راجعت كل عدد مقابل النقد الفعلي وأؤكد صحة الإجمالي.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { root.replaceChildren(view); startCamera(); } }, 'إعادة التصوير'),
        submit),
    );
    root.replaceChildren(review);
    recompute();
  }

  // ------------------------------------------------------------------ lifecycle

  function onVisibility() {
    // Release the camera whenever the page is hidden; ask again on return.
    if (document.hidden) {
      if (state.stream) { stopCamera(); setStatus(''); showBlocked('تم إيقاف الكاميرا مؤقتًا', 'أُغلقت الكاميرا عندما خرجت من التطبيق. أعد فتحها للمتابعة.'); }
    }
  }

  function close() {
    state.closed = true;
    stopCamera();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', stopCamera);
    onClose?.();
  }

  shutter.addEventListener('click', capture);
  reviewBtn.addEventListener('click', finishCapture);
  closeBtn.addEventListener('click', close);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', stopCamera);

  startCamera();
  return { close };
}
