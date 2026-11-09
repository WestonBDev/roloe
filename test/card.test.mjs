import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.mjs';

const P = (id, text, extra = {}) => ({ passage_id: id, kind: 'session', speaker: 'owner', source: 'session aa', locator: 'session aa #1', ts: new Date().toISOString(), text, ...extra });

test('the one switch: off refuses uploads and empties the card; on shows exactly what is shared', async () => {
  const s = await startTestServer();
  try {
    const { body: { key } } = await s.call('POST', '/api/owners', { owner: 'maya', name: 'Maya' });
    const auth = { authorization: `Bearer ${key}` };
    assert.equal((await s.call('PUT', '/api/cards/maya', { passages: [P('p-aaaaaa', 'hello')] }, auth)).status, 409);
    await s.call('POST', '/api/cards/maya/switch', { on: true }, auth);
    const up = await s.call('PUT', '/api/cards/maya', {
      passages: [P('p-aaaaaa', 'pinned the embedding model'), P('p-bbbbbb', 'mail me at maya@example.com'), P('bad-id', 'dropped'), P('p-aaaaaa', 'dup')],
      totals: { sessions: 1 },
    }, auth);
    assert.equal(up.body.passages, 2);
    assert.equal(up.body.rescrubbed, 1, 'coordinator re-scrubs on arrival');
    const shown = await s.call('GET', '/api/cards/maya/passages', null, auth);
    assert.deepEqual(shown.body.passages.map((p) => p.passage_id).sort(), ['p-aaaaaa', 'p-bbbbbb']);
    assert.ok(shown.body.passages.every((p) => p.owner_id === 'maya' && p.encounter_id === 'card:maya'));
    assert.ok(!JSON.stringify(shown.body).includes('maya@example.com'));
    assert.equal((await s.call('GET', '/api/cards/maya/passages')).status, 401);

    await s.call('POST', '/api/cards/maya/private', { passage_id: 'p-bbbbbb' }, auth);
    assert.deepEqual((await s.call('GET', '/api/cards/maya/passages', null, auth)).body.passages.map((p) => p.passage_id), ['p-aaaaaa']);
    // A private passage stays off the card on the next upload too.
    await s.call('PUT', '/api/cards/maya', { passages: [P('p-aaaaaa', 'a'), P('p-bbbbbb', 'b')] }, auth);
    assert.deepEqual((await s.call('GET', '/api/cards/maya/passages', null, auth)).body.passages.map((p) => p.passage_id), ['p-aaaaaa']);

    await s.call('POST', '/api/cards/maya/switch', { on: false }, auth);
    assert.equal((await s.call('GET', '/api/cards/maya/passages', null, auth)).body.passages.length, 0);
    assert.equal((await s.call('GET', '/api/cards/maya')).body.passages, 0);
  } finally { await s.close(); }
});
