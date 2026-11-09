// The recipient's approval page, end to end: real coordinator, real finding, real Docker run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startTestServer } from './helpers.mjs';
import { dockerAvailable } from '../src/tryit.mjs';
import { startTryUi } from '../src/tryit-ui.mjs';

test('approval page shows the literal diff; Approve runs the sandbox and stops the clock green', { skip: !dockerAvailable() && 'docker not available' }, async () => {
  const s = await startTestServer();
  const dir = mkdtempSync(join(tmpdir(), 'roloe-ui-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', type: 'module', scripts: { test: 'node --test' } }));
  writeFileSync(join(dir, 'add.js'), 'export const add = (a, b) => a - b;\n');
  writeFileSync(join(dir, 'test', 'add.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../add.js';\ntest('adds', () => assert.equal(add(2, 3), 5));\n");
  git('add', '.'); git('commit', '-qm', 'init');
  try {
    const reg = async (owner, passages) => {
      const { body: { key } } = await s.call('POST', '/api/owners', { owner, name: owner[0].toUpperCase() + owner.slice(1) });
      const auth = { authorization: `Bearer ${key}` };
      await s.call('POST', `/api/cards/${owner}/switch`, { on: true }, auth);
      await s.call('PUT', `/api/cards/${owner}`, { passages }, auth);
      return { auth, key };
    };
    const P = (id, text) => ({ passage_id: id, kind: 'session', speaker: 'owner', source: 's', locator: id, ts: new Date().toISOString(), text });
    const giver = await reg('gia', [P('p-a00001', 'add should sum both numbers, I had it subtracting for an hour')]);
    const me = await reg('rex', [P('p-b00001', 'add returns the wrong number for 2 and 3')]);
    const { body: { id } } = await s.call('POST', '/api/tap', { to: 'rex' }, giver.auth);
    await s.call('POST', `/api/e/${id}/findings`, { findings: [{ cites: 'p-a00001', quote: 'add should sum both numbers', about: 'p-b00001', what: 'Gia had add subtracting too.',
      change: { edits: [{ file: 'add.js', find: 'a - b', replace: 'a + b' }] } }] }, giver.auth);

    const ui = await startTryUi({ cfg: { url: s.base, key: me.key, owner: 'rex', project: dir }, encounterId: id, port: 0 });
    const page = await (await fetch(ui.url)).text();
    assert.match(page, /-export const add = \(a, b\) =&gt; a - b;/, 'literal diff, escaped');
    assert.match(page, /Change from Gia, via Roloe/);
    assert.match(page, /No network/);
    assert.equal(s.state().encounters[id].tryStatus.state, 'review');
    const approve = await fetch(ui.url + 'approve', { method: 'POST' });
    assert.equal(approve.status, 202);
    const result = await ui.done;
    assert.equal(result.state, 'passed', result.output?.slice(-500));
    const status = await (await fetch(ui.url + 'status')).json();
    assert.equal(status.state, 'passed');
    assert.equal(status.passed, 1);
    assert.ok(s.state().encounters[id].times.green);
    assert.equal(readFileSync(join(dir, 'add.js'), 'utf8'), 'export const add = (a, b) => a - b;\n', 'your project is unchanged');
    const saved = await (await fetch(ui.url + 'save', { method: 'POST' })).json();
    assert.ok(existsSync(saved.path));
    assert.match(readFileSync(saved.path, 'utf8'), /^From: Gia, via Roloe/);
    execFileSync('git', ['-C', dir, 'apply', '--check', saved.path]);
    await ui.close();
  } finally { await s.close(); }
});
