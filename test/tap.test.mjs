import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer } from './helpers.mjs';

const P = (id, text, kind = 'session') => ({ passage_id: id, kind, speaker: kind === 'file' ? '' : 'owner', source: 's', locator: id, ts: new Date().toISOString(), text });

export async function twoCards(s) {
  const reg = async (owner, name, passages) => {
    const { body: { key } } = await s.call('POST', '/api/owners', { owner, name });
    const auth = { authorization: `Bearer ${key}` };
    await s.call('POST', `/api/cards/${owner}/switch`, { on: true }, auth);
    await s.call('PUT', `/api/cards/${owner}`, { passages }, auth);
    return auth;
  };
  const wes = await reg('wes', 'Wes', [P('p-w00001', 'card watcher records refresh as done before the push succeeds'), P('p-w00002', 'function refresh() { push(card); markDone(); }', 'file')]);
  const aiden = await reg('aiden', 'Aiden', [P('p-a00001', 'mark the combined total partial when one fetch fails to load, then retry the push'), P('p-a00002', 'pick a theme')]);
  return { wes, aiden };
}

test('a tap copies both cards into the encounter, precomputes overlap both ways, and is traced', async () => {
  const s = await startTestServer();
  try {
    const { wes, aiden } = await twoCards(s);
    assert.equal((await s.call('POST', '/api/tap', { to: 'aiden' })).status, 401);
    assert.equal((await s.call('POST', '/api/tap', { to: 'nobody' }, aiden)).status, 404);
    assert.equal((await s.call('POST', '/api/tap', { to: 'aiden' }, aiden)).status, 400, 'no tapping yourself');
    const t0 = Date.now();
    const tap = await s.call('POST', '/api/tap', { to: 'wes' }, aiden);
    assert.equal(tap.status, 201);
    assert.ok(Date.now() - t0 < 3000);
    const { id, link, stage } = tap.body;
    assert.match(id, /^e-[0-9a-f]{10}$/);
    assert.match(link, new RegExp(`/e/${id}\\?k=`));
    assert.match(stage, new RegExp(`/stage/${id}\\?k=`));

    // The other person finds it with their own card key, newest first.
    const inbox = await s.call('GET', '/api/me/encounters', null, wes);
    assert.equal(inbox.body.encounters[0].id, id);
    assert.equal(inbox.body.encounters[0].with, 'aiden');
    assert.match(inbox.body.encounters[0].link, new RegExp(`/e/${id}\\?k=`));
    assert.notEqual(inbox.body.encounters[0].link, link, 'each side has its own key');

    const enc = s.state().encounters[id];
    assert.ok(enc.overlap.aiden.theirs.includes('p-w00001'), 'Aiden gives to Wes: overlap in Wes\'s passages');
    assert.ok(enc.overlap.aiden.mine.includes('p-a00001'));
    assert.ok(enc.times.ready >= enc.times.tap);
    assert.equal(await s.store.count(enc.keyId), 4);

    // Card edits after the tap don't reach the encounter.
    await s.call('POST', '/api/cards/aiden/switch', { on: false }, aiden);
    assert.equal(await s.store.count(enc.keyId), 4);

    const { flush } = await import('../src/telemetry.mjs');
    await flush();
    const spans = readFileSync(join(s.dataDir, 'traces.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const tapSpan = spans.find((x) => x.name === 'roloe.tap' && x.attributes['roloe.encounter_id'] === id);
    assert.ok(tapSpan);
    assert.equal(tapSpan.attributes['roloe.scope.passages'], 4);
    assert.ok(spans.some((x) => x.name === 'roloe.overlap' && x.attributes['roloe.encounter_id'] === id));
    assert.ok(!JSON.stringify(spans).includes('card watcher'), 'no passage text in telemetry');
  } finally { await s.close(); }
});

test('cannot tap a card whose switch is off', async () => {
  const s = await startTestServer();
  try {
    const { wes, aiden } = await twoCards(s);
    await s.call('POST', '/api/cards/wes/switch', { on: false }, wes);
    assert.equal((await s.call('POST', '/api/tap', { to: 'wes' }, aiden)).status, 409);
  } finally { await s.close(); }
});
