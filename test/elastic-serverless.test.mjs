// Elastic Cloud Serverless authenticates with an API key. Elasticsearch refuses to mint a key with
// privileges from another API key, so on serverless the store must fall back to its own key plus
// the encounter_id filter on every read, and say so. Simulated with a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elasticStore } from '../src/store/elastic.mjs';

function fakeServerless() {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const body = opts.body && !String(opts.body).includes('\n{') ? JSON.parse(opts.body) : opts.body;
    calls.push({ method: opts.method, path: u.pathname, auth: opts.headers.authorization, body });
    const reply = (status, json) => new Response(JSON.stringify(json), { status });
    // Real Serverless answers /_license too (Gitar): the build flavor must be checked first.
    if (u.pathname === '/_license') return reply(200, { license: { type: 'basic', status: 'active' } });
    if (u.pathname === '/' ) return reply(200, { version: { build_flavor: 'serverless' } });
    if (u.pathname === '/_inference/_all') return reply(200, { endpoints: [{ inference_id: '.elser-2-elastic' }] });
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
