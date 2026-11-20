import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { loadConfig } from './config.js';
import { openSqlite } from './db/sqlite.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = await openSqlite(config);
const app = createApp({ db, config });

const server = config.tlsCert && config.tlsKey
  ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, app)
  : http.createServer(app);

server.listen(config.port, config.host, () => {
  const scheme = server instanceof https.Server ? 'https' : 'http';
  console.log(`Reconciliations listening on ${scheme}://${config.host}:${config.port}`);
  console.log(`AI cash counting: ${config.aiProvider}${config.aiProvider === 'anthropic' ? ` (${config.aiModel})` : ''}`);
  if (scheme === 'http') {
    console.log('Note: phones only allow camera access over HTTPS. Use TLS_CERT/TLS_KEY or an HTTPS reverse proxy (TRUST_PROXY=1).');
  }
});
