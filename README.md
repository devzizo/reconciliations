# Branch Reconciliation

Daily cash reconciliation for retail branches, in five stages:

1. **Daily closing form** — upload the signed form (PDF or photo) and enter its figures.
2. **Z report** — upload the POS Z report and enter its totals.
3. **Bank settlement receipt** — upload the mada / card terminal reconciliation receipt.
4. **Physical cash count** — **live camera only.** Photograph the cash; AI suggests denomination
   counts; the employee checks and confirms every line.
5. **Summary** — expected vs counted cash and cross-checks between the documents, then submit.

Stage 4's security design, limits and the optional native attested-capture channel are in
[`docs/stage4-camera-capture.md`](docs/stage4-camera-capture.md).

## Run it

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

Demo accounts are created on first start — **change them before real use**:

| Username | Password | Role |
|---|---|---|
| `tabuk.employee` | `change-me-tabuk` | Employee, Tabuk branch |
| `najran.employee` | `change-me-najran` | Employee, Najran branch |
| `finance.manager` | `change-me-manager` | Manager (all branches, audit trail) |

Set `SEED_DEMO_DATA=false` to skip them.

### AI cash counting

Set `ANTHROPIC_API_KEY` to enable Claude-based denomination counting (`CASH_AI_MODEL`, default
`claude-opus-5-5`). Without it the review screen starts at zero and employees count by hand.

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
| `DOCUMENT_MAX_BYTES` | `15728640` | Max size of a Stage 1–3 document |

## Tests

```bash
npm test
```

```bash
npm run test:e2e
```

The end-to-end tests skip themselves if Playwright isn't installed (`npm i -D playwright` and
`npx playwright install chromium`). They drive Chromium with a fake camera device: camera launches,
capture → retake → review → confirm, permission denied, no camera, unsupported browser, and the
camera stopping mid-capture.
