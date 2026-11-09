// Guest Try it: the giver's laptop prepares the literal diff on the guest's public repo, the guest
// approves on their phone, the giver's laptop runs the guest's tests with no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, twoCards, waitReady } from './helpers.mjs';

async function guestRepoMeeting(s) {
  const { buildApp } = await import('../src/coordinator.mjs');
  const app = buildApp({ store: s.store, guestReader: async () => ({ kind: 'github', repo: 'https://github.com/acme/widgets', ref: 'main', path: 'pkg', files: 1, error: null,
    passages: [{ passage_id: 'p-b00001', kind: 'file', speaker: '', source: 'pkg/retry.js', locator: 'pkg/retry.js:L1-3', ts: new Date().toISOString(), text: 'export const retry = (fn) => fn(); // no backoff' }] }) });
  const srv = http.createServer(app.handle);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, path, body, headers = {}) => { const r = await fetch(base + path, { method: m, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const g = (await call('POST', '/api/g/wes/start', { link: 'https://github.com/acme/widgets/tree/main/pkg' })).body;
  for (let i = 0; i < 100 && (await call('GET', `/api/e/${g.id}?k=${g.key}`)).body.status === 'preparing'; i++) await new Promise((r) => setTimeout(r, 20));
  return { call, g, base, close: () => srv.close() };
}

test('guest Try it: job → literal diff on the phone → guest approves → giver runs → green and thanks', async () => {
  const s = await startTestServer();
  try {
    const { wes } = await twoCards(s);
    const m = await guestRepoMeeting(s);
    const { g, call } = m;
    await call('POST', `/api/e/${g.id}/findings`, { findings: [{ cites: 'p-e00001', quote: 'card watcher records refresh as done', about: 'p-b00001', what: 'Add backoff.',
      change: { edits: [{ file: 'pkg/retry.js', find: 'fn()', replace: 'withBackoff(fn)' }] } }] }, wes);
    let jobs = (await call('GET', '/api/me/try-jobs', null, wes)).body.jobs;
    assert.equal(jobs.length, 1);
    assert.deepEqual({ repo: jobs[0].repo, ref: jobs[0].ref, path: jobs[0].path, state: jobs[0].state }, { repo: 'https://github.com/acme/widgets', ref: 'main', path: 'pkg', state: 'diff-pending' });
    const f = jobs[0].finding;
    // The guest can't approve before there is a diff to read.
    assert.equal((await call('POST', `/api/e/${g.id}/try-approve?k=${g.key}`, { finding: f })).status, 409);
    const diff = 'diff --git a/pkg/retry.js b/pkg/retry.js\n-export const retry = (fn) => fn();\n+export const retry = (fn) => withBackoff(fn);\n';
    await call('POST', `/api/e/${g.id}/guest-try`, { finding: f, state: 'review', diff, test_command: 'npm test' }, wes);
    let view = (await call('GET', `/api/e/${g.id}?k=${g.key}`)).body;
    assert.equal(view.findings[0].try.state, 'review');
    assert.equal(view.findings[0].try.diff, diff, 'the literal diff, on the phone');
    assert.equal((await call('POST', `/api/e/${g.id}/try-approve?k=wrong`, { finding: f })).status, 401);
    assert.equal((await call('POST', `/api/e/${g.id}/try-approve?k=${g.key}`, { finding: f })).status, 200);
    jobs = (await call('GET', '/api/me/try-jobs', null, wes)).body.jobs;
    assert.equal(jobs[0].state, 'approved');
    for (const st of ['installing', 'testing']) await call('POST', `/api/e/${g.id}/guest-try`, { finding: f, state: st }, wes);
    await call('POST', `/api/e/${g.id}/guest-try`, { finding: f, state: 'passed', passed: 6, failed: 0, test_ms: 2100 }, wes);
    view = (await call('GET', `/api/e/${g.id}?k=${g.key}`)).body;
    assert.equal(view.findings[0].try.state, 'passed');
    assert.equal(view.findings[0].try.passed, 6);
    assert.ok(view.times.green);
    assert.equal(s.state().encounters[g.id].thanks[0].to, 'wes');
    assert.equal((await call('GET', '/api/me/try-jobs', null, wes)).body.jobs.length, 0, 'done jobs leave the queue');
    m.close();
  } finally { await s.close(); }
});

test('guest Try it is honest: no tests means "no tests to run", never green; only the giver reports, only the guest approves', async () => {
  const s = await startTestServer();
  try {
    const { wes, aiden } = await twoCards(s);
    const m = await guestRepoMeeting(s);
    const { g, call } = m;
    await call('POST', `/api/e/${g.id}/findings`, { findings: [{ cites: 'p-e00001', quote: 'card watcher records refresh as done', about: 'p-b00001', what: 'w', change: { edits: [{ file: 'pkg/retry.js', find: 'fn()', replace: 'x' }] } }] }, wes);
    const f = (await call('GET', '/api/me/try-jobs', null, wes)).body.jobs[0].finding;
    assert.equal((await call('POST', `/api/e/${g.id}/guest-try`, { finding: f, state: 'passed', passed: 1 }, aiden)).status, 403, 'not their meeting');
    assert.equal((await call('POST', `/api/e/${g.id}/guest-try`, { finding: f, state: 'passed', passed: 1 }, wes)).status, 409, 'nothing approved yet: can\'t be green');
    await call('POST', `/api/e/${g.id}/guest-try`, { finding: f, state: 'no-tests', diff: 'diff --git a/x b/x\n' }, wes);
    const v = (await call('GET', `/api/e/${g.id}?k=${g.key}`)).body;
    assert.equal(v.findings[0].try.state, 'no-tests');
    assert.equal(v.times.green, null);
    assert.equal((await call('POST', `/api/e/${g.id}/try-approve?k=${g.key}`, { finding: f })).status, 409, 'nothing to run');
    m.close();
  } finally { await s.close(); }
});

test('the giver\'s runner: clone, apply, literal diff, then the guest\'s own tests with no network', { skip: !(await import('../src/tryit.mjs')).dockerAvailable() && 'docker not available' }, async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, cpSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { runGuestTryOnce } = await import('../src/guest-try.mjs');
  const src = mkdtempSync(join(tmpdir(), 'roloe-gsrc-'));
  const git = (...a) => execFileSync('git', ['-C', src, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  mkdirSync(join(src, 'pkg', 'test'), { recursive: true });
  writeFileSync(join(src, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg', type: 'module', scripts: { test: 'node --test' } }));
  writeFileSync(join(src, 'pkg', 'retry.js'), 'export const retry = (fn) => fn();\n');
  writeFileSync(join(src, 'pkg', 'test', 'retry.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { retry } from '../retry.js';\ntest('retries', () => assert.equal(retry(() => 2), 2));\n");
  git('add', '.'); git('commit', '-qm', 'init');
  const clone = async (job, dest) => { cpSync(src, dest, { recursive: true }); };   // stands in for git clone --depth 1 of a public repo

  const s = await startTestServer();
  try {
    const { wes } = await twoCards(s);
    const m = await guestRepoMeeting(s);
    const { g, call } = m;
    const base = (await import('node:url')).URL;
    await call('POST', `/api/e/${g.id}/findings`, { findings: [{ cites: 'p-e00001', quote: 'card watcher records refresh as done', about: 'p-b00001', what: 'w',
      change: { edits: [{ file: 'pkg/retry.js', find: '(fn) => fn()', replace: '(fn) => { try { return fn(); } catch { return fn(); } }' }] } }] }, wes);
    const cfg = { url: m.base, key: s.keys.wes, owner: 'wes' };
    await runGuestTryOnce(cfg, { clone });
    let v = (await call('GET', `/api/e/${g.id}?k=${g.key}`)).body;
    assert.equal(v.findings[0].try.state, 'review');
    assert.match(v.findings[0].try.diff, /^\+export const retry = \(fn\) => \{ try/m);
    await call('POST', `/api/e/${g.id}/try-approve?k=${g.key}`, { finding: v.findings[0].id });
    await runGuestTryOnce(cfg, { clone });
    v = (await call('GET', `/api/e/${g.id}?k=${g.key}`)).body;
    assert.equal(v.findings[0].try.state, 'passed', JSON.stringify(v.findings[0].try));
    assert.equal(v.findings[0].try.passed, 1);
    m.close();
  } finally { await s.close(); }
});
