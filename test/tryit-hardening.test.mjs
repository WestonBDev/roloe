// Try it hardening (Gitar review of step 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyProject, applyEdits, literalDiff, parseCounts, plan, dockerAvailable, runSandboxed, dockerEnv } from '../src/tryit.mjs';
import { safePath } from '../src/checks.mjs';

function repo(files, { attrs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roloe-th-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); }
  if (attrs) writeFileSync(join(dir, '.gitattributes'), attrs);
  return { dir, git };
}

test('symlinks are never copied, so an edit can\'t write through one into the real project', () => {
  const { dir, git } = repo({ 'real.js': 'export const a = 1;\n' });
  symlinkSync('real.js', join(dir, 'link.js'));
  git('add', '.'); git('commit', '-qm', 'x');
  const copy = copyProject(dir, 'e-sym');
  try {
    assert.ok(!existsSync(join(copy, 'link.js')));
    assert.equal(applyEdits(copy, [{ file: 'link.js', find: '1', replace: '2' }]).ok, false);
    assert.equal(readFileSync(join(dir, 'real.js'), 'utf8'), 'export const a = 1;\n');
  } finally { execFileSync('rm', ['-rf', copy]); }
});

test('git attribute files can\'t be edited, and the diff is literal even with -diff attributes', () => {
  for (const p of ['.gitattributes', 'sub/.gitattributes', '.gitmodules', '.git/config']) assert.equal(safePath(p), false, p);
  assert.equal(safePath('.github/workflows/ci.yml'), true);
  const { dir, git } = repo({ 'a.js': 'const x = 1;\n' }, { attrs: '*.js -diff\n' });
  git('add', '.'); git('commit', '-qm', 'x');
  const copy = copyProject(dir, 'e-attr');
  try {
    applyEdits(copy, [{ file: 'a.js', find: '1', replace: '2' }]);
    const d = literalDiff(copy);
    assert.ok(!/Binary files/.test(d), d);
    assert.match(d, /^\+const x = 2;$/m);
  } finally { execFileSync('rm', ['-rf', copy]); }
});

test('python projects install only their requirements, never build the project with the network on', () => {
  const { dir } = repo({ 'pyproject.toml': '[project]\nname = "x"\n', 'setup.py': 'print(1)\n' });
  const p = plan(dir);
  assert.ok(!/(^|\s)\.(\s|$)/.test(p.install), p.install);
  assert.ok(!/setup\.py/.test(p.install));
});

test('pytest "N failed, M passed" counts both', () => {
  assert.deepEqual(parseCounts('==== 1 failed, 3 passed in 0.21s ===='), { passed: 3, failed: 1 });
  assert.deepEqual(parseCounts('==== 3 passed, 1 failed in 0.21s ===='), { passed: 3, failed: 1 });
});

test('containers run as this user, and a timeout removes the container itself', { skip: !dockerAvailable() && 'docker not available' }, async () => {
  const { dir, git } = repo({ 'package.json': JSON.stringify({ name: 'p', scripts: { test: 'id -u > uid.txt; cp uid.txt /tmp/x; sleep 300' } }) });
  git('add', '.'); git('commit', '-qm', 'x');
  const copy = copyProject(dir, 'e-to');
  const before = Date.now();
  const r = await runSandboxed(copy, { testTimeoutMs: 4000, keepCopy: true });
  assert.ok(Date.now() - before < 60000);
  assert.equal(r.state, 'failed');
  assert.equal(readFileSync(join(copy, 'uid.txt'), 'utf8').trim(), String(process.getuid()));
  const ps = spawnSync('docker', ['ps', '-q', '--filter', `name=${r.container}`], { env: dockerEnv(), encoding: 'utf8' });
  assert.equal(ps.stdout.trim(), '', 'container removed on timeout');
  execFileSync('rm', ['-rf', copy]);
});
