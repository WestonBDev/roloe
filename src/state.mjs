// Owner and encounter records, kept in memory and written to one JSON file so a restart
// doesn't turn a real card into "This card does not exist". Card keys are stored only as hashes.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './env.mjs';

const file = join(config.dataDir, 'state.json');
export const state = { owners: {}, encounters: {}, canaries: [] };

export function load() {
  if (!existsSync(file)) return;
  try { Object.assign(state, JSON.parse(readFileSync(file, 'utf8'))); } catch { /* start clean */ }
}
let timer = null;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(saveNow, 150);
}
export function saveNow() {
  clearTimeout(timer);
  mkdirSync(config.dataDir, { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, file);
}

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const newKey = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;
export const newId = (prefix, bytes = 5) => `${prefix}-${randomBytes(bytes).toString('hex')}`;

export function sameHash(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Owner IDs are short lowercase handles: they appear in URLs and in assistants' context.
export function cleanOwnerId(s) {
  const id = String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
  return id;
}
// Names enter assistants' context, so keep them to plain characters.
export function cleanName(s) {
  return String(s || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40);
}
export function cleanLine(s, max = 120) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, max);
}
