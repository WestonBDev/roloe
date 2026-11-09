// Guest Try it, on the card owner's laptop. The guest has nothing installed, so the owner's machine
// shallow-clones the guest's PUBLIC repo (only that folder for a monorepo), applies the change,
// sends the literal diff to the guest's phone, and only after the guest approves runs the guest's
// own tests in the same sandbox as Try it: deps from the lockfile with network, then tests with
// --network none, read-only, no env, no home mount. The clone is deleted afterwards.
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { api } from './client.mjs';
import { applyEdits, literalDiff, plan, runSandboxed, dockerAvailable, toolPath } from './tryit.mjs';

const run = promisify(execFile);
const keyOf = (j) => `${j.encounter_id}:${j.finding}`;

// Only public GitHub repos, cloned shallow and (for a folder) sparse.
export async function gitClone(job, dest) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(job.repo)) throw Object.assign(new Error('only public GitHub repos'), { code: 'bad_repo' });
  const args = ['clone', '--depth', '1', '--filter=blob:none', '--quiet'];
  if (job.path) args.push('--sparse');
  if (job.ref && job.ref !== 'HEAD') args.push('--branch', job.ref);
  args.push(job.repo, dest);
  const env = { PATH: toolPath(), HOME: homedir(), GIT_TERMINAL_PROMPT: '0' };
  await run('git', args, { env, timeout: 60000 });
  // Non-cone patterns work for a folder or a single file; the root package files come too, so tests can run.
  if (job.path) await run('git', ['-C', dest, 'sparse-checkout', 'set', '--no-cone', `/${job.path}`, '/package.json', '/package-lock.json', '/pyproject.toml', '/requirements.txt'], { env, timeout: 60000 });
}

// Clone folders carry the owner, so a runner only ever cleans up its own owner's clones.
const dirName = (owner, j) => `guest-${owner}-${j.encounter_id}-${j.finding}`;

async function prepare(job, clone, owner) {
  const dir = join(homedir(), '.cache', 'roloe', dirName(owner, job));
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

// A runner: its own memory of prepared clones. Several may run for one owner (the MCP server and
// `roloe guest-try`); each job is claimed at the coordinator first, so exactly one does the work.
export function makeRunner() {
  const prepared = new Map();   // job key -> { dir, testDir, diff }
  const running = new Set();

  async function once(cfg, { clone = gitClone, maxDiff = 80_000 } = {}) {
    const { jobs } = await api(cfg, 'GET', '/api/me/try-jobs');
    const post = (job, body) => api(cfg, 'POST', `/api/e/${job.encounter_id}/guest-try`, { finding: job.finding, ...body }).then(() => true, () => false);
    // Declined, stopped or finished: its clone goes now, not when this process exits.
    const live = new Set(jobs.map(keyOf));
    for (const [k, p] of prepared) if (!live.has(k) && !running.has(k)) { rmSync(p.dir, { recursive: true, force: true }); prepared.delete(k); }
    // Also clones on disk that no live job owns (left by a runner that restarted).
    const cache = join(homedir(), '.cache', 'roloe');
    const liveDirs = new Set(jobs.map((j) => dirName(cfg.owner, j)));
    const mine = new RegExp(`^guest-${cfg.owner}-e-[0-9a-f]{10}-f-[0-9a-f]{8}(-cache)?$`);
    if (existsSync(cache)) for (const d of readdirSync(cache)) if (mine.test(d) && !liveDirs.has(d.replace(/-cache$/, ''))) rmSync(join(cache, d), { recursive: true, force: true });

    for (const job of jobs) {
      const k = keyOf(job);
      if (running.has(k) || !['diff-pending', 'approved'].includes(job.state)) continue;
      running.add(k);
      try {
        if (job.state === 'diff-pending') {
          if (!(await post(job, { state: 'preparing' }))) continue;   // another runner claimed it
          const p = await safePrepare(job, clone, cfg.owner);
          // Show the whole diff or nothing: a truncated diff is not the literal change.
          if (p.diff && p.diff.length > maxDiff) Object.assign(p, { state: 'did-not-apply', reason: 'This change is too large to show on a phone, so it is offered as advice only.', diff: '' });
          await post(job, { state: p.state, diff: p.diff, reason: p.reason, test_command: p.test_command });
          if (p.state === 'review') prepared.set(k, p); else if (p.dir) rmSync(p.dir, { recursive: true, force: true });
          continue;
        }
        // approved: claim the run, then run exactly what the guest read.
        if (!(await post(job, { state: 'installing' }))) continue;
        let p = prepared.get(k);
        if (!p) {
          p = await safePrepare(job, clone, cfg.owner);
          if (p.state !== 'review') { await post(job, { state: 'failed', reason: p.reason || 'Could not prepare the change again.' }); if (p.dir) rmSync(p.dir, { recursive: true, force: true }); continue; }
        }
        if (job.approved_diff != null && p.diff !== job.approved_diff) {
          await post(job, { state: 'failed', reason: 'Your repo changed since you approved this change, so it wasn\'t run. Scan again for a fresh one.' });
          rmSync(p.dir, { recursive: true, force: true });
          prepared.delete(k);
          continue;
        }
        if (!dockerAvailable()) {
          await post(job, { state: 'failed', reason: 'Docker isn\'t running on the card owner\'s laptop, so the tests could not run.' });
        } else {
          // Its own package cache: a stranger's install never shares one with the owner's runs.
          const cacheDir = `${p.dir}-cache`;
          mkdirSync(cacheDir, { recursive: true });
          const r = await runSandboxed(p.testDir, { keepCopy: true, cacheDir, onState: (st) => { if (st === 'testing') post(job, { state: 'testing' }); } });
          rmSync(cacheDir, { recursive: true, force: true });
          await post(job, { state: r.state, passed: r.passed, failed: r.failed, test_ms: r.test_ms, reason: r.reason });
        }
        rmSync(p.dir, { recursive: true, force: true });
        prepared.delete(k);
      } finally {
        running.delete(k);
      }
    }
  }

  return {
    once,
    forget() { prepared.clear(); },
    cleanup() { for (const p of prepared.values()) if (existsSync(p.dir)) rmSync(p.dir, { recursive: true, force: true }); prepared.clear(); },
  };
}

async function safePrepare(job, clone, owner) {
  try { return await prepare(job, clone, owner); } catch (e) {
    console.error('[roloe] guest try prepare failed:', e.code || e.name, String(e.stderr || e.message || '').slice(0, 200));
    return { state: 'did-not-apply', reason: e.code === 'bad_repo' ? 'Only public GitHub repos can be tried.' : 'Could not fetch the repo to try the change just now.', diff: '' };
  }
}

// The default runner for this process.
const defaultRunner = makeRunner();
export const runGuestTryOnce = (cfg, opts) => defaultRunner.once(cfg, opts);
export const forgetPrepared = () => defaultRunner.forget();
export const cleanupGuestTries = () => defaultRunner.cleanup();
