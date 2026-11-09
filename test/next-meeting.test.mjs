// Which meeting an assistant answers next: unanswered, open, from the last 10 minutes, oldest first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextMeeting } from '../src/mcp.mjs';

test('oldest fresh unanswered meeting first; stale or answered ones are skipped', () => {
  const now = Date.parse('2026-11-09T12:20:00Z');
  const at = (m) => new Date(now - m * 60e3).toISOString();
  const list = [
    { id: 'e-new', created: at(0.5), posted: false, status: 'open' },
    { id: 'e-mid', created: at(3), posted: false, status: 'open' },
    { id: 'e-answered', created: at(4), posted: true, status: 'open' },
    { id: 'e-stale', created: at(25), posted: false, status: 'open' },
  ];
  assert.equal(nextMeeting(list, now).id, 'e-mid');
  assert.equal(nextMeeting(list.filter((e) => e.id !== 'e-mid'), now).id, 'e-new');
  assert.equal(nextMeeting([list[2], list[3]], now), undefined);
});
