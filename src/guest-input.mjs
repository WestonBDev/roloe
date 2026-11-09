// What a guest gives at scan time, read by the coordinator: a public GitHub repo or subfolder,
// any public https page, or one sentence. Nothing is fetched before they scan, nothing from a
// private address, everything is scrubbed and capped, and it lives only in that meeting.
import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import { Readable } from 'node:stream';
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

// The address checked is the address connected to: the lookup runs inside the connection itself,
// so a host can't answer "public" to a check and "127.0.0.1" to the request (DNS rebinding).
export function guardedLookup(lookup = dnsLookup) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const all = typeof options === 'object' && options?.all;
    lookup(hostname, { all: true }).then((addrs) => {
      if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) return cb(Object.assign(new Error('That link is not on the public internet.'), { code: 'not_public' }));
      if (all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
    }, cb);
  };
}

// Default transport: node:https with the guarded lookup; the body is a stream, read under a cap.
function httpsFetch(lookup) {
  return (url, { signal, headers } = {}) => new Promise((resolve, reject) => {
    const req = https.request(url, { headers, lookup: guardedLookup(lookup), signal }, (res) => {
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return v == null ? null : String(v); } }, body: Readable.toWeb(res) });
    });
    req.on('error', reject);
    req.end();
  });
}

// Read at most maxBytes from a body stream, then stop downloading.
async function readCapped(body, maxBytes) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
      size += value.length;
    }
  } finally { reader.cancel().catch(() => {}); }
  return Buffer.concat(parts).subarray(0, maxBytes);
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
    const buf = await readCapped(res.body, maxBytes);
    return { text: buf.toString('utf8'), type: res.headers.get('content-type') || '' };
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

// Stream GitHub's tarball (codeload: no API rate limit), keep only the wanted folder's text files.
// Stops at a byte cap, so a huge monorepo can't stall a guest's scan.
const MAX_TARBALL_BYTES = 60_000_000;
async function readGithub(g, opts) {
  const url = `https://codeload.github.com/${g.owner}/${g.repo}/tar.gz/${encodeURIComponent(g.ref === 'HEAD' ? 'HEAD' : g.ref)}`;
  const u = new URL(url);
  const addrs = await opts.lookup(u.hostname, { all: true });
  if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) throw Object.assign(new Error('not public'), { code: 'not_public' });
  const prefix = g.path ? g.path.replace(/\/$/, '') : '';
  const wanted = (path, size) => (!prefix || path === prefix || path.startsWith(prefix + '/')) && TEXT_EXT.test(path) && !SKIP.test(path) && size <= MAX_FILE_BYTES;
  const candidates = [];
  let candidateBytes = 0;
  // With a folder, leave time to fall back to walking the tree if the tarball can't reach it:
  // the deadline covers the request itself too, since codeload builds big tarballs on the fly.
  const tarDeadline = prefix ? Math.round(Date.now() + (opts.deadline - Date.now()) * 0.55) : opts.deadline;
  let cutOff = false;
  try {
    const ac = new AbortController();
    let t;
    const res = await Promise.race([
      opts.fetchImpl(url, { signal: ac.signal, headers: { 'user-agent': 'roloe-guest-reader' } }),
      new Promise((_, rej) => { t = setTimeout(() => { ac.abort(); rej(Object.assign(new Error('tarball too slow'), { code: 'slow' })); }, Math.max(300, tarDeadline - Date.now())); }),
    ]).finally(() => clearTimeout(t));
    if (!res.ok || !res.body) throw Object.assign(new Error(`GitHub answered ${res.status}`), { code: `http_${res.status}` });
    ({ cutOff } = await untar(res.body, {
      maxBytes: MAX_TARBALL_BYTES,
      deadline: tarDeadline,
      onFile(path, size) { return wanted(path, size) && candidateBytes < 3_000_000 && candidates.length < 400; },
      file(path, buf) { candidates.push({ path, text: buf.toString('utf8') }); candidateBytes += buf.length; },
    }));
  } catch (e) {
    if (!prefix || e.code === 'not_public') throw e;
    cutOff = true;
  }
  if (prefix && !candidates.length && cutOff) candidates.push(...await walkFolder(g, prefix, opts, wanted));
  // READMEs first, then shallow paths, then the rest.
  candidates.sort((a, b) => (/readme/i.test(b.path) - /readme/i.test(a.path)) || (a.path.split('/').length - b.path.split('/').length) || a.path.localeCompare(b.path));
  const files = candidates.slice(0, MAX_FILES);
  const passages = [];
  let total = 0;
  let removed = 0;
  const ts = new Date().toISOString();
  for (const f of files) {
    if (total > MAX_TOTAL_BYTES) break;
    total += f.text.length;
    const sc = scrub(f.text);
    removed += sc.removed.length;
    passages.push(...chunkLines(sc.text, f.path, 'file', ts));
  }
  if (prefix && !candidates.length) throw Object.assign(new Error('that folder was not found or has no readable files'), { code: 'no_path' });
  return { passages: passages.slice(0, 120), files: files.length, removed, repo: `https://github.com/${g.owner}/${g.repo}`, ref: g.ref, path: g.path };
}

// Fallback for a folder deep inside a huge monorepo: walk the tree to it (a few API calls),
// then fetch its files from raw.githubusercontent.com.
async function walkFolder(g, prefix, opts, wanted) {
  const trees = `https://api.github.com/repos/${g.owner}/${g.repo}/git/trees`;
  const getTree = async (ref, recursive) => JSON.parse((await safeFetch(`${trees}/${encodeURIComponent(ref)}${recursive ? '?recursive=1' : ''}`, { ...opts, maxBytes: 8_000_000 })).text);
  let sha = g.ref;
  let entries = [];
  const parts = prefix.split('/');
  for (const [i, part] of parts.entries()) {
    const hit = ((await getTree(sha, false)).tree || []).find((t) => t.path === part);
    if (!hit) return [];
    if (hit.type === 'blob') { entries = [{ path: prefix, type: 'blob', size: hit.size || 0 }]; break; }
    sha = hit.sha;
    if (i === parts.length - 1) entries = ((await getTree(sha, true)).tree || []).map((t) => ({ ...t, path: `${prefix}/${t.path}` }));
  }
  const files = entries.filter((t) => t.type === 'blob' && wanted(t.path, t.size || 0))
    .sort((a, b) => (/readme/i.test(b.path) - /readme/i.test(a.path)) || (a.path.split('/').length - b.path.split('/').length)).slice(0, MAX_FILES);
  // Fetch in parallel: a scan shouldn't wait on files one by one.
  const got = await Promise.all(files.map(async (f) => {
    const raw = `https://raw.githubusercontent.com/${g.owner}/${g.repo}/${encodeURIComponent(g.ref)}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    try { return { path: f.path, text: (await safeFetch(raw, { ...opts, maxBytes: MAX_FILE_BYTES })).text }; } catch { return null; }
  }));
  return got.filter(Boolean);
}

// A minimal streaming tar reader (ustar + pax path headers) over a gzip stream.
async function untar(webStream, { maxBytes, deadline, onFile, file }) {
  const { createGunzip } = await import('node:zlib');
  const { Readable } = await import('node:stream');
  const source = Readable.fromWeb(webStream);
  const gunzip = source.pipe(createGunzip());
  // A stalled or broken download must end cleanly at the deadline, never crash the coordinator.
  source.on('error', () => {});
  gunzip.on('error', () => {});
  let cutOff = false;
  const timer = setTimeout(() => { cutOff = true; source.destroy(); gunzip.destroy(); }, Math.max(0, deadline - Date.now()));
  let buf = Buffer.alloc(0);
  let seen = 0;
  let entry = null;     // the current entry: { path, size, toRead (size + padding), keep, pax, chunks }
  let paxPath = null;
  const octal = (b) => parseInt(b.toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
  const strip = (p) => p.split('/').slice(1).join('/');   // drop the "<repo>-<sha>/" top folder
  try {
  for await (const chunk of gunzip) {
    seen += chunk.length;
    if (seen > maxBytes || Date.now() > deadline) { cutOff = true; source.destroy(); gunzip.destroy(); break; }
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (entry) {
        const take = Math.min(entry.toRead, buf.length);
        const dataLeft = Math.max(0, entry.size - entry.got);
        if ((entry.keep || entry.pax) && dataLeft) entry.chunks.push(buf.subarray(0, Math.min(take, dataLeft)));
        entry.got += take;
        entry.toRead -= take;
        buf = buf.subarray(take);
        if (entry.toRead > 0) break;
        const body = Buffer.concat(entry.chunks);
        if (entry.pax) { const m = body.toString('utf8').match(/\d+ path=([^\n]*)\n/); if (m) paxPath = m[1]; }
        else if (entry.keep) file(entry.path, body);
        entry = null;
        continue;
      }
      if (buf.length < 512) break;
      const h = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (h.every((x) => x === 0)) continue;
      const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      const pre = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
      const size = octal(h.subarray(124, 136));
      const type = String.fromCharCode(h[156] || 48);
      const path = strip(paxPath || (pre ? `${pre}/${name}` : name));
      if (type !== 'x') paxPath = null;
      const isFile = type === '0' || type === '\0';
      const keep = isFile && Boolean(path) && !/(^|\/)\._/.test(path) && onFile(path, size);
      entry = { path, size, got: 0, toRead: size + ((512 - (size % 512)) % 512), keep, pax: type === 'x', chunks: [] };
    }
  }
  } catch { cutOff = true; } finally { clearTimeout(timer); }
  return { cutOff };
}

async function readPage(p, opts) {
  const { text, type } = await safeFetch(p.url, { ...opts, maxBytes: MAX_PAGE_BYTES });
  const plain = /html/i.test(type) || /<html|<body|<p[\s>]/i.test(text.slice(0, 2000)) ? htmlToText(text) : text;
  const s = scrub(plain.slice(0, 120_000));
  const host = new URL(p.url).hostname;
  return { passages: chunkLines(s.text, host, 'link', new Date().toISOString()).slice(0, 40), removed: s.removed.length };
}

// Plain words for the guest's phone, never raw status codes.
function friendly(e, kind) {
  const code = String(e.code || '');
  if (code === 'not_public') return 'That link is not on the public internet, so Roloe won\'t read it.';
  if (code === 'http_404' || code === 'no_path') return kind === 'github' ? 'That repo or folder wasn\'t found. Is it public?' : 'That page wasn\'t found.';
  if (code === 'http_403' || code === 'http_429') return 'GitHub is limiting lookups right now. Try the repo link itself, a file link, or a sentence.';
  if (code === 'not_https') return 'Only https links can be read.';
  return kind === 'github' ? 'Couldn\'t read that repo just now.' : 'Couldn\'t read that page just now.';
}

export async function readGuestInput({ link, text } = {}, { fetchImpl, lookup = dnsLookup, timeoutMs = TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  const opts = { fetchImpl: fetchImpl || httpsFetch(lookup), lookup, deadline };
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
      out.error = friendly(e, parsed.kind);
    }
  }
  return out;
}
