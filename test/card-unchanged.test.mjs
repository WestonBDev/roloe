// An assistant re-uploads its card on a timer. When nothing changed, the coordinator must not
// rewrite (and re-embed) every passage: that spent Elastic's inference quota on 9 November.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, twoCards } from './helpers.mjs';

const P = (id, text) => ({ passage_id: id, kind: 'session', speaker: 'owner', source: 's', locator: 'l', ts: '2026-11-09T12:00:00.000Z', text });

test('re-uploading an unchanged card skips the store; a change, a switch-off or a removal writes again', async () => {
  const s = await startTestServer();
  try {
    const { wes } = await twoCards(s);
    let writes = 0;
    const orig = s.store.replaceCard.bind(s.store);
    s.store.replaceCard = async (...a) => { writes++; return orig(...a); };
    const card = [P('p-c00001', 'retry loops need a finite overall deadline'), P('p-c00002', 'cache the token per tenant')];
    const put = (passages) => s.call('PUT', '/api/cards/wes', { passages }, wes);

    assert.equal((await put(card)).status, 200);
    assert.equal(writes, 1);
    const again = await put(card);
    assert.equal(again.status, 200);
    assert.equal(again.body.unchanged, true);
    assert.equal(again.body.passages, 2);
    assert.equal(writes, 1, 'unchanged: no rewrite');

    await put([...card, P('p-c00003', 'a new lesson')]);
    assert.equal(writes, 2, 'changed: written');

    await s.call('POST', '/api/cards/wes/switch', { on: false }, wes);
    await s.call('POST', '/api/cards/wes/switch', { on: true }, wes);
    const w = writes;
    await put([...card, P('p-c00003', 'a new lesson')]);
    assert.equal(writes, w + 1, 'after switch-off emptied it, the same card is written again');

    await s.call('POST', '/api/cards/wes/private', { passage_id: 'p-c00003' }, wes);
    const w2 = writes;
    await put([...card, P('p-c00003', 'a new lesson')]);
    assert.ok(writes > w2 || (await s.call('GET', '/api/cards/wes/passages', null, wes)).body.passages.length === 2, 'after a removal, the next upload is not skipped blindly');
  } finally { await s.close(); }
});

test('a failed write is never remembered as the last good upload', async () => {
  const s = await startTestServer();
  try {
    const { wes } = await twoCards(s);
    const card = [P('p-c00001', 'retry loops need a finite overall deadline')];
    const orig = s.store.replaceCard.bind(s.store);
    let fail = true, writes = 0;
    s.store.replaceCard = async (...a) => { writes++; if (fail) throw Object.assign(new Error('bulk'), { code: 'bulk_error' }); return orig(...a); };
    assert.equal((await s.call('PUT', '/api/cards/wes', { passages: card }, wes)).status, 500);
    fail = false;
    assert.equal((await s.call('PUT', '/api/cards/wes', { passages: card }, wes)).status, 200);
    assert.equal(writes, 2, 'the retry is written, not skipped');
  } finally { await s.close(); }
});

test('a skipped upload still refreshes totals and "updated"; overlapping uploads never remember the wrong card (Gitar)', async () => {
  const s = await startTestServer();
  try {
    const { wes } = await twoCards(s);
    const card = [P('p-c00001', 'retry loops need a finite overall deadline')];
    await s.call('PUT', '/api/cards/wes', { passages: card, totals: { sessions: 1 } }, wes);
    const before = s.state().owners.wes.card.updated;
    await new Promise((r) => setTimeout(r, 5));
    const r = await s.call('PUT', '/api/cards/wes', { passages: card, totals: { sessions: 7 }, scope: 'two repos' }, wes);
    assert.equal(r.body.unchanged, true);
    assert.equal(s.state().owners.wes.card.totals.sessions, 7);
    assert.equal(s.state().owners.wes.card.scope, 'two repos');
    assert.notEqual(s.state().owners.wes.card.updated, before);

    // A (card X) starts, B (card Y) starts and finishes first, then A finishes: X must not be remembered.
    const orig = s.store.replaceCard.bind(s.store);
    let writes = 0;
    s.store.replaceCard = async (owner, name, ps) => { writes++; if (ps[0]?.text === 'X') await new Promise((res) => setTimeout(res, 150)); return orig(owner, name, ps); };
    const X = [P('p-c00009', 'X')], Y = [P('p-c00009', 'Y')];
    const a = s.call('PUT', '/api/cards/wes', { passages: X }, wes);
    await new Promise((res) => setTimeout(res, 20));
    await s.call('PUT', '/api/cards/wes', { passages: Y }, wes);
    await a;
    const n = writes;
    await s.call('PUT', '/api/cards/wes', { passages: X }, wes);
    assert.equal(writes, n + 1, 'X is written again, not skipped against a store that may hold Y');
  } finally { await s.close(); }
});
