import { childSpan } from '../telemetry.mjs';

// Elasticsearch store. One index of passages with owner_id and encounter_id.
// At a tap, both cards are copied into the encounter and an API key is minted with the
// elastic user's credentials. On a trial/Enterprise license the key's role descriptor carries
// document-level security (query: term encounter_id), so the key itself can't reach anything
// else. On Basic, DLS is refused; the key is read-only on the index and the coordinator's
// encounter_id filter (applied on every read in both modes) carries scope.

const LICENSED = new Set(['trial', 'enterprise', 'platinum']);
const SEMANTIC_CANDIDATES = ['.elser-2-elastic', '.elser-2-elasticsearch', '.multilingual-e5-small-elasticsearch'];
// ELSER is English-only. A second semantic field on a multilingual Jina model (Elastic Inference
// Service) lets someone who writes in another language find the same passages.
const MULTILINGUAL_CANDIDATES = ['.jina-embeddings-v5-text-small', '.jina-embeddings-v3'];
const EMBEDDED = ['text_semantic', 'text_jina'];   // never returned with a passage
// One metadata record per meeting (see meeting-record.mjs). Strict: no other field can be written.
const MEETING_MAPPING = { dynamic: 'strict', properties: {
  meeting_id: { type: 'keyword' }, kind: { type: 'keyword' }, started_at: { type: 'date' }, updated_at: { type: 'date' },
  findings_accepted: { type: 'integer' }, findings_dropped: { type: 'integer' }, nothing_strong: { type: 'boolean' },
  time_to_findings_s: { type: 'float' }, try_state: { type: 'keyword' }, time_to_help_s: { type: 'float' }, stopped: { type: 'boolean' },
} };

export function elasticStore({ esUrl, esUser, esPassword, esApiKey, esIndex, fetchImpl = fetch }) {
  const base = esUrl.replace(/\/$/, '');
  const index = esIndex;
  const meetingsIndex = `${esIndex}-meetings`;
  const basic = esApiKey ? `ApiKey ${esApiKey}` : 'Basic ' + Buffer.from(`${esUser}:${esPassword}`).toString('base64');
  const keys = new Map(); // keyId -> { encoded, encounter_id, valid }  (memory only, never persisted)
  let mintRefused = false; // serverless / API-key auth: keys with privileges can't be minted from a key
  const info = { store: 'elasticsearch', license: 'unknown', scope: 'coordinator filter', rrf: 'coordinator', semantic: false, inference_id: null, multilingual: false, multilingual_inference_id: null };

  // Each request is a span (operation, status, duration; never the body), a child of the meeting
  // step that made it, so Dash0 shows Elastic's share of every meeting.
  const opName = (path) => path.split('?')[0].replace(`/${index}`, '').replace(/^\//, '') || 'index';
  async function es(method, path, body, opts = {}) {
    return childSpan(`elasticsearch ${method} ${opName(path)}`, { 'db.system.name': 'elasticsearch', 'db.operation.name': opName(path), 'http.request.method': method, 'server.address': new URL(base).hostname },
      async (span) => { const r = await esRaw(method, path, body, opts); span.setAttribute('http.response.status_code', r.status); return r; });
  }
  async function esRaw(method, path, body, { auth = basic, ndjson = false, allow = [] } = {}) {
    const res = await fetchImpl(base + path, {
      method,
      headers: { authorization: auth, 'content-type': ndjson ? 'application/x-ndjson' : 'application/json' },
      body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok && !allow.includes(res.status)) {
      const e = new Error(`elasticsearch ${res.status} ${json?.error?.type || ''}`.trim());
      e.code = json?.error?.type || `es_${res.status}`;
      e.status = res.status;
      throw e;
    }
    return { status: res.status, json };
  }

  const keyAuth = (keyId) => {
    const k = keys.get(keyId);
    if (!k || !k.valid) { const e = new Error('Key is not valid'); e.code = 'key_invalid'; throw e; }
    return k;
  };
  const docOf = (h) => ({ ...h._source, _score: h._score });
  const strip = ({ _score, ...d }) => d;
  const scoped = (enc, must = [], filter = []) => ({ bool: { must, filter: [{ term: { encounter_id: enc } }, ...filter] } });

  async function bulkIndex(docs) {
    if (!docs.length) return 0;
    const lines = [];
    const stamp = new Date().toISOString();   // when this copy was made: what expiry reads
    for (const d of docs) {
      lines.push(JSON.stringify({ index: { _index: index, _id: `${d.encounter_id}:${d.owner_id}:${d.passage_id}` } }));
      lines.push(JSON.stringify({ ...d, shared_at: stamp }));
    }
    const { json } = await es('POST', '/_bulk?refresh=true', lines.join('\n') + '\n', { ndjson: true });
    if (json.errors) {
      const first = json.items.find((i) => i.index?.error);
      const e = new Error(`bulk error ${first?.index?.error?.type}`); e.code = 'bulk_error'; throw e;
    }
    return docs.length;
  }

  async function searchAs(keyId, body) {
    const k = keyAuth(keyId);
    const { json } = await es('POST', `/${index}/_search`, body, { auth: k.encoded ? `ApiKey ${k.encoded}` : basic });
    return json.hits.hits.map(docOf);
  }

  return {
    mode: 'elasticsearch',
    describe: () => ({ ...info }),
    async init() {
      // Serverless answers /_license too, so ask for the build flavor first.
      const root = await es('GET', '/');
      let licensed;
      if (root.json.version?.build_flavor === 'serverless') {
        info.license = 'serverless';
        licensed = true;
      } else {
        const lic = await es('GET', '/_license', undefined, { allow: [400, 404, 410] });
        info.license = lic.json.license?.type || 'unknown';
        licensed = LICENSED.has(info.license) && lic.json.license?.status === 'active';
      }
      info.scope = licensed ? 'document-level security key' : 'coordinator filter (Basic license refuses DLS)';
      info.rrf = licensed ? 'elasticsearch' : 'coordinator';
      const wantSemantic = licensed && process.env.ROLOE_SEMANTIC !== 'off';
      const wantMultilingual = wantSemantic && process.env.ROLOE_MULTILINGUAL !== 'off';
      const inferenceIds = async () => ((await es('GET', '/_inference/_all', undefined, { allow: [400, 403, 404] })).json.endpoints || []).map((e) => e.inference_id);
      const exists = await es('HEAD', `/${index}`, undefined, { allow: [404] });
      const ids = exists.status !== 404 && wantMultilingual ? await inferenceIds() : [];
      if (exists.status === 404) {
        const ids = wantSemantic ? await inferenceIds() : [];
        info.inference_id = SEMANTIC_CANDIDATES.find((c) => ids.includes(c)) || null;
        const jina = info.inference_id && wantMultilingual ? MULTILINGUAL_CANDIDATES.find((c) => ids.includes(c)) || null : null;
        const props = {
          passage_id: { type: 'keyword' }, owner_id: { type: 'keyword' }, owner_name: { type: 'keyword' },
          encounter_id: { type: 'keyword' }, kind: { type: 'keyword' }, speaker: { type: 'keyword' },
          source: { type: 'keyword' }, locator: { type: 'keyword' }, via: { type: 'keyword' },
          ts: { type: 'date' }, shared_at: { type: 'date' }, text: { type: 'text' },
        };
        if (info.inference_id) {
          props.text = { type: 'text', copy_to: jina ? EMBEDDED : ['text_semantic'] };
          props.text_semantic = { type: 'semantic_text', inference_id: info.inference_id };
          if (jina) props.text_jina = { type: 'semantic_text', inference_id: jina };
        }
        const body = { mappings: { properties: props } };
        if (info.license !== 'serverless') body.settings = { number_of_shards: 1, number_of_replicas: 0, refresh_interval: '1s' };
        const r = await es('PUT', `/${index}`, body, { allow: [400] });
        if (r.status === 400 && r.json?.error?.type !== 'resource_already_exists_exception') {
          const e = new Error(`index create failed: ${r.json?.error?.type}: ${String(r.json?.error?.reason || "").slice(0, 200)}`); e.code = r.json?.error?.type || 'index_create_failed'; throw e;
        }
        info.multilingual_inference_id = jina;
      } else {
        const m = await es('GET', `/${index}/_mapping`);
        const have = Object.values(m.json)[0]?.mappings?.properties || {};
        info.inference_id = have.text_semantic?.inference_id || null;
        info.multilingual_inference_id = have.text_jina?.inference_id || null;
        // Upgrade in place: semantic_text fields and copy_to can be added to a live index, so the
        // next copy made for a meeting is embedded both ways. No reindex. If Elasticsearch
        // refuses, search stays keywords + ELSER.
        const add = {};
        if (!have.shared_at) add.shared_at = { type: 'date' };
        if (info.inference_id && !have.text_jina && wantMultilingual) {
          const jina = MULTILINGUAL_CANDIDATES.find((c) => ids.includes(c)) || null;
          if (jina) { add.text = { type: 'text', copy_to: EMBEDDED }; add.text_jina = { type: 'semantic_text', inference_id: jina }; }
        }
        if (Object.keys(add).length) {
          const r = await es('PUT', `/${index}/_mapping`, { properties: add }, { allow: [400] });
          if (r.status === 200 && add.text_jina) info.multilingual_inference_id = add.text_jina.inference_id;
        }
      }
      if (process.env.ROLOE_MULTILINGUAL === 'off') info.multilingual_inference_id = null;
      info.multilingual = Boolean(info.multilingual_inference_id);
      const mi = await es('HEAD', `/${meetingsIndex}`, undefined, { allow: [404] });
      if (mi.status === 404) await es('PUT', `/${meetingsIndex}`, { mappings: MEETING_MAPPING }, { allow: [400] });
      info.semantic = Boolean(info.inference_id);
      // Probe once: can this credential mint a scoped key? Then describe() is honest from startup.
      if (info.scope.startsWith('document-level') && esApiKey) {   // password auth fails closed at mint time instead
        const probe = await es('POST', '/_security/api_key', {
          name: 'roloe-mint-probe', expiration: '1m',
          role_descriptors: { probe: { indices: [{ names: [index], privileges: ['read'], query: { term: { encounter_id: 'probe' } } }] } },
        }, { allow: [400, 403] });
        if (probe.status === 200) await es('DELETE', '/_security/api_key', { ids: [probe.json.id] }, { allow: [404] });
        else { mintRefused = true; info.scope = 'coordinator filter (this cluster refuses to mint scoped keys from an API key)'; }
      }
    },
    async replaceCard(owner, ownerName, passages) {
      await es('POST', `/${index}/_delete_by_query?refresh=true&conflicts=proceed`, { query: { term: { encounter_id: `card:${owner}` } } });
      return bulkIndex(passages.map((p) => ({ ...p, owner_id: owner, owner_name: ownerName, encounter_id: `card:${owner}` })));
    },
    async listCard(owner) {
      const { json } = await es('POST', `/${index}/_search`, { size: 1000, query: { term: { encounter_id: `card:${owner}` } } });
      return json.hits.hits.map((h) => h._source);
    },
    async removeFromCard(owner, passageId) {
      const { json } = await es('POST', `/${index}/_delete_by_query?refresh=true&conflicts=proceed`, {
        query: { bool: { filter: [{ term: { encounter_id: `card:${owner}` } }, { term: { passage_id: passageId } }] } },
      });
      return json.deleted || 0;
    },
    // _reindex can't write into the index it reads from, so search + bulk.
    async copyCardsToEncounter(enc, owners) {
      const { json } = await es('POST', `/${index}/_search`, { size: 2000, query: { terms: { encounter_id: owners.map((o) => `card:${o}`) } } });
      return bulkIndex(json.hits.hits.map((h) => ({ ...h._source, encounter_id: enc })));
    },
    async addToEncounter(enc, owner, ownerName, passages) {
      return bulkIndex(passages.map((p) => ({ ...p, owner_id: owner, owner_name: ownerName, encounter_id: enc })));
    },
    // Minted with the elastic user's credentials: a key created by another API key gets no privileges.
    async createEncounterKey(enc) {
      const priv = { names: [index], privileges: ['read'] };
      if (info.scope.startsWith('document-level')) priv.query = { term: { encounter_id: enc } };
      if (!mintRefused) {
        try {
          const { json } = await es('POST', '/_security/api_key', {
            name: `roloe-${enc}`, expiration: '1d',
            role_descriptors: { roloe_encounter: { cluster: [], indices: [priv] } },
            metadata: { roloe_encounter: enc },
          });
          keys.set(json.id, { encoded: json.encoded, encounter_id: enc, valid: true });
          return { id: json.id };
        } catch (e) {
          // Only an API-key credential is expected to be refused (Elasticsearch won't derive a
          // privileged key from one). With the elastic user's password, fail closed: never downgrade.
          if (!esApiKey || ![400, 403].includes(e.status)) throw e;
          mintRefused = true;
          info.scope = 'coordinator filter (this cluster refuses to mint scoped keys from an API key)';
        }
      }
      // No minted key: a coordinator-side handle that the encounter_id filter scopes, and that
      // stop invalidates just the same.
      const id = 'ck-' + enc + '-' + Math.random().toString(16).slice(2, 10);
      keys.set(id, { encoded: null, encounter_id: enc, valid: true });
      return { id };
    },
    // After a restart the key map is empty. Filter mode: a fresh handle with the same id.
    // Minted keys can't be recovered (their secret was never stored), so mint a new one.
    async flush() {},
    async reattach(enc, keyId) {
      const k = keys.get(keyId);
      if (k?.valid) return { id: keyId };
      if (mintRefused || String(keyId).startsWith('ck-')) { keys.set(keyId, { encoded: null, encounter_id: enc, valid: true }); return { id: keyId }; }
      return this.createEncounterKey(enc);
    },
    async invalidateKey(id) {
      const k = keys.get(id);
      if (k) k.valid = false;
      if (k?.encoded) await es('DELETE', '/_security/api_key', { ids: [id] }, { allow: [404] });
    },
    async get(keyId, passageId, owner) {
      const k = keyAuth(keyId);
      const hits = await searchAs(keyId, { size: 1, query: scoped(k.encounter_id, [], [{ term: { passage_id: passageId } }, ...(owner ? [{ term: { owner_id: owner } }] : [])]) });
      return hits[0] ? strip(hits[0]) : null;
    },
    // Many passages by id in one request (a pull, a post's citations), not one search each.
    async getMany(keyId, ids) {
      const k = keyAuth(keyId);
      const uniq = [...new Set(ids)].slice(0, 200);
      if (!uniq.length) return [];
      const hits = await searchAs(keyId, { size: uniq.length * 2, _source: { excludes: EMBEDDED }, query: scoped(k.encounter_id, [], [{ terms: { passage_id: uniq } }]) });
      return hits.map(strip);
    },
    async list(keyId, owner) {
      const k = keyAuth(keyId);
      const hits = await searchAs(keyId, { size: 2000, query: scoped(k.encounter_id, [], owner ? [{ term: { owner_id: owner } }] : []) });
      return hits.map(strip);
    },
    async count(keyId) {
      try {
        const k = keyAuth(keyId);
        const { json } = await es('POST', `/${index}/_count`, { query: scoped(k.encounter_id) }, { auth: k.encoded ? `ApiKey ${k.encoded}` : basic });
        return json.count;
      } catch { return 0; }
    },
    // The raw proof for DLS: no filter in the query at all. On a licensed cluster this still
    // returns only the key's encounter.
    async countUnfiltered(keyId) {
      const k = keyAuth(keyId);
      if (!k.encoded) return 'no minted key';
      const { json } = await es('POST', `/${index}/_count`, { query: { match_all: {} } }, { auth: `ApiKey ${k.encoded}` });
      return json.count;
    },
    async search(keyId, query, { owner, k = 5 } = {}) {
      return (await this.msearch(keyId, [query], { owner, k }))[0];
    },
    async msearch(keyId, queries, { owner, k = 5, hybrid = false } = {}) {
      const key = keyAuth(keyId);
      if (!queries.length) return [];
      const filter = owner ? [{ term: { owner_id: owner } }] : [];
      const lines = [];
      for (const q of queries) {
        lines.push('{}');
        const lexical = { match: { text: { query: String(q).slice(0, 2000) } } };
        if (hybrid && info.semantic && info.rrf === 'elasticsearch') {
          const f = [{ term: { encounter_id: key.encounter_id } }, ...filter];
          lines.push(JSON.stringify({ size: k, _source: { excludes: EMBEDDED }, retriever: { rrf: { rank_window_size: 20, rank_constant: 60, retrievers: [
            { standard: { query: { bool: { must: [lexical], filter: f } } } },
            { standard: { query: { bool: { must: [{ semantic: { field: 'text_semantic', query: String(q).slice(0, 2000) } }], filter: f } } } },
            ...(info.multilingual ? [{ standard: { query: { bool: { must: [{ semantic: { field: 'text_jina', query: String(q).slice(0, 2000) } }], filter: f } } } }] : []),
          ] } } }));
        } else {
          lines.push(JSON.stringify({ size: k, _source: { excludes: EMBEDDED }, query: scoped(key.encounter_id, [lexical], filter) }));
        }
      }
      const { json } = await es('POST', `/${index}/_msearch`, lines.join('\n') + '\n', { auth: key.encoded ? `ApiKey ${key.encoded}` : basic, ndjson: true });
      return json.responses.map((r) => (r.hits?.hits || []).map(docOf));
    },
    // Metadata only, in its own strict index. An upsert, so each step of a meeting adds to one record.
    async recordMeeting(doc) {
      await es('POST', `/${meetingsIndex}/_update/${encodeURIComponent(doc.meeting_id)}`, { doc, doc_as_upsert: true });
    },
    async listMeetings() {
      const { json } = await es('POST', `/${meetingsIndex}/_search`, { size: 1000, sort: [{ started_at: 'desc' }] }, { allow: [404] });
      return (json.hits?.hits || []).map((h) => h._source);
    },
    async deleteEncounter(enc) {
      const { json } = await es('POST', `/${index}/_delete_by_query?refresh=true&conflicts=proceed`, { query: { term: { encounter_id: enc } } }, { allow: [404] });
      return json.deleted || 0;
    },
    // After stop: send the old key to Elasticsearch itself. 0 means ES refused it (or it reads nothing).
    async readsWithRevokedKey(keyId) {
      const k = keys.get(keyId);
      if (!k) return 0;
      if (!k.encoded) return k.valid ? -1 : 0;   // coordinator-side handle: closed by valid=false
      const r = await es('POST', `/${index}/_count`, { query: { term: { encounter_id: k.encounter_id } } }, { auth: `ApiKey ${k.encoded}`, allow: [401, 403] });
      return r.status === 200 ? r.json.count : 0;
    },
    async dropIndex() { if (index.startsWith('roloe-test-')) { await es('DELETE', `/${index}`, undefined, { allow: [404] }); await es('DELETE', `/${meetingsIndex}`, undefined, { allow: [404] }); } },
  };
}
