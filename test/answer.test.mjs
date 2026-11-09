// `roloe answer`: for judging, the card owner's own Claude Code answers every meeting unattended,
// one headless run per meeting, on the owner's laptop with the owner's own login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingsToAnswer, answerCommand } from '../src/answer.mjs';

const now = Date.parse('2026-11-09T16:00:00Z');
const M = (id, minAgo, extra = {}) => ({ id, status: 'open', posted: false, created: new Date(now - minAgo * 60e3).toISOString(), ...extra });

test('answers open, unposted meetings under 10 minutes old, oldest first, never one already running, at most 3 at once', () => {
  const list = [M('e-0000000005', 1), M('e-0000000001', 4), M('e-0000000002', 12), M('e-0000000003', 2, { posted: true }), M('e-0000000004', 3, { status: 'closed' }), M('e-0000000006', 0.5), M('e-0000000007', 0.2)];
  assert.deepEqual(meetingsToAnswer(list, now, new Set()), ['e-0000000001', 'e-0000000005', 'e-0000000006']);
  assert.deepEqual(meetingsToAnswer(list, now, new Set(['e-0000000001'])), ['e-0000000005', 'e-0000000006']);
  assert.deepEqual(meetingsToAnswer(list, now, new Set(['a', 'b', 'c'])), [], 'three already running');
});

test('each run is told its one meeting, gets only the four Roloe tools, and its server serves no Try it', () => {
  const { cmd, args, env } = answerCommand('e-0123456789', { bin: '/x/bin/roloe.mjs', home: '/h/.roloe', model: 'sonnet' });
  assert.equal(cmd, 'claude');
  const prompt = args[args.indexOf('-p') + 1];
  assert.match(prompt, /e-0123456789/);
  assert.match(prompt, /roloe_pull/);
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__roloe__roloe_pull,mcp__roloe__roloe_search_mine,mcp__roloe__roloe_post_findings');
  assert.ok(args.includes('--strict-mcp-config'));
  const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.roloe;
  assert.deepEqual(mcp.args, ['/x/bin/roloe.mjs', 'mcp']);
  assert.equal(mcp.env.ROLOE_GUEST_TRY, 'off', 'Try it is served by the long-lived runner, not by a run that exits');
  assert.equal(mcp.env.ROLOE_HOME, '/h/.roloe');
  assert.ok(!('ANTHROPIC_API_KEY' in env), 'no keys passed around: the owner\'s own login');
});

test('a meeting id that is not one is never put in a prompt', () => {
  assert.throws(() => answerCommand('e-1; rm -rf ~', { bin: 'b', home: 'h' }), /bad meeting id/);
});
