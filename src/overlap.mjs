// Overlap retrieval at tap time. For each giver: run ~40 of their own passages as queries
// against the recipient's passages in this encounter, fuse ranks with reciprocal rank fusion
// (1 / (60 + rank)), keep the top 8 ("theirs") with up to 3 slots for the recipient's files so a
// finding can carry a code change, and keep the giver passages that produced those hits ("mine").
import { tokens } from './store/text.mjs';

const RRF_K = 60;
const MIX = [['owner', 0.40], ['assistant', 0.35], ['commit', 0.15], ['file', 0.10]];
const bucketOf = (p) => (p.kind === 'commit' ? 'commit' : p.kind === 'file' ? 'file' : p.speaker === 'assistant' ? 'assistant' : 'owner');

export function pickQueries(passages, max = 40) {
  const byBucket = Object.fromEntries(MIX.map(([b]) => [b, []]));
  for (const p of passages) if (tokens(p.text).length) byBucket[bucketOf(p)].push(p);
  for (const list of Object.values(byBucket)) list.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const picked = [];
  for (const [b, share] of MIX) picked.push(...byBucket[b].splice(0, Math.round(max * share)));
  // Fill from whatever is left, newest first, when a bucket ran short.
  const rest = Object.values(byBucket).flat().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  while (picked.length < max && rest.length) picked.push(rest.shift());
  return picked.slice(0, max);
}

// Strip paths and URLs from the query text so filesystem layout never drives a match.
const queryText = (p) => tokens(p.text).join(' ');

// For a guest, the direction flips: their material (one sentence, a page, a repo folder) is the query,
// searched over the giver's whole card. A few searches, and "mine" is what answers them best.
async function guestOverlap(store, keyId, { giver, recipient, theirsMax, mineMax, hybrid }) {
  const theirsAll = await store.list(keyId, recipient);
  const queries = theirsAll
    .filter((p) => queryText(p))
    .sort((a, b) => (b.speaker === 'owner') - (a.speaker === 'owner') || (/readme/i.test(b.source) - /readme/i.test(a.source)))
    .slice(0, 12);
  const results = queries.length ? await store.msearch(keyId, queries.map(queryText), { owner: giver, k: 6, hybrid }) : [];
  const fused = new Map();
  const credit = new Map();
  results.forEach((hits, qi) => hits.forEach((h, rank) => {
    if (tokens(h.text).length < 2) return;
    const sc = 1 / (RRF_K + rank + 1);
    fused.set(h.passage_id, (fused.get(h.passage_id) || 0) + sc);
    credit.set(queries[qi].passage_id, (credit.get(queries[qi].passage_id) || 0) + sc);
  }));
  const mine = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, mineMax).map(([id]) => id);
  const theirs = [...credit.entries()].sort((a, b) => b[1] - a[1]).slice(0, theirsMax).map(([id]) => id);
  return { theirs, mine, counts: { queries: queries.length, searches: results.length, candidates: fused.size, theirs: theirs.length, mine: mine.length } };
}

export async function computeOverlap(store, keyId, { giver, recipient, theirsMax = 8, fileSlots = 3, mineMax = 8, hybrid = false, queriesFrom = 'giver' }) {
  if (queriesFrom === 'recipient') return guestOverlap(store, keyId, { giver, recipient, theirsMax, mineMax, hybrid });
  const giverPassages = await store.list(keyId, giver);
  const queries = pickQueries(giverPassages).filter((p) => queryText(p));
  const results = queries.length ? await store.msearch(keyId, queries.map(queryText), { owner: recipient, k: 5, hybrid }) : [];

  const fused = new Map();       // recipient passage -> { score, kind }
  const credit = new Map();      // giver passage -> score from hits
  results.forEach((hits, qi) => {
    hits.forEach((h, rank) => {
      if (tokens(h.text).length < 2) return;
      const s = 1 / (RRF_K + rank + 1);
      const f = fused.get(h.passage_id) || { score: 0, kind: h.kind, by: new Set() };
      f.score += s;
      f.by.add(queries[qi].passage_id);
      fused.set(h.passage_id, f);
    });
  });
  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score);
  let theirs = ranked.slice(0, theirsMax);
  const filesIn = theirs.filter(([, f]) => f.kind === 'file').length;
  const spareFiles = ranked.slice(theirsMax).filter(([, f]) => f.kind === 'file').slice(0, Math.max(0, fileSlots - filesIn));
  if (spareFiles.length) {
    const keep = theirs.filter(([, f]) => f.kind === 'file');
    const others = theirs.filter(([, f]) => f.kind !== 'file').slice(0, theirsMax - keep.length - spareFiles.length);
    theirs = [...others, ...keep, ...spareFiles].sort((a, b) => b[1].score - a[1].score);
  }
  for (const [, f] of theirs) {
    for (const g of f.by) credit.set(g, (credit.get(g) || 0) + f.score);
  }
  const mine = [...credit.entries()].sort((a, b) => b[1] - a[1]).slice(0, mineMax).map(([id]) => id);
  return {
    theirs: theirs.map(([id]) => id),
    mine,
    counts: { queries: queries.length, searches: results.length, candidates: fused.size, theirs: theirs.length, mine: mine.length },
  };
}
