// Prove which scope mode is live on the configured cluster.
//   node scripts/elastic-check.mjs        (uses .env ELASTIC_* or ES_* values)
// Licensed (trial/Enterprise): a key queried with NO filter sees only its own encounter (DLS).
// Basic: DLS is refused, so the same raw query sees every encounter; the coordinator filter carries scope.
import { config } from '../src/env.mjs';
import { elasticStore } from '../src/store/elastic.mjs';

if (!config.esUrl) { console.log('No ELASTIC_URL / ES_URL set.'); process.exit(1); }
const store = elasticStore({ ...config, esIndex: `roloe-test-check-${Date.now()}` });
await store.init();
const P = (id, t) => ({ passage_id: id, kind: 'session', speaker: 'owner', source: 's', locator: id, ts: new Date().toISOString(), text: t, via: '' });
try {
  await store.replaceCard('x1', 'X', [P('p-000001', 'one'), P('p-000002', 'two')]);
  await store.replaceCard('y1', 'Y', [P('p-000003', 'three')]);
  await store.copyCardsToEncounter('e-check1', ['x1']);
  await store.copyCardsToEncounter('e-check2', ['y1']);
  const k = await store.createEncounterKey('e-check1');
  const filtered = await store.count(k.id);
  let raw;
  try { raw = await store.countUnfiltered(k.id); } catch (e) { raw = `refused (${e.code})`; }
  console.log(JSON.stringify({ ...store.describe(), filtered_count: filtered, raw_unfiltered_count: raw, total_docs_in_index: 6 }, null, 2));
  console.log(raw === 2 ? 'PASS: the key alone limits reads to its encounter (document-level security).'
    : `Scope is the coordinator filter on this license (raw key sees ${raw}).`);
  // Multilingual proof: one English passage, asked for in four other languages. ELSER is
  // English-only, so these only match through the Jina field.
  if (store.describe().multilingual) {
    await store.addToEncounter('e-check1', 'x1', 'X', [P('p-000009', 'The search results got worse after the upgrade because the embedding model changed underneath us. Pinning the embedding model version in the index mapping fixed it.')]);
    const asks = { es: 'mi búsqueda se rompió después de la actualización', ja: 'アップグレード後に検索結果が悪くなった', hi: 'अपग्रेड के बाद मेरी खोज खराब हो गई', pt: 'minha busca piorou depois da atualização' };
    const hits = await store.msearch(k.id, Object.values(asks), { owner: 'x1', k: 3, hybrid: true });
    const ranks = Object.keys(asks).map((lang, i) => `${lang}: ${(hits[i].findIndex((h) => h.passage_id === 'p-000009') + 1) || 'miss'}`);
    console.log(`multilingual (${store.describe().multilingual_inference_id}): rank of the English passage for a query in ${ranks.join(', ')}`);
  }
  await store.invalidateKey(k.id);
  console.log('after stop, Elasticsearch answers the old key with', await store.readsWithRevokedKey(k.id), 'documents');
} finally { await store.dropIndex(); }
