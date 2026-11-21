# Daily closing reconciliation (مطابقة الإقفال اليومي)

Open web app (Arabic, right-to-left) for reconciling each branch's day. Everything comes from photographs
taken with the live camera and read by AI — the daily closing form (branch and date included), Z report,
bank settlement receipt, yesterday's cash deposit receipt, expense invoices and the cash itself. Figures
can't be typed or edited; the app checks them against each other and shows matched (green) /
unmatched (red, with the difference) and yellow alerts. Each reconciliation opens only through its own link or
QR code; the home page shows just the latest one started on that phone.

How it works, the rules, and the security limits (no accounts!): [`docs/camera-capture.md`](docs/camera-capture.md).

## Live deployment (Cloudflare Workers)

Deployed at **https://reconciliations.dev-zizo.workers.dev** as the Worker `reconciliations`, with the
Cloudflare D1 database `reconciliations-db` (location hint: Eastern Europe, the closest D1 region to Saudi Arabia).

- `src/worker.js` runs the same Express app on Workers (`nodejs_compat` + `cloudflare:node`), with D1
  instead of `node:sqlite`. The front end in `public/` is bundled at build time
  (`scripts/build-static.mjs`) and served with the headers in `public/_headers`.
- Cash photographs and documents are stored in D1 as chunks (`file_chunks`), because R2 is not enabled
  on the account. The D1 free plan caps a database at 500 MB; once R2 is enabled, move file storage
  there (`src/fileStore.js` is the single place to change).
- There are no user accounts and no branch setup: the branch is taken from the name written on the form.
- The blank printable form is `public/daily-closing-form.pdf` (rebuild with `node scripts/build-form.mjs`
  after editing `forms/daily-closing-form.html`).

Deploy changes:

```bash
npx wrangler d1 migrations apply reconciliations-db --remote
```

```bash
npx wrangler deploy
```

Enable AI cash counting:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Smoke-test a deployment (`BASE=https://…`):

```bash
node scripts/smoke.mjs
```

## Run it locally

Requires Node.js 22.5+ (uses the built-in `node:sqlite`).

```bash
npm install
```

```bash
npm start
```

Phones only allow camera access on HTTPS. To try it on a phone on your network:

```bash
npm run dev-cert
```

```bash
TLS_CERT=dev-cert.pem TLS_KEY=dev-key.pem npm start
```

Then open `https://<your-computer-ip>:8443` on the phone (accept the self-signed certificate warning).
In production, put it behind an HTTPS reverse proxy with `TRUST_PROXY=1` (HTTPS is enforced when
`NODE_ENV=production`).

Two demo branches (Tabuk, Najran) are created locally on first start. Reading photos needs an AI key (below) —
without it no reconciliation can be created.

### AI cash counting

Set `ANTHROPIC_API_KEY` to enable reading the photographed documents and counting the cash (`CASH_AI_MODEL`, default
`claude-opus-5-5`). Without it nothing can be read, so no reconciliation can be created.

### Configuration

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `8443` / `0.0.0.0` | |
| `DATA_DIR` | `./data` | SQLite database and stored files |
| `TLS_CERT` / `TLS_KEY` | — | Serve HTTPS directly |
| `REQUIRE_HTTPS` | `true` in production | Refuse non-HTTPS requests |
| `TRUST_PROXY` | — | Express `trust proxy` setting when behind a proxy |
| `CAPTURE_SESSION_TTL_SECONDS` | `600` | Stage 4 capture session lifetime |
| `CAPTURE_MAX_IMAGES` | `10` | Photographs per capture session |
| `CAPTURE_MAX_BYTES` | `5242880` | Max size of one photograph |
| `CAPTURE_MIN_SHORT_SIDE` | `480` | Minimum photograph resolution (px) |

## Tests

```bash
npm test
```

```bash
npm run test:e2e
```

The end-to-end tests skip themselves if Playwright isn't installed (`npm i -D playwright` and
`npx playwright install chromium`). They drive Chromium with a fake camera device through the whole day — new reconciliation from the
photographed form, every document, cash confirmation, submission, the public view and home page — plus
camera denied / missing / unsupported / stopping, and an unreadable form header.
