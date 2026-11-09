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
    wait: { type: 'string' }, port: { type: 'string' }, undo: { type: 'boolean' },
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
      const reg = await api({ url }, 'POST', '/api/owners', { owner, name: opt.name || owner, line: opt.line || '' }, { key: '' });
      cfg = { owner: reg.owner, name: opt.name || owner, url, key: reg.key, project: resolve(opt.project || process.cwd()), removed: [] };
      saveConfig(cfg);
      out(`Registered card "${cfg.owner}" at ${url}`);
    }
    if (opt.project) cfg.project = resolve(opt.project);
    if (opt.url) cfg.url = opt.url;
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
    for (const e of r.encounters) out(`${e.id}  with ${e.with_name}${e.guest ? ' (guest)' : ''}  ${e.posted ? 'posted' : 'not posted yet'}  ${e.link}`);
  },

  async tap() {
    const cfg = cfgFor();
    if (!pos[0]) throw new Error('Usage: roloe tap <their card name>');
    const r = await api(cfg, 'POST', '/api/tap', { to: pos[0] });
    out(`Tapped ${r.with}: meeting ${r.id} (ready in ${r.ready_ms} ms)`);
    out(`Your page: ${r.link}`);
    out(`Stage:     ${r.stage}`);
  },

  async help() {
    out(`roloe on --owner <name> --name "<Name>" --project <dir> [--url <coordinator>]
roloe off | refresh | show [--all|--json] | private <passage_id> [--undo] | me
roloe tap <name> | inbox | mcp`);
  },
};

const fn = commands[cmd] || commands.help;
fn().catch((e) => { console.error(`roloe ${cmd}: ${e.message}`); process.exit(1); });
