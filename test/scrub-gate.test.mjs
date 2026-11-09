import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, secretShaped } from '../src/scrub.mjs';
import { gate, usableSecret } from '../src/gate.mjs';

// Test-only fake values, assembled at runtime so no secret-shaped literal sits in the repo.
const fake = (prefix, n = 32) => prefix + 'Ab3'.repeat(Math.ceil(n / 3)).slice(0, n);

test('scrubber removes each secret shape and keeps the value only in `removed`', () => {
  const cases = [
    ['anthropic key', fake('sk-ant-api03-')],
    ['openai key', fake('sk-proj-')],
    ['github token', fake('ghp_', 36)],
    ['aws key', 'AKIA' + 'ABCDEFGHIJ234567'],
    ['slack token', fake('xoxb-', 20)],
    ['jwt', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4fw'],
    ['bearer token', 'Bearer ' + fake('', 24)],
    ['email', 'someone@example.com'],
    ['long hex', 'a1'.repeat(21)],
  ];
  for (const [kind, value] of cases) {
    const s = scrub(`before ${value} after`);
    assert.ok(!s.text.includes(value), `${kind} leaked`);
    assert.match(s.text, new RegExp(`\\[removed: ${kind}\\]`), kind);
    assert.ok(s.removed.some((r) => r.value.includes(value) || value.includes(r.value)), kind);
  }
});

test('scrubber removes private key blocks and assigned secret values', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow' + 'x'.repeat(40) + '\n-----END RSA PRIVATE KEY-----';
  assert.equal(scrub(pem).text, '[removed: private key]');
  const s = scrub('DB_PASSWORD=hunter2isNotGood9');
  assert.equal(s.text, 'DB_PASSWORD=[removed: secret value]');
});

test('scrubber leaves references and identifiers alone (Nov 8 false positive)', () => {
  for (const t of ['const p = process.env.SITE_PASSWORD;', 'token: ${SECRET}', 'STEAM_KEY is read at boot', 'API_KEY=YOUR_KEY_HERE']) {
    assert.equal(scrub(t).text, t, t);
    assert.equal(scrub(t).removed.length, 0, t);
  }
});

test('scrubber turns home paths into ~', () => {
  assert.equal(scrub('see /Users/alice/dev/x and /home/bob/y').text, 'see ~/dev/x and ~/y');
});

test('gate blocks a known secret verbatim, respaced, base64, hex and by fragments', () => {
  const canary = 'roloe7canary3XQ9pz41mmk2';
  const known = [canary];
  assert.equal(gate(`here it is ${canary}`, known).ok, false);
  assert.equal(gate(canary.split('').join(' '), known).ok, false);
  assert.equal(gate(Buffer.from(`x ${canary} y`).toString('base64'), known).ok, false);
  assert.equal(gate(Buffer.from(`x ${canary} y`).toString('hex'), known).ok, false);
  assert.equal(gate('fragments roloe7canary3 then xq9pz41mmk2', known).ok, false);
  assert.equal(gate('A normal finding about canary deployments and roloe.', known).ok, true);
});

test('gate blocks secret-shaped strings even when unknown', () => {
  assert.equal(gate(`use ${fake('ghp_', 36)}`).ok, false);
  assert.equal(gate(`Bearer ${fake('', 30)}`).ok, false);
  assert.equal(secretShaped('nothing to see'), null);
});

test('gate ignores plain-word "secrets" so project vocabulary never blocks', () => {
  assert.equal(usableSecret('wishlist'), false);
  assert.equal(usableSecret('steam'), false);
  assert.equal(usableSecret('a@b.co'), true);
  assert.equal(gate('Wishlist and steam totals', ['wishlist', 'steam']).ok, true);
});

test('scrubbing keeps line numbers: a multi-line match leaves the same number of lines (Gitar)', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow' + 'x'.repeat(40) + '\nabc\n-----END RSA PRIVATE KEY-----';
  const text = `line one\n${pem}\nline after`;
  const out = scrub(text).text;
  assert.equal(out.split('\n').length, text.split('\n').length);
  assert.equal(out.split('\n')[5], 'line after');
});
