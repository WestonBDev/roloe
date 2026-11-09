// A second semantic field on a multilingual Jina model (Elastic Inference Service) sits next to
// ELSER, which is English-only. A guest who writes in Spanish, Japanese or Hindi still finds the
// English passage. Three rankings (keywords, ELSER, Jina) are fused by Elasticsearch's own RRF,
// and every one of them carries the meeting filter. Simulated with a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elasticStore } from '../src/store/elastic.mjs';

function fakeEs({ endpoints = ['.elser-2-elastic', '.jina-embeddings-v5-text-small'], existing = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const nd = String(opts.headers['content-type']).includes('ndjson');
    const body = opts.body === undefined ? undefined : nd ? String(opts.body).trim().split('\n').map((l) => JSON.parse(l)) : JSON.parse(opts.body);
    calls.push({ method: opts.method, path: u.pathname, body });
    const reply = (status, json) => new Response(JSON.stringify(json), { status });
    if (u.pathname === '/') return reply(200, { version: { build_flavor: 'serverless' } });
    if (u.pathname === '/_inference/_all') return reply(200, { endpoints: endpoints.map((inference_id) => ({ inference_id })) });
    if (opts.method === 'HEAD') return reply(existing && u.pathname === '/roloe-t' ? 200 : 404, {});
    if (opts.method === 'GET' && u.pathname.endsWith('/_mapping')) return reply(200, { 'roloe-t': { mappings: { properties: existing } } });
    if (opts.method === 'PUT') return reply(200, { acknowledged: true });
    if (u.pathname === '/_security/api_key') return reply(400, { error: { type: 'illegal_argument_exception' } });
    if (u.pathname.endsWith('/_bulk')) return reply(200, { errors: false, items: [] });
    if (u.pathname.endsWith('/_msearch')) return reply(200, { responses: [{ hits: { hits: [] } }] });
    return reply(200, { hits: { hits: [] } });
  };
  return { calls, fetchImpl };
}
const open = async (opts) => {
  const f = fakeEs(opts);
  const store = elasticStore({ esUrl: 'https://x.es.example', esApiKey: 'k', esIndex: 'roloe-t', fetchImpl: f.fetchImpl });
  await store.init();
  return { store, calls: f.calls };
};
const P = (id, text) => ({ passage_id: id, kind: 'session', speaker: 'owner', source: 's', locator: id, ts: '2026-11-09T10:00:00Z', text });

test('a new index gets a Jina multilingual semantic field next to ELSER, and a shared_at date', async () => {
  const { store, calls } = await open();
  const props = calls.find((c) => c.method === 'PUT' && c.path === '/roloe-t').body.mappings.properties;
  assert.deepEqual(props.text.copy_to, ['text_semantic', 'text_jina']);
  assert.equal(props.text_semantic.inference_id, '.elser-2-elastic');
  assert.deepEqual(props.text_jina, { type: 'semantic_text', inference_id: '.jina-embeddings-v5-text-small' });
  assert.equal(props.shared_at.type, 'date');
  const d = store.describe();
  assert.equal(d.multilingual, true);
  assert.equal(d.multilingual_inference_id, '.jina-embeddings-v5-text-small');
});

test('an existing ELSER-only index is upgraded in place: one mapping update, no reindex', async () => {
  const existing = { text: { type: 'text', copy_to: ['text_semantic'] }, text_semantic: { type: 'semantic_text', inference_id: '.elser-2-elastic' } };
  const { store, calls } = await open({ existing });
  const put = calls.find((c) => c.method === 'PUT' && c.path === '/roloe-t/_mapping');
  assert.ok(put, 'adds the field with PUT _mapping');
  assert.deepEqual(put.body.properties.text.copy_to, ['text_semantic', 'text_jina']);
  assert.equal(put.body.properties.text_jina.inference_id, '.jina-embeddings-v5-text-small');
  assert.equal(put.body.properties.shared_at.type, 'date');
  assert.equal(store.describe().multilingual, true);
});

test('hybrid search fuses keywords, ELSER and Jina with RRF, each ranking locked to the meeting', async () => {
  const { store, calls } = await open();
  const k = await store.createEncounterKey('e-1');
  await store.msearch(k.id, ['mi búsqueda se rompió después de la actualización'], { owner: 'wes', hybrid: true });
  const [, search] = calls.filter((c) => c.path.endsWith('/_msearch')).pop().body;
  const rs = search.retriever.rrf.retrievers;
  assert.equal(rs.length, 3);
  assert.ok(rs[0].standard.query.bool.must[0].match.text, 'keywords');
  assert.equal(rs[1].standard.query.bool.must[0].semantic.field, 'text_semantic');
  assert.equal(rs[2].standard.query.bool.must[0].semantic.field, 'text_jina');
  for (const r of rs) {
    assert.deepEqual(r.standard.query.bool.filter[0], { term: { encounter_id: 'e-1' } }, 'every ranking is scoped to this meeting');
    assert.deepEqual(r.standard.query.bool.filter[1], { term: { owner_id: 'wes' } });
  }
  assert.ok(search._source.excludes.includes('text_jina'), 'embeddings never come back with a passage');
});

test('copies made for a meeting are stamped with shared_at, so they can expire', async () => {
  const { store, calls } = await open();
  await store.addToEncounter('e-1', 'wes', 'Wes', [P('p-000001', 'one')]);
  const [, doc] = calls.filter((c) => c.path.endsWith('/_bulk')).pop().body;
  assert.equal(doc.encounter_id, 'e-1');
  assert.ok(Math.abs(Date.parse(doc.shared_at) - Date.now()) < 5000);
});

test('without a Jina endpoint, or with ROLOE_MULTILINGUAL=off, search stays keywords + ELSER', async () => {
  for (const setup of [() => open({ endpoints: ['.elser-2-elastic'] }), async () => { process.env.ROLOE_MULTILINGUAL = 'off'; try { return await open(); } finally { delete process.env.ROLOE_MULTILINGUAL; } }]) {
    const { store, calls } = await setup();
    assert.equal(store.describe().multilingual, false);
    const props = calls.find((c) => c.method === 'PUT' && c.path === '/roloe-t').body.mappings.properties;
    assert.equal(props.text_jina, undefined);
    const k = await store.createEncounterKey('e-1');
    await store.msearch(k.id, ['q'], { hybrid: true });
    const [, search] = calls.filter((c) => c.path.endsWith('/_msearch')).pop().body;
    assert.equal(search.retriever.rrf.retrievers.length, 2);
  }
});

test('a meeting record written to Elasticsearch is an upsert of metadata into its own index', async () => {
  const { store, calls } = await open();
  await store.recordMeeting({ meeting_id: 'e-1', kind: 'guest', started_at: '2026-11-09T10:00:00.000Z', findings_accepted: 2 });
  const c = calls.pop();
  assert.equal(c.method, 'POST');
  assert.equal(c.path, '/roloe-t-meetings/_update/e-1');
  assert.equal(c.body.doc_as_upsert, true);
  assert.equal(c.body.doc.findings_accepted, 2);
  const created = calls.find((x) => x.method === 'PUT' && x.path === '/roloe-t-meetings');
  assert.equal(created.body.mappings.dynamic, 'strict', 'nothing outside the listed metadata fields can be written');
  assert.equal(created.body.mappings.properties.text, undefined);
});
