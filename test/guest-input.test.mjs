// What a guest gives: a GitHub repo or subfolder, any public page, or one sentence.
// Fetched by the coordinator at scan time only, scrubbed, capped, and never from private addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseGuestLink, readGuestInput, htmlToText } from '../src/guest-input.mjs';

const publicDns = async () => [{ address: '140.82.112.3', family: 4 }];
function fakeFetch(routes) {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    for (const [re, body, type = 'text/plain'] of routes) if (re.test(String(url))) return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': type } });
    return new Response('nope', { status: 404 });
  };
  f.calls = calls;
  return f;
}

test('parses repo, subfolder and file links on GitHub, and other https pages', () => {
  assert.deepEqual(parseGuestLink('https://github.com/acme/widgets'), { kind: 'github', owner: 'acme', repo: 'widgets', ref: 'HEAD', path: '' });
  assert.deepEqual(parseGuestLink('https://github.com/acme/mono/tree/main/packages/api'), { kind: 'github', owner: 'acme', repo: 'mono', ref: 'main', path: 'packages/api' });
  assert.deepEqual(parseGuestLink('https://github.com/acme/mono/blob/dev/README.md'), { kind: 'github', owner: 'acme', repo: 'mono', ref: 'dev', path: 'README.md' });
  assert.equal(parseGuestLink('https://example.com/post').kind, 'page');
  assert.equal(parseGuestLink('http://example.com/post'), null, 'https only');
  assert.equal(parseGuestLink('javascript:alert(1)'), null);
});

// Repos are read from GitHub's tarball download (codeload), not the API: the API allows 60
// unauthenticated calls an hour per IP, and every judge at a venue shares one IP.
function tarball(files) {
  const root = mkdtempSync(join(tmpdir(), 'roloe-tgz-'));
  const top = join(root, 'repo-abc123');
  for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(top, f)), { recursive: true }); writeFileSync(join(top, f), t); }
  return readFileSync(execFileSync("sh", ["-c", `COPYFILE_DISABLE=1 tar -czf "${root}/x.tgz" -C "${root}" repo-abc123 && echo "${root}/x.tgz"`], { encoding: 'utf8' }).trim());
}
const tgzFetch = (bytes, calls = []) => Object.assign(async (url) => { calls.push(String(url)); return /codeload\.github\.com/.test(String(url)) ? new Response(bytes, { status: 200, headers: { 'content-type': 'application/x-gzip' } }) : new Response('no', { status: 404 }); }, { calls });

test('a GitHub subfolder: only that folder\'s text files, from the tarball, scrubbed', async () => {
  const bytes = tarball({
    'packages/api/README.md': '# API\nRetry uploads with backoff. Contact ops@example.com\n',
    'packages/api/src/retry.js': 'export async function retry(fn) { for (;;) { try { return await fn(); } catch {} } }\n',
    'packages/api/logo.png': 'PNG',
    'packages/api/.env': 'SECRET=' + 'abc123'.repeat(2),
    'packages/web/src/app.js': 'export const app = 1;\n',
  });
  const calls = [];
  const r = await readGuestInput({ link: 'https://github.com/acme/mono/tree/main/packages/api' }, { fetchImpl: tgzFetch(bytes, calls), lookup: publicDns });
  assert.equal(r.kind, 'github');
  assert.deepEqual(r.passages.map((p) => p.source).sort(), ['packages/api/README.md', 'packages/api/src/retry.js']);
  assert.ok(r.passages.every((p) => /^p-[0-9a-f]{6}$/.test(p.passage_id) && p.kind === 'file'));
  assert.ok(!JSON.stringify(r.passages).includes('ops@example.com'), 'scrubbed');
  assert.ok(!JSON.stringify(r.passages).includes('abc123abc123'), '.env never read');
  assert.equal(r.repo, 'https://github.com/acme/mono');
  assert.ok(calls.every((u) => u.startsWith('https://codeload.github.com/acme/mono/tar.gz/main')), 'no API calls');
});

test('a whole public repo: READMEs and source first, capped', async () => {
  const files = { 'README.md': '# Widgets\nRetry with backoff and jitter so pushes succeed.\n' };
  for (let i = 0; i < 80; i++) files[`src/m${i}.js`] = `export const m${i} = () => retry(${i});\n`;
  const r = await readGuestInput({ link: 'https://github.com/acme/widgets' }, { fetchImpl: tgzFetch(tarball(files)), lookup: publicDns });
  assert.equal(r.passages[0].source, 'README.md');
  assert.ok(r.files <= 40);
});

test('any public page: text only, scripts dropped, chunked', async () => {
  const html = '<html><head><title>My post</title><script>steal()</script><style>p{}</style></head><body><h1>Fixing flaky retries</h1><p>We pinned the embedding model &amp; it stopped.</p></body></html>';
  const r = await readGuestInput({ link: 'https://blog.example.com/post' }, { fetchImpl: fakeFetch([[/blog\.example\.com/, html, 'text/html']]), lookup: publicDns });
  assert.equal(r.kind, 'page');
  const all = r.passages.map((p) => p.text).join(' ');
  assert.match(all, /Fixing flaky retries/);
  assert.match(all, /pinned the embedding model & it stopped/);
  assert.ok(!all.includes('steal()'));
  assert.equal(htmlToText('<p>a</p><p>b</p>').trim(), 'a\nb');
});

test('one sentence, or nothing: no fetch at all', async () => {
  const f = fakeFetch([]);
  const r = await readGuestInput({ text: 'Stuck on flaky retries when the upload times out; token sk-ant-api03-' + 'x'.repeat(30) }, { fetchImpl: f, lookup: publicDns });
  assert.equal(r.kind, 'text');
  assert.equal(r.passages.length, 1);
  assert.equal(r.passages[0].speaker, 'owner');
  assert.ok(!r.passages[0].text.includes('sk-ant'));
  assert.equal(f.calls.length, 0);
  assert.equal((await readGuestInput({}, { fetchImpl: f, lookup: publicDns })).passages.length, 0);
});

test('never fetches private or local addresses, and a failed fetch is reported, not thrown', async () => {
  for (const addr of ['127.0.0.1', '10.1.0.84', '192.168.1.5', '169.254.169.254', '::1', 'fd00::1']) {
    const r = await readGuestInput({ link: 'https://internal.example/x' }, { fetchImpl: fakeFetch([[/./, 'secret']]), lookup: async () => [{ address: addr, family: addr.includes(':') ? 6 : 4 }] });
    assert.equal(r.passages.length, 0, addr);
    assert.match(r.error, /public/i, addr);
  }
  const down = await readGuestInput({ link: 'https://github.com/acme/gone' }, { fetchImpl: fakeFetch([]), lookup: publicDns });
  assert.match(down.error, /wasn't found|couldn't read/i);
  assert.ok(!/\d{3}/.test(down.error), 'no status codes');
  assert.equal(down.passages.length, 0);
  assert.ok(down.error);
});


test('a tarball that stalls never crashes anything, and a deep monorepo folder falls back to walking the tree', async () => {
  // A body that never finishes: the reader must give up cleanly at its deadline.
  const stall = async (url) => {
    if (/codeload/.test(String(url))) return new Response(new ReadableStream({ start() {} }), { status: 200 });
    if (/git\/trees\/main$/.test(String(url))) return new Response(JSON.stringify({ tree: [{ path: 'packages', type: 'tree', sha: 'pk' }] }), { status: 200 });
    if (/git\/trees\/pk$/.test(String(url))) return new Response(JSON.stringify({ tree: [{ path: 'api', type: 'tree', sha: 'ap' }] }), { status: 200 });
    if (/git\/trees\/ap\?recursive=1$/.test(String(url))) return new Response(JSON.stringify({ tree: [{ path: 'index.js', type: 'blob', size: 40 }] }), { status: 200 });
    if (/raw\.githubusercontent\.com\/acme\/huge\/main\/packages\/api\/index\.js$/.test(String(url))) return new Response('export const retryWithBackoff = () => 1;\n', { status: 200 });
    return new Response('no', { status: 404 });
  };
  const t0 = Date.now();
  const r = await readGuestInput({ link: 'https://github.com/acme/huge/tree/main/packages/api' }, { fetchImpl: stall, lookup: publicDns, timeoutMs: 3000 });
  assert.ok(Date.now() - t0 < 6000);
  assert.deepEqual(r.passages.map((p) => p.source), ['packages/api/index.js']);
});

test('the connection itself is pinned to a checked public address (no DNS rebinding)', async () => {
  const { guardedLookup } = await import('../src/guest-input.mjs');
  let calls = 0;
  const flip = async () => (++calls === 1 ? [{ address: '140.82.112.3', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
  const lk = guardedLookup(flip);
  const first = await new Promise((res) => lk('evil.example', { all: true }, (err, addrs) => res({ err, addrs })));
  assert.equal(first.err, null);
  const second = await new Promise((res) => lk('evil.example', { all: true }, (err, addrs) => res({ err, addrs })));
  assert.match(String(second.err?.message), /public/, 'the address used to connect is checked, every time');
});

test('byte caps hold while downloading: an endless page is cut off, not buffered', async () => {
  let sent = 0;
  const endless = async () => new Response(new ReadableStream({ pull(c) { sent += 65536; c.enqueue(new TextEncoder().encode('<p>' + 'retry backoff '.repeat(4600) + '</p>')); } }), { status: 200, headers: { 'content-type': 'text/html' } });
  const r = await readGuestInput({ link: 'https://endless.example/' }, { fetchImpl: endless, lookup: publicDns, timeoutMs: 3000 });
  assert.ok(r.passages.length > 0);
  assert.ok(sent < 2_000_000, `pulled ${sent} bytes`);
});

test('a slow tarball start still leaves time for the folder fallback', async () => {
  const f = async (url, opts = {}) => {
    const u = String(url);
    if (/codeload/.test(u)) return new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    if (/git\/trees\/main$/.test(u)) return new Response(JSON.stringify({ tree: [{ path: 'pkg', type: 'tree', sha: 'p1' }] }), { status: 200 });
    if (/git\/trees\/p1\?recursive=1$/.test(u)) return new Response(JSON.stringify({ tree: [{ path: 'a.js', type: 'blob', size: 30 }] }), { status: 200 });
    if (/raw\.githubusercontent\.com\/acme\/slow\/main\/pkg\/a\.js$/.test(u)) return new Response('export const retry = () => 1;\n', { status: 200 });
    return new Response('no', { status: 404 });
  };
  const r = await readGuestInput({ link: 'https://github.com/acme/slow/tree/main/pkg' }, { fetchImpl: f, lookup: publicDns, timeoutMs: 3000 });
  assert.deepEqual(r.passages.map((p) => p.source), ['pkg/a.js']);
});
