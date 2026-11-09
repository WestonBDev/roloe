// Owner-side client: local config (card key, removed secret values) and coordinator calls.
// Used by the CLI and the MCP server. Nothing here talks to any model or assistant login.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const roloeHome = () => process.env.ROLOE_HOME || process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.roloe');

export function currentOwner() {
  if (process.env.ROLOE_OWNER) return process.env.ROLOE_OWNER;
  const f = join(roloeHome(), 'current');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
}

export function loadConfig(owner = currentOwner()) {
  if (!owner) throw new Error('No card yet. Run: roloe on --owner <name> --project <dir>');
  const f = join(roloeHome(), `${owner}.json`);
  if (!existsSync(f)) throw new Error(`No local card for "${owner}". Run: roloe on --owner ${owner} --project <dir>`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

export function saveConfig(cfg) {
  const dir = roloeHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, `${cfg.owner}.json`);
  writeFileSync(f, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(f, 0o600);
  writeFileSync(join(dir, 'current'), cfg.owner, { mode: 0o600 });
}

export async function api(cfg, method, path, body, { key = cfg.key, timeoutMs = 20000 } = {}) {
  const res = await fetch(cfg.url.replace(/\/$/, '') + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { message: text }; }
  if (!res.ok) {
    const e = new Error(json.message || `${res.status}`);
    e.status = res.status; e.code = json.error;
    throw e;
  }
  return json;
}

// Index the project and upload. Returns counts. Removed values stay in the local config.
export async function refreshCard(cfg) {
  const { buildCard } = await import('./indexer.mjs');
  const card = buildCard({ owner: cfg.owner, projectDir: cfg.project });
  cfg.removed = [...new Set([...(cfg.removed || []), ...card.removed])].slice(-500);
  saveConfig(cfg);
  const scope = `today's work in ${cfg.project.split('/').pop()}`;
  const out = await api(cfg, 'PUT', `/api/cards/${cfg.owner}`, { passages: card.passages, totals: card.totals, scope });
  return { ...out, totals: card.totals };
}
