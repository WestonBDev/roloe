// Send one test span over OTLP with the .env values and print whether the collector accepted it.
//   node scripts/otlp-check.mjs
import { config } from '../src/env.mjs';
import { TracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

if (!config.otlpEndpoint) { console.log('OTEL_EXPORTER_OTLP_ENDPOINT is not set.'); process.exit(1); }
const base = config.otlpEndpoint.replace(/\/$/, '');
const headers = {};
if (config.dash0Token) headers.Authorization = `Bearer ${config.dash0Token}`;
if (config.dash0Dataset) headers['Dash0-Dataset'] = config.dash0Dataset;
const exporter = new OTLPTraceExporter({ url: base.endsWith('/v1/traces') ? base : `${base}/v1/traces`, headers });
const result = await new Promise((resolve) => {
  const capture = { export: (spans, cb) => exporter.export(spans, (r) => { resolve(r); cb(r); }), shutdown: () => exporter.shutdown(), forceFlush: () => Promise.resolve() };
  const provider = new TracerProvider({ resource: resourceFromAttributes({ 'service.name': 'roloe-otlp-check' }), spanProcessors: [new SimpleSpanProcessor({ exporter: capture })] });
  provider.getTracer('check').startSpan('roloe.otlp_check', { attributes: { 'roloe.check': true } }).end();
});
console.log(result.code === 0 ? 'Accepted by the OTLP endpoint.' : `Rejected: ${result.error?.message || result.code}`);
await exporter.shutdown();

// Metrics too: collect one batch and send it to /v1/metrics.
const { MeterProvider, MetricReader } = await import('@opentelemetry/sdk-metrics');
const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
class Manual extends MetricReader { async onForceFlush() {} async onShutdown() {} }
const reader = new Manual();
const mp = new MeterProvider({ resource: resourceFromAttributes({ 'service.name': 'roloe-otlp-check' }), readers: [reader] });
mp.getMeter('check').createCounter('roloe.otlp_check').add(1);
const { resourceMetrics } = await reader.collect();
const mexp = new OTLPMetricExporter({ url: `${base.replace(/\/v1\/traces$/, '')}/v1/metrics`, headers });
const mres = await new Promise((r) => mexp.export(resourceMetrics, r));
console.log(mres.code === 0 ? 'Metrics accepted by the OTLP endpoint.' : `Metrics rejected: ${mres.error?.message || mres.code}`);
await mexp.shutdown();
