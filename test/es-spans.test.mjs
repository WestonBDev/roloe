// Every Elasticsearch call is a child span of the meeting step it serves, so Dash0 shows Elastic's
// latency inside each meeting's trace. No request bodies, no query text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import './helpers.mjs';
import { elasticStore } from '../src/store/elastic.mjs';
import { step, startEncounterTrace, flush, traceFile } from '../src/telemetry.mjs';

test('Elasticsearch requests are child spans of the step that made them', async () => {
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const reply = (status, json) => new Response(JSON.stringify(json), { status });
    if (u.pathname === '/') return reply(200, { version: { build_flavor: 'serverless' } });
    if (u.pathname === '/_inference/_all') return reply(200, { endpoints: [] });
    if (opts.method === 'HEAD') return reply(200, {});
    if (u.pathname.endsWith('/_mapping')) return reply(200, { x: { mappings: { properties: {} } } });
    if (u.pathname === '/_security/api_key') return reply(400, { error: { type: 'illegal_argument_exception' } });
    if (u.pathname.endsWith('/_msearch')) return reply(200, { responses: [{ hits: { hits: [] } }] });
    return reply(200, { hits: { hits: [] } });
  };
  const store = elasticStore({ esUrl: 'https://x.es.example', esApiKey: 'k', esIndex: 'roloe-t', fetchImpl });
  await store.init();
  const { id } = await store.createEncounterKey('e-span000001');
  const trace = startEncounterTrace('e-span000001');
  const ref = { encounterId: 'e-span000001', ...trace };
  let stepSpanId;
  await step('roloe.overlap', ref, {}, async (span) => {
    stepSpanId = span.spanContext().spanId;
    await store.msearch(id, ['the secret query text'], { owner: 'wes' });
  });
  await flush();
  const spans = readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const es = spans.find((x) => x.name === 'elasticsearch POST _msearch');
  assert.ok(es, spans.map((x) => x.name).join(', '));
  assert.equal(es.parentSpanId, stepSpanId);
  assert.equal(es.traceId, trace.traceId);
  assert.equal(es.attributes['db.system.name'], 'elasticsearch');
  assert.equal(es.attributes['http.response.status_code'], 200);
  assert.ok(!JSON.stringify(spans).includes('secret query text'), 'no query text in telemetry');
});
