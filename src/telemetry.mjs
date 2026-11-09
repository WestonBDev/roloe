// OpenTelemetry for the coordinator. One trace per encounter; child spans for each step.
// Attributes are IDs, counts, sizes and per-encounter HMACs. Never passage text, quotes or diffs.
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { TracerProvider, SimpleSpanProcessor, BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { config } from './env.mjs';

const ExportOk = { code: 0 };

// Local JSONL exporter: always on, so the canary scan can read every exported span.
class JsonlExporter {
  constructor(file) { this.file = file; mkdirSync(dirname(file), { recursive: true }); }
  export(spans, done) {
    try {
      const lines = spans.map((s) => JSON.stringify({
        name: s.name,
        traceId: s.spanContext().traceId,
        spanId: s.spanContext().spanId,
        parentSpanId: s.parentSpanContext?.spanId,
        start: hrToMs(s.startTime),
        durationMs: Math.round(hrToMs(s.duration) * 10) / 10,
        status: s.status?.code === SpanStatusCode.ERROR ? 'error' : 'ok',
        attributes: s.attributes,
      })).join('\n') + '\n';
      appendFileSync(this.file, lines);
      done(ExportOk);
    } catch (e) { done({ code: 1, error: e }); }
  }
  shutdown() { return Promise.resolve(); }
  forceFlush() { return Promise.resolve(); }
}
const hrToMs = (hr) => (Array.isArray(hr) ? hr[0] * 1e3 + hr[1] / 1e6 : Number(hr) || 0);

export const traceFile = config.traceFile || join(config.dataDir, 'traces.jsonl');

function otlpHeaders() {
  const h = {};
  if (config.dash0Token) h.Authorization = `Bearer ${config.dash0Token}`;
  if (config.dash0Dataset) h['Dash0-Dataset'] = config.dash0Dataset;
  return h;
}

const processors = [new SimpleSpanProcessor({ exporter: new JsonlExporter(traceFile) })];
export const otlpOn = Boolean(config.otlpEndpoint);
if (otlpOn) {
  const base = config.otlpEndpoint.replace(/\/$/, '');
  const url = base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
  processors.push(new BatchSpanProcessor({
    exporter: new OTLPTraceExporter({ url, headers: otlpHeaders() }),
    scheduledDelayMillis: 1000,
  }));
}

export const provider = new TracerProvider({
  resource: resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME || 'roloe-coordinator',
    'service.version': '0.1.0',
    'deployment.environment.name': process.env.ROLOE_ENVIRONMENT || 'hackathon',
  }),
  spanProcessors: processors,
});
export const tracer = provider.getTracer('roloe', '0.1.0');

// Per-encounter HMAC keys live in memory only and are destroyed when the encounter stops.
const hmacKeys = new Map();
export function hmac(encounterId, value) {
  let key = hmacKeys.get(encounterId);
  if (!key) { key = randomBytes(32); hmacKeys.set(encounterId, key); }
  return createHmac('sha256', key).update(String(value)).digest('hex').slice(0, 16);
}
export function destroyHmacKey(encounterId) { return hmacKeys.delete(encounterId); }
export function hasHmacKey(encounterId) { return hmacKeys.has(encounterId); }

// Root span per encounter. It stays open until stop; children attach by stored span context.
const roots = new Map();
export function startEncounterTrace(encounterId, attrs = {}) {
  const span = tracer.startSpan('roloe.encounter', { attributes: { 'roloe.encounter_id': encounterId, ...attrs } });
  roots.set(encounterId, span);
  const sc = span.spanContext();
  return { traceId: sc.traceId, spanId: sc.spanId };
}
export function endEncounterTrace(encounterId, attrs = {}) {
  const span = roots.get(encounterId);
  if (!span) return;
  span.setAttributes(attrs);
  span.end();
  roots.delete(encounterId);
}

function parentContext(ref) {
  if (!ref) return context.active();
  const live = roots.get(ref.encounterId);
  if (live) return trace.setSpan(context.active(), live);
  if (ref.traceId && ref.spanId) {
    return trace.setSpanContext(context.active(), { traceId: ref.traceId, spanId: ref.spanId, traceFlags: 1, isRemote: true });
  }
  return context.active();
}

// Run fn inside a child span of the encounter. fn receives the span to add attributes.
export async function step(name, ref, attrs, fn) {
  const span = tracer.startSpan(name, { attributes: { 'roloe.encounter_id': ref?.encounterId, ...clean(attrs) } }, parentContext(ref));
  try {
    const out = await fn(span);
    span.end();
    return out;
  } catch (e) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: e?.code || e?.name || 'error' });
    span.setAttribute('error.type', e?.code || e?.name || 'error');
    span.end();
    throw e;
  }
}

// Attribute values must be primitives or arrays of them. Drop anything else rather than stringify content.
export function clean(attrs = {}) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    else if (Array.isArray(v) && v.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) out[k] = v;
  }
  return out;
}

export function requestSpan(method, route) {
  return tracer.startSpan(`${method} ${route}`, {
    kind: 1,
    attributes: { 'http.request.method': method, 'http.route': route },
  });
}

export async function flush() { await provider.forceFlush(); }
