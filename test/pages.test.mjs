import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, twoCards } from './helpers.mjs';

test('pages and assets are served with a strict CSP; the QR points at the guest page', async () => {
  const s = await startTestServer();
  try {
    await twoCards(s);
    for (const path of ['/g/wes', '/e/e-0000000000', '/stage/e-0000000000', '/me/wes', '/dashboard', '/c/wes', '/', '/how', '/r']) {
      const r = await fetch(s.base + path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('content-type'), /text\/html/, path);
      assert.match(r.headers.get('content-security-policy'), /default-src 'self'/, path);
      assert.match(r.headers.get('content-security-policy'), /connect-src 'self'/, path);
      const html = await r.text();
      assert.match(html, /<title>[^<]*Roloe[^<]*<\/title>/, path);
      assert.match(html, /roloe\.css/, path);
    }
    const css = await fetch(s.base + '/roloe.css');
    assert.match(css.headers.get('content-type'), /text\/css/);
    const js = await fetch(s.base + '/roloe.js');
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(s.base + '/../package.json')).status, 404);
    assert.equal((await fetch(s.base + '/%2e%2e/package.json')).status, 404);
    const qr = await fetch(s.base + '/api/cards/wes/qr.svg');
    assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await qr.text(), /<svg/);
    assert.equal((await fetch(s.base + '/api/cards/nobody/qr.svg')).status, 404);
  } finally { await s.close(); }
});

test('the How it works page names the real components and the two trust zones', async () => {
  const s = await startTestServer();
  try {
    const html = await (await fetch(s.base + '/how')).text();
    for (const t of ['Roloe coordinator', 'no model, no logins', 'Elasticsearch', 'Dash0', 'roloe mcp', 'Try it', 'network none', "Each person's own machine and subscription", 'Roloe services: no model, no credentials', 'Card tap']) {
      assert.ok(html.includes(t), t);
    }
  } finally { await s.close(); }
});

test('QR is the one entry point: full-screen QR page, scan wording, guest input with "Nothing private, please"', async () => {
  const s = await startTestServer();
  try {
    await twoCards(s);
    const q = await fetch(s.base + '/q/wes');
    assert.equal(q.status, 200);
    const qh = await q.text();
    assert.match(qh, /Scan to meet/);
    const info = (await s.call('GET', '/api/cards/wes/qr.json')).body;
    assert.equal(info.url, `${process.env.ROLOE_PUBLIC_URL || 'http://localhost:7420'}/g/wes`);
    assert.equal(info.short, info.url.replace(/^https?:\/\//, ''));
    const g = await (await fetch(s.base + '/g/wes')).text();
    assert.match(g, /Nothing private, please/);
    assert.match(g, /What are you working on, or stuck on right now\?/);
    const gj = await (await fetch(s.base + '/guest.js')).text();
    assert.ok(!/Tap as/.test(gj), 'scan wording');
    const card = await (await fetch(s.base + '/c/wes')).text();
    assert.ok(!/Tap a phone/.test(card));
    const stage = await (await fetch(s.base + '/stage/e-0000000000')).text();
    assert.match(stage, /id="judgeqr"/);
    const pj = await (await fetch(s.base + '/person.js')).text();
    assert.match(pj, /Still reading/, 'an honest waiting state past a minute');
  } finally { await s.close(); }
});

test('the scanner\'s own Roloe: a stack of the cards they scanned, kept on their phone only', async () => {
  const s = await startTestServer();
  try {
    const html = await (await fetch(s.base + '/r')).text();
    assert.match(html, /Your Roloe/);
    assert.match(html, /only on this phone/);
    const js = await (await fetch(s.base + '/wheel.js')).text();
    assert.match(js, /prefers-reduced-motion/);
    const pj = await (await fetch(s.base + '/person.js')).text();
    assert.match(pj, /roloe\.wheel/, 'each meeting a phone joins is filed on that phone');
  } finally { await s.close(); }
});

test('phone pages: big targets, no leftover status dot, and your Roloe is a rotary file in 3D', async () => {
  const s = await startTestServer();
  try {
    const css = await (await fetch(s.base + '/roloe.css')).text();
    assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, 'a hidden status line shows nothing, not even its dot');
    assert.match(css, /button, \.btn \{ min-height: 60px/, 'thumb-sized buttons');
    const g = await (await fetch(s.base + '/g/wes')).text();
    assert.ok(!/usually within a minute|read only for this meeting, and deleted/.test(g), 'the scan page says only what the person needs to act');
    assert.match(g, /id="send" class="wide"/);
    const html = await (await fetch(s.base + '/r')).text();
    assert.match(html, /preserve-3d/);
    assert.match(html, /aria-roledescription="rotary card file"/);
    const js = await (await fetch(s.base + '/wheel.js')).text();
    assert.match(js, /angleFor/);
    assert.match(html, /prefers-reduced-motion: reduce\) \{ \.leaf, \.leaf \.shade \{ transition: none/, 'reduced motion: the file jumps instead of turning');
    assert.match(html, /transition: transform 440ms/, 'a turn is a compositor transition, never a repaint per frame');
  } finally { await s.close(); }
});
