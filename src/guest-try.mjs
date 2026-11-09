// Guest Try it, on the card owner's laptop. The guest has nothing installed, so the owner's machine
// shallow-clones the guest's PUBLIC repo (only that folder for a monorepo), applies the change,
// sends the literal diff to the guest's phone, and only after the guest approves runs the guest's
// own tests in the same sandbox as Try it: deps from the lockfile with network, then tests with
// --network none, read-only, no env, no home mount. The clone is deleted afterwards.
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { api } from './client.mjs';
import { applyEdits, literalDiff, plan, runSandboxed, dockerAvailable } from './tryit.mjs';

const run = promisify(execFile);
const prepared = new Map();   // job key -> { dir, testDir }
const running = new Set();
const keyOf = (j) => `${j.encounter_id}:${j.finding}`;

// Only public GitHub repos, cloned shallow and (for a folder) sparse.
export async function gitClone(job, dest) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(job.repo)) throw Object.assign(new Error('only public GitHub repos'), { code: 'bad_repo' });
  const args = ['clone', '--depth', '1', '--filter=blob:none', '--quiet'];
  if (job.path) args.push('--sparse');
  if (job.ref && job.ref !== 'HEAD') args.push('--branch', job.ref);
  args.push(job.repo, dest);
  const env = { PATH: process.env.PATH, HOME: homedir(), GIT_TERMINAL_PROMPT: '0' };
  await run('git', args, { env, timeout: 60000 });
  if (job.path) await run('git', ['-C', dest, 'sparse-checkout', 'set', job.path], { env, timeout: 60000 });
}

async function prepare(job, clone) {
  const dir = join(homedir(), '.cache', 'roloe', `guest-${job.encounter_id}-${job.finding}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, '..'), { recursive: true });
  await clone(job, dir);
  const applied = applyEdits(dir, job.edits);
  if (!applied.ok) return { dir, state: 'did-not-apply', reason: applied.reason, diff: '' };
  const diff = literalDiff(dir);
  // Tests live in the folder they gave, or at the repo root.
  const testDir = job.path && plan(join(dir, job.path)) ? join(dir, job.path) : dir;
  const p = plan(testDir);
  if (!p) return { dir, testDir, state: 'no-tests', diff, reason: 'This project has no test command Roloe can run.' };
  return { dir, testDir, state: 'review', diff, test_command: p.test };
}

// One pass over this owner's guest Try it jobs. Called on a short loop by the MCP server.
export async function runGuestTryOnce(cfg, { clone = gitClone } = {}) {
  const { jobs } = await api(cfg, 'GET', '/api/me/try-jobs');
  const report = (job, body) => api(cfg, 'POST', `/api/e/${job.encounter_id}/guest-try`, { finding: job.finding, ...body }).catch(() => {});
  for (const job of jobs) {
    const k = keyOf(job);
    if (running.has(k)) continue;
    running.add(k);
    try {
      if (job.state === 'diff-pending' || (job.state === 'approved' && !prepared.has(k))) {
        let p;
        try { p = await prepare(job, clone); } catch (e) { p = { state: 'did-not-apply', reason: e.code === 'bad_repo' ? 'Only public GitHub repos can be tried.' : 'Could not fetch the repo to try the change.', diff: '' }; }
        if (job.state === 'diff-pending') {
          await report(job, { state: p.state, diff: p.diff, reason: p.reason, test_command: p.test_command });
          if (p.state === 'review') prepared.set(k, p); else if (p.dir) rmSync(p.dir, { recursive: true, force: true });
          continue;
        }
        if (p.state !== 'review') { await report(job, { state: 'failed', reason: p.reason || 'Could not prepare the change again.' }); if (p.dir) rmSync(p.dir, { recursive: true, force: true }); continue; }
        prepared.set(k, p);
      }
      if (job.state === 'approved') {
        const p = prepared.get(k);
        if (!dockerAvailable()) {
          await report(job, { state: 'failed', reason: 'Docker isn\'t running on the card owner\'s laptop, so the tests could not run.' });
        } else {
          const r = await runSandboxed(p.testDir, { keepCopy: true, onState: (st) => { if (st === 'installing' || st === 'testing') report(job, { state: st }); } });
          await report(job, { state: r.state, passed: r.passed, failed: r.failed, test_ms: r.test_ms, reason: r.reason });
        }
        rmSync(p.dir, { recursive: true, force: true });
        prepared.delete(k);
      }
    } finally {
      running.delete(k);
    }
  }
}

// Clean up anything left behind (a restarted runner re-prepares from the job).
export function cleanupGuestTries() {
  for (const p of prepared.values()) if (existsSync(p.dir)) rmSync(p.dir, { recursive: true, force: true });
  prepared.clear();
}
