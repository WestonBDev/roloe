// Try it, on the recipient's own laptop: copy the project (what the card showed), apply the
// finding's edits to the copy, show the literal git diff, and after approval run the tests in a
// container: dependencies installed with network, then tests with --network none, a read-only
// root, no host environment and no home-directory mount. The copy is deleted afterwards.
import { mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
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
    try { if (!statSync(from).isFile()) continue; } catch { continue; }
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
      if (!existsSync(path)) return { ok: false, reason: `${e.file}: no such file` };
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

export const literalDiff = (dir) => execFileSync('git', ['-C', dir, 'diff', '--no-color', '--no-ext-diff'], { encoding: 'utf8' });

export function patchText(diff, { giver, finding, cites }) {
  return `From: ${giver}, via Roloe (finding ${finding}, cites ${cites})\nApply: git apply <this file>   Undo: git apply -R <this file>\n\n${diff}`;
}

export function parseCounts(out) {
  const s = String(out || '');
  let m;
  if ((m = s.match(/^# pass (\d+)[\s\S]*?^# fail (\d+)/m))) return { passed: +m[1], failed: +m[2] };          // node --test
  if ((m = s.match(/Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(\d+) passed/))) return { passed: +m[2], failed: +(m[1] || 0) }; // jest
  if ((m = s.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/))) return { passed: +m[2], failed: +(m[1] || 0) };   // vitest
  if ((m = s.match(/(\d+) passed(?:, (\d+) failed)?/))) return { passed: +m[1], failed: +(m[2] || 0) };            // pytest
  if ((m = s.match(/(\d+) failed, (\d+) passed/))) return { passed: +m[2], failed: +m[1] };
  return { passed: null, failed: null };
}

// Green: exit 0 and at least one test ran. A suite that runs nothing proves nothing.
export const verdict = (code, counts) => (code === 0 && counts.passed > 0 && !counts.failed ? 'passed' : 'failed');

export function dockerEnv() {
  const env = { PATH: process.env.PATH, HOME: homedir() };
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
  if (dockerOk === undefined) dockerOk = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { env: dockerEnv(), stdio: 'ignore', timeout: 8000 }).status === 0;
  return dockerOk;
}

function docker(args, { timeoutMs = 180000, onData } = {}) {
  return new Promise((resolve) => {
    const p = spawn('docker', args, { env: dockerEnv() });
    let out = '';
    const take = (d) => { out += d; onData?.(String(d)); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, out }); });
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
    const req = existsSync(join(dir, 'requirements.txt')) ? '-r requirements.txt' : '.';
    return { image: process.env.ROLOE_PYTHON_IMAGE || 'python:3.12-slim', install: `pip install -q --target /w/.roloe-deps ${req} pytest`, test: 'PYTHONPATH=/w/.roloe-deps:/w python -m pytest -q -p no:cacheprovider', cache: '/tmp/.pip', cacheEnv: 'PIP_CACHE_DIR' };
  }
  return null;
}

export async function runSandboxed(dir, { onState = () => {}, onOutput = () => {} } = {}) {
  const started = Date.now();
  try {
    const p = plan(dir);
    if (!p) { onState('failed'); return { state: 'failed', reason: 'no test runner found (package.json or Python project)', output: '', passed: null, failed: null, test_ms: 0 }; }
    onState('installing');
    let output = '';
    if (p.install) {
      // Dependencies from the lockfile, with network, in Linux (a macOS node_modules won't run here).
      const cacheDir = join(homedir(), '.cache', 'roloe', 'pkg-cache');
      mkdirSync(cacheDir, { recursive: true });
      const r = await docker(['run', '--rm', '-v', `${dir}:/w`, '-v', `${cacheDir}:${p.cache}`, '-w', '/w', '-e', 'HOME=/tmp', '-e', `${p.cacheEnv}=${p.cache}`, p.image, 'sh', '-c', p.install], { onData: onOutput });
      output += r.out;
      if (r.code !== 0) { onState('failed'); return { state: 'failed', reason: 'dependency install failed', output, passed: null, failed: null, test_ms: 0 }; }
    }
    onState('testing');
    const t0 = Date.now();
    const r = await docker(['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:exec', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-v', `${dir}:/w`, '-w', '/w', '-e', 'HOME=/tmp', '-e', 'CI=1', p.image, 'sh', '-c', p.test], { onData: onOutput, timeoutMs: 120000 });
    const test_ms = Date.now() - t0;
    output += r.out;
    const counts = parseCounts(r.out);
    const state = verdict(r.code, counts);
    onState(state);
    return { state, exit: r.code, ...counts, test_ms, total_ms: Date.now() - started, output, sandbox: 'docker --network none --read-only, no env, no home mount' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
