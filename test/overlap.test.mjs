import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store/memory.mjs';
import { pickQueries, computeOverlap } from '../src/overlap.mjs';

const P = (id, text, kind = 'session', speaker = 'owner', min = 0) => ({ passage_id: id, kind, speaker, source: kind === 'file' ? 'src/x.js' : 's', locator: id, ts: new Date(Date.now() - min * 60e3).toISOString(), text, via: '' });

test('pickQueries mixes owner words, assistant prose, commits and files, newest first, capped at 40', () => {
  const ps = [];
  for (let i = 0; i < 30; i++) ps.push(P(`p-o${String(i).padStart(4, '0')}`, `owner ${i}`, 'session', 'owner', i));
  for (let i = 0; i < 30; i++) ps.push(P(`p-a${String(i).padStart(4, '0')}`, `assistant ${i}`, 'session', 'assistant', i));
  for (let i = 0; i < 10; i++) ps.push(P(`p-c${String(i).padStart(4, '0')}`, `commit ${i}`, 'commit', 'owner', i));
  for (let i = 0; i < 10; i++) ps.push(P(`p-f${String(i).padStart(4, '0')}`, `module ${i}`, 'file', '', i));
  const q = pickQueries(ps);
  assert.equal(q.length, 40);
  const n = (pre) => q.filter((p) => p.passage_id.startsWith(pre)).length;
  assert.equal(n('p-o'), 16); assert.equal(n('p-a'), 14); assert.equal(n('p-c'), 6); assert.equal(n('p-f'), 4);
  assert.equal(q.find((p) => p.passage_id.startsWith('p-o')).passage_id, 'p-o0000', 'newest owner message first');
  // Short on one kind: the rest fill the 40.
  assert.equal(pickQueries(ps.filter((p) => !p.passage_id.startsWith('p-o'))).length, 40);
});

test('computeOverlap fuses ranks, reserves file slots, and ranks the giver passages that produced hits', async () => {
  const store = memoryStore();
  await store.init();
  await store.replaceCard('maya', 'Maya', [
    P('p-m00001', 'why are my search scores garbage after the embedding model upgrade', 'session', 'owner'),
    P('p-m00002', 'pinned the embedding model version so search scores stay stable', 'session', 'assistant'),
    P('p-m00003', 'mark the combined total partial when one game fails to load', 'session', 'owner'),
    P('p-m00004', 'lunch was good', 'session', 'owner'),
  ]);
  const wes = [P('p-w00001', 'search scores garbage after the embedding model upgrade, again'),
    P('p-w00002', 'export function refresh() { push(card); markDone(); } // push fails are ignored', 'file', ''),
    P('p-w00003', 'card watcher records refresh as done before push succeeds'),
    P('p-w00004', 'pick a font for the stage screen')];
  for (let i = 5; i <= 14; i++) wes.push(P(`p-w000${String(i).padStart(2, '0')}`, `search scores embedding model note ${i}`));
  await store.replaceCard('wes', 'Wes', wes);
  await store.copyCardsToEncounter('e-1', ['maya', 'wes']);
  const { id } = await store.createEncounterKey('e-1');

  const o = await computeOverlap(store, id, { giver: 'maya', recipient: 'wes' });
  assert.ok(o.theirs.length <= 8);
  assert.ok(o.theirs.includes('p-w00001'));
  assert.ok(o.theirs.includes('p-w00002'), 'a recipient file keeps a slot even when sessions outrank it');
  assert.ok(!o.theirs.includes('p-w00004'));
  assert.ok(o.mine.length >= 2 && o.mine.length <= 8);
  assert.ok(o.mine.includes('p-m00001'));
  assert.ok(!o.mine.includes('p-m00004'), 'a giver passage that found nothing is not citable context');
  assert.equal(o.counts.queries, 4);
  assert.ok(o.counts.searches >= 1);
});

test('ranking ignores filesystem paths so machine layout never matches', async () => {
  const store = memoryStore();
  await store.init();
  await store.replaceCard('a', 'A', [P('p-a00001', 'ran ~/dev/project/node_modules/.bin/vite in /tmp/build/output')]);
  await store.replaceCard('b', 'B', [P('p-b00001', 'cd ~/dev/project/node_modules/.bin/vite && /tmp/build/output')]);
  await store.copyCardsToEncounter('e-2', ['a', 'b']);
  const { id } = await store.createEncounterKey('e-2');
  const o = await computeOverlap(store, id, { giver: 'a', recipient: 'b' });
  assert.deepEqual(o.theirs, []);
});

test('for a guest, their material is the query: a few searches over the giver\'s work, not forty over one sentence', async () => {
  const store = memoryStore();
  await store.init();
  const wes = [P('p-a00001', 'Dash0 accepted spans only after the OTLP exporter got the Authorization Bearer header and the /v1/traces path'), P('p-a00002', 'picked a font for the stage'), P('p-a00003', 'export traces over OTLP HTTP to the collector endpoint', 'file', '')];
  for (let i = 4; i < 60; i++) wes.push(P(`p-a000${String(i).padStart(2, '0')}`, `unrelated note number ${i} about cards and wheels`));
  await store.replaceCard('wes', 'Wes', wes);
  await store.copyCardsToEncounter('e-g', ['wes']);
  await store.addToEncounter('e-g', 'guest-1', 'Guest', [P('p-b00001', 'no spans show up in my backend, is it the OTLP exporter or the auth header?')]);
  const { id } = await store.createEncounterKey('e-g');
  const o = await computeOverlap(store, id, { giver: 'wes', recipient: 'guest-1', queriesFrom: 'recipient' });
  assert.ok(o.counts.queries <= 12, `queries ${o.counts.queries}`);
  assert.equal(o.mine[0], 'p-a00001');
  assert.ok(o.mine.includes('p-a00003'));
  assert.ok(!o.mine.includes('p-a00002'));
  assert.deepEqual(o.theirs, ['p-b00001']);
});
