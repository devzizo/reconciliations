# Camera-only capture and how a reconciliation is built

Every figure in a reconciliation ("مطابقة") comes from a photograph taken with the **live camera**
inside the app and read by AI. Nothing is typed, nothing can be edited, and no file, PDF or gallery
image can be uploaded. To change a number, the employee corrects the handwriting on the paper and
photographs it again.

## Flow

1. **مطابقة جديدة** → live camera → photograph the daily closing form (FIN-DCF-01).
   The AI reads the **branch** (chosen from the branches table), the **date**, the weekday and every
   amount. The reconciliation is created with the next sequential number. If the branch or date can't be
   read, nothing is created and the employee is asked to photograph again.
   One reconciliation per branch per day: a second phone photographing the same day's form is shown
   the existing reconciliation's number instead.
2. On the same phone, photograph: Z report, bank settlement receipt, yesterday's cash deposit receipt,
   one invoice per expense (required when an expense is written on the form), and the cash.
3. Cash: the AI counts each denomination; the employee compares and **confirms** (or photographs again).
4. **اعتماد المطابقة** once every required photograph is in. The result is stored as matched / unmatched.

There is no public list. The home page shows only the latest reconciliation started on that phone
(number, branch, date, status, QR code, copyable link). Every reconciliation stays in the database and
opens only through its own unguessable link or its QR code. Only the phone that started a reconciliation holds its secret
edit token (kept in that browser) and can add photographs to it.

## Rules (`src/services/checks.js`)

| Check | Compared |
|---|---|
| gross − returns = net | closing form |
| payment methods = net | mada + mastercard + visa + tamara + tabby + cash (overage/shortage excluded) |
| Z report ↔ form | net sales, cash, mada, visa (Z) vs visa + mastercard (form) |
| bank receipt ↔ form | mada; visa + mastercard |
| deposit ↔ yesterday | deposit receipt amount vs **yesterday's closing cash balance** for the same branch |
| expenses | sum of invoices vs cash outflow |
| cash | counted cash vs closing cash balance |

Differences under 0.30 SAR are treated as matching and not mentioned. Other differences are shown in red
("غير مطابق") with the amount to two decimals. Empty or unclear fields, missing photographs and date
inconsistencies are yellow alerts.

## Capture integrity

- The client's camera details are sent in an ASCII-escaped header (Arabic-language phones report an
  Arabic camera name, which browsers refuse to put in a header as-is).
- Live `getUserMedia()` preview, rear camera preferred; frames go `<video>` → `<canvas>` → JPEG and are
  uploaded immediately. No `<input type=file>`, no paste/drop, no download links, no `<img>` of a captured
  frame (iOS "Save to Photos"); the camera is released when the app goes to the background.
- Each photo needs a short-lived, server-issued camera session (secret token, 10 minutes, one kind, one
  reconciliation). Server-side checks: raw `image/jpeg` only (multipart/PDF → 415), complete JPEG, minimum
  resolution, no camera EXIF (gallery photos → 422). Server timestamps, UUIDs and SHA-256 for every image.
- Append-only, hash-chained `audit_log` (sessions, captures, retakes, readings, refusals, confirmations,
  submissions, client IP from Cloudflare).
- Per-IP limit of 60 camera sessions per hour.

## Limits — read this

- **There are no user accounts.** Anyone with the site address can start a reconciliation for any
  branch whose form they can photograph, and anyone holding a reconciliation's link or QR code can view it
  and its document photos.
  Cash photos are only shown to the phone that took them. If that is not acceptable, put the site behind
  Cloudflare Access (or bring back sign-in).
- Browser capture cannot prove a scene is live: a virtual camera, a photo of a screen, or a scripted
  client can still submit an image. The controls above remove the easy paths and leave an evidence trail;
  they are not absolute anti-fraud protection.
- Every reading costs an AI call; the per-IP limit reduces, but does not prevent, abuse of the open site.
- An optional native attested-capture channel exists server-side (`/attested-captures`, see
  `src/services/attestation.js`); it returns 501 until a verifier is configured. The native app is not included.
