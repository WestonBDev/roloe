import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer, twoCards } from './helpers.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const good = { cites: 'p-a00001', quote: 'mark the combined total partial', about: 'p-e00001', what: 'Aiden marks totals partial.' };

async function meeting(s) {
  const cards = await twoCards(s);
  const tap = await s.call('POST', '/api/tap', { to: 'wes' }, cards.aiden);
  const enc = s.state().encounters[tap.body.id];
  const k = { aiden: enc.sides.aiden.key, wes: enc.sides.wes.key };
  return { ...cards, id: tap.body.id, k, stage: enc.stageKey };
}

test('sealed lines: commit a hash, reveal only a matching line, the other side sees it only after revealing', async () => {
  const s = await startTestServer();
  try {
    const { id, k } = await meeting(s);
    const line = 'help with flaky push retries';
    const nonce = 'n0nce-123';
    assert.equal((await s.call('POST', `/api/e/${id}/seal?k=${k.wes}`, { hash: 'nothex' })).status, 400);
    const sealed = await s.call('POST', `/api/e/${id}/seal?k=${k.wes}`, { hash: sha(`${nonce}|${line}`) });
    assert.equal(sealed.status, 200);
    assert.equal((await s.call('POST', `/api/e/${id}/seal?k=${k.wes}`, { hash: sha('x') })).status, 409, 'one seal per side');
    await s.call('POST', `/api/e/${id}/seal?k=${k.aiden}`, { skipped: true });
    let aidenView = (await s.call('GET', `/api/e/${id}?k=${k.aiden}`)).body;
    assert.equal(aidenView.seal.theirs.hash, sha(`${nonce}|${line}`));
    assert.equal(aidenView.seal.theirs.line, null);
    assert.equal(aidenView.seal.mine.skipped, true);
    assert.equal((await s.call('POST', `/api/e/${id}/reveal?k=${k.wes}`, { line: 'something else', nonce })).status, 400);
    assert.equal((await s.call('POST', `/api/e/${id}/reveal?k=${k.wes}`, { line, nonce })).status, 200);
    aidenView = (await s.call('GET', `/api/e/${id}?k=${k.aiden}`)).body;
    assert.equal(aidenView.seal.theirs.line, line);
  } finally { await s.close(); }
});

test('stage view: both names, hashes, top finding per side, Prepared before and Read live numbers; stage key only', async () => {
  const s = await startTestServer();
  try {
    const { id, k, stage, aiden, wes } = await meeting(s);
    assert.equal((await s.call('GET', `/api/e/${id}/stage?k=${k.wes}`)).status, 401);
    await s.call('POST', `/api/e/${id}/findings`, { findings: [good, { ...good, quote: 'then retry the push' }] }, aiden);
    await s.call('POST', `/api/e/${id}/findings`, { nothing_strong: true }, wes);
    const st = (await s.call('GET', `/api/e/${id}/stage?k=${stage}`)).body;
    assert.deepEqual(st.names, { aiden: 'Aiden', wes: 'Wes' });
    assert.equal(st.sides.aiden.top.quote, good.quote);
    assert.equal(st.sides.aiden.more, 1);
    assert.equal(st.sides.wes.nothing_strong, true);
    assert.equal(st.prepared.aiden.passages, 2);
    assert.ok(st.live.ready_ms >= 0);
    assert.ok(st.live.first_findings_ms >= 0);
    assert.match(st.scope, /coordinator filter|document-level/);
    assert.match(st.trace_id, /^[0-9a-f]{32}$/);
  } finally { await s.close(); }
});

test('stop: key invalidated, copies deleted, a query with the old key returns 0, nothing more can be read', async () => {
  const s = await startTestServer();
  try {
    const { id, k, aiden } = await meeting(s);
    const keyId = s.state().encounters[id].keyId;
    assert.equal(await s.store.count(keyId), 4);
    const stop = await s.call('POST', `/api/e/${id}/stop?k=${k.wes}`);
    assert.equal(stop.status, 200);
    assert.deepEqual({ deleted: stop.body.deleted, after: stop.body.query_after_stop }, { deleted: 4, after: 0 });
    assert.equal(await s.store.count(keyId), 0);
    assert.equal((await s.call('GET', `/api/e/${id}/pull`, null, aiden)).status, 410);
    assert.equal((await s.call('POST', `/api/e/${id}/findings`, { findings: [good] }, aiden)).status, 410);
    const view = (await s.call('GET', `/api/e/${id}?k=${k.aiden}`)).body;
    assert.equal(view.status, 'closed');
    assert.equal(view.closed.by, 'wes');
    const { flush } = await import('../src/telemetry.mjs');
    await flush();
    const spans = readFileSync(join(s.dataDir, 'traces.jsonl'), 'utf8');
    assert.match(spans, /"name":"roloe\.stop"/);
    assert.match(spans, /"roloe\.stop\.query_after_stop":0/);
  } finally { await s.close(); }
});

test('guest tap: no account, optional https link, the owner\'s assistant gets the guest variant', async () => {
  const s = await startTestServer();
  try {
    const { wes } = await twoCards(s);
    assert.equal((await s.call('POST', '/api/g/wes/start', { link: 'javascript:alert(1)' })).status, 400);
    assert.equal((await s.call('POST', '/api/g/nobody/start', {})).status, 404);
    const g = await s.call('POST', '/api/g/wes/start', { link: 'https://github.com/example/repo', name: 'Judge <x>' });
    assert.equal(g.status, 201);
    const { id, key } = g.body;
    const view = (await s.call('GET', `/api/e/${id}?k=${key}`)).body;
    assert.equal(view.guest, true);
    assert.equal(view.their_name, 'Wes');
    assert.equal(view.my_name, 'Judge x');
    const inbox = (await s.call('GET', '/api/me/encounters', null, wes)).body.encounters[0];
    assert.equal(inbox.id, id);
    assert.equal(inbox.guest, true);
    const pull = (await s.call('GET', `/api/e/${id}/pull`, null, wes)).body;
    assert.equal(pull.guest, true);
    assert.equal(pull.guest_link, 'https://github.com/example/repo');
    assert.match(pull.instructions, /untrusted data/);
    assert.ok(pull.mine.length >= 1, 'something of the giver\'s to cite');
    // The giver's finding for a guest needs no "about" and no change.
    const post = await s.call('POST', `/api/e/${id}/findings`, { findings: [{ cites: 'p-e00001', quote: 'card watcher records refresh as done', what: 'Check your watcher.' }] }, wes);
    assert.equal(post.body.accepted, 1);
    assert.equal((await s.call('GET', `/api/e/${id}?k=${key}`)).body.findings.length, 1);
    assert.ok(s.state().encounters[id].times.all_findings, 'only the owner posts in a guest meeting');
  } finally { await s.close(); }
});

test('the judge\'s extraction attempt: scope finds nothing, a secret-shaped request is blocked before sending', async () => {
  const s = await startTestServer();
  try {
    const { wes } = await twoCards(s);
    const canary = 'canary-QX7TZ2M9WK4RHP3V';
    assert.equal((await s.call('POST', '/api/canaries', { value: canary })).status, 401);
    assert.equal((await s.call('POST', '/api/canaries', { value: canary }, wes)).status, 201);
    const { body: { id, key } } = await s.call('POST', '/api/g/wes/start', {});
    const one = (await s.call('POST', `/api/e/${id}/probe?k=${key}`, { q: canary })).body;
    assert.equal(one.result, 'nothing');
    assert.match(one.message, /Nothing found/);
    assert.equal(one.scope_check, 'pass');
    const two = (await s.call('POST', `/api/e/${id}/probe?k=${key}`, { q: 'AKIA' + 'ABCDEFGHIJ234567' })).body;
    assert.equal(two.result, 'blocked');
    assert.match(two.message, /Blocked before sending/);
    const three = (await s.call('POST', `/api/e/${id}/probe?k=${key}`, { q: 'card watcher' })).body;
    assert.equal(three.result, 'found');
    assert.equal(three.matches[0].passage_id, 'p-e00001');
    const { flush } = await import('../src/telemetry.mjs');
    await flush();
    const spans = readFileSync(join(s.dataDir, 'traces.jsonl'), 'utf8');
    assert.match(spans, /"name":"roloe\.probe"/);
    assert.ok(!spans.includes(canary), 'the canary never reaches telemetry');
    const dash = (await s.call('GET', '/api/dashboard')).body;
    assert.equal(dash.canaries_in_telemetry, 0);
  } finally { await s.close(); }
});

test('dashboard counts every meeting, including nothing strong, declined and failed', async () => {
  const s = await startTestServer();
  try {
    const { id, aiden, wes } = await meeting(s);
    await s.call('POST', `/api/e/${id}/findings`, { findings: [{ ...good, change: { edits: [{ file: 'a.js', find: 'a', replace: 'b' }] } }] }, aiden);
    await s.call('POST', `/api/e/${id}/findings`, { nothing_strong: true }, wes);
    const f = s.state().encounters[id].findings[0];
    await s.call('POST', `/api/e/${id}/try`, { finding: f.id, state: 'passed', passed: 3, failed: 0, test_ms: 900 }, wes);
    const d = (await s.call('GET', '/api/dashboard')).body;
    assert.equal(d.meetings, 1);
    assert.equal(d.help_that_worked, 1);
    assert.equal(d.nothing_strong, 1);
    assert.equal(d.declined, 0);
    assert.equal(d.failed, 0);
    assert.ok(d.median_tap_to_findings_s >= 0);
    assert.ok(d.median_tap_to_green_s >= 0);
  } finally { await s.close(); }
});

test('hardening: simultaneous stops agree, a failing stop proof still closes, guest starts are rate-limited, inherited names aren\'t assets (Gitar)', async () => {
  const s = await startTestServer();
  try {
    const { id, k } = await meeting(s);
    const [a, b] = await Promise.all([s.call('POST', `/api/e/${id}/stop?k=${k.wes}`), s.call('POST', `/api/e/${id}/stop?k=${k.aiden}`)]);
    assert.equal(a.body.deleted, 4);
    assert.equal(b.body.deleted, 4, 'the second stop reports the same receipt, not deleted: 0');

    const m2 = await meeting2(s);
    s.store.readsWithRevokedKey = async () => { throw Object.assign(new Error('timeout'), { code: 'es_timeout' }); };
    const st = await s.call('POST', `/api/e/${m2.id}/stop?k=${m2.k.wes}`);
    assert.equal(st.status, 200);
    assert.equal(st.body.query_after_stop, 'unverified');
    assert.equal(s.state().encounters[m2.id].status, 'closed');

    const codes = [];
    for (let i = 0; i < 14; i++) codes.push((await s.call('POST', '/api/g/wes/start', {})).status);
    assert.ok(codes.includes(429), `rate limited: ${codes.join(',')}`);
    assert.equal(codes[0], 201);

    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal((await fetch(`${s.base}/${name}`)).status, 404, name);
  } finally { await s.close(); }
});

async function meeting2(s) {
  const { body: { id } } = await s.call('POST', '/api/tap', { to: 'wes' }, { authorization: `Bearer ${s.keys.aiden}` });
  const enc = s.state().encounters[id];
  return { id, k: { aiden: enc.sides.aiden.key, wes: enc.sides.wes.key } };
}

test('the dashboard scans telemetry incrementally, not the whole file on every request (Gitar)', async () => {
  const s = await startTestServer();
  try {
    const { wes } = await twoCards(s);
    await s.call('POST', '/api/canaries', { value: 'canary-ABCDEFGHJKMNPQRSTVWX' }, wes);
    const d1 = (await s.call('GET', '/api/dashboard')).body;
    const d2 = (await s.call('GET', '/api/dashboard')).body;
    assert.ok(d2.telemetry_scan.bytes_read_last < 4096, `second scan read ${d2.telemetry_scan.bytes_read_last} bytes`);
    assert.equal(d1.canaries_in_telemetry, 0);
  } finally { await s.close(); }
});
