// Cloudflare Workers entry point. The same Express app runs here through the Workers Node.js HTTP
// server compatibility layer, with D1 instead of node:sqlite. The front end (public/) is bundled at
// build time (scripts/build-static.mjs) and served directly, with the headers from public/_headers.
import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { loadConfig } from './config.js';
import { openD1 } from './db/d1.js';
import { createApp } from './app.js';
import { STATIC_FILES, STATIC_HEADERS } from './generated/static.js';

const config = loadConfig({ serveStatic: false, requireHttps: false, alwaysHsts: true, trustProxy: true, seedDemoData: false });
const app = createApp({ db: openD1(env.DB), config });
const PORT = 8080;
app.listen(PORT);
const node = httpServerHandler({ port: PORT });

export default {
  async fetch(request, workerEnv, ctx) {
    const url = new URL(request.url);
    // Camera access needs HTTPS: never serve the API over plain HTTP (localhost excepted for wrangler dev).
    if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 308);
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && !url.pathname.startsWith('/api/') && url.pathname !== '/healthz') {
      return serveStatic(request, url);
    }
    // Client IP for the audit trail comes from Cloudflare, never from a client-supplied header.
    const headers = new Headers(request.headers);
    headers.set('x-forwarded-for', request.headers.get('cf-connecting-ip') ?? '');
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    return node.fetch(new Request(request, { headers }), workerEnv, ctx);
  },
};

function serveStatic(request, url) {
  // Single-page app: unknown paths get index.html.
  const file = STATIC_FILES[decodeURIComponent(url.pathname)] ?? STATIC_FILES['/index.html'];
  const headers = new Headers(STATIC_HEADERS);
  headers.set('Content-Type', file.type);
  headers.set('ETag', file.etag);
  headers.set('Cache-Control', 'no-cache');
  if (request.headers.get('if-none-match') === file.etag) return new Response(null, { status: 304, headers });
  if (file.base64) headers.set('Content-Disposition', `inline; filename="${url.pathname.slice(1)}"`);
  const body = file.base64 ? Buffer.from(file.base64, 'base64') : file.body;
  return new Response(request.method === 'HEAD' ? null : body, { headers });
}
