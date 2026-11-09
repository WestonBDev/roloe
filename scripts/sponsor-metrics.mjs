// Real numbers for each sponsor, or "not yet". Never a guess.
//   node scripts/sponsor-metrics.mjs [--url https://roloe.cnh.radarhq.io] [--traces data-live/traces.jsonl ...]
import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { config } from '../src/env.mjs';

const { values: opt } = parseArgs({ options: { url: { type: 'string', default: 'https://roloe.cnh.radarhq.io' }, traces: { type: 'string', multiple: true, default: ['data-live/traces.jsonl', 'data/traces.jsonl'] }, index: { type: 'string', default: process.env.ES_INDEX || 'roloe-passages' } } });
const NY = 'not yet';
const out = {};
const pct = (a, p) => { const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return v.length ? Math.round(v[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)]) : NY; };

// Product, from the public coordinator's own counts.
try {
  const d = await (await fetch(`${opt.url}/api/dashboard`, { signal: AbortSignal.timeout(8000) })).json();
  out.product = { source: `${opt.url}/api/dashboard`, meetings: d.meetings, guest_scans: d.guests, findings_accepted: d.findings_accepted, findings_dropped_by_citation_check: d.findings_dropped,
    nothing_strong: d.nothing_strong, try_it_green: d.help_that_worked, median_scan_to_findings_s: d.median_tap_to_findings_s ?? NY, median_scan_to_green_s: d.median_tap_to_green_s ?? NY, canaries_in_telemetry: d.canaries_in_telemetry };
} catch { out.product = NY; }

// Elastic, read-only with the project's API key.
if (config.esUrl && (config.esApiKey || config.esPassword)) {
  const auth = config.esApiKey ? `ApiKey ${config.esApiKey}` : 'Basic ' + Buffer.from(`${config.esUser}:${config.esPassword}`).toString('base64');
  const es = async (path, body) => (await fetch(config.esUrl.replace(/\/$/, '') + path, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })).json();
  try {
    const r = await es(`/${opt.index}/_search`, { size: 0, track_total_hits: true, aggs: { cards: { filter: { prefix: { encounter_id: 'card:' } } }, meetings: { cardinality: { field: 'encounter_id' } } } });
    out.elastic = { index: opt.index, passages_total: r.hits?.total?.value ?? NY, passages_on_cards: r.aggregations?.cards?.doc_count ?? NY,
      open_meeting_scopes: r.aggregations ? Math.max(0, r.aggregations.meetings.value - (r.aggregations.cards.doc_count ? 1 : 0)) : NY,
      retrieval: 'BM25 + semantic_text (.elser-2-elastic), rrf retriever', scope: 'coordinator encounter_id filter (Serverless refuses scoped keys from an API key)' };
  } catch { out.elastic = NY; }
} else out.elastic = NY;

// Dash0 / OpenTelemetry, from the spans this Mac exported (the cluster's go straight to Dash0).
const spans = [];
for (const f of opt.traces) if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n')) { try { if (l) spans.push(JSON.parse(l)); } catch { /* partial line */ } }
if (spans.length) {
  const es = spans.filter((s) => s.name.startsWith('elasticsearch '));
  const tries = spans.filter((s) => s.name === 'roloe.try' && s.attributes['roloe.time_to_green_ms'] != null).map((s) => s.attributes['roloe.time_to_green_ms'] / 1000);
  // Privacy proof: no attribute value that looks like content (long free text).
  const LABELS = new Set(['roloe.scope.mode']);   // fixed enum labels, not content
  const contentLike = spans.flatMap((s) => Object.entries(s.attributes || {})).filter(([k, v]) => !LABELS.has(k) && typeof v === 'string' && v.length > 40 && /\s\S+\s/.test(v) && !/^(GET|POST|PUT) /.test(v));
  out.dash0 = { spans_exported_here: spans.length, traces: new Set(spans.map((s) => s.traceId)).size, elasticsearch_spans: es.length,
    elasticsearch_ms_p50: pct(es.map((s) => s.durationMs), 0.5), elasticsearch_ms_p95: pct(es.map((s) => s.durationMs), 0.95),
    time_to_help_s_p50: tries.length ? pct(tries, 0.5) : NY, time_to_help_s_p95: tries.length ? pct(tries, 0.95) : NY,
    slo: '90% of passing meetings within 120 s', slo_compliance: tries.length ? `${Math.round(100 * tries.filter((t) => t <= 120).length / tries.length)}% of ${tries.length}` : NY,
    content_like_attribute_values: contentLike.length };
} else out.dash0 = NY;

out.radar = 'see Radar Cloud (deploys, rollouts, Checks): not measured by this script';
console.log(JSON.stringify(out, null, 2));
