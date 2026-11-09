// Guest-path rehearsal: N consecutive zero-install guest meetings against a running coordinator,
// with the card owner's own Claude Code answering (headless, the owner's own login on this machine).
//   node scripts/guest-rehearsal.mjs --url http://localhost:7420 --owner weston --roloe-home ~/.roloe [--out runs.json]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values: opt } = parseArgs({ options: { url: { type: 'string' }, owner: { type: 'string' }, 'roloe-home': { type: 'string' }, out: { type: 'string' }, model: { type: 'string' }, only: { type: 'string' }, try: { type: 'boolean' } } });
const BIN = fileURLToPath(new URL('../bin/roloe.mjs', import.meta.url));
const base = opt.url.replace(/\/$/, '');

const CASES = [
  { name: 'public repo', body: { link: 'https://github.com/sindresorhus/p-retry' } },
  { name: 'monorepo subfolder', body: { link: 'https://github.com/vercel/next.js/tree/canary/packages/next/src/lib' } },
  { name: 'blog / docs page', body: { link: 'https://nodejs.org/en/learn/test-runner/using-test-runner' } },
  { name: 'sentence only', body: { text: "I'm adding OpenTelemetry to a Node service but no spans show up in my backend, and I can't tell if it's the exporter or the auth header." } },
  { name: 'skip', body: {} },
];

const json = async (path, init) => { const r = await fetch(base + path, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };

function startAssistant() {
  const mcp = JSON.stringify({ mcpServers: { roloe: { command: 'node', args: [BIN, 'mcp'], env: { ROLOE_HOME: opt['roloe-home'], ROLOE_REFRESH_MS: '0', ROLOE_CHANNEL_POLL_MS: '600000' } } } });
  const env = { HOME: process.env.HOME, USER: process.env.USER, PATH: process.env.PATH, TERM: 'xterm', LANG: 'en_US.UTF-8' };
  const p = spawn('claude', ['-p', 'Call roloe_wait_for_tap once, follow the instructions it returns, post your findings, then stop.', '--model', opt.model || 'sonnet', '--strict-mcp-config', '--mcp-config', mcp,
    '--allowedTools', 'mcp__roloe__roloe_wait_for_tap,mcp__roloe__roloe_pull,mcp__roloe__roloe_search_mine,mcp__roloe__roloe_post_findings'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  return { p, output: () => out };
}

const runs = [];
const cases = opt.only ? CASES.filter((c) => opt.only.split(',').includes(c.name)) : CASES;
for (const c of cases) {
  const before = (await json('/api/dashboard')).body;
  const a = startAssistant();
  await new Promise((r) => setTimeout(r, 7000));   // the assistant is open and waiting, as at the event
  const r = { case: c.name };
  let t = Date.now();
  const page = await fetch(`${base}/g/${opt.owner}`);
  await page.text();
  r.page_ms = Date.now() - t;
  r.page_status = page.status;
  t = Date.now();
  const start = await json(`/api/g/${opt.owner}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c.body) });
  r.start_ms = Date.now() - t;
  r.start_status = start.status;
  const { id, key } = start.body;
  r.meeting = id;
  let view = null;
  while (Date.now() - t < 120000) {
    view = (await json(`/api/e/${id}?k=${encodeURIComponent(key)}`)).body;
    if (view.their_side?.posted) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  r.scan_to_findings_s = view?.their_side?.posted ? Math.round((Date.now() - t) / 100) / 10 : null;
  r.findings = view?.findings?.length ?? 0;
  r.nothing_strong = Boolean(view?.their_side?.nothing_strong);
  r.input = view?.guest_input ? `${view.guest_input.kind}${view.guest_input.files != null ? ` (${view.guest_input.files} files)` : ''}${view.guest_input.error ? ` error: ${view.guest_input.error}` : ''}` : '';
  r.quotes = (view?.findings || []).map((f) => `${f.credit?.locator} :: "${f.quote}" → ${f.what}`);
  r.has_change = (view?.findings || []).some((f) => f.change);
  // Guest Try it: approve the first change on the guest's behalf, wait for the honest outcome.
  if (opt.try && view?.findings?.some((f) => f.try)) {
    const f = view.findings.find((x) => x.try);
    const t1 = Date.now();
    let st = f.try.state;
    while (Date.now() - t1 < 240000) {
      const fv = (await json(`/api/e/${id}?k=${encodeURIComponent(key)}`)).body.findings.find((x) => x.id === f.id);
      st = fv.try.state;
      if (st === 'review') await json(`/api/e/${id}/try-approve?k=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ finding: f.id }) });
      if (['passed', 'failed', 'no-tests', 'did-not-apply', 'declined'].includes(st)) { r.try = { state: st, passed: fv.try.passed ?? null, failed: fv.try.failed ?? null, reason: fv.try.reason || null, diff_lines: (fv.try.diff || '').split('\n').length, s: Math.round((Date.now() - t1) / 100) / 10 }; break; }
      await new Promise((res) => setTimeout(res, 1500));
    }
    if (!r.try) r.try = { state: `stuck at ${st}` };
  }
  const person = await fetch(`${base}/e/${id}?k=${encodeURIComponent(key)}`);
  r.person_page = person.status;
  const after = (await json('/api/dashboard')).body;
  r.counted = after.meetings === before.meetings + 1 && after.guests === before.guests + 1;
  r.pass = r.page_status === 200 && r.start_status === 201 && r.scan_to_findings_s !== null && r.scan_to_findings_s <= 60 && r.person_page === 200 && r.counted;
  await new Promise((res) => setTimeout(res, 2000));
  if (a.p.exitCode === null) a.p.kill('SIGTERM');
  r.assistant_tail = a.output().trim().split('\n').slice(-2).join(' ').slice(0, 240);
  runs.push(r);
  if (r.try) r.pass = r.pass && !String(r.try.state).startsWith('stuck');
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(20)} page ${r.page_ms} ms · start ${r.start_ms} ms · findings ${r.scan_to_findings_s ?? '–'} s · ${r.nothing_strong ? 'nothing strong' : `${r.findings} finding(s)`} · input ${r.input} · counted ${r.counted}${r.try ? ` · try ${JSON.stringify(r.try)}` : ''}`);
}
if (opt.out) writeFileSync(opt.out, JSON.stringify(runs, null, 2));
console.log(`${runs.filter((r) => r.pass).length}/${runs.length} passed`);
