// `roloe answer`: unattended answering for a long session (judging, a booth). For each new meeting
// on the owner's card, it starts the owner's own Claude Code headless on this laptop, with the
// owner's own login, told to answer that one meeting with the Roloe tools and stop. It also
// serves guest Try it. Nothing here holds a key or a login; the coordinator still runs no model.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { api } from './client.mjs';

const FRESH_MS = 10 * 60e3;   // the same window the wait tool uses
const MAX_RUNNING = 3;
const RUN_TIMEOUT_MS = 150_000;

// attempts: meeting id -> { n, last }. A run that ended without posting gets one retry, 30 s later.
export function meetingsToAnswer(list, now, running, attempts = new Map()) {
  const room = MAX_RUNNING - running.size;
  if (room <= 0) return [];
  return list
    .filter((e) => !e.posted && (e.status ?? 'open') === 'open' && now - Date.parse(e.created) < FRESH_MS && !running.has(e.id)
      && !((attempts.get(e.id)?.n || 0) >= 2) && now - (attempts.get(e.id)?.last || 0) > 30_000)
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created))
    .slice(0, room)
    .map((e) => e.id);
}

const TOOLS = ['roloe_pull', 'roloe_search_mine', 'roloe_post_findings'].map((t) => `mcp__roloe__${t}`).join(',');

export function answerCommand(id, { bin, home, model = 'sonnet' }) {
  if (!/^e-[0-9a-f]{10}$/.test(id)) throw new Error('bad meeting id');
  const mcp = { mcpServers: { roloe: { command: process.execPath, args: [bin, 'mcp'], env: { ROLOE_HOME: home, ROLOE_REFRESH_MS: '0', ROLOE_CHANNEL_POLL_MS: '600000', ROLOE_GUEST_TRY: 'off' } } } };
  const prompt = `Call roloe_pull with encounter_id ${id}, follow the instructions it returns, post your findings with roloe_post_findings, then stop.`;
  const env = { HOME: process.env.HOME, USER: process.env.USER, PATH: process.env.PATH, TERM: 'xterm', LANG: process.env.LANG || 'en_US.UTF-8' };
  return { cmd: 'claude', args: ['-p', prompt, '--model', model, '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp), '--allowedTools', TOOLS], env };
}

export async function runAnswerLoop(cfg, { home, model, log = console.log, pollMs = 2000, tryIt = true } = {}) {
  const bin = fileURLToPath(new URL('../bin/roloe.mjs', import.meta.url));
  const running = new Map();   // meeting id -> child
  const attempts = new Map();  // meeting id -> { n, last }
  const { runGuestTryOnce } = await import('./guest-try.mjs');
  let tryBusy = false;
  for (;;) {
    try {
      // The header marks the owner's assistant as online on the guest's page.
      const { encounters } = await api(cfg, 'GET', '/api/me/encounters', undefined, { headers: { 'x-roloe-client': 'assistant' } });
      for (const id of meetingsToAnswer(encounters, Date.now(), running, attempts)) {
        const a = attempts.get(id) || { n: 0, last: 0 };
        attempts.set(id, { n: a.n + 1, last: Date.now() });
        if (attempts.size > 500) attempts.delete(attempts.keys().next().value);
        const { cmd, args, env } = answerCommand(id, { bin, home, model });
        const t0 = Date.now();
        const child = spawn(cmd, args, { env, stdio: 'ignore' });
        const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS);
        running.set(id, child);
        log(`answering ${id}`);
        const done = (how) => { clearTimeout(timer); running.delete(id); log(`${id}: ${how} in ${Math.round((Date.now() - t0) / 1000)} s`); };
        child.on('exit', (code) => done(code === 0 ? 'done' : `exit ${code}`));
        child.on('error', (e) => done(`could not start claude (${e.code || e.message})`));
      }
    } catch (e) { log(`(retrying: ${e.message})`); }
    if (tryIt && !tryBusy) {   // Try it runs beside answering, never blocking it
      tryBusy = true;
      runGuestTryOnce(cfg).catch((e) => log(`(Try it retrying: ${e.message})`)).finally(() => { tryBusy = false; });
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
