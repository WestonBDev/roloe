import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { copyProject, applyEdits, literalDiff, parseCounts, verdict, dockerAvailable, runSandboxed, patchText } from '../src/tryit.mjs';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'roloe-try-src-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', type: 'module', scripts: { test: 'node --test' } }));
  writeFileSync(join(dir, 'src', 'add.js'), 'export const add = (a, b) => a - b;\n');
  writeFileSync(join(dir, 'test', 'add.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../src/add.js';\ntest('adds', () => assert.equal(add(2, 3), 5));\ntest('net is off', async () => { await assert.rejects(fetch('https://example.com', { signal: AbortSignal.timeout(3000) })); });\n");
  writeFileSync(join(dir, '.env'), 'SECRET=never-copied-123\n');
  writeFileSync(join(dir, '.gitignore'), '.env\nnode_modules\n');
  git('add', '.'); git('commit', '-qm', 'init');
  writeFileSync(join(dir, 'src', 'extra.js'), 'export const x = 1;\n'); // untracked but not ignored: what the card showed
  return dir;
}

test('copy takes tracked and unignored files only, under the home folder (Colima shares only ~)', () => {
  const src = project();
  const copy = copyProject(src, 'e-test');
  try {
    assert.ok(copy.startsWith(homedir()));
    assert.ok(existsSync(join(copy, 'src', 'add.js')));
    assert.ok(existsSync(join(copy, 'src', 'extra.js')));
    assert.ok(!existsSync(join(copy, '.env')), '.env is never copied');
  } finally { execFileSync('rm', ['-rf', copy]); }
});

test('each edit must match exactly once; the diff is literal git output', () => {
  const src = project();
  const copy = copyProject(src, 'e-test');
  try {
    assert.deepEqual(applyEdits(copy, [{ file: 'src/add.js', find: 'nope', replace: 'x' }]), { ok: false, reason: 'src/add.js: find text not found' });
    writeFileSync(join(copy, 'src', 'dup.js'), 'a\na\n');
    assert.equal(applyEdits(copy, [{ file: 'src/dup.js', find: 'a', replace: 'b' }]).reason, 'src/dup.js: find text matches 2 times');
    assert.equal(applyEdits(copy, [{ file: '../escape.js', find: 'a', replace: 'b' }]).ok, false);
    assert.equal(applyEdits(copy, [{ file: 'missing.js', find: 'a', replace: 'b' }]).reason, 'missing.js: no such file');
    assert.deepEqual(applyEdits(copy, [{ file: 'src/add.js', find: 'a - b', replace: 'a + b' }]), { ok: true, files: ['src/add.js'] });
    const diff = literalDiff(copy);
    assert.match(diff, /^diff --git a\/src\/add\.js b\/src\/add\.js/m);
    assert.match(diff, /^-export const add = \(a, b\) => a - b;$/m);
    assert.match(diff, /^\+export const add = \(a, b\) => a \+ b;$/m);
    assert.equal(readFileSync(join(src, 'src', 'add.js'), 'utf8'), 'export const add = (a, b) => a - b;\n', 'the real project is unchanged');
    const patch = patchText(diff, { giver: 'Maya', finding: 'f-1', cites: 'p-abcdef' });
    assert.match(patch, /^From: Maya, via Roloe \(finding f-1, cites p-abcdef\)/);
  } finally { execFileSync('rm', ['-rf', copy]); }
});

test('green means exit 0 AND at least one test ran', () => {
  assert.deepEqual(parseCounts('# tests 2\n# pass 2\n# fail 0\n'), { passed: 2, failed: 0 });
  assert.deepEqual(parseCounts('Tests:       1 failed, 5 passed, 6 total'), { passed: 5, failed: 1 });
  assert.deepEqual(parseCounts(' Tests  7 passed (7)'), { passed: 7, failed: 0 });
  assert.deepEqual(parseCounts('===== 3 passed, 1 failed in 0.1s ====='), { passed: 3, failed: 1 });
  assert.equal(verdict(0, { passed: 2, failed: 0 }), 'passed');
  assert.equal(verdict(0, { passed: 0, failed: 0 }), 'failed', 'zero tests is not green');
  assert.equal(verdict(0, { passed: null, failed: null }), 'failed');
  assert.equal(verdict(1, { passed: 5, failed: 1 }), 'failed');
});

test('sandboxed run: deps with network, tests with --network none, no env, copy deleted', { skip: !dockerAvailable() && 'docker not available' }, async () => {
  const src = project();
  const copy = copyProject(src, 'e-test');
  applyEdits(copy, [{ file: 'src/add.js', find: 'a - b', replace: 'a + b' }]);
  process.env.ROLOE_TEST_LEAK = 'host-env-must-not-reach-the-container';
  const events = [];
  const r = await runSandboxed(copy, { onState: (s) => events.push(s) });
  assert.equal(r.state, 'passed', r.output.slice(-800));
  assert.equal(r.passed, 2);
  assert.ok(r.test_ms > 0);
  assert.deepEqual(events, ['installing', 'testing', 'passed']);
  assert.ok(!r.output.includes('host-env-must-not-reach'));
  assert.ok(!existsSync(copy), 'throwaway copy deleted');
});
