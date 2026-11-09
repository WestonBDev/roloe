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

test('a guest meeting leaves started, input-read and stopped logs on its trace, none with their words', async () => {
  const { startTestServer, twoCards, waitReady } = await import('./helpers.mjs');
  const s = await startTestServer();
  try {
    await twoCards(s);
    const words = 'my card watcher marks the refresh done before the push actually succeeds';
    const g = (await s.call('POST', '/api/g/wes/start', { text: words })).body;
    await waitReady(s, g.id, g.key);
    await s.call('POST', `/api/e/${g.id}/stop?k=${g.key}`, {});
    await flush();
    const mine = read().filter((l) => l.attributes['roloe.encounter_id'] === g.id);
    const names = mine.map((l) => l.body);
    for (const n of ['guest.input_read', 'meeting.started', 'meeting.instant_shown', 'meeting.stopped']) assert.ok(names.includes(n), `${n} in ${names}`);
    assert.equal(new Set(mine.map((l) => l.traceId)).size, 1, 'one meeting, one trace');
    assert.ok(!JSON.stringify(mine).includes('watcher'), 'no guest words in any log');
  } finally { await s.close(); }
});
