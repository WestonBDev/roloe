// Compare embedding endpoints on the configured Elastic project with made-up passages.
//   node scripts/embedding-check.mjs [.jina-embeddings-v5-text-small] [.elser-2-elastic]
// Each endpoint gets its own throwaway index (deleted after). The query shares no words with
// the passage it should find, so only semantic search can find it.
import { config } from '../src/env.mjs';
import { elasticStore } from '../src/store/elastic.mjs';

if (!config.esUrl) { console.log('No ELASTIC_URL / ES_URL set.'); process.exit(1); }
const endpoints = process.argv.slice(2).length ? process.argv.slice(2) : ['.jina-embeddings-v5-text-small', '.elser-2-elastic'];
const P = (id, t) => ({ passage_id: id, kind: 'session', speaker: 'owner', source: 's', locator: id, ts: new Date().toISOString(), text: t, via: '' });
const passages = [
  P('p-000001', 'Retries now back off exponentially with jitter so a flaky upstream is not hammered.'),
  P('p-000002', 'The spans were dropped because the exporter sent no bearer header to the collector.'),
  P('p-000003', 'We moved the vector index to a smaller shard count to save memory.'),
];
const query = 'traces never arrive in my observability backend';
for (const id of endpoints) {
  const store = elasticStore({ ...config, esInference: id, esIndex: `roloe-test-emb-${Date.now()}` });
  try {
    await store.init();
    const d = store.describe();
    await store.replaceCard('x1', 'X', passages);
    await store.copyCardsToEncounter('e-emb1', ['x1']);
    const k = await store.createEncounterKey('e-emb1');
    const t = Date.now();
    const [hits] = await store.msearch(k.id, [query], { k: 3, hybrid: true });
    console.log(JSON.stringify({ asked_for: id, used: d.inference_id, semantic: d.semantic, ms: Date.now() - t, top: (hits || []).map((h) => h.passage_id) }));
  } finally { await store.dropIndex(); }
}
