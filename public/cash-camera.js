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

  const video = h('video', { class: 'cam-video', autoplay: true, muted: true, playsinline: true, 'aria-label': 'Live camera preview' });
  // iOS Safari needs these as properties as well as attributes.
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('webkit-playsinline', '');

  const status = h('div', { class: 'cam-status', role: 'status', 'aria-live': 'polite' });
  const shutter = h('button', { class: 'shutter', type: 'button', disabled: true, 'aria-label': 'Capture photograph' });
  const reviewBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Review count · مراجعة العد');
  const strip = h('div', { class: 'thumb-strip', 'aria-label': 'Captured photographs' });
  const counter = h('span', { class: 'muted' });
  const blocked = h('div', { class: 'blocked', hidden: true });
  const closeBtn = h('button', { class: 'btn ghost', type: 'button' }, '✕ Close');

  const view = h('section', { class: 'cash-view' },
    h('header', { class: 'cash-head' },
      h('div', {}, h('h2', {}, 'Physical cash count · عدّ النقد'), h('p', { class: 'muted' }, `${recon.branchName} · ${recon.businessDate}`)),
      closeBtn),
    h('div', { class: 'cam-frame' }, video, status, blocked),
    h('div', { class: 'cam-controls' }, h('div', { class: 'spacer' }), shutter, h('div', { class: 'spacer' })),
    h('div', { class: 'strip-head' }, h('strong', {}, 'Photographs'), counter),
    strip,
    h('p', { class: 'muted small' }, 'Spread the notes and coins so each one is visible. Take several photographs if needed. Photographs go straight to the reconciliation and are not saved on this phone.'),
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
      h('p', { class: 'small' }, 'Cash count submission is blocked until the live camera is available. There is no photo upload alternative.'),
      retry ? h('button', { class: 'btn primary', type: 'button', onclick: () => startCamera() }, 'Try camera again') : null,
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
      return showBlocked('Secure connection required', 'The camera can only be used over HTTPS. Open the app from its https:// address.', { retry: false });
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return showBlocked('Camera not supported', 'This browser cannot open the camera. Use Safari on iPhone or Chrome on Android.', { retry: false });
    }
    setStatus('Opening camera…');
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
        return showBlocked('Camera permission denied', 'Allow camera access for this site in your browser settings, then try again.');
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
        return showBlocked('No camera found', 'This device has no usable camera.');
      }
      if (name === 'NotSupportedError' || name === 'TypeError') {
        return showBlocked('Camera not supported', 'This browser cannot open the camera. Use Safari on iPhone or Chrome on Android.', { retry: false });
      }
      if (name === 'NotReadableError' || name === 'AbortError') {
        return showBlocked('Camera is busy', 'Another app is using the camera. Close it and try again.');
      }
      return showBlocked('Camera unavailable', 'The camera could not be opened.');
    }
    if (state.closed) { for (const t of stream.getTracks()) t.stop(); return; }

    state.stream = stream;
    state.track = stream.getVideoTracks()[0] ?? null;
    if (!state.track) { stopCamera(); return showBlocked('Camera unavailable', 'No video track was provided.'); }
    state.track.addEventListener('ended', () => {
      if (!state.closed) showBlocked('Camera stopped', 'The camera feed stopped. Reopen it to continue.');
    });
    video.srcObject = stream;
    try { await video.play(); } catch { /* autoplay is allowed for muted inline video; ignore */ }
    await waitForFrames();
    if (!video.videoWidth) { stopCamera(); return showBlocked('Camera unavailable', 'The camera did not deliver any picture.'); }

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
      showBlocked('Could not start capture', err.message, { retry: true });
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
      toast(err.message || 'Capture failed.', 'error');
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
        toast('The capture timed out. Starting a new capture — please photograph the cash again.', 'warn');
        await startSession();
        return null;
      }
      throw err;
    }
  }

  function toJpeg(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the photograph.'))), 'image/jpeg', quality));
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
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => retake(image.imageId, item) }, 'Retake'));
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
    setStatus('Counting the cash… this can take up to a minute.');
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
    const submit = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Confirm cash count · تأكيد');

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
      totalEl.textContent = `${formatSar(sum)} SAR`;
      submit.disabled = !valid || !confirmBox.checked;
    };

    const rows = denominations.map((d) => {
      const input = h('input', { type: 'number', inputmode: 'numeric', min: '0', step: '1', value: String(analysis.counts[d.id] ?? 0), 'aria-label': `Count of ${d.label}` });
      input.addEventListener('input', recompute);
      inputs.set(d.id, input);
      const line = h('td', { class: 'num' });
      lineTotals.set(d.id, line);
      return h('tr', {}, h('td', {}, d.label, h('div', { class: 'muted small', dir: 'rtl' }, d.labelAr)), h('td', { class: 'num muted' }, String(analysis.counts[d.id] ?? 0)), h('td', {}, input), line);
    });

    const aiNote = analysis.status === 'completed'
      ? h('p', { class: 'note' }, 'These counts were suggested by AI from your photographs. AI can miscount overlapping or folded notes — check every line against the cash in front of you and correct it.')
      : h('p', { class: 'note warn' }, 'Automatic counting is not available for this capture. Enter every count by hand.');

    confirmBox.addEventListener('change', recompute);
    submit.addEventListener('click', async () => {
      submit.disabled = true;
      const counts = Object.fromEntries(denominations.map((d) => [d.id, Number(inputs.get(d.id).value.trim() || 0)]));
      try {
        const res = await api(`/reconciliations/${recon.id}/cash-count/confirm`, { method: 'POST', body: { analysisId: analysis.analysisId, counts, confirmed: true } });
        toast(`Cash count confirmed: ${res.total} SAR`, 'ok');
        close();
      } catch (err) {
        toast(err.message, 'error');
        recompute();
      }
    });

    const review = h('section', { class: 'cash-view review' },
      h('header', { class: 'cash-head' }, h('div', {}, h('h2', {}, 'Review cash count · مراجعة العد'), h('p', { class: 'muted' }, `${analysis.imageIds.length} photograph(s) · ${recon.branchName} · ${recon.businessDate}`)), closeBtn),
      aiNote,
      analysis.issues.length ? h('ul', { class: 'issues' }, ...analysis.issues.map((i) => h('li', {}, i))) : null,
      h('table', { class: 'denoms' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Denomination'), h('th', { class: 'num' }, 'AI'), h('th', {}, 'Confirmed'), h('th', { class: 'num' }, 'SAR'))),
        h('tbody', {}, ...rows),
        h('tfoot', {}, h('tr', {}, h('td', { colspan: '3' }, 'Total counted'), h('td', { class: 'num' }, totalEl)))),
      h('label', { class: 'confirm-line', for: 'confirm-count' }, confirmBox, ' I have checked every count against the physical cash and confirm the total. · أؤكد صحة العد'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { root.replaceChildren(view); startCamera(); } }, 'Recapture'),
        submit),
    );
    root.replaceChildren(review);
    recompute();
  }

  // ------------------------------------------------------------------ lifecycle

  function onVisibility() {
    // Release the camera whenever the page is hidden; ask again on return.
    if (document.hidden) {
      if (state.stream) { stopCamera(); setStatus(''); showBlocked('Camera paused', 'The camera was released while the app was in the background.'); }
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
