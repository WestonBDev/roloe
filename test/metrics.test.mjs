// Metrics for the counts dashboard and the time-to-help SLO in Dash0. Attributes are outcomes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, twoCards } from './helpers.mjs';

test('meetings, findings and help outcomes are counted; time to help and to findings are histograms in seconds', async () => {
  const s = await startTestServer();
  try {
    const { collectForTest } = await import('../src/metrics.mjs');
    const { maya, wes } = await twoCards(s);
    const { body: { id } } = await s.call('POST', '/api/tap', { to: 'wes' }, maya);
    await s.call('POST', '/api/g/wes/start', {});
    await s.call('POST', `/api/e/${id}/findings`, { findings: [
      { cites: 'p-a00001', quote: 'mark the combined total partial', about: 'p-e00001', what: 'w', change: { edits: [{ file: 'a.js', find: 'a', replace: 'b' }] } },
      { cites: 'p-ffffff', quote: 'nope nope nope', what: 'w' },
    ] }, maya);
    await s.call('POST', `/api/e/${id}/findings`, { nothing_strong: true }, wes);
    const f = s.state().encounters[id].findings[0];
    await s.call('POST', `/api/e/${id}/try`, { finding: f.id, state: 'passed', passed: 4, failed: 0, test_ms: 900 }, wes);

    const m = await collectForTest();
    assert.equal(m.sum('roloe.meetings', { kind: 'pair' }), 1);
    assert.equal(m.sum('roloe.meetings', { kind: 'guest' }), 1);
    assert.equal(m.sum('roloe.findings', { outcome: 'accepted' }), 1);
    assert.equal(m.sum('roloe.findings', { outcome: 'dropped' }), 1);
    assert.equal(m.sum('roloe.findings', { outcome: 'nothing_strong' }), 1);
    assert.equal(m.sum('roloe.help', { outcome: 'passed' }), 1);
    const h = m.histogram('roloe.time_to_help');
    assert.equal(h.count, 1);
    assert.equal(h.unit, 's');
    assert.ok(h.boundaries.includes(120), 'a 120 s bucket for the SLO');
    assert.equal(m.histogram('roloe.time_to_findings').count, 1);
    for (const attrs of m.allAttributes()) for (const v of Object.values(attrs)) assert.ok(String(v).length < 20, `attribute looks like an outcome, not content: ${v}`);
  } finally { await s.close(); }
});
