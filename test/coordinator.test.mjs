import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer } from './helpers.mjs';

test('health, register, rotate, and every route is traced without content', async () => {
  const s = await startTestServer();
  try {
    assert.equal((await s.call('GET', '/healthz')).status, 200);
    const reg = await s.call('POST', '/api/owners', { owner: 'Weston', name: 'Weston <b>', line: 'Builds Roloe' });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.owner, 'weston');
    assert.match(reg.body.key, /^rk_/);
    assert.equal((await s.call('POST', '/api/owners', { owner: 'weston' })).status, 409);
    const card = await s.call('GET', '/api/cards/weston');
    assert.equal(card.body.name, 'Weston b');
    assert.equal((await s.call('POST', '/api/owners/weston/rotate', {}, { authorization: 'Bearer wrong' })).status, 401);
    const rot = await s.call('POST', '/api/owners/weston/rotate', {}, { authorization: `Bearer ${reg.body.key}` });
    assert.equal(rot.status, 200);
    assert.notEqual(rot.body.key, reg.body.key);
    assert.equal((await s.call('POST', '/api/owners/weston/rotate', {}, { authorization: `Bearer ${reg.body.key}` })).status, 401);

    const { flush } = await import('../src/telemetry.mjs');
    await flush();
    const spans = readFileSync(join(s.dataDir, 'traces.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(spans.some((sp) => sp.name === 'POST /api/owners'));
    const all = JSON.stringify(spans);
    assert.ok(!all.includes(reg.body.key), 'card key must never reach telemetry');
    assert.ok(!all.includes('Builds Roloe'), 'card text must never reach telemetry');
  } finally { await s.close(); }
});
