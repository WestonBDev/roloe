// Real-user monitoring from the phone pages goes through the coordinator: the Dash0 token stays on
// the server, and meeting keys never leave the phone, even if a page forgets to scrub a URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardRum } from '../src/rum-proxy.mjs';

test('the RUM proxy strips meeting keys and card keys, caps size, and forwards with the server token', async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push({ url, opts }); return new Response('', { status: 200 }); };
  const body = JSON.stringify({ resourceSpans: [{ attrs: [{ key: 'url.full', value: { stringValue: 'https://r.example/e/e-1234567890?k=sk_SECRETSIDEKEY123456789&x=1' } }, { key: 'u2', value: { stringValue: '/me/weston#rk_CARDKEY1234567890abcdef' } }, { key: 'u3', value: { stringValue: '/stage/e-1?k=stk_STAGEKEY12345678901234' } }] }] });
  const r = await forwardRum('traces', body, 'application/json', { endpoint: 'https://ingress.example.com', headers: { Authorization: 'Bearer server-token' }, fetchImpl });
  assert.equal(r.status, 200);
  assert.equal(sent[0].url, 'https://ingress.example.com/v1/traces');
  assert.equal(sent[0].opts.headers.Authorization, 'Bearer server-token');
  const out = sent[0].opts.body;
  for (const leak of ['SECRETSIDEKEY', 'CARDKEY', 'STAGEKEY']) assert.ok(!out.includes(leak), leak);
  assert.equal((await forwardRum('traces', 'x'.repeat(600_000), 'application/json', { endpoint: 'https://i', headers: {}, fetchImpl })).status, 413);
  assert.equal((await forwardRum('profiles', '{}', 'application/json', { endpoint: 'https://i', headers: {}, fetchImpl })).status, 404);
  assert.equal((await forwardRum('traces', '{}', 'application/json', { endpoint: '', headers: {}, fetchImpl })).status, 204, 'off without an OTLP endpoint');
  assert.equal((await forwardRum('traces', 'AAAA', 'application/x-protobuf', { endpoint: 'https://i', headers: {}, fetchImpl })).status, 415, 'only JSON, which can be scrubbed');
});
