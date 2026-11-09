// Pick the store: Elasticsearch when a URL is configured, otherwise in-memory.
import { config } from '../env.mjs';
import { memoryStore } from './memory.mjs';

export async function openStore() {
  let store;
  if (config.esUrl && !config.esApiKey && !config.esPassword) {
    console.warn('[roloe] An Elasticsearch URL is set but no ELASTIC_API_KEY or password; using the in-memory store.');
    store = memoryStore({ dataDir: config.dataDir });
  } else if (config.esUrl) {
    const { elasticStore } = await import('./elastic.mjs');
    store = elasticStore(config);
  } else {
    store = memoryStore({ dataDir: config.dataDir });
  }
  await store.init();
  return store;
}
