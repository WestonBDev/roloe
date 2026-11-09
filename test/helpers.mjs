// Test harness: a coordinator on a random port with a throwaway data dir.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ROLOE_DATA_DIR = mkdtempSync(join(tmpdir(), 'roloe-test-'));
process.env.ROLOE_ENV_FILE = '/nonexistent';
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.ES_URL;
delete process.env.ELASTIC_URL;

export async function startTestServer() {
  const http = await import('node:http');
  const { buildApp } = await import('../src/coordinator.mjs');
  const { state } = await import('../src/state.mjs');
  for (const k of Object.keys(state.owners)) delete state.owners[k];
  for (const k of Object.keys(state.encounters)) delete state.encounters[k];
  state.canaries.length = 0;
  const { memoryStore } = await import('../src/store/memory.mjs');
  const store = memoryStore();
  await store.init();
  const app = buildApp({ store });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  return { keys: {}, base, call, close: () => new Promise((r) => server.close(r)), dataDir: process.env.ROLOE_DATA_DIR, store, state: () => state };
}

// Two registered, sharing cards with a known overlap (Maya's retry lesson, Wes's watcher bug).
const P = (id, text, kind = 'session') => ({ passage_id: id, kind, speaker: kind === 'file' ? '' : 'owner', source: 's', locator: id, ts: new Date().toISOString(), text });

export async function twoCards(s) {
  const reg = async (owner, name, passages) => {
    const { body: { key } } = await s.call('POST', '/api/owners', { owner, name });
    const auth = { authorization: `Bearer ${key}` };
    await s.call('POST', `/api/cards/${owner}/switch`, { on: true }, auth);
    await s.call('PUT', `/api/cards/${owner}`, { passages }, auth);
    if (s.keys) s.keys[owner] = auth.authorization.slice(7);
    return auth;
  };
  const wes = await reg('wes', 'Wes', [P('p-e00001', 'card watcher records refresh as done before the push succeeds'), P('p-e00002', 'function refresh() { push(card); markDone(); }', 'file')]);
  const maya = await reg('maya', 'Maya', [P('p-a00001', 'mark the combined total partial when one fetch fails to load, then retry the push'), P('p-a00002', 'pick a theme')]);
  return { wes, maya };
}


// A guest meeting opens at once and gets ready behind the scenes: wait for that.
export async function waitReady(s, id, key, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = (await s.call('GET', `/api/e/${id}?k=${key}`)).body;
    if (v.status !== 'preparing' || Date.now() > until) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}
