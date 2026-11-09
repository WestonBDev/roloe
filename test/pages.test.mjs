import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, twoCards } from './helpers.mjs';

test('pages and assets are served with a strict CSP; the QR points at the guest page', async () => {
  const s = await startTestServer();
  try {
    await twoCards(s);
    for (const path of ['/g/wes', '/e/e-0000000000', '/stage/e-0000000000', '/me/wes', '/dashboard', '/c/wes', '/', '/how']) {
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
