// Pick the store: Elasticsearch when a URL is configured, otherwise in-memory.
import { config } from '../env.mjs';
import { memoryStore } from './memory.mjs';

export async function openStore() {
  let store;
  if (config.esUrl) {
    const { elasticStore } = await import('./elastic.mjs');
    store = elasticStore(config);
  } else {
    store = memoryStore({ dataDir: config.dataDir });
  }
  await store.init();
  return store;
}
