// Roloe coordinator: pages, API, encounter state and checks. It runs no model and holds no
// assistant login or token. Assistants call it with the owner's Roloe card key.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { config } from './env.mjs';
import { router, send, readJson, bearer, HttpError } from './http.mjs';
import { state, load, save, saveNow, sha256, newKey, sameHash, cleanOwnerId, cleanName, cleanLine } from './state.mjs';
import { otlpOn, traceFile, flush } from './telemetry.mjs';

export function authOwner(req, ownerId) {
  const key = bearer(req);
  const owner = state.owners[ownerId];
  if (!owner || !key || !sameHash(owner.token_hash, sha256(key))) throw new HttpError(401, 'unauthorized', 'Card key required');
  return owner;
}

export function publicCard(o) {
  return { owner: o.owner, name: o.name, line: o.line, sharing: o.sharing, passages: o.card?.passages || 0, updated: o.card?.updated || null };
}

export function buildApp() {
  const r = router();

  r.add('GET', '/healthz', ({ res }) => send(res, 200, { ok: true, otlp: otlpOn }));

  // Register a card. The key is returned once; only its hash is kept.
  r.add('POST', '/api/owners', async ({ req, res, span }) => {
    const body = await readJson(req);
    const owner = cleanOwnerId(body.owner);
    if (!owner || owner.length < 2) throw new HttpError(400, 'bad_owner', 'Owner must be 2–32 letters, digits or dashes');
    if (state.owners[owner]) throw new HttpError(409, 'taken', 'That card name is taken. Rotate its key with the old key, or pick another.');
    const key = newKey('rk');
    state.owners[owner] = {
      owner, name: cleanName(body.name) || owner, line: cleanLine(body.line),
      token_hash: sha256(key), sharing: false, private: [], card: { passages: 0, totals: {}, updated: null },
      created: new Date().toISOString(),
    };
    save();
    span.setAttribute('roloe.owner', owner);
    send(res, 201, { owner, key, card_url: `${config.publicUrl}/g/${owner}`, me_url: `${config.publicUrl}/me/${owner}#${key}` });
  });

  r.add('POST', '/api/owners/:owner/rotate', async ({ req, res, params }) => {
    const o = authOwner(req, params.owner);
    const key = newKey('rk');
    o.token_hash = sha256(key);
    save();
    send(res, 200, { owner: o.owner, key });
  });

  r.add('GET', '/api/cards/:owner', ({ res, params }) => {
    const o = state.owners[params.owner];
    if (!o) throw new HttpError(404, 'no_card', 'No card by that name yet');
    send(res, 200, publicCard(o));
  });

  return r;
}

export function start(port = config.port) {
  load();
  const app = buildApp();
  const server = http.createServer(app.handle);
  server.listen(port, config.host, () => {
    console.log(`[roloe] coordinator on ${config.publicUrl} (port ${port})`);
    console.log(`[roloe] traces → ${traceFile}${otlpOn ? ' and OTLP' : ' (OTLP off: set OTEL_EXPORTER_OTLP_ENDPOINT)'}`);
  });
  // Write any pending state before exiting: a key already sent to a caller must survive.
  const stop = async () => { try { saveNow(); } catch { /* disk gone: nothing more to do */ } await flush().catch(() => {}); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
