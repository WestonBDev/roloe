// Meeting events are OpenTelemetry log records carrying the meeting's trace ID, so Dash0 links each
// log line to its trace. The body is a fixed event name and the attributes are labels: never content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import './helpers.mjs';
import { step, startEncounterTrace, flush, logEvent, logFile } from '../src/telemetry.mjs';

const read = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('a log inside a step carries that step\'s span; outside, the meeting\'s root span', async () => {
  const trace = startEncounterTrace('e-log0000001');
  const ref = { encounterId: 'e-log0000001', ...trace };
  let stepSpanId;
  await step('roloe.overlap', ref, {}, async (span) => {
    stepSpanId = span.spanContext().spanId;
    logEvent('meeting.findings_posted', { ref, attrs: { 'roloe.findings': 2 } });
  });
  logEvent('meeting.stopped', { ref, severity: 'WARN', attrs: { 'roloe.reason': 'stop', text: { not: 'a label' } } });
  await flush();
  const logs = read().filter((l) => l.attributes['roloe.encounter_id'] === 'e-log0000001');
  const posted = logs.find((l) => l.body === 'meeting.findings_posted');
  assert.ok(posted, JSON.stringify(logs));
  assert.equal(posted.traceId, trace.traceId);
  assert.equal(posted.spanId, stepSpanId);
  assert.equal(posted.severity, 'INFO');
  assert.equal(posted.attributes['roloe.findings'], 2);
  const stopped = logs.find((l) => l.body === 'meeting.stopped');
  assert.equal(stopped.traceId, trace.traceId);
  assert.equal(stopped.spanId, trace.spanId);
  assert.equal(stopped.severity, 'WARN');
  assert.equal(stopped.attributes.text, undefined, 'objects are dropped, not stringified');
});

test('only known event names are logged, so free text can never become a log body', async () => {
  assert.throws(() => logEvent('the guest said something private', {}), /unknown log event/);
});
