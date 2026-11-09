// OpenTelemetry metrics for the counts dashboard and the time-to-help SLO in Dash0.
// Attributes are outcomes and kinds only, never IDs of people or content.
import { MeterProvider, PeriodicExportingMetricReader, MetricReader, AggregationType } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { config } from './env.mjs';

// Buckets in seconds; 120 is the SLO threshold (tap to working help within two minutes).
const HELP_BUCKETS = [10, 20, 30, 45, 60, 90, 120, 180, 300, 600];

class TestReader extends MetricReader {
  async onForceFlush() {}
  async onShutdown() {}
}
const testReader = new TestReader();
const readers = [testReader];
if (config.otlpEndpoint) {
  const base = config.otlpEndpoint.replace(/\/$/, '').replace(/\/v1\/traces$/, '');
  const headers = {};
  if (config.dash0Token) headers.Authorization = `Bearer ${config.dash0Token}`;
  if (config.dash0Dataset) headers['Dash0-Dataset'] = config.dash0Dataset;
  readers.push(new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics`, headers }), exportIntervalMillis: 10000 }));
}

const provider = new MeterProvider({
  resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || 'roloe-coordinator', 'deployment.environment.name': process.env.ROLOE_ENVIRONMENT || 'hackathon' }),
  readers,
  views: [
    { instrumentName: 'roloe.time_to_help', aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: HELP_BUCKETS } } },
    { instrumentName: 'roloe.time_to_findings', aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: HELP_BUCKETS } } },
  ],
});
const meter = provider.getMeter('roloe', '0.1.0');

const meetings = meter.createCounter('roloe.meetings', { description: 'Meetings started (taps)' });
const findings = meter.createCounter('roloe.findings', { description: 'Findings by outcome' });
const help = meter.createCounter('roloe.help', { description: 'Try it outcomes' });
const timeToHelp = meter.createHistogram('roloe.time_to_help', { unit: 's', description: 'Tap to Try it passed' });
const timeToFindings = meter.createHistogram('roloe.time_to_findings', { unit: 's', description: 'Tap to the first side posting' });

export const record = {
  meeting(kind) { meetings.add(1, { kind }); },
  findings(outcome, n = 1) { if (n > 0) findings.add(n, { outcome }); },
  help(outcome) { help.add(1, { outcome }); },
  timeToHelp(ms) { timeToHelp.record(ms / 1000); },
  timeToFindings(ms) { timeToFindings.record(ms / 1000); },
};

export async function flushMetrics() { await provider.forceFlush().catch(() => {}); }

// Test helper: read the current values without any exporter.
export async function collectForTest() {
  const { resourceMetrics } = await testReader.collect();
  const metrics = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
  const find = (name) => metrics.find((m) => m.descriptor.name === name);
  const match = (attrs, want) => Object.entries(want).every(([k, v]) => attrs[k] === v);
  return {
    sum(name, want = {}) { return (find(name)?.dataPoints || []).filter((p) => match(p.attributes, want)).reduce((n, p) => n + p.value, 0); },
    histogram(name) {
      const m = find(name);
      const p = m?.dataPoints?.[0];
      return { count: p?.value.count || 0, unit: m?.descriptor.unit, boundaries: p?.value.buckets.boundaries || [] };
    },
    allAttributes() { return metrics.flatMap((m) => m.dataPoints.map((p) => p.attributes)); },
  };
}
