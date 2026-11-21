// Live-camera capture for every photograph in the app (documents, invoices, receipts and cash).
//
//  * No file input, gallery picker, PDF, drag-and-drop or paste path exists anywhere in the app.
//  * Frames are grabbed from a live getUserMedia() <video> into a <canvas> and uploaded immediately.
//  * Nothing is written to the device photo library: no download links, no <img> of a captured frame
//    (iOS long-press offers "Save to Photos" on images); thumbnails are small canvases.
//  * If the camera is unavailable, denied, or stops, capturing and sending are disabled.

import { h, api, ApiError, headerJson, toast } from './ui.js';

const MAX_LONG_SIDE = 2560;

/**
 * @param {object} o
 *   root, kind, title, subtitle, hint, publicId (null for a new closing form), editToken,
 *   doneLabel, onResult(response) — called with the finalize response, onClose()
 */
export function openCamera(o) {
  const multi = o.kind === 'cash';
  const state = { stream: null, track: null, session: null, images: [], busy: false, cameraLive: false, closed: false };

  const video = h('video', { class: 'cam-video', autoplay: true, muted: true, playsinline: true, 'aria-label': 'معاينة الكاميرا المباشرة' });
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('webkit-playsinline', '');

  const status = h('div', { class: 'cam-status', role: 'status', 'aria-live': 'polite', hidden: true });
  const shutter = h('button', { class: 'shutter', type: 'button', disabled: true, 'aria-label': 'التقاط صورة', 'data-testid': 'shutter' });
  const doneBtn = h('button', { class: 'btn primary wide', type: 'button', disabled: true, 'data-testid': 'camera-done' }, o.doneLabel ?? 'قراءة الأرقام');
  const strip = h('div', { class: 'thumb-strip', 'aria-label': 'الصور الملتقطة' });
  const counter = h('span', { class: 'muted small' });
  const blocked = h('div', { class: 'blocked', hidden: true });
  const result = h('div', { class: 'cam-result', hidden: true, role: 'alert' });
  const closeBtn = h('button', { class: 'btn ghost', type: 'button', 'aria-label': 'إغلاق' }, '✕');

  const view = h('section', { class: 'cam-view' },
    h('header', { class: 'cam-head' },
      h('div', {}, h('h2', {}, o.title), o.subtitle ? h('p', { class: 'muted small' }, o.subtitle) : null),
      closeBtn),
    h('div', { class: `cam-frame ${multi ? '' : 'doc'}` }, video, multi ? null : h('div', { class: 'doc-guide', 'aria-hidden': 'true' }), status, blocked),
    result,
    h('div', { class: 'cam-controls' }, shutter),
    h('div', { class: 'strip-head' }, h('strong', {}, multi ? 'الصور' : 'الصورة'), counter),
    strip,
    h('p', { class: 'muted small hint' }, o.hint ?? ''),
    h('div', { class: 'actions' }, doneBtn));

  for (const evt of ['paste', 'drop', 'dragover', 'dragenter']) view.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); }, true);
  o.root.replaceChildren(view);
  window.scrollTo(0, 0);

  const setStatus = (text) => { status.textContent = text ?? ''; status.hidden = !text; };

  function showBlocked(title, body, { retry = true } = {}) {
    state.cameraLive = false;
    blocked.replaceChildren(
      h('strong', {}, title), h('p', {}, body),
      h('p', { class: 'small' }, 'لا يمكن المتابعة بدون الكاميرا المباشرة. لا يوجد بديل لرفع الصور أو الملفات.'),
      retry ? h('button', { class: 'btn primary', type: 'button', onclick: () => startCamera() }, 'إعادة محاولة فتح الكاميرا') : null);
    blocked.hidden = false;
    refresh();
  }

  function stopCamera() {
    if (state.stream) for (const t of state.stream.getTracks()) t.stop();
    state.stream = null;
    state.track = null;
    state.cameraLive = false;
    video.srcObject = null;
    refresh();
  }

  async function startCamera() {
    blocked.hidden = true;
    if (!window.isSecureContext) return showBlocked('يلزم اتصال آمن', 'الكاميرا تعمل فقط عبر HTTPS. افتح التطبيق من رابط يبدأ بـ https://', { retry: false });
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return showBlocked('الكاميرا غير مدعومة', 'هذا المتصفح لا يستطيع فتح الكاميرا. استخدم Safari على الآيفون أو Chrome على أندرويد.', { retry: false });
    }
    setStatus('جاري فتح الكاميرا…');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } } });
    } catch (err) {
      setStatus('');
      const name = err?.name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError') return showBlocked('تم رفض إذن الكاميرا', 'اسمح لهذا الموقع باستخدام الكاميرا من إعدادات المتصفح ثم حاول مرة أخرى.');
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return showBlocked('لا توجد كاميرا', 'هذا الجهاز لا يحتوي على كاميرا قابلة للاستخدام.');
      if (name === 'NotSupportedError' || name === 'TypeError') return showBlocked('الكاميرا غير مدعومة', 'هذا المتصفح لا يستطيع فتح الكاميرا. استخدم Safari على الآيفون أو Chrome على أندرويد.', { retry: false });
      if (name === 'NotReadableError' || name === 'AbortError') return showBlocked('الكاميرا مشغولة', 'تطبيق آخر يستخدم الكاميرا. أغلقه وحاول مرة أخرى.');
      return showBlocked('الكاميرا غير متاحة', 'تعذّر فتح الكاميرا.');
    }
    if (state.closed) { for (const t of stream.getTracks()) t.stop(); return; }
    state.stream = stream;
    state.track = stream.getVideoTracks()[0] ?? null;
    if (!state.track) { stopCamera(); return showBlocked('الكاميرا غير متاحة', 'لم تُرسل الكاميرا أي صورة.'); }
    state.track.addEventListener('ended', () => { if (!state.closed) showBlocked('توقفت الكاميرا', 'توقف بث الكاميرا. أعد فتحها للمتابعة.'); });
    video.srcObject = stream;
    try { await video.play(); } catch { /* muted inline autoplay is allowed */ }
    await new Promise((resolve) => {
      if (video.readyState >= 2 && video.videoWidth) return resolve();
      const t = setTimeout(resolve, 5000);
      video.addEventListener('loadeddata', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (!video.videoWidth) { stopCamera(); return showBlocked('الكاميرا غير متاحة', 'لم تُظهر الكاميرا أي صورة.'); }
    state.cameraLive = true;
    setStatus('');
    if (!state.session || Date.parse(state.session.expiresAt) <= Date.now()) await startSession();
    refresh();
  }

  async function startSession() {
    const s = state.track?.getSettings?.() ?? {};
    try {
      state.session = await api('/camera/sessions', {
        method: 'POST', editToken: o.editToken,
        body: { kind: o.kind, publicId: o.publicId ?? undefined, camera: { facingMode: s.facingMode ?? null, width: video.videoWidth, height: video.videoHeight, label: state.track?.label ?? null } },
      });
    } catch (err) {
      state.session = null;
      showBlocked('تعذّر بدء التصوير', err.message);
      return;
    }
    state.images = [];
    strip.replaceChildren();
    refresh();
  }

  function refresh() {
    const live = state.cameraLive && state.track?.readyState === 'live';
    shutter.disabled = !live || state.busy || !state.session || state.images.length >= (state.session?.maxImages ?? 0);
    doneBtn.disabled = !live || state.busy || state.images.length === 0;
    counter.textContent = state.session && multi ? `${state.images.length} / ${state.session.maxImages}` : '';
  }

  async function capture() {
    if (shutter.disabled) return;
    state.busy = true;
    refresh();
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const scale = Math.min(1, MAX_LONG_SIDE / Math.max(vw, vh));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vw * scale);
      canvas.height = Math.round(vh * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      view.classList.add('flash');
      setTimeout(() => view.classList.remove('flash'), 120);
      let blob = await toJpeg(canvas, 0.9);
      if (blob.size > state.session.maxBytes) blob = await toJpeg(canvas, 0.7);
      const thumb = makeThumb(canvas);
      canvas.width = 0;
      const s = state.track?.getSettings?.() ?? {};
      let image;
      try {
        image = await api(`/camera/sessions/${state.session.sessionId}/captures`, {
          method: 'POST', rawBody: blob,
          headers: { 'Content-Type': 'image/jpeg', 'X-Capture-Token': state.session.captureToken, 'X-Capture-Meta': headerJson({ videoWidth: vw, videoHeight: vh, facingMode: s.facingMode ?? null, trackLabel: state.track?.label ?? null }) },
        });
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'CAPTURE_SESSION_EXPIRED' || err.code === 'CAPTURE_SESSION_CLOSED')) {
          toast('انتهت مهلة التصوير. صوّر مرة أخرى.', 'warn');
          await startSession();
          return;
        }
        throw err;
      }
      blob = null;
      result.hidden = true;
      const item = h('figure', { class: 'thumb' }, thumb, h('figcaption', {}, multi ? `#${image.seq}` : 'تم الالتقاط'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => retake(image.captureId, item) }, 'إعادة'));
      state.images.push({ captureId: image.captureId });
      strip.append(item);
    } catch (err) {
      toast(err.message || 'فشل التصوير.', 'error');
    } finally {
      state.busy = false;
      refresh();
    }
  }

  async function retake(captureId, item) {
    if (state.busy) return;
    state.busy = true;
    refresh();
    try {
      await api(`/camera/sessions/${state.session.sessionId}/captures/${captureId}`, { method: 'DELETE', headers: { 'X-Capture-Token': state.session.captureToken } });
      state.images = state.images.filter((i) => i.captureId !== captureId);
      item.remove();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      state.busy = false;
      refresh();
    }
  }

  async function finish() {
    if (doneBtn.disabled) return;
    state.busy = true;
    refresh();
    setStatus(multi ? 'جاري عدّ النقد… قد يستغرق ذلك دقيقة.' : 'جاري قراءة الأرقام من الصورة…');
    try {
      const res = await api(`/camera/sessions/${state.session.sessionId}/finalize`, { method: 'POST', editToken: o.editToken, headers: { 'X-Capture-Token': state.session.captureToken } });
      close(false);
      o.onResult?.(res);
    } catch (err) {
      setStatus('');
      // Reading failed / wrong document: show why and let the employee photograph again.
      state.session = null;
      result.replaceChildren(h('strong', {}, 'لم تُقبل الصورة'), h('p', {}, err.message),
        err.details?.number ? h('a', { class: 'btn', href: `/m/${err.details.publicId}`, 'data-link': '' }, `فتح المطابقة رقم ${err.details.number}`) : null);
      result.hidden = false;
      state.busy = false;
      await startSession();
    } finally {
      state.busy = false;
      refresh();
    }
  }

  function toJpeg(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('تعذّر حفظ الصورة.'))), 'image/jpeg', quality));
  }

  function makeThumb(src) {
    const t = document.createElement('canvas');
    t.width = 160;
    t.height = Math.round((src.height / src.width) * 160);
    t.getContext('2d').drawImage(src, 0, 0, t.width, t.height);
    t.className = 'thumb-canvas';
    t.addEventListener('contextmenu', (e) => e.preventDefault());
    return t;
  }

  function onVisibility() {
    if (document.hidden && state.stream) { stopCamera(); setStatus(''); showBlocked('تم إيقاف الكاميرا مؤقتًا', 'أُغلقت الكاميرا عندما خرجت من التطبيق. أعد فتحها للمتابعة.'); }
  }

  function close(notify = true) {
    state.closed = true;
    stopCamera();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', stopCamera);
    if (notify) o.onClose?.();
  }

  shutter.addEventListener('click', capture);
  doneBtn.addEventListener('click', finish);
  closeBtn.addEventListener('click', () => close(true));
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', stopCamera);
  startCamera();
  return { close };
}
