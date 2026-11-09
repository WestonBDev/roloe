// Each meeting leaves one metadata record (IDs, counts, times, outcomes) in the store, so an
// organizer can see how the conference is going without any access to what people shared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, twoCards } from './helpers.mjs';
import { meetingRecord, MEETING_FIELDS } from '../src/meeting-record.mjs';

test('a meeting record holds only the listed metadata fields, never names, keys, links or text', () => {
  const enc = {
    id: 'e-0123456789', a: 'maya', b: 'guest-abc', names: { maya: 'Maya', 'guest-abc': 'Guest' }, guest: { kind: 'text', link: 'https://example.com/private' },
    same_person: false, status: 'open', stageKey: 'stk_secret', sides: { maya: { key: 'sk_secret', posted: true } },
    findings: [{ id: 'f1', what: 'private finding text', quote: 'private quote' }], dropped: [{ reason: 'x' }],
    tries: [{ finding: 'f1', state: 'passed' }], times: { tap: 1000, first_findings: 15000, green: 61000 }, closed: null,
  };
  const r = meetingRecord(enc, 70000);
  assert.deepEqual(Object.keys(r).sort(), [...MEETING_FIELDS].sort());
  assert.deepEqual(r, {
    meeting_id: 'e-0123456789', kind: 'guest', started_at: new Date(1000).toISOString(), updated_at: new Date(70000).toISOString(),
    findings_accepted: 1, findings_dropped: 1, nothing_strong: false, time_to_findings_s: 14, try_state: 'passed', time_to_help_s: 60, stopped: false,
  });
  const flat = JSON.stringify(r);
  for (const secret of ['Maya', 'maya', 'sk_secret', 'stk_secret', 'private', 'example.com']) assert.ok(!flat.includes(secret), `${secret} must not be in the record`);
});

test('a tap, and a stop, each update the meeting record in the store', async () => {
  const s = await startTestServer();
  try {
    const { maya } = await twoCards(s);
    const { body: { id } } = await s.call('POST', '/api/tap', { to: 'wes' }, maya);
    await new Promise((r) => setTimeout(r, 30));
    const rec = (await s.store.listMeetings()).find((m) => m.meeting_id === id);
    assert.equal(rec.kind, 'pair');
    assert.equal(rec.stopped, false);
    assert.equal(rec.findings_accepted, 0);
    await s.call('POST', `/api/e/${id}/stop?k=${s.state().encounters[id].sides.maya.key}`);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await s.store.listMeetings()).find((m) => m.meeting_id === id).stopped, true);
  } finally { await s.close(); }
});

test('a guest meeting stopped while it is still opening leaves a record, marked stopped (Gitar)', async () => {
  const s = await startTestServer();
  try {
    await twoCards(s);
    const http = await import('node:http');
    const { buildApp } = await import('../src/coordinator.mjs');
    // A guest reader that never finishes in time keeps the meeting in "preparing".
    const app = buildApp({ store: s.store, guestReader: () => new Promise((r) => setTimeout(() => r({ kind: 'text', passages: [] }), 1500)) });
    const srv = http.createServer(app.handle);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const g = await (await fetch(`${base}/api/g/wes/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link: 'https://example.com/slow' }) })).json();
    const stop = await fetch(`${base}/api/e/${g.id}/stop?k=${g.key}`, { method: 'POST' });
    assert.equal((await stop.json()).before_open, true);
    await new Promise((r) => setTimeout(r, 30));
    const rec = (await s.store.listMeetings()).find((m) => m.meeting_id === g.id);
    assert.ok(rec, 'the stopped meeting has a record');
    assert.equal(rec.stopped, true);
    assert.equal(rec.kind, 'guest');
    srv.close();
  } finally { await s.close(); }
});
