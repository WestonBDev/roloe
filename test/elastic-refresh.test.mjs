// Forced refreshes are the slow part of a meeting on Elastic Cloud Serverless: measured today,
// `_bulk?refresh=true` took about 5 s whatever the batch held, twice per guest meeting, so the
// guest waited 13 s for the first words. A guest meeting now waits for one refresh, not two, and
// never forces one; a card is rebuilt in place, so a scan never lands on a half-empty card.
// (Dash0's Agent0 named the forced refresh in its diagnosis.) Simulated with a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elasticStore } from '../src/store/elastic.mjs';

function fakeEs({ stale = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const nd = String(opts.headers['content-type']).includes('ndjson');
    const body = opts.body === undefined ? undefined : nd ? String(opts.body).trim().split('\n').map((l) => JSON.parse(l)) : JSON.parse(opts.body);
    calls.push({ method: opts.method, path: u.pathname, refresh: u.searchParams.get('refresh'), body });
    const reply = (status, json) => new Response(JSON.stringify(json), { status });
    if (u.pathname === '/') return reply(200, { version: { build_flavor: 'serverless' } });
    if (u.pathname === '/_inference/_all') return reply(200, { endpoints: [{ inference_id: '.elser-2-elastic' }] });
    if (opts.method === 'HEAD') return reply(404, {});
    if (opts.method === 'PUT') return reply(200, { acknowledged: true });
    if (u.pathname === '/_security/api_key') return reply(400, { error: { type: 'illegal_argument_exception' } });
    if (u.pathname.endsWith('/_bulk')) return reply(200, { errors: false, items: [] });
    if (u.pathname.endsWith('/_count')) return reply(200, { count: stale });
    if (u.pathname.endsWith('/_delete_by_query')) return reply(200, { deleted: stale });
    if (u.pathname.endsWith('/_refresh')) return reply(200, {});
    if (u.pathname.endsWith('/_search')) return reply(200, { hits: { hits: [{ _source: { passage_id: 'p-000001', owner_id: 'wes', text: 'one', encounter_id: 'card:wes' } }] } });
    return reply(200, {});
  };
  return { calls, fetchImpl };
}
const open = async (opts) => {
  const f = fakeEs(opts);
  const store = elasticStore({ esUrl: 'https://x.es.example', esApiKey: 'k', esIndex: 'roloe-t', fetchImpl: f.fetchImpl });
  await store.init();
  f.calls.length = 0;
  return { store, calls: f.calls };
};
const P = (id, text) => ({ passage_id: id, kind: 'session', speaker: 'owner', source: 's', locator: id, ts: '2026-11-09T10:00:00Z', text });
const bulks = (calls) => calls.filter((c) => c.path.endsWith('/_bulk'));

test('a guest meeting waits for one refresh, not two, and never forces one', async () => {
  const { store, calls } = await open();
  await store.copyCardsToEncounter('e-1', ['wes'], { deferRefresh: true });
  await store.addToEncounter('e-1', 'guest-1', 'Guest', [P('p-g00001', 'what the guest gave')]);
  const [copy, guest] = bulks(calls);
  assert.equal(copy.refresh, null, 'the card copy does not wait: the guest write right after it does');
  assert.equal(guest.refresh, 'wait_for', 'one wait covers both writes');
  assert.ok(!calls.some((c) => c.refresh === 'true' && c.path.endsWith('/_bulk')), 'no forced refresh on a write');
});

test('a meeting between two cards (no guest write) waits on the copy itself', async () => {
  const { store, calls } = await open();
  await store.copyCardsToEncounter('e-2', ['wes', 'maya']);
  assert.equal(bulks(calls)[0].refresh, 'wait_for');
});

test('a card is rebuilt in place: new passages are written before stale ones are removed, so it is never empty', async () => {
  const { store, calls } = await open({ stale: 2 });
  await store.replaceCard('wes', 'Wes', [P('p-000001', 'one'), P('p-000002', 'two')]);
  const order = calls.map((c) => c.path.split('/').pop());
  assert.ok(order.indexOf('_bulk') < order.indexOf('_delete_by_query'), 'write first, then remove');
  const del = calls.find((c) => c.path.endsWith('/_delete_by_query'));
  assert.deepEqual(del.body.query.bool.filter, [{ term: { encounter_id: 'card:wes' } }]);
  assert.deepEqual(del.body.query.bool.must_not, [{ terms: { passage_id: ['p-000001', 'p-000002'] } }], 'only passages no longer on the card are removed');
});

test('an unchanged card costs no delete and no forced refresh', async () => {
  const { store, calls } = await open({ stale: 0 });
  await store.replaceCard('wes', 'Wes', [P('p-000001', 'one')]);
  assert.ok(!calls.some((c) => c.path.endsWith('/_delete_by_query')));
  assert.ok(!calls.some((c) => c.refresh === 'true'));
});

test('switching a card off still empties it at once', async () => {
  const { store, calls } = await open({ stale: 3 });
  await store.replaceCard('wes', 'Wes', []);
  const del = calls.find((c) => c.path.endsWith('/_delete_by_query'));
  assert.deepEqual(del.body.query, { bool: { filter: [{ term: { encounter_id: 'card:wes' } }], must_not: [] } });
  assert.equal(del.refresh, 'true', 'a removal is visible before the call returns');
});

test('deleting a meeting whose copy was never refreshed refreshes first, so nothing is left behind', async () => {
  const { store, calls } = await open({ stale: 1 });
  await store.copyCardsToEncounter('e-3', ['wes'], { deferRefresh: true });   // then the build fails
  await store.deleteEncounter('e-3');
  const order = calls.map((c) => c.path.split('/').pop());
  assert.ok(order.includes('_refresh') && order.indexOf('_refresh') < order.indexOf('_delete_by_query'));
  calls.length = 0;
  await store.copyCardsToEncounter('e-4', ['wes']);                            // waited for its refresh
  await store.deleteEncounter('e-4');
  assert.ok(!calls.some((c) => c.path.endsWith('/_refresh')), 'no extra refresh when the copy is already searchable');
});
