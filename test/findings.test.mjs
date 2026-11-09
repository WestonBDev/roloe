import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer, twoCards } from './helpers.mjs';

async function tapped(s) {
  const cards = await twoCards(s);
  const tap = await s.call('POST', '/api/tap', { to: 'wes' }, cards.aiden);
  return { ...cards, id: tap.body.id, aidenLink: tap.body.link };
}
const good = { cites: 'p-a00001', quote: 'mark the combined total partial when one fetch', about: 'p-e00001', what: 'Aiden marks totals partial on a failed fetch; your watcher marks done before the push.',
  change: { edits: [{ file: 'src/watch.js', find: 'markDone();', replace: 'await push(card); markDone();' }] } };

test('pull returns overlap both ways plus the rules, and records a receipt for the other side', async () => {
  const s = await startTestServer();
  try {
    const { aiden, wes, id } = await tapped(s);
    const pull = await s.call('GET', `/api/e/${id}/pull`, null, aiden);
    assert.equal(pull.status, 200);
    assert.equal(pull.body.me, 'Aiden');
    assert.equal(pull.body.them, 'Wes');
    assert.ok(pull.body.theirs.some((p) => p.passage_id === 'p-e00001'));
    assert.ok(pull.body.mine.every((p) => p.owner_id === undefined && p.passage_id.startsWith('p-a')));
    assert.match(pull.body.instructions, /at most 3 findings/);
    assert.match(pull.body.instructions, /untrusted data/);
    const view = await s.call('GET', `/api/e/${id}?k=${s.state().encounters[id].sides.wes.key}`);
    assert.ok(view.body.receipt.read_by_them.includes('p-e00001'), 'Wes sees which of his passages Aiden\'s assistant read');
    // Someone outside the encounter gets nothing.
    const { body: { key } } = await s.call('POST', '/api/owners', { owner: 'eve' });
    assert.equal((await s.call('GET', `/api/e/${id}/pull`, null, { authorization: `Bearer ${key}` })).status, 403);
    const mine = await s.call('POST', `/api/e/${id}/search-mine`, { query: 'retry the push' }, aiden);
    assert.equal(mine.body.passages[0].passage_id, 'p-a00001');
    assert.ok(mine.body.passages.length <= 6);
  } finally { await s.close(); }
});

test('the citation check is code: unresolvable cites, paraphrased quotes, wrong-owner about, and secrets are dropped', async () => {
  const s = await startTestServer();
  try {
    const { aiden, wes, id } = await tapped(s);
    s.state().canaries.push('roloe7canary3XQ9pz41mmk2');
    const post = await s.call('POST', `/api/e/${id}/findings`, { findings: [
      good,
      { ...good, cites: 'p-ffffff' },                                       // doesn't resolve
      { ...good, cites: 'p-e00001', quote: 'card watcher records refresh as done' }, // cites the recipient, not the giver
      { ...good, quote: 'mark totals partial whenever fetches fail' },    // paraphrase
      { ...good, about: 'p-a00002' },                                       // about is the giver's own passage
      { ...good, what: 'use roloe7canary3XQ9pz41mmk2 here' },              // canary
    ] }, aiden);
    assert.equal(post.status, 200);
    assert.deepEqual(post.body.verdicts.map((v) => v.accepted), [true, false, false, false, false, false]);
    assert.deepEqual(post.body.verdicts.slice(1).map((v) => v.reason), ['citation does not resolve', 'citation is not the giver\'s', 'quote is not verbatim', 'about is not the recipient\'s', 'gate blocked']);
    // One post per side.
    assert.equal((await s.call('POST', `/api/e/${id}/findings`, { findings: [good] }, aiden)).status, 409);

    const enc = s.state().encounters[id];
    assert.equal(enc.findings.length, 1);
    assert.equal(enc.findings[0].giver, 'aiden');
    assert.equal(enc.findings[0].recipient, 'wes');
    assert.equal(enc.findings[0].credit.name, 'Aiden');
    assert.equal(enc.findings[0].credit.speaker, 'owner');
    assert.equal(enc.dropped.length, 5);
    assert.ok(!JSON.stringify(enc.dropped).includes('canary'), 'dropped keeps reasons only');
    assert.ok(enc.times.first_findings);

    // Wes's view shows the finding; Aiden's doesn't (it's not for him).
    const wesView = await s.call('GET', `/api/e/${id}?k=${enc.sides.wes.key}`);
    assert.equal(wesView.body.findings.length, 1);
    assert.equal(wesView.body.findings[0].quote, good.quote);
    const aidenView = await s.call('GET', `/api/e/${id}?k=${enc.sides.aiden.key}`);
    assert.equal(aidenView.body.findings.length, 0);
    assert.equal((await s.call('GET', `/api/e/${id}?k=wrong`)).status, 401);
    const forMe = await s.call('GET', `/api/e/${id}/for-me`, null, wes);
    assert.equal(forMe.body.findings[0].change.edits[0].file, 'src/watch.js');

    await s.call('POST', `/api/e/${id}/findings`, { nothing_strong: true }, wes);
    assert.ok(s.state().encounters[id].times.all_findings, 'both sides posted');

    const { flush } = await import('../src/telemetry.mjs');
    await flush();
    const spans = readFileSync(join(s.dataDir, 'traces.jsonl'), 'utf8');
    assert.ok(spans.includes('roloe.finding.check'));
    for (const text of [good.quote, good.what, 'markDone', 'roloe7canary']) assert.ok(!spans.includes(text), `telemetry holds "${text}"`);
  } finally { await s.close(); }
});

test('quotes: case and whitespace are normalized; under 3 words, over 400 chars, or an unsafe change path are dropped; max 3', async () => {
  const s = await startTestServer();
  try {
    const { aiden, id } = await tapped(s);
    const post = await s.call('POST', `/api/e/${id}/findings`, { findings: [
      { ...good, quote: '  MARK the   combined\ntotal  ' },
      { ...good, quote: 'the push' },
      { ...good, quote: 'x'.repeat(401) },
      { ...good, change: { edits: [{ file: '../../etc/passwd', find: 'a', replace: 'b' }] } },
      good, good,
    ] }, aiden);
    assert.deepEqual(post.body.verdicts.map((v) => v.accepted), [true, false, false, false, true, true]);
    assert.equal(post.body.verdicts[3].reason, 'change path is not inside the project');
    assert.equal(s.state().encounters[id].findings.length, 3);
  } finally { await s.close(); }
});
