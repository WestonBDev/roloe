// Found by Dash0 (slow Elasticsearch on roloe-coordinator, p95 1.5 s): each meeting fired ~22
// separate searches, one per passage. Passages are now fetched by id in one request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, twoCards } from './helpers.mjs';

test('a pull fetches all its passages in one store call, and a post checks all its citations in one', async () => {
  const s = await startTestServer();
  try {
    const { maya, wes } = await twoCards(s);
    const { body: { id } } = await s.call('POST', '/api/tap', { to: 'wes' }, maya);
    const counts = { get: 0, getMany: 0 };
    const get = s.store.get.bind(s.store);
    s.store.get = async (...a) => { counts.get++; return get(...a); };
    const getMany = s.store.getMany.bind(s.store);
    s.store.getMany = async (...a) => { counts.getMany++; return getMany(...a); };
    const pull = await s.call('GET', `/api/e/${id}/pull`, null, maya);
    assert.ok(pull.body.theirs.length + pull.body.mine.length >= 2);
    assert.deepEqual(counts, { get: 0, getMany: 1 });
    const good = { cites: 'p-a00001', quote: 'mark the combined total partial', about: 'p-e00001', what: 'w' };
    const post = await s.call('POST', `/api/e/${id}/findings`, { findings: [good, { ...good, cites: 'p-ffffff' }, { ...good, cites: 'p-e00001', quote: 'card watcher records refresh' }] }, maya);
    assert.deepEqual(post.body.verdicts.map((v) => v.reason), [null, 'citation does not resolve', 'citation is not the giver\'s']);
    assert.deepEqual(counts, { get: 0, getMany: 2 });
  } finally { await s.close(); }
});
