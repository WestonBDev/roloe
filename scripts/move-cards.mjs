// Copy every card (not meetings) from one index into a new one, embedding with the new index's model.
//   ES_INDEX=roloe-passages-jina ES_INFERENCE_ID=.jina-embeddings-v5-text-small ROLOE_MULTILINGUAL=off \
//     node scripts/move-cards.mjs roloe-passages
// Used when ELSER hit its trial limit: the new index's semantic field runs on Jina alone.
import { config } from '../src/env.mjs';
import { elasticStore } from '../src/store/elastic.mjs';

const from = process.argv[2];
if (!from || !config.esUrl || from === config.esIndex) { console.log('usage: ES_INDEX=<new> node scripts/move-cards.mjs <old-index>'); process.exit(1); }
const store = elasticStore(config);
await store.init();   // creates the new index with its mapping
console.log('new index', config.esIndex, JSON.stringify(store.describe()));
const H = { authorization: config.esApiKey ? `ApiKey ${config.esApiKey}` : 'Basic ' + Buffer.from(`${config.esUser}:${config.esPassword}`).toString('base64'), 'content-type': 'application/json' };
const base = config.esUrl.replace(/\/$/, '');
const s = await (await fetch(`${base}/${from}/_search`, { method: 'POST', headers: H, body: JSON.stringify({ size: 5000, query: { prefix: { encounter_id: 'card:' } } }) })).json();
const docs = s.hits.hits.map((h) => ({ id: h._id, src: Object.fromEntries(Object.entries(h._source).filter(([k]) => k !== '_inference_fields')) }));
console.log('cards to move', docs.length);
for (let i = 0; i < docs.length; i += 50) {
  const chunk = docs.slice(i, i + 50);
  const body = chunk.flatMap((d) => [JSON.stringify({ index: { _index: config.esIndex, _id: d.id } }), JSON.stringify(d.src)]).join('\n') + '\n';
  for (let attempt = 1; ; attempt++) {
    const r = await (await fetch(`${base}/_bulk`, { method: 'POST', headers: { ...H, 'content-type': 'application/x-ndjson' }, body })).json();
    if (!r.errors) break;
    const err = r.items.find((x) => x.index?.error)?.index.error;
    if (attempt >= 4) { console.log('failed at', i, err?.type, String(err?.caused_by?.reason || err?.reason).slice(0, 160)); process.exit(1); }
    await new Promise((res) => setTimeout(res, 2000 * attempt));
  }
  console.log('moved', Math.min(i + 50, docs.length));
}
await fetch(`${base}/${config.esIndex}/_refresh`, { method: 'POST', headers: H });
const c = await (await fetch(`${base}/${config.esIndex}/_count`, { method: 'POST', headers: H, body: JSON.stringify({ query: { prefix: { encounter_id: 'card:' } } }) })).json();
console.log('cards in', config.esIndex, c.count);
