# Stage 4 — Camera-only physical cash count

This document describes how the cash-counting stage enforces live-camera capture, what it
proves, and — just as importantly — what it does **not** prove.

The restriction applies **only to Stage 4 cash photographs**. Daily closing forms, Z reports
and bank settlement receipts (Stages 1–3) keep normal PDF / image upload.

## Requirement → implementation

| # | Requirement | Where |
|---|---|---|
| 1 | Capture with the phone camera | `public/cash-camera.js` → `startCamera()` |
| 2 | No gallery / photo library / file picker in the employee UI | `cash-camera.js` has no `<input type=file>`, `FileReader`, file-system picker, paste or drop handling; paste/drop events are blocked on the Stage 4 view. Checked by `test/api/cash-capture.test.js` and `test/e2e/camera.test.js`. |
| 3 | Live preview via `getUserMedia()`, rear camera preferred | `facingMode: { ideal: 'environment' }`, `playsinline` + `muted` video for iOS |
| 4 | Capture from the live stream | `<video>` frame → `<canvas>` → `canvas.toBlob('image/jpeg')` |
| 5 | `<input type=file>` is not the capture mechanism | Not used anywhere in Stage 4 |
| 6 | Retake allowed, existing photo never selectable | `DELETE /api/cash-capture/sessions/:sid/images/:imageId` soft-deletes (kept for audit); the shutter is the only way to add a photo |
| 7 | Upload immediately | Each frame is POSTed the moment the shutter is pressed |
| 8 | Each capture tied to employee, branch, reconciliation, server timestamp, capture session, unique image id | `cash_images` row: `user_id`, `branch_id`, `reconciliation_id`, `captured_at` (server clock; client time headers are ignored), `session_id`, `id` (UUID) + `sha256` |
| 9 | Reject ordinary image uploads for cash | `POST /api/reconciliations/:id/documents?type=cash_*` → **403 `CASH_PHOTOS_CAMERA_ONLY`**. The capture endpoint refuses anything that isn't a raw `image/jpeg` body (multipart, JSON/base64, PNG…) → **415 `CAMERA_CAPTURE_ONLY`**. JPEGs carrying camera EXIF (Make/Model/DateTimeOriginal/GPS…) → **422 `NOT_A_LIVE_CAPTURE`**. Every rejection is audited. |
| 10 | Block submission when the camera is unavailable | Shutter and "Review count" are disabled unless a live video track exists. Server side, a count can only be confirmed against an analysis built from photographs taken in a capture session. |
| 11 | No gallery fallback | The blocked screen offers "Try camera again" only |
| 12 | iOS Safari + Android Chrome over HTTPS | Secure-context check, `playsinline`/`webkit-playsinline`, `REQUIRE_HTTPS`, HSTS, `Permissions-Policy: camera=(self)` |
| 13 | Never stored in the device photo gallery | No download links or blob URLs; previews are `<canvas>` thumbnails (an `<img>` would offer "Save to Photos" on long-press), frame buffers are dropped after upload, camera is released when the page is hidden |
| 14 | Human confirmation of AI counts | `POST /api/reconciliations/:id/cash-count/confirm` requires `confirmed: true` and the full count table from the employee; AI vs confirmed differences are stored as `adjustments` |

## Capture integrity

1. **Session issue** — `POST /api/reconciliations/:id/cash-count/sessions` (employee only, own branch,
   reconciliation open, cash count not yet confirmed). Returns a random 256-bit `captureToken` once;
   only its SHA-256 is stored. Default lifetime 10 minutes (`CAPTURE_SESSION_TTL_SECONDS`). Starting a
   new session supersedes any open one for that employee + reconciliation.
2. **Upload** — needs both the employee's bearer token **and** `X-Capture-Token`. The server checks,
   in constant time, that the token matches, the caller is the session's employee, the employee's
   branch is the session's branch, the reconciliation belongs to that branch and is open, the session
   is open and unexpired, and the per-session photo limit (default 10) isn't exceeded.
3. **Image checks** — complete JPEG, minimum resolution, no camera EXIF. Frames whose size doesn't
   match the video track the client reported are accepted but **flagged** for review.
4. **Finalize** — closes the session (no further uploads), runs the AI count on the active photographs.
5. **Confirm** — only the capturing employee, only the latest analysis, only if every photograph it
   used is still active.

### Audit trail

`audit_log` is append-only (SQLite triggers reject UPDATE/DELETE) and hash-chained: each entry's
hash covers the previous entry's hash, so editing the database file afterwards is detectable
(`GET /api/reconciliations/:id/audit` returns `chain.ok`). Logged events include session start /
supersede / finalize, each capture (hash, size, dimensions, flags, client camera metadata), retakes,
every denied request (bad token, wrong user/branch, expired, wrong content type, EXIF rejection),
the AI result, the human confirmation with adjustments, and every time a manager views a photo.

## AI denomination counting

`src/services/cashCounter.js` sends the photographs to Claude (`claude-opus-5-5`) with a strict JSON
schema and returns per-denomination counts plus issues (overlap, low confidence, text in the image
that tries to change the count). It runs only when `ANTHROPIC_API_KEY` (or another Anthropic SDK
credential) is configured. Without it, or if the call fails or is refused, the review screen starts
at zero and the employee counts by hand — **the stage never completes without a person confirming
every line.**

## Security limitation — read this

Browser-based capture **cannot** cryptographically prove that the photographed scene is live or that
the camera feed was not manipulated. Someone with control of their device can:

- install a virtual camera / modified browser that feeds a pre-recorded image into `getUserMedia()`;
- point the camera at a screen or printout showing a photo of cash;
- script the HTTP API directly using their own credentials and a valid capture token, sending a
  metadata-stripped JPEG.

What the controls above *do* achieve: they remove the easy path (picking an old photo from the
gallery), make every capture attributable to an authenticated employee, branch, reconciliation and
server time, bound it to a short-lived session, and leave a tamper-evident record for reviewers. The
EXIF check is a heuristic. Treat this as a deterrent and an evidence trail, **not** absolute
anti-fraud protection. Physical controls (dual counting, manager spot checks, safe drops) still matter.

## Optional: native capture module with device attestation

For stronger assurance, the server has an attested channel:

- `POST /api/reconciliations/:id/cash-count/sessions` with `{"channel":"native_attested"}`
- `POST /api/cash-capture/sessions/:sid/attested-images` with `X-Device-Attestation`

Both return **501** until a verifier is configured (`config.attestationVerifier`, see
`src/services/attestation.js` for the interface). The verifier receives a challenge of
`sha256(captureToken):<seq>:<imageSha256>`, so an attestation is bound to one session, one capture
slot and one exact image.

The native module itself is **not included in this repository**. A conforming iOS/Android module must:

1. Use the platform camera API directly (AVFoundation / CameraX) with no photo-library access, and
   never write to the camera roll.
2. Request a capture session with `channel: "native_attested"`.
3. For each shot, compute `imageSha256`, build the challenge above, and obtain an Apple App Attest
   assertion or a Google Play Integrity token whose request hash / client data is that challenge.
4. Upload the JPEG with the attestation in `X-Device-Attestation`.

The server-side verifier must validate the attestation chain against Apple/Google roots, the app's
bundle id / package name and signing certificate, and the challenge. Even then, attestation proves the
*app and device* are genuine, not that the scene in front of the lens is.
