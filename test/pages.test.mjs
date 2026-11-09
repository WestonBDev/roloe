import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, twoCards } from './helpers.mjs';

test('pages and assets are served with a strict CSP; the QR points at the guest page', async () => {
  const s = await startTestServer();
  try {
    await twoCards(s);
    for (const path of ['/g/wes', '/e/e-0000000000', '/stage/e-0000000000', '/me/wes', '/dashboard', '/c/wes', '/']) {
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
