import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

/** Build the runtime configuration. Tests pass overrides instead of touching process.env. */
export function loadConfig(overrides = {}) {
  const dataDir = overrides.dataDir ?? process.env.DATA_DIR ?? path.join(root, 'data');
  return {
    root,
    port: int('PORT', 8443),
    host: process.env.HOST ?? '0.0.0.0',
    dataDir,
    dbFile: path.join(dataDir, 'reconciliations.sqlite'),
    // TLS: provide cert + key to serve HTTPS directly; otherwise run behind an HTTPS-terminating proxy.
    tlsCert: process.env.TLS_CERT ?? null,
    tlsKey: process.env.TLS_KEY ?? null,
    // When true, any request that did not arrive over HTTPS is refused (camera APIs need a secure context).
    requireHttps: (process.env.REQUIRE_HTTPS ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true',
    trustProxy: process.env.TRUST_PROXY ?? false,
    authTokenTtlMinutes: int('AUTH_TOKEN_TTL_MINUTES', 12 * 60),
    // Stage 4 capture sessions are deliberately short-lived.
    captureSessionTtlSeconds: int('CAPTURE_SESSION_TTL_SECONDS', 10 * 60),
    captureMaxImages: int('CAPTURE_MAX_IMAGES', 10),
    captureMaxBytes: int('CAPTURE_MAX_BYTES', 5 * 1024 * 1024),
    captureMinShortSide: int('CAPTURE_MIN_SHORT_SIDE', 480),
    documentMaxBytes: int('DOCUMENT_MAX_BYTES', 15 * 1024 * 1024),
    // AI denomination counting (Claude vision). Disabled unless credentials are present.
    aiProvider: process.env.CASH_AI_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'none'),
    aiModel: process.env.CASH_AI_MODEL ?? 'claude-opus-5-5',
    seedDemoData: (process.env.SEED_DEMO_DATA ?? 'true') === 'true',
    ...overrides,
  };
}
