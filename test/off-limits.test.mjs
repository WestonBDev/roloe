// "Off-limits, always": names, clients or topics the owner lists never reach the card, Elastic or a finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startTestServer } from './helpers.mjs';
import { applyOffLimits } from '../src/scrub.mjs';
import { gate } from '../src/gate.mjs';

const run = promisify(execFile);
const BIN = new URL('../bin/roloe.mjs', import.meta.url).pathname;

test('off-limits terms are removed whole-word and case-insensitively; the gate blocks them', () => {
  const r = applyOffLimits('Met Aiden and AIDEN-team; aidenville stays. Client: Globex Corp.', ['Aiden', 'Globex Corp']);
  assert.equal(r.text, 'Met [removed: off-limits] and [removed: off-limits]-team; aidenville stays. Client: [removed: off-limits].');
  assert.equal(r.count, 3);
  assert.equal(gate('a finding mentioning aiden', [], ['Aiden']).ok, false);
  assert.equal(gate('a finding about aidenville', [], ['Aiden']).ok, true);
});

test('roloe off-limits: the terms never reach the coordinator, and a finding with one is blocked locally', async () => {
  const s = await startTestServer();
  const home = mkdtempSync(join(tmpdir(), 'roloe-ol-'));
  const project = join(home, 'proj');
  mkdirSync(project);
  const git = (...a) => execFileSync('git', ['-C', project, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(join(project, 'notes.md'), 'Paired with Claire on the retry logic for the Globex Corp deploy.\n');
  git('add', '.'); git('commit', '-qm', 'notes');
  const env = { ...process.env, HOME: home, ROLOE_HOME: join(home, '.roloe') };
  try {
    await run('node', [BIN, 'on', '--url', s.base, '--owner', 'olga', '--name', 'Olga', '--project', project], { env });
    const out = await run('node', [BIN, 'off-limits', 'add', 'Claire', 'Globex Corp'], { env });
    assert.match(out.stdout, /2 off-limits terms/);
    const cfg = JSON.parse(readFileSync(join(home, '.roloe', 'olga.json'), 'utf8'));
    const card = await s.call('GET', '/api/cards/olga/passages', null, { authorization: `Bearer ${cfg.key}` });
    const all = JSON.stringify(card.body);
    assert.ok(!/claire|globex/i.test(all), 'not on the card, not in the store');
    assert.match(all, /\[removed: off-limits\]/);
    const list = await run('node', [BIN, 'off-limits', 'list'], { env });
    assert.match(list.stdout, /Claire/);
  } finally { await s.close(); }
});
