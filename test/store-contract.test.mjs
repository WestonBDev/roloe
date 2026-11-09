// Every store must pass this contract. Memory always runs; Elasticsearch runs when
// ES_TEST_URL (or ES_URL) and credentials are in the environment, e.g. the local cluster:
//   set -a; . ~/roloe-elastic/es.env; set +a; npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { memoryStore } from '../src/store/memory.mjs';

const P = (id, text, extra = {}) => ({ passage_id: id, kind: 'session', speaker: 'owner', source: 'session aa', locator: `session aa #${id}`, ts: new Date().toISOString(), text, via: '', ...extra });

const targets = [['memory', () => memoryStore()]];
const esUrl = process.env.ES_TEST_URL || process.env.ES_URL;
if (esUrl && process.env.ES_PASSWORD) {
  targets.push(['elasticsearch', async () => {
    const { elasticStore } = await import('../src/store/elastic.mjs');
    return elasticStore({ esUrl, esUser: process.env.ES_USER || 'elastic', esPassword: process.env.ES_PASSWORD, esIndex: `roloe-test-${randomBytes(3).toString('hex')}` });
  }]);
}

for (const [name, make] of targets) {
  test(`${name}: cards, encounter copies, scoped keys, search, stop`, async () => {
    const store = await make();
    await store.init();
    const u = randomBytes(2).toString('hex');
    const a = `ann${u}`, b = `ben${u}`, c = `cat${u}`;
    try {
      await store.replaceCard(a, 'Ann', [P('p-a00001', 'retry the upload when the push fails and mark the total partial'), P('p-a00002', 'pinned the embedding model after the upgrade broke search scores')]);
      await store.replaceCard(b, 'Ben', [P('p-b00001', 'our search scores went bad after upgrading the embedding model'), P('p-b00002', 'the push to the card watcher fails silently', { kind: 'file', speaker: '' })]);
      await store.replaceCard(c, 'Cat', [P('p-c00001', 'unrelated: watercolor brush textures')]);
      assert.equal((await store.listCard(a)).length, 2);
      // replace really replaces
      await store.replaceCard(a, 'Ann', [P('p-a00001', 'retry the upload when the push fails and mark the total partial'), P('p-a00002', 'pinned the embedding model after the upgrade broke search scores'), P('p-a00003', 'a third')]);
      assert.equal((await store.listCard(a)).length, 3);
      assert.equal(await store.removeFromCard(a, 'p-a00003'), 1);
      assert.equal((await store.listCard(a)).length, 2);

      const e1 = `e-${u}000001`, e2 = `e-${u}000002`;
      assert.equal(await store.copyCardsToEncounter(e1, [a, b]), 4);
      assert.equal(await store.copyCardsToEncounter(e2, [b, c]), 3);
      const k1 = await store.createEncounterKey(e1);
      const k2 = await store.createEncounterKey(e2);

      // Scope: e1's key sees exactly e1's copies, never cards or other encounters.
      const seen1 = await store.list(k1.id);
      assert.equal(seen1.length, 4);
      assert.ok(seen1.every((d) => d.encounter_id === e1));
      assert.equal(await store.count(k2.id), 3);
      assert.equal(await store.get(k1.id, 'p-c00001'), null, 'Cat was never tapped in e1');
      assert.equal((await store.get(k1.id, 'p-a00001')).owner_id, a);
      assert.equal((await store.list(k1.id, b)).length, 2);

      const hits = await store.search(k1.id, 'search scores embedding model upgrade', { owner: b, k: 5 });
      assert.equal(hits[0].passage_id, 'p-b00001');
      assert.ok(hits.every((h) => h.owner_id === b && h.encounter_id === e1));
      const multi = await store.msearch(k1.id, ['push fails silently', 'embedding model'], { owner: b, k: 3 });
      assert.equal(multi.length, 2);
      assert.equal(multi[0][0].passage_id, 'p-b00002');

      // Card edits after the tap don't change the encounter's copy.
      await store.removeFromCard(a, 'p-a00001');
      assert.ok(await store.get(k1.id, 'p-a00001'));

      // Two owners may carry the same passage_id; neither overwrites the other (Gitar).
      const e3 = `e-${u}000003`;
      await store.replaceCard(a, 'Ann', [P('p-a00001', 'retry the upload when the push fails and mark the total partial'), P('p-a00002', 'pinned the embedding model after the upgrade broke search scores')]);
      await store.replaceCard(c, 'Cat', [P('p-a00001', 'cat has the same id as ann')]);
      assert.equal(await store.copyCardsToEncounter(e3, [a, c]), 3);
      const k3 = await store.createEncounterKey(e3);
      assert.equal(await store.count(k3.id), 3);
      assert.equal((await store.get(k3.id, 'p-a00001', c)).owner_id, c);
      assert.equal((await store.get(k3.id, 'p-a00001', a)).owner_id, a);
      await store.invalidateKey(k3.id);
      await store.deleteEncounter(e3);
      assert.equal(store.scanFor, undefined, 'no unscoped reads in the store interface');

      // Stop: invalidate, delete, and the old key reads nothing.
      await store.invalidateKey(k1.id);
      assert.equal(await store.readsWithRevokedKey(k1.id), 0, 'the store itself refuses the old key');
      await assert.rejects(store.list(k1.id));
      assert.equal(await store.count(k1.id), 0);
      assert.equal(await store.deleteEncounter(e1), 4);
      assert.equal(await store.count(k2.id), 3, 'other encounters untouched');
    } finally {
      await store.deleteEncounter?.(`e-${u}000002`);
      await store.dropIndex?.();
    }
  });
}
