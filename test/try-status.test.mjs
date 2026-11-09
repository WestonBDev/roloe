import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, twoCards } from './helpers.mjs';

test('Try it status: only the recipient reports; passed stops the clock and thanks the giver with the real count', async () => {
  const s = await startTestServer();
  try {
    const { maya, wes } = await twoCards(s);
    const { body: { id } } = await s.call('POST', '/api/tap', { to: 'wes' }, maya);
    await s.call('POST', `/api/e/${id}/findings`, { findings: [{ cites: 'p-a00001', quote: 'mark the combined total partial', about: 'p-e00001', what: 'w',
      change: { edits: [{ file: 'src/w.js', find: 'a', replace: 'b' }] } }] }, maya);
    const f = s.state().encounters[id].findings[0];
    assert.equal((await s.call('POST', `/api/e/${id}/try`, { finding: f.id, state: 'review' }, maya)).status, 403, 'the giver can\'t report the recipient\'s run');
    assert.equal((await s.call('POST', `/api/e/${id}/try`, { finding: 'f-nope', state: 'review' }, wes)).status, 404);
    assert.equal((await s.call('POST', `/api/e/${id}/try`, { finding: f.id, state: 'exploded' }, wes)).status, 400);
    for (const st of ['review', 'installing', 'testing']) assert.equal((await s.call('POST', `/api/e/${id}/try`, { finding: f.id, state: st }, wes)).status, 200);
    assert.equal(s.state().encounters[id].tryStatus.state, 'testing');
    assert.equal(s.state().encounters[id].times.green, null);
    await s.call('POST', `/api/e/${id}/try`, { finding: f.id, state: 'passed', passed: 7, failed: 0, test_ms: 1234, sandbox: 'docker --network none' }, wes);
    const enc = s.state().encounters[id];
    assert.ok(enc.times.green >= enc.times.tap);
    assert.equal(enc.thanks.length, 1);
    assert.deepEqual({ to: enc.thanks[0].to, finding: enc.thanks[0].finding, tests: enc.thanks[0].tests_passed }, { to: 'maya', finding: f.id, tests: 7 });
    const mayaView = await s.call('GET', `/api/e/${id}?k=${enc.sides.maya.key}`);
    assert.equal(mayaView.body.thanks[0].tests_passed, 7);
    assert.ok(mayaView.body.given[0].helped);
    // A later run doesn't reset the clock.
    await s.call('POST', `/api/e/${id}/try`, { finding: f.id, state: 'failed', passed: 0, failed: 1 }, wes);
    assert.equal(s.state().encounters[id].times.green, enc.times.green);
  } finally { await s.close(); }
});

test('the sandbox label in telemetry is a fixed value, never client text (Gitar)', async () => {
  const s = await startTestServer();
  try {
    const { maya, wes } = await twoCards(s);
    const { body: { id } } = await s.call('POST', '/api/tap', { to: 'wes' }, maya);
    await s.call('POST', `/api/e/${id}/findings`, { findings: [{ cites: 'p-a00001', quote: 'mark the combined total partial', about: 'p-e00001', what: 'w', change: { edits: [{ file: 'a.js', find: 'a', replace: 'b' }] } }] }, maya);
    const f = s.state().encounters[id].findings[0];
    await s.call('POST', `/api/e/${id}/try`, { finding: f.id, state: 'failed', sandbox: 'free text from the client' }, wes);
    assert.equal(s.state().encounters[id].tryStatus.sandbox, 'other');
    await s.call('POST', `/api/e/${id}/try`, { finding: f.id, state: 'passed', passed: 1, sandbox: 'docker-network-none' }, wes);
    assert.equal(s.state().encounters[id].tryStatus.sandbox, 'docker-network-none');
  } finally { await s.close(); }
});
