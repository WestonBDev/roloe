// Fallbacks so the demo works with any second person, or none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startTestServer } from './helpers.mjs';
import { replayView } from '../src/pages/roloe.js';

const run = promisify(execFile);
const BIN = new URL('../bin/roloe.mjs', import.meta.url).pathname;

function home() {
  const h = mkdtempSync(join(tmpdir(), 'roloe-fb-'));
  const project = join(h, 'proj');
  mkdirSync(project);
  const git = (...a) => execFileSync('git', ['-C', project, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(join(project, 'notes.md'), 'Retry the push before marking the refresh done.\n');
  git('add', '.'); git('commit', '-qm', 'notes');
  // Fake assistants on PATH record how they were configured.
  const bin = join(h, 'bin'); mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$@" >> "${join(h, name + '.args')}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { h, project, env: { ...process.env, HOME: h, ROLOE_HOME: join(h, '.roloe'), PATH: `${bin}:${process.env.PATH}` } };
}

test('roloe join: one command puts a card on and connects whichever assistants are installed', async () => {
  const s = await startTestServer();
  const { h, project, env } = home();
  try {
    const r = await run('node', [BIN, 'join', '--url', s.base, '--owner', 'pat', '--name', 'Pat', '--project', project], { env });
    assert.match(r.stdout, /Sharing is on/);
    assert.match(r.stdout, /roloe_wait_for_tap/);
    const claudeArgs = readFileSync(join(h, 'claude.args'), 'utf8');
    const codexArgs = readFileSync(join(h, 'codex.args'), 'utf8');
    assert.match(claudeArgs, new RegExp(`mcp add --scope user roloe -- node ${BIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} mcp`));
    assert.match(codexArgs, /mcp add roloe -- node \S+\/bin\/roloe\.mjs mcp/);
    assert.equal((await s.call('GET', '/api/cards/pat')).body.sharing, true);
  } finally { await s.close(); }
});

test('same person, two projects: only with the first card\'s key, and every screen says so', async () => {
  const s = await startTestServer();
  const { project, env } = home();
  try {
    await run('node', [BIN, 'on', '--url', s.base, '--owner', 'wes', '--name', 'Wes', '--project', project], { env });
    const wesKey = JSON.parse(readFileSync(join(env.ROLOE_HOME, 'wes.json'), 'utf8')).key;
    // Without the first card's key, nobody can claim to be the same person.
    assert.equal((await s.call('POST', '/api/owners', { owner: 'fake', same_person_as: 'wes' })).status, 403);
    const r = await run('node', [BIN, 'on', '--url', s.base, '--owner', 'wes-two', '--name', 'Wes (second project)', '--project', project, '--same-person-as', 'wes'], { env });
    assert.match(r.stdout, /same person as wes/i);
    const card = (await s.call('GET', '/api/cards/wes-two')).body;
    assert.equal(card.same_person_as, 'wes');
    const tap = await s.call('POST', '/api/tap', { to: 'wes-two' }, { authorization: `Bearer ${wesKey}` });
    const enc = s.state().encounters[tap.body.id];
    assert.equal(enc.same_person, true);
    const stage = (await s.call('GET', `/api/e/${enc.id}/stage?k=${enc.stageKey}`)).body;
    assert.equal(stage.same_person, true);
    const view = (await s.call('GET', `/api/e/${enc.id}?k=${enc.sides.wes.key}`)).body;
    assert.equal(view.same_person, true);
  } finally { await s.close(); }
});

test('replay: a recorded meeting shows only what had happened by each moment of its own clock', () => {
  const rec = {
    tap: Date.parse('2026-11-09T12:31:00Z'), a: 'wes', b: 'aiden', names: { wes: 'Wes', aiden: 'Aiden' },
    sides: { wes: { posted: true, posted_ms: 20000, top: { quote: 'q' }, more: 0, nothing_strong: false }, aiden: { posted: true, posted_ms: 9000, top: null, more: 0, nothing_strong: true } },
    live: { ready_ms: 900, first_findings_ms: 9000, all_findings_ms: 20000, green_ms: 26000 },
    try: { state: 'passed', passed: 7, test_ms: 3100 },
  };
  const at5 = replayView(rec, 5000);
  assert.equal(at5.sides.wes.posted, false);
  assert.equal(at5.sides.wes.top, null);
  assert.equal(at5.sides.aiden.posted, false);
  assert.equal(at5.try, null);
  assert.equal(at5.live.green_ms, null);
  const at10 = replayView(rec, 10000);
  assert.equal(at10.sides.aiden.nothing_strong, true);
  assert.equal(at10.sides.wes.posted, false);
  const at22 = replayView(rec, 22000);
  assert.equal(at22.sides.wes.top.quote, 'q');
  assert.equal(at22.try.state, 'testing');
  const at30 = replayView(rec, 30000);
  assert.equal(at30.try.state, 'passed');
  assert.equal(at30.live.green_ms, 26000);
  assert.equal(at30.recorded, true);
});

test('replay never shows the future: post times, seals and sealed lines appear only at their moment (Gitar)', () => {
  const tap = Date.parse('2026-11-09T12:31:00Z');
  const rec = {
    tap, a: 'wes', b: 'aiden', names: { wes: 'Wes', aiden: 'Aiden' },
    sides: {
      wes: { posted: true, posted_ms: 20000, top: { quote: 'q' }, more: 0, nothing_strong: false, seal: { hash: 'h1', ts: new Date(tap + 4000).toISOString(), line: 'help with retries' } },
      aiden: { posted: true, posted_ms: 9000, top: null, more: 0, nothing_strong: true, seal: { skipped: true, ts: new Date(tap + 3000).toISOString(), line: null } },
    },
    live: { ready_ms: 900, first_findings_ms: 9000, all_findings_ms: 20000, green_ms: null },
    try: null,
  };
  const at2 = replayView(rec, 2000);
  assert.equal(at2.sides.wes.posted_ms, null);
  assert.equal(at2.sides.wes.seal, null, 'not sealed yet at 0:02');
  const at5 = replayView(rec, 5000);
  assert.equal(at5.sides.wes.seal.hash, 'h1');
  assert.equal(at5.sides.wes.seal.line, null, 'line still sealed before the findings land');
  const at21 = replayView(rec, 21000);
  assert.equal(at21.sides.wes.seal.line, 'help with retries');
  assert.equal(at21.sides.wes.posted_ms, 20000);
});

test('replay ends after the last recorded moment, whatever it was', async () => {
  const { replayEndMs } = await import('../src/pages/roloe.js');
  assert.equal(replayEndMs({ live: { ready_ms: 900, first_findings_ms: 9000, all_findings_ms: null, green_ms: null }, sides: { a: { posted_ms: 9000 }, b: { posted_ms: null } } }), 12000);
  assert.equal(replayEndMs({ live: { ready_ms: 900, first_findings_ms: 9000, all_findings_ms: 20000, green_ms: 26000 }, sides: {} }), 29000);
});
