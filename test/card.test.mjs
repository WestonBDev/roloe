import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.mjs';

const P = (id, text, extra = {}) => ({ passage_id: id, kind: 'session', speaker: 'owner', source: 'session aa', locator: 'session aa #1', ts: new Date().toISOString(), text, ...extra });

test('the one switch: off refuses uploads and empties the card; on shows exactly what is shared', async () => {
  const s = await startTestServer();
  try {
    const { body: { key } } = await s.call('POST', '/api/owners', { owner: 'maya', name: 'Maya' });
    const auth = { authorization: `Bearer ${key}` };
    assert.equal((await s.call('PUT', '/api/cards/maya', { passages: [P('p-aaaaaa', 'hello')] }, auth)).status, 409);
    await s.call('POST', '/api/cards/maya/switch', { on: true }, auth);
    const up = await s.call('PUT', '/api/cards/maya', {
      passages: [P('p-aaaaaa', 'pinned the embedding model'), P('p-bbbbbb', 'mail me at maya@example.com'), P('bad-id', 'dropped'), P('p-aaaaaa', 'dup')],
      totals: { sessions: 1 },
    }, auth);
    assert.equal(up.body.passages, 2);
    assert.equal(up.body.rescrubbed, 1, 'coordinator re-scrubs on arrival');
    const shown = await s.call('GET', '/api/cards/maya/passages', null, auth);
    assert.deepEqual(shown.body.passages.map((p) => p.passage_id).sort(), ['p-aaaaaa', 'p-bbbbbb']);
    assert.ok(shown.body.passages.every((p) => p.owner_id === 'maya' && p.encounter_id === 'card:maya'));
    assert.ok(!JSON.stringify(shown.body).includes('maya@example.com'));
    assert.equal((await s.call('GET', '/api/cards/maya/passages')).status, 401);

    await s.call('POST', '/api/cards/maya/private', { passage_id: 'p-bbbbbb' }, auth);
    assert.deepEqual((await s.call('GET', '/api/cards/maya/passages', null, auth)).body.passages.map((p) => p.passage_id), ['p-aaaaaa']);
    // A private passage stays off the card on the next upload too.
    await s.call('PUT', '/api/cards/maya', { passages: [P('p-aaaaaa', 'a'), P('p-bbbbbb', 'b')] }, auth);
    assert.deepEqual((await s.call('GET', '/api/cards/maya/passages', null, auth)).body.passages.map((p) => p.passage_id), ['p-aaaaaa']);

    await s.call('POST', '/api/cards/maya/switch', { on: false }, auth);
    assert.equal((await s.call('GET', '/api/cards/maya/passages', null, auth)).body.passages.length, 0);
    assert.equal((await s.call('GET', '/api/cards/maya')).body.passages, 0);
  } finally { await s.close(); }
});

test('an upload still streaming when the switch goes off does not refill the card (Gitar)', async () => {
  const s = await startTestServer();
  try {
    const http = await import('node:http');
    const { body: { key } } = await s.call('POST', '/api/owners', { owner: 'race' });
    const auth = { authorization: `Bearer ${key}` };
    await s.call('POST', '/api/cards/race/switch', { on: true }, auth);
    const body = JSON.stringify({ passages: [P('p-aaaaaa', 'streamed passage')] });
    const u = new URL(s.base + '/api/cards/race');
    const done = new Promise((resolve) => {
      const req = http.request({ method: 'PUT', host: u.hostname, port: u.port, path: u.pathname, headers: { ...auth, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.write(body.slice(0, 10));
      setTimeout(async () => { await s.call('POST', '/api/cards/race/switch', { on: false }, auth); req.end(body.slice(10)); }, 100);
    });
    assert.equal(await done, 409);
    assert.equal((await s.call('GET', '/api/cards/race/passages', null, auth)).body.passages.length, 0);
  } finally { await s.close(); }
});

test('a passage kept private stays off the card when its file shifts by a line (Gitar)', async () => {
  const s = await startTestServer();
  try {
    const { body: { key } } = await s.call('POST', '/api/owners', { owner: 'priv' });
    const auth = { authorization: `Bearer ${key}` };
    await s.call('POST', '/api/cards/priv/switch', { on: true }, auth);
    const lines = Array.from({ length: 10 }, (_, i) => `const secretPlan${i} = "launch the private roadmap item ${i}";`);
    await s.call('PUT', '/api/cards/priv', { passages: [P('p-111111', lines.join('\n'), { kind: 'file', speaker: '' }), P('p-222222', 'public note about retries')] }, auth);
    await s.call('POST', '/api/cards/priv/private', { passage_id: 'p-111111' }, auth);
    // Next refresh: one line added at the top, so the window's text and ID both change.
    const shifted = ['// a new header line', ...lines.slice(0, 9)].join('\n');
    await s.call('PUT', '/api/cards/priv', { passages: [P('p-333333', shifted, { kind: 'file', speaker: '' }), P('p-222222', 'public note about retries')] }, auth);
    const ids = (await s.call('GET', '/api/cards/priv/passages', null, auth)).body.passages.map((p) => p.passage_id);
    assert.deepEqual(ids, ['p-222222']);
  } finally { await s.close(); }
});

test('marking a passage private twice keeps its protection; shared boilerplate lines never hide public passages (Gitar)', async () => {
  const s = await startTestServer();
  try {
    const { body: { key } } = await s.call('POST', '/api/owners', { owner: 'twice' });
    const auth = { authorization: `Bearer ${key}` };
    await s.call('POST', '/api/cards/twice/switch', { on: true }, auth);
    const secret = Array.from({ length: 6 }, (_, i) => `const hiddenPlan${i} = "private roadmap item ${i}";`);
    const boiler = ['import { test } from "node:test";', '} catch (err) {', '  return { ok: false, err };'];
    await s.call('PUT', '/api/cards/twice', { passages: [P('p-111111', [...boiler, ...secret].join('\n'), { kind: 'file', speaker: '' })] }, auth);
    await s.call('POST', '/api/cards/twice/private', { passage_id: 'p-111111' }, auth);
    await s.call('POST', '/api/cards/twice/private', { passage_id: 'p-111111' }, auth); // again
    const shifted = ['// header', ...secret.slice(0, 5)].join('\n');
    const publicOne = [boiler[0], boiler[1], 'console.log("public note about retries")'].join('\n');
    await s.call('PUT', '/api/cards/twice', { passages: [P('p-333333', shifted, { kind: 'file', speaker: '' }), P('p-444444', publicOne, { kind: 'file', speaker: '' })] }, auth);
    const ids = (await s.call('GET', '/api/cards/twice/passages', null, auth)).body.passages.map((p) => p.passage_id);
    assert.deepEqual(ids, ['p-444444']);
  } finally { await s.close(); }
});
