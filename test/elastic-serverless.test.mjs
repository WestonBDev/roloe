// Elastic Cloud Serverless authenticates with an API key. Elasticsearch refuses to mint a key with
// privileges from another API key, so on serverless the store must fall back to its own key plus
// the encounter_id filter on every read, and say so. Simulated with a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elasticStore } from '../src/store/elastic.mjs';

function fakeServerless(endpoints = ['.elser-2-elastic']) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const body = opts.body && !String(opts.body).includes('\n{') ? JSON.parse(opts.body) : opts.body;
    calls.push({ method: opts.method, path: u.pathname, auth: opts.headers.authorization, body });
    const reply = (status, json) => new Response(JSON.stringify(json), { status });
    // Real Serverless answers /_license too (Gitar): the build flavor must be checked first.
    if (u.pathname === '/_license') return reply(200, { license: { type: 'basic', status: 'active' } });
    if (u.pathname === '/' ) return reply(200, { version: { build_flavor: 'serverless' } });
    if (u.pathname === '/_inference/_all') return reply(200, { endpoints: endpoints.map((inference_id) => ({ inference_id })) });
    if (opts.method === 'HEAD') return reply(404, {});
    if (opts.method === 'PUT') return reply(200, { acknowledged: true });
    if (u.pathname === '/_security/api_key') return reply(400, { error: { type: 'illegal_argument_exception' } });
    if (u.pathname.endsWith('/_count')) return reply(200, { count: 2 });
    if (u.pathname.endsWith('/_msearch')) return reply(200, { responses: [{ hits: { hits: [] } }] });
    return reply(200, { hits: { hits: [] } });
  };
  return { calls, fetchImpl };
}

test('serverless: API-key auth, semantic + RRF on, scope falls back to the coordinator filter', async () => {
  const { calls, fetchImpl } = fakeServerless();
  const store = elasticStore({ esUrl: 'https://x.es.example', esApiKey: 'main-key', esIndex: 'roloe-t', fetchImpl });
  await store.init();
  const d = store.describe();
  assert.equal(d.license, 'serverless');
  assert.equal(d.rrf, 'elasticsearch');
  assert.equal(d.semantic, true);
  assert.match(d.scope, /coordinator filter/, 'honest from startup, before any tap');
  assert.ok(calls.every((c) => c.auth === 'ApiKey main-key'));
  const put = calls.find((c) => c.method === 'PUT').body;
  assert.equal(put.settings, undefined, 'Serverless refuses shard and replica settings');
  const mapping = put.mappings.properties;
  assert.equal(mapping.text_semantic.type, 'semantic_text');

  const k = await store.createEncounterKey('e-1');
  assert.match(store.describe().scope, /coordinator filter/);
  assert.equal(await store.count(k.id), 2);
  const countCall = calls.filter((c) => c.path.endsWith('/_count')).pop();
  assert.equal(countCall.auth, 'ApiKey main-key');
  assert.deepEqual(countCall.body.query.bool.filter[0], { term: { encounter_id: 'e-1' } });
  await store.invalidateKey(k.id);
  assert.equal(await store.count(k.id), 0);
  await assert.rejects(store.list(k.id));
});

test('with the elastic user\'s password, a refused key mint fails closed instead of downgrading scope (Gitar)', async () => {
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const reply = (status, json) => new Response(JSON.stringify(json), { status });
    if (u.pathname === '/') return reply(200, { version: { build_flavor: 'default' } });
    if (u.pathname === '/_license') return reply(200, { license: { type: 'trial', status: 'active' } });
    if (opts.method === 'HEAD') return reply(200, {});
    if (u.pathname.endsWith('/_mapping')) return reply(200, { 'roloe-t': { mappings: { properties: {} } } });
    if (u.pathname === '/_security/api_key') return reply(403, { error: { type: 'security_exception' } });
    return reply(200, {});
  };
  const store = elasticStore({ esUrl: 'https://x.example', esUser: 'elastic', esPassword: 'pw', esIndex: 'roloe-t', fetchImpl });
  await store.init();
  await assert.rejects(store.createEncounterKey('e-1'));
  assert.match(store.describe().scope, /document-level/, 'scope mode unchanged: no silent downgrade');
});

test('ES_INFERENCE_ID puts the semantic field on Jina alone, so a rate-limited ELSER is never called', async () => {
  const jina = '.jina-embeddings-v5-text-small';
  const prev = process.env.ROLOE_MULTILINGUAL;
  process.env.ROLOE_MULTILINGUAL = 'off';
  try {
    const a = fakeServerless(['.elser-2-elastic', jina]);
    const s1 = elasticStore({ esUrl: 'https://x.es.example', esApiKey: 'k', esIndex: 'roloe-t', esInference: jina, fetchImpl: a.fetchImpl });
    await s1.init();
    assert.equal(s1.describe().inference_id, jina);
    const props = a.calls.find((c) => c.method === 'PUT' && c.path === '/roloe-t').body.mappings.properties;
    assert.equal(props.text_semantic.inference_id, jina);
    assert.ok(!JSON.stringify(props).includes('elser'), 'no ELSER field at all');

    const b = fakeServerless(['.elser-2-elastic']);   // not on this project: fall back, don't fail
    const s2 = elasticStore({ esUrl: 'https://x.es.example', esApiKey: 'k', esIndex: 'roloe-t', esInference: jina, fetchImpl: b.fetchImpl });
    await s2.init();
    assert.equal(s2.describe().inference_id, '.elser-2-elastic');
  } finally { if (prev === undefined) delete process.env.ROLOE_MULTILINGUAL; else process.env.ROLOE_MULTILINGUAL = prev; }
});
