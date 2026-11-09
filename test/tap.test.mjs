import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer, twoCards } from './helpers.mjs';

test('a tap copies both cards into the encounter, precomputes overlap both ways, and is traced', async () => {
  const s = await startTestServer();
  try {
    const { wes, maya } = await twoCards(s);
    assert.equal((await s.call('POST', '/api/tap', { to: 'maya' })).status, 401);
    assert.equal((await s.call('POST', '/api/tap', { to: 'nobody' }, maya)).status, 404);
    assert.equal((await s.call('POST', '/api/tap', { to: 'maya' }, maya)).status, 400, 'no tapping yourself');
    const t0 = Date.now();
    const tap = await s.call('POST', '/api/tap', { to: 'wes' }, maya);
    assert.equal(tap.status, 201);
    assert.ok(Date.now() - t0 < 3000);
    const { id, link, stage } = tap.body;
    assert.match(id, /^e-[0-9a-f]{10}$/);
    assert.match(link, new RegExp(`/e/${id}\\?k=`));
    assert.match(stage, new RegExp(`/stage/${id}\\?k=`));

    // The other person finds it with their own card key, newest first.
    const inbox = await s.call('GET', '/api/me/encounters', null, wes);
    assert.equal(inbox.body.encounters[0].id, id);
    assert.equal(inbox.body.encounters[0].with, 'maya');
    assert.match(inbox.body.encounters[0].link, new RegExp(`/e/${id}\\?k=`));
    assert.notEqual(inbox.body.encounters[0].link, link, 'each side has its own key');
    assert.equal(inbox.body.encounters[0].stage, stage, 'each participant can open the stage for their meeting');

    const enc = s.state().encounters[id];
    assert.ok(enc.overlap.maya.theirs.includes('p-e00001'), 'Maya gives to Wes: overlap in Wes\'s passages');
    assert.ok(enc.overlap.maya.mine.includes('p-a00001'));
    assert.ok(enc.times.ready >= enc.times.tap);
    assert.equal(await s.store.count(enc.keyId), 4);

    // Card edits after the tap don't reach the encounter.
    await s.call('POST', '/api/cards/maya/switch', { on: false }, maya);
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
    const { wes, maya } = await twoCards(s);
    await s.call('POST', '/api/cards/wes/switch', { on: false }, wes);
    assert.equal((await s.call('POST', '/api/tap', { to: 'wes' }, maya)).status, 409);
  } finally { await s.close(); }
});

test('a tap that fails midway leaves no open encounter, no copies and no live key (Gitar)', async () => {
  const s = await startTestServer();
  try {
    const { maya, wes } = await twoCards(s);
    const orig = s.store.createEncounterKey;
    let failedId = null;
    s.store.createEncounterKey = async (enc) => { failedId = enc; throw Object.assign(new Error('boom'), { code: 'es_down' }); };
    const tap = await s.call('POST', '/api/tap', { to: 'wes' }, maya);
    s.store.createEncounterKey = orig;
    assert.equal(tap.status, 500);
    assert.deepEqual(Object.keys(s.state().encounters), []);
    assert.equal((await s.call('GET', '/api/me/encounters', null, wes)).body.encounters.length, 0);
    assert.ok(failedId);
    assert.equal(await s.store.deleteEncounter(failedId), 0, 'its copies were already deleted');
    const leftovers = (await s.store.listCard('maya')).length + (await s.store.listCard('wes')).length;
    assert.equal(leftovers, 4, 'cards untouched');
    // no encounter copies remain: a fresh tap's key sees exactly its own 4
    const ok = await s.call('POST', '/api/tap', { to: 'wes' }, maya);
    assert.equal(await s.store.count(s.state().encounters[ok.body.id].keyId), 4);
  } finally { await s.close(); }
});
