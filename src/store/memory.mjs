// In-memory store with the same interface as the Elasticsearch store. Used for tests and as the
// fallback when no ES_URL / ELASTIC_URL is set. Writes to disk so a restart keeps cards.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { bm25Search } from './text.mjs';

export function memoryStore({ dataDir } = {}) {
  let docs = [];               // { ...passage, owner_id, owner_name, encounter_id }
  const keys = new Map();      // keyId -> { encounter_id, valid }
  const file = dataDir ? join(dataDir, 'memory-store.json') : null;
  let timer = null;
  const writeNow = () => {
    if (!file) return;
    clearTimeout(timer);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ docs: docs.map(({ _tokens, ...d }) => d), keys: [...keys] }), { mode: 0o600 });
  };
  const persist = () => {
    if (!file) return;
    clearTimeout(timer);
    timer = setTimeout(writeNow, 200);
  };
  const scope = (keyId) => {
    const k = keys.get(keyId);
    if (!k || !k.valid) { const e = new Error('Key is not valid'); e.code = 'key_invalid'; throw e; }
    return docs.filter((d) => d.encounter_id === k.encounter_id);
  };

  return {
    mode: 'memory',
    describe: () => ({ store: 'memory', scope: 'coordinator filter', license: 'n/a', rrf: 'coordinator', semantic: false }),
    async init() {
      if (file && existsSync(file)) {
        try { const s = JSON.parse(readFileSync(file, 'utf8')); docs = s.docs || []; for (const [k, v] of s.keys || []) keys.set(k, v); } catch { /* clean */ }
      }
    },
    async replaceCard(owner, ownerName, passages) {
      docs = docs.filter((d) => d.encounter_id !== `card:${owner}`);
      for (const p of passages) docs.push({ ...p, owner_id: owner, owner_name: ownerName, encounter_id: `card:${owner}` });
      persist();
      return passages.length;
    },
    async listCard(owner) { return docs.filter((d) => d.encounter_id === `card:${owner}`).map(({ _tokens, ...d }) => d); },
    async removeFromCard(owner, passageId) {
      const before = docs.length;
      docs = docs.filter((d) => !(d.encounter_id === `card:${owner}` && d.passage_id === passageId));
      persist();
      return before - docs.length;
    },
    async copyCardsToEncounter(enc, owners) {
      const copies = docs.filter((d) => owners.includes(d.owner_id) && d.encounter_id === `card:${d.owner_id}`).map(({ _tokens, ...d }) => ({ ...d, encounter_id: enc }));
      docs.push(...copies);
      persist();
      return copies.length;
    },
    async addToEncounter(enc, owner, ownerName, passages) {
      for (const p of passages) docs.push({ ...p, owner_id: owner, owner_name: ownerName, encounter_id: enc });
      persist();
      return passages.length;
    },
    async createEncounterKey(enc) {
      const id = 'mk-' + randomBytes(8).toString('hex');
      keys.set(id, { encounter_id: enc, valid: true });
      persist();
      return { id };
    },
    async flush() { writeNow(); },
    async reattach(enc, keyId) {
      const k = keys.get(keyId);
      if (k?.valid) return { id: keyId };
      return this.createEncounterKey(enc);
    },
    async invalidateKey(id) { const k = keys.get(id); if (k) k.valid = false; persist(); },
    async get(keyId, passageId, owner) {
      const d = scope(keyId).find((x) => x.passage_id === passageId && (!owner || x.owner_id === owner));
      if (!d) return null;
      const { _tokens, ...rest } = d;
      return rest;
    },
    async list(keyId, owner) { return scope(keyId).filter((d) => !owner || d.owner_id === owner).map(({ _tokens, ...d }) => d); },
    async count(keyId) { try { return scope(keyId).length; } catch { return 0; } },
    async search(keyId, query, { owner, k = 5 } = {}) {
      const pool = scope(keyId).filter((d) => !owner || d.owner_id === owner);
      return bm25Search(pool, query, k).map(({ doc, score }) => { const { _tokens, ...d } = doc; return { ...d, _score: score }; });
    },
    async msearch(keyId, queries, { owner, k = 5 } = {}) {
      const out = [];
      for (const q of queries) out.push(await this.search(keyId, q, { owner, k }));
      return out;
    },
    async deleteEncounter(enc) {
      const before = docs.length;
      docs = docs.filter((d) => d.encounter_id !== enc);
      persist();
      return before - docs.length;
    },
    async readsWithRevokedKey(keyId) { const k = keys.get(keyId); return k && k.valid ? docs.filter((d) => d.encounter_id === k.encounter_id).length : 0; },
  };
}
