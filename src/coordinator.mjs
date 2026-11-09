// Roloe coordinator: pages, API, encounter state and checks. It runs no model and holds no
// assistant login or token. Assistants call it with the owner's Roloe card key.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { config } from './env.mjs';
import { router, send, readJson, bearer, HttpError } from './http.mjs';
import { state, load, save, sha256, newKey, sameHash, cleanOwnerId, cleanName, cleanLine } from './state.mjs';
import { otlpOn, traceFile, flush } from './telemetry.mjs';
import { scrub } from './scrub.mjs';
import { openStore } from './store/index.mjs';

const KINDS = new Set(['session', 'file', 'commit', 'link']);
const SPEAKERS = new Set(['owner', 'assistant', 'pasted', '']);

export function authOwner(req, ownerId) {
  const key = bearer(req);
  const owner = state.owners[ownerId];
  if (!owner || !key || !sameHash(owner.token_hash, sha256(key))) throw new HttpError(401, 'unauthorized', 'Card key required');
  return owner;
}

export function publicCard(o) {
  return { owner: o.owner, name: o.name, line: o.line, sharing: o.sharing, passages: o.card?.passages || 0, updated: o.card?.updated || null };
}

export function buildApp({ store }) {
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

  // ---------- The card: one switch, and exactly what is shared ----------
  r.add('PUT', '/api/cards/:owner', async ({ req, res, params, span }) => {
    const o = authOwner(req, params.owner);
    if (!o.sharing) throw new HttpError(409, 'switch_off', 'Sharing is off. Turn the switch on first.');
    const body = await readJson(req, 8_000_000);
    const priv = new Set(o.private);
    const seen = new Set();
    const passages = [];
    let rescrubbed = 0;
    for (const p of Array.isArray(body.passages) ? body.passages.slice(0, 600) : []) {
      const id = String(p.passage_id || '');
      if (!/^p-[0-9a-f]{6}$/.test(id) || priv.has(id) || seen.has(id)) continue;
      seen.add(id);
      // Scrub again on arrival: the coordinator never trusts the client's scrubber alone.
      const s = scrub(String(p.text || '').slice(0, 1500));
      rescrubbed += s.removed.length;
      passages.push({
        passage_id: id,
        kind: KINDS.has(p.kind) ? p.kind : 'file',
        speaker: SPEAKERS.has(p.speaker) ? p.speaker : '',
        source: scrub(String(p.source || '')).text.slice(0, 200),
        locator: scrub(String(p.locator || '')).text.slice(0, 200),
        via: String(p.via || '').slice(0, 20),
        ts: isNaN(Date.parse(p.ts)) ? new Date().toISOString() : new Date(p.ts).toISOString(),
        text: s.text,
      });
    }
    await store.replaceCard(o.owner, o.name, passages);
    const t = body.totals || {};
    o.card = {
      passages: passages.length,
      totals: { sessions: +t.sessions || 0, files: +t.files || 0, commits: +t.commits || 0, owner_messages: +t.owner_messages || 0, secrets_removed: (+t.secrets_removed || 0) + rescrubbed },
      scope: cleanLine(body.scope || '', 80),
      updated: new Date().toISOString(),
    };
    save();
    span.setAttributes({ 'roloe.owner': o.owner, 'roloe.card.passages': passages.length, 'roloe.card.rescrubbed': rescrubbed });
    send(res, 200, { owner: o.owner, passages: passages.length, private: o.private.length, rescrubbed });
  });

  r.add('POST', '/api/cards/:owner/switch', async ({ req, res, params }) => {
    const o = authOwner(req, params.owner);
    const { on } = await readJson(req);
    o.sharing = Boolean(on);
    if (!o.sharing) {
      await store.replaceCard(o.owner, o.name, []);   // off empties the card at once
      o.card = { ...o.card, passages: 0, updated: new Date().toISOString() };
    }
    save();
    send(res, 200, { owner: o.owner, sharing: o.sharing, passages: o.card.passages });
  });

  r.add('GET', '/api/cards/:owner/passages', async ({ req, res, params }) => {
    const o = authOwner(req, params.owner);
    const passages = (await store.listCard(o.owner)).sort((a, b) => (a.source > b.source ? 1 : a.source < b.source ? -1 : a.locator.localeCompare(b.locator, undefined, { numeric: true })));
    send(res, 200, { owner: o.owner, name: o.name, sharing: o.sharing, card: o.card, private: o.private, passages });
  });

  r.add('POST', '/api/cards/:owner/private', async ({ req, res, params }) => {
    const o = authOwner(req, params.owner);
    const { passage_id: id, private: priv = true } = await readJson(req);
    if (!/^p-[0-9a-f]{6}$/.test(String(id))) throw new HttpError(400, 'bad_passage', 'passage_id required');
    o.private = o.private.filter((x) => x !== id);
    if (priv) {
      o.private.push(id);
      const n = await store.removeFromCard(o.owner, id);
      o.card.passages = Math.max(0, (o.card.passages || 0) - n);
    }
    save();
    send(res, 200, { owner: o.owner, private: o.private });
  });

  return r;
}

export async function start(port = config.port) {
  load();
  const store = await openStore();
  const app = buildApp({ store });
  console.log(`[roloe] store: ${JSON.stringify(store.describe())}`);
  const server = http.createServer(app.handle);
  server.listen(port, config.host, () => {
    console.log(`[roloe] coordinator on ${config.publicUrl} (port ${port})`);
    console.log(`[roloe] traces → ${traceFile}${otlpOn ? ' and OTLP' : ' (OTLP off: set OTEL_EXPORTER_OTLP_ENDPOINT)'}`);
  });
  const stop = async () => { await flush().catch(() => {}); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
