// What a guest gives at scan time, read by the coordinator: a public GitHub repo or subfolder,
// any public https page, or one sentence. Nothing is fetched before they scan, nothing from a
// private address, everything is scrubbed and capped, and it lives only in that meeting.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { scrub } from './scrub.mjs';

const MAX_FILES = 40;
const MAX_FILE_BYTES = 120_000;
const MAX_TOTAL_BYTES = 400_000;
const MAX_PAGE_BYTES = 600_000;
const TIMEOUT_MS = 8000;
const TEXT_EXT = /\.(md|mdx|txt|rst|js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|swift|rb|php|c|h|cc|cpp|cs|sh|ya?ml|toml|json|html|css|sql|vue|svelte)$/i;
const SKIP = /(^|\/)(\.env[^/]*|node_modules|dist|build|vendor|\.git|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.js|.*\.(pem|key|lock))(\/|$)/i;

const pid = (source, locator, text) => 'p-' + createHash('sha256').update(`guest|${source}|${locator}|${text.slice(0, 40)}`).digest('hex').slice(0, 6);

export function parseGuestLink(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (u.hostname === 'github.com') {
    const [owner, repo, mode, ref, ...rest] = u.pathname.replace(/^\/|\/$/g, '').split('/');
    if (owner && repo && /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo)) {
      if (!mode) return { kind: 'github', owner, repo: repo.replace(/\.git$/, ''), ref: 'HEAD', path: '' };
      if ((mode === 'tree' || mode === 'blob') && ref) return { kind: 'github', owner, repo, ref, path: rest.join('/') };
    }
  }
  return { kind: 'page', url: u.toString() };
}

// Refuse loopback, private, link-local, CGNAT and unique-local addresses (SSRF guard).
export function isPublicAddress(addr) {
  if (isIP(addr) === 4) {
    const [a, b] = addr.split('.').map(Number);
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  const s = addr.toLowerCase();
  if (s.startsWith('::ffff:')) return isPublicAddress(s.slice(7));
  return !(s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80'));
}

async function safeFetch(url, { fetchImpl, lookup, maxBytes, deadline }) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:') throw Object.assign(new Error('Only https links can be read.'), { code: 'not_https' });
    const addrs = await lookup(u.hostname, { all: true });
    if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) throw Object.assign(new Error('That link is not on the public internet.'), { code: 'not_public' });
    const res = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(500, deadline - Date.now())), headers: { 'user-agent': 'roloe-guest-reader', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { current = new URL(res.headers.get('location'), current).toString(); continue; }
    if (!res.ok) throw Object.assign(new Error(`That link answered ${res.status}.`), { code: `http_${res.status}` });
    const buf = Buffer.from(await res.arrayBuffer());
    return { text: buf.subarray(0, maxBytes).toString('utf8'), type: res.headers.get('content-type') || '' };
  }
  throw Object.assign(new Error('Too many redirects.'), { code: 'redirects' });
}

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

function chunkLines(text, source, kind, ts) {
  const lines = text.split('\n');
  const out = [];
  const size = kind === 'file' ? 50 : 18;
  for (let i = 0; i < lines.length && out.length < 30; i += size) {
    const body = lines.slice(i, i + size).join('\n').slice(0, 1500);
    if (body.trim().length < 15) continue;
    const locator = `${source}:L${i + 1}-${Math.min(i + size, lines.length)}`;
    out.push({ passage_id: pid(source, locator, body), kind, speaker: '', source, locator, ts, text: body, via: '' });
  }
  return out;
}

async function readGithub(g, opts) {
  const api = `https://api.github.com/repos/${g.owner}/${g.repo}/git/trees/${encodeURIComponent(g.ref)}?recursive=1`;
  const tree = JSON.parse((await safeFetch(api, { ...opts, maxBytes: 5_000_000 })).text);
  const prefix = g.path ? g.path.replace(/\/$/, '') : '';
  const files = (tree.tree || [])
    .filter((t) => t.type === 'blob' && (!prefix || t.path === prefix || t.path.startsWith(prefix + '/')))
    .filter((t) => TEXT_EXT.test(t.path) && !SKIP.test(t.path) && (t.size || 0) <= MAX_FILE_BYTES)
    // READMEs and source first, shallow paths first.
    .sort((a, b) => (/readme/i.test(b.path) - /readme/i.test(a.path)) || (a.path.split('/').length - b.path.split('/').length))
    .slice(0, MAX_FILES);
  const passages = [];
  let total = 0;
  const removed = [];
  const ts = new Date().toISOString();
  for (const f of files) {
    if (total > MAX_TOTAL_BYTES || Date.now() > opts.deadline) break;
    const raw = `https://raw.githubusercontent.com/${g.owner}/${g.repo}/${encodeURIComponent(g.ref)}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    let text;
    try { text = (await safeFetch(raw, { ...opts, maxBytes: MAX_FILE_BYTES })).text; } catch { continue; }
    total += text.length;
    const s = scrub(text);
    removed.push(...s.removed);
    passages.push(...chunkLines(s.text, f.path, 'file', ts));
  }
  return { passages: passages.slice(0, 120), files: files.length, removed: removed.length, repo: `https://github.com/${g.owner}/${g.repo}`, ref: g.ref, path: g.path };
}

async function readPage(p, opts) {
  const { text, type } = await safeFetch(p.url, { ...opts, maxBytes: MAX_PAGE_BYTES });
  const plain = /html/i.test(type) || /<html|<body|<p[\s>]/i.test(text.slice(0, 2000)) ? htmlToText(text) : text;
  const s = scrub(plain.slice(0, 120_000));
  const host = new URL(p.url).hostname;
  return { passages: chunkLines(s.text, host, 'link', new Date().toISOString()).slice(0, 40), removed: s.removed.length };
}

export async function readGuestInput({ link, text } = {}, { fetchImpl = fetch, lookup = dnsLookup } = {}) {
  const deadline = Date.now() + TIMEOUT_MS;
  const opts = { fetchImpl, lookup, deadline };
  const out = { kind: 'none', passages: [], error: null };
  const sentence = String(text || '').trim().slice(0, 600);
  if (sentence) {
    const s = scrub(sentence);
    out.kind = 'text';
    out.passages.push({ passage_id: pid('their words', 'note', s.text), kind: 'session', speaker: 'owner', source: 'what they are working on', locator: 'their note', ts: new Date().toISOString(), text: s.text, via: '' });
  }
  if (link) {
    const parsed = parseGuestLink(link);
    if (!parsed) { out.error = 'Only public https links can be read.'; return out; }
    try {
      const r = parsed.kind === 'github' ? await readGithub(parsed, opts) : await readPage(parsed, opts);
      out.kind = parsed.kind;
      out.passages.push(...r.passages);
      Object.assign(out, { repo: r.repo || null, ref: r.ref || null, path: r.path || null, files: r.files ?? null, removed: r.removed || 0 });
      if (!r.passages.length) out.error = 'Nothing readable was found at that link.';
    } catch (e) {
      out.error = e.code === 'not_public' ? 'That link is not on the public internet, so Roloe won\'t read it.' : `Couldn't read that link (${e.message}).`;
    }
  }
  return out;
}
