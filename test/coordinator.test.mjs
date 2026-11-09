import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer } from './helpers.mjs';

test('health, register, rotate, and every route is traced without content', async () => {
  const s = await startTestServer();
  try {
    const h = await s.call('GET', '/healthz');
    assert.equal(h.status, 200);
    assert.equal(h.body.store, 'memory', 'healthz says which store and scope are live');
    assert.ok(h.body.scope);
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

test('SIGTERM right after a registration still writes the card to disk', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dataDir = mkdtempSync(join(tmpdir(), 'roloe-sig-'));
  const port = 7600 + Math.floor(Math.random() * 300);
  const env = { ...process.env, PORT: String(port), ROLOE_DATA_DIR: dataDir, ROLOE_ENV_FILE: '/nonexistent', ES_URL: '', ELASTIC_URL: '' };
  const boot = () => new Promise((resolve) => {
    const p = spawn('node', ['src/coordinator.mjs'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.on('data', (d) => { if (String(d).includes('coordinator on')) resolve(p); });
  });
  let p = await boot();
  const reg = await fetch(`http://127.0.0.1:${port}/api/owners`, { method: 'POST', body: JSON.stringify({ owner: 'sig' }) });
  assert.equal(reg.status, 201);
  p.kill('SIGTERM');
  await new Promise((r) => p.on('exit', r));
  assert.ok(existsSync(join(dataDir, 'state.json')), 'state written on shutdown');
  p = await boot();
  const card = await fetch(`http://127.0.0.1:${port}/api/cards/sig`);
  p.kill('SIGTERM');
  assert.equal(card.status, 200);
});
