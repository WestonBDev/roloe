#!/usr/bin/env node
// roloe: the owner's command line. Runs on the owner's machine.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, saveConfig, api, refreshCard, currentOwner } from '../src/client.mjs';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const { values: opt, positionals: pos } = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    url: { type: 'string' }, owner: { type: 'string' }, name: { type: 'string' }, line: { type: 'string' },
    project: { type: 'string' }, json: { type: 'boolean' }, ui: { type: 'boolean' }, all: { type: 'boolean' },
    wait: { type: 'string' }, port: { type: 'string' }, undo: { type: 'boolean' }, 'same-person-as': { type: 'string' },
  },
});

const DEFAULT_URL = process.env.ROLOE_URL || 'http://localhost:7420';
const out = (s) => process.stdout.write(s + '\n');
const cfgFor = () => loadConfig(opt.owner || currentOwner());

const commands = {
  // Flip the switch on: register if needed, index today's work for one project, upload.
  async on() {
    let cfg;
    const owner = (opt.owner || currentOwner() || '').toLowerCase();
    try { cfg = loadConfig(owner); } catch { cfg = null; }
    if (!cfg) {
      if (!owner) throw new Error('First time: roloe on --owner <short-name> --name "<Your Name>" --project <dir> [--url <coordinator>]');
      const url = opt.url || DEFAULT_URL;
      const same = opt['same-person-as'] ? loadConfig(opt['same-person-as']) : null;
      const reg = await api({ url }, 'POST', '/api/owners', { owner, name: opt.name || owner, line: opt.line || '', ...(same ? { same_person_as: same.owner } : {}) },
        { key: '', headers: same ? { 'x-roloe-same-person-key': same.key } : {} });
      if (same) out(`Second card: labelled as the same person as ${same.owner} on every screen.`);
      cfg = { owner: reg.owner, name: opt.name || owner, url, key: reg.key, project: resolve(opt.project || process.cwd()), removed: [] };
      saveConfig(cfg);
      out(`Registered card "${cfg.owner}" at ${url}`);
    }
    if (opt.project) cfg.project = resolve(opt.project);
    if (opt.url && opt.url.replace(/\/$/, '') !== cfg.url.replace(/\/$/, '')) {
      // A new coordinator (e.g. the cluster): the old key means nothing there, so register again.
      const reg = await api({ url: opt.url }, 'POST', '/api/owners', { owner: cfg.owner, name: opt.name || cfg.name, line: opt.line || '' }, { key: '' });
      Object.assign(cfg, { url: opt.url, key: reg.key });
      out(`Registered card "${cfg.owner}" at ${opt.url}`);
    }
    saveConfig(cfg);
    await api(cfg, 'POST', `/api/cards/${cfg.owner}/switch`, { on: true });
    const r = await refreshCard(cfg);
    const t = r.totals;
    out(`Sharing is on: today's work in ${cfg.project}`);
    out(`${r.passages} passages (${t.sessions} sessions, ${t.files} files, ${t.commits} commits), ${t.secrets_removed} secrets removed, ${r.private} kept private.`);
    out(`See exactly what is shared: roloe show   ·   your page: roloe me`);
  },

  async off() {
    const cfg = cfgFor();
    await api(cfg, 'POST', `/api/cards/${cfg.owner}/switch`, { on: false });
    out('Sharing is off. Your card is empty now.');
  },

  async refresh() {
    const cfg = cfgFor();
    const r = await refreshCard(cfg);
    out(`Card refreshed: ${r.passages} passages.`);
  },

  // Print exactly what is on the card, as the coordinator holds it.
  async show() {
    const cfg = cfgFor();
    const r = await api(cfg, 'GET', `/api/cards/${cfg.owner}/passages`);
    if (opt.json) return out(JSON.stringify(r, null, 2));
    out(`${r.name}'s card · sharing ${r.sharing ? 'on' : 'off'} · ${r.passages.length} passages · ${r.private.length} kept private`);
    let last = '';
    for (const p of r.passages) {
      if (p.source !== last) { out(`\n== ${p.source}`); last = p.source; }
      const who = p.speaker === 'owner' ? 'you' : p.speaker === 'pasted' ? 'you pasted' : p.speaker || p.kind;
      out(`  ${p.passage_id}  ${p.locator}  (${who})`);
      out('    ' + p.text.replace(/\s+/g, ' ').slice(0, opt.all ? 1500 : 200));
    }
  },

  async private() {
    const cfg = cfgFor();
    if (!pos[0]) throw new Error('Usage: roloe private <passage_id> [--undo]');
    const r = await api(cfg, 'POST', `/api/cards/${cfg.owner}/private`, { passage_id: pos[0], private: !opt.undo });
    out(`${pos[0]} ${opt.undo ? 'is shareable again' : 'is private and off the card'} (${r.private.length} private).`);
  },

  async me() {
    const cfg = cfgFor();
    out(`${cfg.url}/me/${cfg.owner}#${cfg.key}`);
    out('(This link holds your card key. Open it on your own phone or laptop only.)');
  },

  // MCP server for Claude Code / Codex (stdio).
  async mcp() {
    const { runMcp } = await import('../src/mcp.mjs');
    await runMcp();
  },

  async inbox() {
    const cfg = cfgFor();
    const r = await api(cfg, 'GET', '/api/me/encounters');
    if (!r.encounters.length) return out('No open meetings.');
    for (const e of r.encounters) out(`${e.id}  with ${e.with_name}${e.guest ? ' (guest)' : ''}  ${e.posted ? 'posted' : 'not posted yet'}\n  page:  ${e.link}\n  stage: ${e.stage}`);
  },

  async tap() {
    const cfg = cfgFor();
    if (!pos[0]) throw new Error('Usage: roloe tap <their card name>');
    const r = await api(cfg, 'POST', '/api/tap', { to: pos[0] });
    out(`Tapped ${r.with}: meeting ${r.id} (ready in ${r.ready_ms} ms)`);
    out(`Your page: ${r.link}`);
    out(`Stage:     ${r.stage}`);
  },

  // Try a finding's change: literal diff on 127.0.0.1, approve, sandboxed tests.
  async try() {
    const cfg = cfgFor();
    if (opt.project) cfg.project = resolve(opt.project);
    const id = pos[0] || (await api(cfg, 'GET', '/api/me/encounters')).encounters[0]?.id;
    if (!id) throw new Error('No meetings yet.');
    const { startTryUi } = await import('../src/tryit-ui.mjs');
    const ui = await startTryUi({ cfg, encounterId: id, findingId: pos[1], port: Number(opt.port || 7421) });
    out(`Try it: ${ui.url}  (change from ${ui.finding.credit.name}, finding ${ui.finding.id})`);
    if (process.platform === 'darwin' && !process.env.ROLOE_NO_OPEN) (await import('node:child_process')).spawn('open', [ui.url], { stdio: 'ignore', detached: true }).unref();
    const r = await ui.done;
    out(r.state === 'passed' ? `Passed: ${r.passed} tests in ${(r.test_ms / 1000).toFixed(1)} s with no network. Your project is unchanged.` : `${r.state}${r.reason ? ': ' + r.reason : ''}`);
    out('Save the patch from the page if you want it; press Ctrl-C to close.');
  },

  // The judge beat: a fresh secret written to a file that is never shared, registered so both
  // gates (this machine's and the coordinator's) will block it if it ever tries to leave.
  async canary() {
    const cfg = cfgFor();
    const { randomInt } = await import('node:crypto');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const A = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
    const value = 'canary-' + Array.from({ length: 20 }, () => A[randomInt(A.length)]).join('');
    const dir = join(homedir(), 'roloe-canary');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `canary-${Date.now()}.txt`);
    writeFileSync(file, value + '\n', { mode: 0o600 });
    await api(cfg, 'POST', '/api/canaries', { value });
    cfg.removed = [...new Set([...(cfg.removed || []), value])];
    saveConfig(cfg);
    out(`${value}`);
    out(`written to ${file} (never shared: outside ${cfg.project})`);
    out('Registered with the coordinator gate and this machine\'s gate.');
  },

  async stop() {
    const cfg = cfgFor();
    const list = (await api(cfg, 'GET', '/api/me/encounters')).encounters;
    const e = pos[0] ? list.find((x) => x.id === pos[0]) : list[0];
    if (!e) throw new Error('No open meeting by that id.');
    const k = new URL(e.link).searchParams.get('k');
    const r = await api(cfg, 'POST', `/api/e/${e.id}/stop`, undefined, { key: '' , headers: { 'x-roloe-key': k } });
    out(`Stopped ${e.id} with ${e.with_name}: key revoked, ${r.deleted} shared copies deleted, a query with the old key returns ${r.query_after_stop}.`);
  },

  // One command for a new participant: put the card on, then connect whichever assistants are installed.
  async join() {
    await commands.on();
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const bin = fileURLToPath(import.meta.url);
    const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
    const added = [];
    if (has('claude')) {
      const r = spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'roloe', '--', 'node', bin, 'mcp'], { encoding: 'utf8' });
      added.push(r.status === 0 ? 'Claude Code' : `Claude Code (already set up or failed: ${(r.stderr || '').trim().slice(0, 80)})`);
    }
    if (has('codex')) {
      const r = spawnSync('codex', ['mcp', 'add', 'roloe', '--', 'node', bin, 'mcp'], { encoding: 'utf8' });
      added.push(r.status === 0 ? 'Codex' : `Codex (already set up or failed: ${(r.stderr || '').trim().slice(0, 80)})`);
    }
    out(added.length ? `Connected: ${added.join(', ')}.` : 'No Claude Code or Codex found on PATH; connect any MCP client to: node ' + bin + ' mcp');
    out('Now open your assistant in your project and say: "Call roloe_wait_for_tap, then follow its instructions; repeat."');
  },

  // Off-limits terms: names, clients, topics that must never be on the card or in a finding.
  async ['off-limits']() {
    const cfg = cfgFor();
    const [action = 'list', ...terms] = pos;
    const set = new Set(cfg.offLimits || []);
    if (action === 'add') terms.forEach((t) => set.add(t.trim()));
    else if (action === 'remove') terms.forEach((t) => set.delete(t.trim()));
    else if (action !== 'list') throw new Error('Usage: roloe off-limits list | add <term>... | remove <term>...');
    cfg.offLimits = [...set];
    saveConfig(cfg);
    if (action !== 'list') { const r = await refreshCard(cfg); out(`Card refreshed: ${r.passages} passages, ${r.totals.off_limits_removed} off-limits mentions removed.`); }
    out(`${cfg.offLimits.length} off-limits terms${cfg.offLimits.length ? ': ' + cfg.offLimits.join(', ') : ''}`);
  },

  async help() {
    out(`roloe join --url <coordinator> --owner <name> --name "<Name>" --project <dir>   (on + connect Claude Code / Codex)
roloe on --owner <name> --name "<Name>" --project <dir> [--url <coordinator>] [--same-person-as <your first card>]
roloe off | refresh | show [--all|--json] | private <passage_id> [--undo] | me
roloe tap <name> | inbox | try [<meeting>] [--project <dir>] | stop [<meeting>] | canary | mcp
roloe off-limits list | add <term>... | remove <term>...`);
  },
};

const fn = commands[cmd] || commands.help;
fn().catch((e) => { console.error(`roloe ${cmd}: ${e.message}`); process.exit(1); });
