// Try it, on the recipient's own laptop: copy the project (what the card showed), apply the
// finding's edits to the copy, show the literal git diff, and after approval run the tests in a
// container: dependencies installed with network, then tests with --network none, a read-only
// root, no host environment and no home-directory mount. The copy is deleted afterwards.
import { mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { safePath } from './checks.mjs';
import { listProjectFiles } from './indexer.mjs';

const NEVER_COPY = /(^|\/)(\.env[^/]*|.*\.(pem|key|p12|pfx)|id_[a-z0-9]+|node_modules\/.*|\.git\/.*)$/i;

// Colima shares only the home folder with its VM, so the copy lives under ~/.cache.
export function copyProject(src, encounterId) {
  const dest = join(homedir(), '.cache', 'roloe', `try-${encounterId}-${randomBytes(3).toString('hex')}`);
  mkdirSync(dest, { recursive: true });
  for (const rel of listProjectFiles(src)) {
    if (NEVER_COPY.test(rel)) continue;
    const from = join(src, rel);
    // Regular files only: a symlink in the copy could point back into the real project.
    try { if (!lstatSync(from).isFile()) continue; } catch { continue; }
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    cpSync(from, join(dest, rel));
  }
  const git = (...a) => execFileSync('git', ['-C', dest, '-c', 'user.email=roloe@localhost', '-c', 'user.name=Roloe', ...a], { stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'baseline', '--allow-empty');
  return dest;
}

export function applyEdits(dir, edits) {
  const planned = new Map();
  for (const e of edits || []) {
    if (!safePath(e.file)) return { ok: false, reason: `${e.file}: path is not inside the project` };
    const path = join(dir, e.file);
    if (!planned.has(e.file)) {
      let st; try { st = lstatSync(path); } catch { return { ok: false, reason: `${e.file}: no such file` }; }
      if (!st.isFile()) return { ok: false, reason: `${e.file}: not a regular file` };
      planned.set(e.file, readFileSync(path, 'utf8'));
    }
    const text = planned.get(e.file);
    const n = e.find ? text.split(e.find).length - 1 : 0;
    if (n === 0) return { ok: false, reason: `${e.file}: find text not found` };
    if (n > 1) return { ok: false, reason: `${e.file}: find text matches ${n} times` };
    planned.set(e.file, text.replace(e.find, () => e.replace));
  }
  for (const [file, text] of planned) writeFileSync(join(dir, file), text);
  return { ok: true, files: [...planned.keys()] };
}

// --text and --no-textconv: no attribute can turn a change into "Binary files differ" or a filtered view.
export const literalDiff = (dir) => execFileSync('git', ['-C', dir, '-c', 'core.attributesFile=/dev/null', 'diff', '--no-color', '--no-ext-diff', '--text', '--no-textconv'], { encoding: 'utf8' });

export function patchText(diff, { giver, finding, cites }) {
  return `From: ${giver}, via Roloe (finding ${finding}, cites ${cites})\nApply: git apply <this file>   Undo: git apply -R <this file>\n\n${diff}`;
}

export function parseCounts(out) {
  const s = String(out || '');
  let m;
  if ((m = s.match(/^# pass (\d+)[\s\S]*?^# fail (\d+)/m))) return { passed: +m[1], failed: +m[2] };          // node --test
  if ((m = s.match(/Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(\d+) passed/))) return { passed: +m[2], failed: +(m[1] || 0) }; // jest
  if ((m = s.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/))) return { passed: +m[2], failed: +(m[1] || 0) };   // vitest
  if ((m = s.match(/(\d+) failed, (\d+) passed/))) return { passed: +m[2], failed: +m[1] };                       // pytest, failures first
  if ((m = s.match(/(\d+) passed(?:, (\d+) failed)?/))) return { passed: +m[1], failed: +(m[2] || 0) };            // pytest
  return { passed: null, failed: null };
}

// Green: exit 0 and at least one test ran. A suite that runs nothing proves nothing.
export const verdict = (code, counts) => (code === 0 && counts.passed > 0 && !counts.failed ? 'passed' : 'failed');

// MCP servers can start with a bare environment: make sure git and docker are still found.
export function toolPath() {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', join(homedir(), '.colima', 'bin')];
  return [...new Set([...(process.env.PATH || '').split(':').filter(Boolean), ...extra])].join(':');
}

export function dockerEnv() {
  const env = { PATH: toolPath(), HOME: homedir() };
  const colima = join(homedir(), '.colima', 'default', 'docker.sock');
  env.DOCKER_HOST = process.env.DOCKER_HOST || (existsSync(colima) ? `unix://${colima}` : undefined);
  // A leftover Docker Desktop credsStore breaks every pull; use a clean client config.
  const cfgDir = join(homedir(), '.roloe', 'docker-config');
  if (!existsSync(join(cfgDir, 'config.json'))) { mkdirSync(cfgDir, { recursive: true }); writeFileSync(join(cfgDir, 'config.json'), '{}'); }
  env.DOCKER_CONFIG = process.env.ROLOE_DOCKER_CONFIG || cfgDir;
  if (!env.DOCKER_HOST) delete env.DOCKER_HOST;
  return env;
}

let dockerOk;
export function dockerAvailable() {
  if (process.env.ROLOE_DOCKER === 'off') return false;
  if (dockerOk === undefined) dockerOk = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { env: dockerEnv(), stdio: 'ignore', timeout: 8000 }).status === 0;
  return dockerOk;
}

// Every container is named, so a timeout removes the container itself, not just the docker client.
function docker(args, { timeoutMs = 180000, onData, name } = {}) {
  return new Promise((resolve) => {
    const p = spawn('docker', args, { env: dockerEnv() });
    let out = '';
    let timedOut = false;
    const take = (d) => { out += d; onData?.(String(d)); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    const t = setTimeout(() => {
      timedOut = true;
      if (name) spawnSync('docker', ['rm', '-f', name], { env: dockerEnv(), stdio: 'ignore', timeout: 20000 });
      p.kill('SIGKILL');
    }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ code: timedOut ? 124 : code ?? 1, out: out + (timedOut ? '\n[roloe] timed out: container removed\n' : ''), timedOut }); });
  });
}

// What to run, by project type.
export function plan(dir) {
  if (existsSync(join(dir, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
    const install = existsSync(join(dir, 'package-lock.json')) ? 'npm ci --ignore-scripts --no-audit --no-fund'
      : hasDeps ? 'npm install --ignore-scripts --no-audit --no-fund' : null;
    return { image: process.env.ROLOE_NODE_IMAGE || 'node:22-slim', install, test: 'npm test', cache: '/tmp/.npm', cacheEnv: 'npm_config_cache' };
  }
  if (['pyproject.toml', 'requirements.txt', 'setup.py'].some((f) => existsSync(join(dir, f)))) {
    // Requirements only: building the project itself (setup.py, a build backend) would run its code with the network on.
    const req = existsSync(join(dir, 'requirements.txt')) ? '-r requirements.txt ' : '';
    return { image: process.env.ROLOE_PYTHON_IMAGE || 'python:3.12-slim', install: `pip install -q --no-build-isolation --only-binary=:all: --target /w/.roloe-deps ${req}pytest`, test: 'PYTHONPATH=/w/.roloe-deps:/w python -m pytest -q -p no:cacheprovider', cache: '/tmp/.pip', cacheEnv: 'PIP_CACHE_DIR' };
  }
  return null;
}

// The dependency install keeps the network (it fetches from the lockfile) but is otherwise as
// locked down as the test run: no capabilities, no privilege gain, read-only root, this user.
export function installArgs({ dir, cacheDir, image, cmd, user, name, cacheMount, cacheEnv }) {
  return ['run', '--rm', '--name', name, '--user', user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:exec',
    '-v', `${dir}:/w`, '-v', `${cacheDir}:${cacheMount}`, '-w', '/w', '-e', 'HOME=/tmp', '-e', `${cacheEnv}=${cacheMount}`, image, 'sh', '-c', cmd];
}

export async function runSandboxed(dir, { onState = () => {}, onOutput = () => {}, testTimeoutMs = 120000, keepCopy = false, cacheDir: ownCacheDir = null } = {}) {
  const started = Date.now();
  // Run as this user, so nothing in the copy ends up owned by root (and the copy can be deleted).
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const container = `roloe-try-${randomBytes(4).toString('hex')}`;
  try {
    const p = plan(dir);
    if (!p) { onState('failed'); return { state: 'failed', reason: 'no test runner found (package.json or Python project)', output: '', passed: null, failed: null, test_ms: 0 }; }
    onState('installing');
    let output = '';
    // The image comes down with the network on, before anything is timed or cut off.
    if (spawnSync('docker', ['image', 'inspect', p.image], { env: dockerEnv(), stdio: 'ignore' }).status !== 0) {
      const pull = await docker(['pull', '-q', p.image], { onData: onOutput });
      output += pull.out;
      if (pull.code !== 0) { onState('failed'); return { state: 'failed', reason: `could not pull ${p.image}`, output, passed: null, failed: null, test_ms: 0 }; }
    }
    if (p.install) {
      // Dependencies from the lockfile, with network, in Linux (a macOS node_modules won't run here).
      const cacheDir = ownCacheDir || join(homedir(), '.cache', 'roloe', 'pkg-cache');
      mkdirSync(cacheDir, { recursive: true });
      const r = await docker(installArgs({ dir, cacheDir, image: p.image, cmd: p.install, user, name: `${container}-deps`, cacheMount: p.cache, cacheEnv: p.cacheEnv }), { onData: onOutput, name: `${container}-deps` });
      output += r.out;
      if (r.code !== 0) { onState('failed'); return { state: 'failed', reason: 'dependency install failed', output, passed: null, failed: null, test_ms: 0 }; }
    }
    onState('testing');
    const t0 = Date.now();
    const r = await docker(['run', '--rm', '--name', container, '--user', user, '--network', 'none', '--read-only', '--tmpfs', '/tmp:exec', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-v', `${dir}:/w`, '-w', '/w', '-e', 'HOME=/tmp', '-e', 'CI=1', p.image, 'sh', '-c', p.test], { onData: onOutput, timeoutMs: testTimeoutMs, name: container });
    const test_ms = Date.now() - t0;
    output += r.out;
    const counts = parseCounts(r.out);
    const state = verdict(r.code, counts);
    onState(state);
    return { state, exit: r.code, ...counts, test_ms, total_ms: Date.now() - started, output, container, timed_out: r.timedOut, sandbox: 'docker-network-none' };
  } finally {
    if (!keepCopy) rmSync(dir, { recursive: true, force: true });
  }
}
