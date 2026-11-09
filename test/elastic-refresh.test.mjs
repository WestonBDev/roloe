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

// ---- An embedding endpoint that stops answering (today: ELSER, 429 "trial limit") ----
function fakeEsInference({ dead = new Set(), failFirstBulk = false } = {}) {
  const calls = [];
  let bulkCalls = 0;
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const nd = String(opts.headers['content-type']).includes('ndjson');
    const body = opts.body === undefined ? undefined : nd ? String(opts.body).trim().split('\n').map((l) => JSON.parse(l)) : JSON.parse(opts.body);
    calls.push({ method: opts.method, path: decodeURIComponent(u.pathname), body });
    const reply = (status, json) => new Response(JSON.stringify(json), { status });
    if (u.pathname === '/') return reply(200, { version: { build_flavor: 'serverless' } });
    if (u.pathname === '/_inference/_all') return reply(200, { endpoints: [{ inference_id: '.elser-2-elastic' }, { inference_id: '.jina-embeddings-v5-text-small' }] });
    if (u.pathname.startsWith('/_inference/')) return dead.has(decodeURIComponent(u.pathname.split('/').pop())) ? reply(429, { error: { type: 'status_exception', reason: 'trial limit' } }) : reply(200, { text_embedding: [] });
    if (opts.method === 'HEAD') return reply(404, {});
    if (opts.method === 'PUT') return reply(200, { acknowledged: true });
    if (u.pathname === '/_security/api_key') return reply(400, { error: { type: 'illegal_argument_exception' } });
    if (u.pathname.endsWith('/_bulk')) { bulkCalls++; return failFirstBulk && bulkCalls === 1 ? reply(200, { errors: true, items: [{ index: { error: { type: 'inference_exception', reason: 'Exception when running inference id [.elser-2-elastic] on field [text_semantic]' } } }] }) : reply(200, { errors: false, items: [] }); }
    if (u.pathname.endsWith('/_msearch')) return reply(200, { responses: [{ hits: { hits: [] } }] });
    return reply(200, { hits: { hits: [] } });
  };
  return { calls, fetchImpl, dead };
}
const openInf = async (opts) => {
  const f = fakeEsInference(opts);
  const store = elasticStore({ esUrl: 'https://x.es.example', esApiKey: 'k', esIndex: 'roloe-t', fetchImpl: f.fetchImpl });
  await store.init();
  return { store, calls: f.calls, dead: f.dead };
};
const lastSearch = (calls) => calls.filter((c) => c.path.endsWith('/_msearch')).pop().body[1];
const textMapping = (calls) => calls.filter((c) => c.method === 'PUT' && c.path === '/roloe-t/_mapping' && c.body.properties?.text).pop()?.body.properties.text;

test('ELSER refused at startup: writes stop embedding with it and search runs on keywords + Jina', async () => {
  const { store, calls } = await openInf({ dead: new Set(['.elser-2-elastic']) });
  const d = store.describe();
  assert.equal(d.semantic, false);
  assert.equal(d.multilingual, true);
  assert.deepEqual(textMapping(calls), { type: 'text', copy_to: ['text_jina'] }, 'the dead endpoint is out of copy_to');
  const k = await store.createEncounterKey('e-1');
  await store.msearch(k.id, ['q'], { hybrid: true });
  const rs = lastSearch(calls).retriever.rrf.retrievers;
  assert.equal(rs.length, 2);
  assert.equal(rs[1].standard.query.bool.must[0].semantic.field, 'text_jina');
  assert.ok(rs.every((r) => r.standard.query.bool.filter[0].term.encounter_id === 'e-1'), 'still scoped to the meeting');
});

test('every embedding endpoint refused: search is keywords alone, and still answers', async () => {
  const { store, calls } = await openInf({ dead: new Set(['.elser-2-elastic', '.jina-embeddings-v5-text-small']) });
  assert.deepEqual(textMapping(calls), { type: 'text' });
  const k = await store.createEncounterKey('e-1');
  await store.msearch(k.id, ['q'], { hybrid: true });
  const search = lastSearch(calls);
  assert.equal(search.retriever, undefined);
  assert.deepEqual(search.query.bool.filter[0], { term: { encounter_id: 'e-1' } });
});

test('an endpoint that dies mid-day: the failed write is retried without it, and the meeting still opens', async () => {
  // A limited endpoint can still answer the startup check and then refuse a real batch.
  const { store, calls } = await openInf({ failFirstBulk: true });
  assert.equal(store.describe().semantic, true);
  const n = await store.addToEncounter('e-1', 'wes', 'Wes', [P('p-000001', 'one')]);
  assert.equal(n, 1, 'the write succeeded on the second try');
  assert.equal(calls.filter((c) => c.path.endsWith('/_bulk')).length, 2);
  assert.equal(store.describe().semantic, false, 'the endpoint the error named stays out until a restart');
  assert.equal(store.describe().multilingual, true, 'the other one keeps working');
  assert.deepEqual(textMapping(calls), { type: 'text', copy_to: ['text_jina'] });
  const k = await store.createEncounterKey('e-1');
  await store.msearch(k.id, ['q'], { hybrid: true });
  assert.equal(lastSearch(calls).retriever.rrf.retrievers.length, 2);
});

test('copying a card into a meeting reuses its stored embeddings instead of embedding again', async () => {
  const calls = [];
  const stored = { text_jina: { inference: { inference_id: '.jina-embeddings-v5-text-small', chunks: { text: [{ start_offset: 0, end_offset: 3, embeddings: [0.1, 0.2] }] } } } };
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const nd = String(opts.headers['content-type']).includes('ndjson');
    const body = opts.body === undefined ? undefined : nd ? String(opts.body).trim().split('\n').map((l) => JSON.parse(l)) : JSON.parse(opts.body);
    calls.push({ method: opts.method, path: u.pathname, body });
    const reply = (status, json) => new Response(JSON.stringify(json), { status });
    if (u.pathname === '/') return reply(200, { version: { build_flavor: 'serverless' } });
    if (u.pathname === '/_inference/_all') return reply(200, { endpoints: [{ inference_id: '.elser-2-elastic' }, { inference_id: '.jina-embeddings-v5-text-small' }] });
    if (opts.method === 'HEAD') return reply(404, {});
    if (u.pathname === '/_security/api_key') return reply(400, { error: { type: 'illegal_argument_exception' } });
    if (u.pathname.endsWith('/_bulk')) return reply(200, { errors: false, items: [] });
    if (u.pathname.endsWith('/_search')) return reply(200, { hits: { hits: [{ _source: { passage_id: 'p-000001', owner_id: 'wes', text: 'one', encounter_id: 'card:wes', _inference_fields: stored } }] } });
    return reply(200, { acknowledged: true });
  };
  const store = elasticStore({ esUrl: 'https://x.es.example', esApiKey: 'k', esIndex: 'roloe-t', fetchImpl });
  await store.init();
  await store.copyCardsToEncounter('e-1', ['wes']);
  const read = calls.filter((c) => c.path.endsWith('/_search')).pop().body;
  assert.deepEqual(read.fields, ['_inference_fields'], 'the card is read with its embeddings');
  const [, doc] = calls.filter((c) => c.path.endsWith('/_bulk')).pop().body;
  assert.equal(doc.encounter_id, 'e-1');
  assert.deepEqual(doc._inference_fields, stored, 'and they are written back with the copy');
});
