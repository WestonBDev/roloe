// The zero-install guest path, end to end on the coordinator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, twoCards, waitReady } from './helpers.mjs';
import { elasticStore } from '../src/store/elastic.mjs';

test('a guest\'s sentence becomes their side of the overlap; Weston\'s assistant gets both sides', async () => {
  const s = await startTestServer();
  try {
    const { wes } = await twoCards(s);
    const g = await s.call('POST', '/api/g/wes/start', { text: 'Our card watcher marks the refresh done before the push succeeds and I am stuck' });
    assert.equal(g.status, 201);
    const view = await waitReady(s, g.body.id, g.body.key);
    assert.equal(view.guest_input.kind, 'text');
    const pull = (await s.call('GET', `/api/e/${g.body.id}/pull`, null, wes)).body;
    assert.equal(pull.theirs.length, 1);
    assert.equal(pull.theirs[0].speaker, 'owner');
    assert.match(pull.instructions, /"theirs"/);
    assert.ok(pull.mine.some((p) => p.passage_id === 'p-e00001'), 'the overlap found Wes\'s matching passage');
    const post = await s.call('POST', `/api/e/${g.body.id}/findings`, { findings: [{ cites: 'p-e00001', quote: 'card watcher records refresh as done', about: pull.theirs[0].passage_id, what: 'Wes hit this too.' }] }, wes);
    assert.equal(post.body.accepted, 1);
  } finally { await s.close(); }
});

test('a link that can\'t be read still opens the meeting, and the guest is told why', async () => {
  const s = await startTestServer();
  try {
    await twoCards(s);
    const g = await s.call('POST', '/api/g/wes/start', { link: 'https://localhost/private' });
    assert.equal(g.status, 201);
    const view = await waitReady(s, g.body.id, g.body.key);
    assert.match(view.guest_input.error, /public/);
  } finally { await s.close(); }
});

test('Elasticsearch re-attaches an open meeting\'s scope after a restart', async () => {
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const reply = (status, json) => new Response(JSON.stringify(json), { status });
    if (u.pathname === '/') return reply(200, { version: { build_flavor: 'serverless' } });
    if (u.pathname === '/_inference/_all') return reply(200, { endpoints: [] });
    if (opts.method === 'HEAD') return reply(200, {});
    if (u.pathname.endsWith('/_mapping')) return reply(200, { x: { mappings: { properties: {} } } });
    if (u.pathname === '/_security/api_key') return reply(400, { error: { type: 'illegal_argument_exception' } });
    if (u.pathname.endsWith('/_count')) return reply(200, { count: 5 });
    return reply(200, { hits: { hits: [] } });
  };
  const mk = async () => { const st = elasticStore({ esUrl: 'https://x', esApiKey: 'k', esIndex: 'roloe-t', fetchImpl }); await st.init(); return st; };
  const before = await mk();
  const { id } = await before.createEncounterKey('e-0000000001');
  const after = await mk();   // a new process: the key map is empty
  assert.equal(await after.count(id), 0);
  const re = await after.reattach('e-0000000001', id);
  assert.equal(await after.count(re.id), 5);
});

test('a coordinator restart keeps the card and the guest\'s meeting page working', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'roloe-restart-'));
  const port = 7700 + Math.floor(Math.random() * 200);
  const env = { ...process.env, PORT: String(port), ROLOE_DATA_DIR: dataDir, ROLOE_ENV_FILE: '/nonexistent', ES_URL: '', ELASTIC_URL: '' };
  const boot = () => new Promise((resolve) => { const p = spawn('node', ['src/coordinator.mjs'], { env, stdio: ['ignore', 'pipe', 'inherit'] }); p.stdout.on('data', (d) => { if (String(d).includes('coordinator on')) resolve(p); }); });
  const base = `http://127.0.0.1:${port}`;
  const call = async (m, path, body, headers = {}) => { const r = await fetch(base + path, { method: m, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  let p = await boot();
  try {
    const { body: { key } } = await call('POST', '/api/owners', { owner: 'wes', name: 'Wes' });
    const auth = { authorization: `Bearer ${key}` };
    await call('POST', '/api/cards/wes/switch', { on: true }, auth);
    await call('PUT', '/api/cards/wes', { passages: [{ passage_id: 'p-e00001', kind: 'session', speaker: 'owner', source: 's', locator: 'x', ts: new Date().toISOString(), text: 'card watcher records refresh as done before the push succeeds' }] }, auth);
    const g = await call('POST', '/api/g/wes/start', { text: 'my watcher marks refresh done too early' });
    for (let i = 0; i < 100 && (await call('GET', `/api/e/${g.body.id}?k=${g.body.key}`)).body.status === 'preparing'; i++) await new Promise((r) => setTimeout(r, 30));
    p.kill('SIGTERM'); await new Promise((r) => p.on('exit', r));
    p = await boot();
    assert.equal((await call('GET', '/api/cards/wes')).status, 200, 'card survives');
    const view = await call('GET', `/api/e/${g.body.id}?k=${g.body.key}`);
    assert.equal(view.status, 200, 'guest page survives');
    const pull = await call('GET', `/api/e/${g.body.id}/pull`, null, auth);
    assert.equal(pull.status, 200, 'Weston\'s assistant can still read the meeting');
    assert.equal(pull.body.theirs.length, 1);
  } finally { p.kill('SIGTERM'); }
});

test('the guest\'s page opens at once; reading and copying happen behind it, and the assistant sees the meeting only when it\'s ready', async () => {
  const http = await import('node:http');
  const { buildApp } = await import('../src/coordinator.mjs');
  const s = await startTestServer();
  try {
    const { wes } = await twoCards(s);
    // A second app on the same store, with a slow reader (a big repo).
    const slow = buildApp({ store: s.store, guestReader: async (inp) => { await new Promise((r) => setTimeout(r, 1500)); return { kind: 'text', passages: [{ passage_id: 'p-b00009', kind: 'session', speaker: 'owner', source: 'note', locator: 'note', ts: new Date().toISOString(), text: inp.text }], error: null }; } });
    const srv = http.createServer(slow.handle);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const t0 = Date.now();
    const res = await fetch(`${base}/api/g/wes/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'card watcher marks refresh done before the push' }) });
    const g = await res.json();
    assert.equal(res.status, 201);
    assert.ok(Date.now() - t0 < 500, `answered in ${Date.now() - t0} ms`);
    let view = await (await fetch(`${base}/api/e/${g.id}?k=${g.key}`)).json();
    assert.equal(view.status, 'preparing');
    assert.equal((await s.call('GET', '/api/me/encounters', null, wes)).body.encounters.length, 0, 'not offered to the assistant yet');
    await new Promise((r) => setTimeout(r, 2500));
    view = await (await fetch(`${base}/api/e/${g.id}?k=${g.key}`)).json();
    assert.equal(view.status, 'open');
    assert.equal((await s.call('GET', '/api/me/encounters', null, wes)).body.encounters[0].id, g.id);
    srv.close();
  } finally { await s.close(); }
});

test('GitHub refusals become plain words, not status codes', async () => {
  const { readGuestInput } = await import('../src/guest-input.mjs');
  const lookup = async () => [{ address: '140.82.112.3', family: 4 }];
  const r = await readGuestInput({ link: 'https://github.com/acme/private-repo' }, { fetchImpl: async () => new Response('no', { status: 404 }), lookup });
  assert.match(r.error, /not found|public/i);
  assert.ok(!/404/.test(r.error));
});
