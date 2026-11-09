import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startTestServer } from './helpers.mjs';

const run = promisify(execFile);
const BIN = new URL('../bin/roloe.mjs', import.meta.url).pathname;

function fixtureProject() {
  const home = mkdtempSync(join(tmpdir(), 'roloe-cli-'));
  const project = join(home, 'proj');
  mkdirSync(project);
  const git = (...a) => execFileSync('git', ['-C', project, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(join(project, 'notes.md'), 'Cache the card for offline use. Contact: dev@example.com\n');
  git('add', '.'); git('commit', '-qm', 'Offline card cache');
  return { home, project };
}

test('roloe on registers, uploads a scrubbed card, and keeps the key and removed values local', async () => {
  const s = await startTestServer();
  const { home, project } = fixtureProject();
  const env = { ...process.env, HOME: home, ROLOE_HOME: join(home, '.roloe') };
  try {
    const on = await run('node', [BIN, 'on', '--url', s.base, '--owner', 'tess', '--name', 'Tess', '--project', project], { env });
    assert.match(on.stdout, /Sharing is on/);
    assert.match(on.stdout, /passages/);
    assert.ok(!on.stdout.includes('rk_'), 'the card key is never printed by `on`');
    const cfgPath = join(home, '.roloe', 'tess.json');
    assert.equal(statSync(cfgPath).mode & 0o777, 0o600);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.match(cfg.key, /^rk_/);
    assert.deepEqual(cfg.removed, ['dev@example.com']);

    const shared = await s.call('GET', '/api/cards/tess/passages', null, { authorization: `Bearer ${cfg.key}` });
    assert.ok(shared.body.passages.length >= 2);
    assert.ok(!JSON.stringify(shared.body).includes('dev@example.com'));

    // show prints exactly what is on the card, from the coordinator.
    const show = await run('node', [BIN, 'show', '--owner', 'tess'], { env });
    for (const p of shared.body.passages) assert.ok(show.stdout.includes(p.passage_id), p.passage_id);
    assert.match(show.stdout, /\[removed: email\]/);

    // private takes a passage off the card at once.
    const pid = shared.body.passages[0].passage_id;
    await run('node', [BIN, 'private', pid, '--owner', 'tess'], { env });
    const after = await s.call('GET', '/api/cards/tess/passages', null, { authorization: `Bearer ${cfg.key}` });
    assert.ok(!after.body.passages.some((p) => p.passage_id === pid));

    const off = await run('node', [BIN, 'off', '--owner', 'tess'], { env });
    assert.match(off.stdout, /Sharing is off/);
    assert.equal((await s.call('GET', '/api/cards/tess')).body.passages, 0);
  } finally { await s.close(); }
});

test('roloe canary writes a never-shared file, registers it, and the gate then blocks it', async () => {
  const s = await startTestServer();
  const { home, project } = fixtureProject();
  const env = { ...process.env, HOME: home, ROLOE_HOME: join(home, '.roloe') };
  try {
    await run('node', [BIN, 'on', '--url', s.base, '--owner', 'tess', '--name', 'Tess', '--project', project], { env });
    const c = await run('node', [BIN, 'canary', '--owner', 'tess'], { env });
    const value = c.stdout.match(/canary-[A-Z0-9]{20}/)[0];
    const file = c.stdout.match(/written to (\S+)/)[1];
    assert.ok(!file.startsWith(project), 'outside the shared project');
    assert.equal(readFileSync(file, 'utf8').trim(), value);
    assert.ok(s.state().canaries.includes(value));
    const cfg = JSON.parse(readFileSync(join(home, '.roloe', 'tess.json'), 'utf8'));
    assert.ok(cfg.removed.includes(value), 'the local gate knows it too');
    // stop from the CLI ends a meeting for both sides
    const { body: { key } } = await s.call('POST', '/api/owners', { owner: 'otto' });
    await s.call('POST', '/api/cards/otto/switch', { on: true }, { authorization: `Bearer ${key}` });
    const tap = await s.call('POST', '/api/tap', { to: 'otto' }, { authorization: `Bearer ${cfg.key}` });
    const stop = await run('node', [BIN, 'stop', tap.body.id, '--owner', 'tess'], { env });
    assert.match(stop.stdout, /Stopped/);
    assert.match(stop.stdout, /query with the old key returns 0/);
    assert.equal(s.state().encounters[tap.body.id].status, 'closed');
  } finally { await s.close(); }
});
