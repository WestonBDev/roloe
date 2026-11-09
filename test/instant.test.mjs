// "Their words, instantly": before any model runs, the guest sees the giver's best-matching passage,
// verbatim and cited, through the egress gate. Findings replace it when they land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, twoCards, waitReady } from './helpers.mjs';

test('a guest sees the best-matching words from the card at once, verbatim and cited', async () => {
  const s = await startTestServer();
  try {
    const { wes } = await twoCards(s);
    const g = (await s.call('POST', '/api/g/wes/start', { text: 'my card watcher marks the refresh done before the push actually succeeds' })).body;
    const v = await waitReady(s, g.id, g.key);
    assert.ok(v.instant, 'an instant passage');
    assert.equal(v.instant.passage_id, 'p-e00001');
    assert.ok('card watcher records refresh as done before the push succeeds'.includes(v.instant.text.replace(/^…|…$/g, '').trim()), 'verbatim');
    assert.equal(v.instant.whose, 'owner');
    assert.ok(v.instant.locator);
    assert.equal(v.their_assistant, 'unknown', 'the giver\'s assistant has not checked in yet');
    await s.call('GET', '/api/me/encounters', null, wes);   // the owner's /me page: not their assistant (Gitar)
    assert.equal((await s.call('GET', `/api/e/${g.id}?k=${g.key}`)).body.their_assistant, 'unknown');
    await s.call('GET', '/api/me/encounters', null, { ...wes, 'x-roloe-client': 'assistant' });   // the assistant checks in
    assert.equal((await s.call('GET', `/api/e/${g.id}?k=${g.key}`)).body.their_assistant, 'online');
  } finally { await s.close(); }
});

test('no instant passage when nothing matches, when they skipped, or when the gate blocks it', async () => {
  const s = await startTestServer();
  try {
    const { wes } = await twoCards(s);
    const skip = (await s.call('POST', '/api/g/wes/start', {})).body;
    assert.equal((await waitReady(s, skip.id, skip.key)).instant, null);
    const none = (await s.call('POST', '/api/g/wes/start', { text: 'zebra quilting for sailboats' })).body;
    assert.equal((await waitReady(s, none.id, none.key)).instant, null);
    await s.call('PUT', '/api/cards/wes', { passages: [{ passage_id: 'p-e00009', kind: 'session', speaker: 'owner', source: 's', locator: 'x', ts: new Date().toISOString(), text: 'the push watcher token canary-QX7TZ2M9WK4RHP3V refresh' }] }, wes);
    await s.call('POST', '/api/canaries', { value: 'canary-QX7TZ2M9WK4RHP3V' }, wes);
    const gated = (await s.call('POST', '/api/g/wes/start', { text: 'push watcher refresh' })).body;
    const v = await waitReady(s, gated.id, gated.key);
    assert.equal(v.instant, null, 'a passage holding a protected value is never shown');
  } finally { await s.close(); }
});

test('after Stop, the instant words are gone with everything else (Gitar)', async () => {
  const s = await startTestServer();
  try {
    await twoCards(s);
    const g = (await s.call('POST', '/api/g/wes/start', { text: 'my card watcher marks the refresh done before the push succeeds' })).body;
    assert.ok((await waitReady(s, g.id, g.key)).instant);
    await s.call('POST', `/api/e/${g.id}/stop?k=${g.key}`);
    assert.equal((await s.call('GET', `/api/e/${g.id}?k=${g.key}`)).body.instant, null);
  } finally { await s.close(); }
});
