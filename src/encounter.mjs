// Encounter lifecycle: tap → copies and key → overlap both ways. Each step is a span under the
// encounter's root span. Spans carry IDs, counts and HMACs only.
import { config } from './env.mjs';
import { state, save, newId, newKey } from './state.mjs';
import { startEncounterTrace, endEncounterTrace, destroyHmacKey, step, hmac, logEvent } from './telemetry.mjs';
import { computeOverlap } from './overlap.mjs';
import { gate } from './gate.mjs';
import { tokens } from './store/text.mjs';
import { record } from './metrics.mjs';
import { syncMeeting } from './meeting-record.mjs';

export const sideLink = (enc, who) => `${config.publicUrl}/e/${enc.id}?k=${enc.sides[who].key}`;
export const stageLink = (enc) => `${config.publicUrl}/stage/${enc.id}?k=${enc.stageKey}`;

export function newSide() {
  return { key: newKey('sk'), seal: null, posted: false, nothing_strong: false, retrieved_by_other: [], findings_seen: false };
}

export async function createEncounter(store, a, b, { guest = null, guestPassages = [], preset = null } = {}) {
  const id = preset?.id || newId('e', 5);
  const now = preset?.tap || Date.now();
  const enc = {
    id, a: a.owner, b: b.owner, names: { [a.owner]: a.name, [b.owner]: b.name },
    created: new Date(now).toISOString(), status: 'open', guest,
    // Two cards of one person: allowed as a labelled last resort, and every screen says so.
    same_person: Boolean(a.same_person_as === b.owner || b.same_person_as === a.owner || (a.same_person_as && a.same_person_as === b.same_person_as)),
    stageKey: preset?.stageKey || newKey('stk'), sides: preset?.sides || { [a.owner]: newSide(), [b.owner]: newSide() },
    findings: [], dropped: [], tries: [], tryStatus: null, thanks: [],
    times: { tap: now, ready: null, first_findings: null, all_findings: null, green: null },
    overlap: {}, keyId: null, trace: null, closed: null,
  };
  enc.trace = preset?.trace || startEncounterTrace(id, { 'roloe.guest': Boolean(guest) });
  const ref = { encounterId: id, ...enc.trace };
  try {
    await buildEncounter(store, enc, ref, a, b, guest, guestPassages);
    logEvent('meeting.started', { ref, attrs: { 'roloe.guest': Boolean(guest) } });
    if (enc.instant) logEvent('meeting.instant_shown', { ref, attrs: { 'roloe.instant.kind': enc.instant.kind } });
  } catch (e) {
    // Leave nothing half-built: no copies, no live key, no open record.
    if (enc.keyId) await store.invalidateKey(enc.keyId).catch(() => {});
    await store.deleteEncounter(id).catch(() => {});
    endEncounterTrace(id, { 'roloe.tap.failed': true, 'error.type': e.code || e.name || 'error' });
    destroyHmacKey(id);
    throw e;
  }
  // Registered only once it's complete.
  state.encounters[id] = enc;
  record.meeting(enc.guest ? 'guest' : enc.same_person ? 'same_person' : 'pair');
  syncMeeting(store, enc);
  save();
  return enc;
}

async function buildEncounter(store, enc, ref, a, b, guest, guestPassages) {
  const id = enc.id;

  await step('roloe.tap', ref, { 'roloe.side_a': hmac(id, a.owner), 'roloe.side_b': hmac(id, b.owner) }, async (span) => {
    const owners = [a.owner, b.owner].filter((o) => !o.startsWith('guest-'));
    // A guest's material is written right after this copy; one wait for a refresh covers both.
    const copied = await store.copyCardsToEncounter(id, owners, { deferRefresh: Boolean(guest && guestPassages.length) });
    const key = await store.createEncounterKey(id);
    enc.keyId = key.id;
    const d = store.describe();
    span.setAttributes({ 'roloe.scope.passages': copied, 'roloe.scope.mode': d.scope, 'roloe.store': d.store, 'roloe.key_id_hmac': hmac(id, key.id) });
  });

  // A guest's material (their repo, page or sentence) lives only inside this meeting.
  if (guest && guestPassages.length) {
    await step('roloe.guest_input', ref, { 'roloe.guest.kind': guest.kind || 'none', 'roloe.guest.passages': guestPassages.length }, async () => {
      await store.addToEncounter(id, b.owner, b.name, guestPassages);
    });
  }
  const directions = guest ? (guestPassages.length ? [[a.owner, b.owner]] : []) : [[a.owner, b.owner], [b.owner, a.owner]];
  {
    for (const [giver, recipient] of directions) {
      await step('roloe.overlap', ref, { 'roloe.giver': hmac(id, giver) }, async (span) => {
        const o = await computeOverlap(store, enc.keyId, { giver, recipient, hybrid: store.describe().rrf === 'elasticsearch', queriesFrom: guest ? 'recipient' : 'giver' });
        enc.overlap[giver] = { theirs: o.theirs, mine: o.mine };
        span.setAttributes({
          'roloe.overlap.queries': o.counts.queries, 'roloe.overlap.searches': o.counts.searches,
          'roloe.overlap.candidates': o.counts.candidates, 'roloe.overlap.theirs': o.counts.theirs, 'roloe.overlap.mine': o.counts.mine,
        });
      });
    }
  }
  // "Their words, instantly": the giver's best match for what the guest gave, verbatim and cited,
  // shown before any model runs. Already scrubbed at indexing; the gate checks it again here.
  if (guest && guestPassages.length && enc.overlap[a.owner]?.mine?.length) {
    const ids = enc.overlap[a.owner].mine.slice(0, 3);
    const docs = await store.getMany(enc.keyId, ids);
    const ranked = ids.map((pid) => docs.find((d) => d.passage_id === pid && d.owner_id === a.owner)).filter(Boolean);
    // Words read better than code on a phone: prefer prose among the top matches.
    const best = ranked.find((d) => d.kind !== 'file') || ranked[0];
    if (best) {
      const text = bestExcerpt(best.text, new Set(guestPassages.flatMap((p) => tokens(p.text))));
      if (text && gate(text, state.canaries).ok) {
        enc.instant = { passage_id: best.passage_id, text, source: best.source, locator: best.locator, kind: best.kind, ts: best.ts,
          whose: best.speaker === 'owner' && best.kind !== 'file' ? 'owner' : best.kind === 'commit' ? 'commit' : best.kind === 'file' ? 'file' : 'session' };
      }
    }
  }
  enc.times.ready = Date.now();
}

// The sentence (or two) of a passage that shares the most words with what the guest gave: verbatim.
export function bestExcerpt(text, want, max = 280) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const parts = t.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length > 12);
  let bestI = 0, bestScore = -1;
  parts.forEach((p, i) => { const sc = tokens(p).filter((w) => want.has(w)).length; if (sc > bestScore) { bestScore = sc; bestI = i; } });
  let out = parts[bestI] || t.slice(0, max);
  if (out.length < max * 0.6 && parts[bestI + 1] && (out + ' ' + parts[bestI + 1]).length <= max && t.includes(out + ' ' + parts[bestI + 1])) out = out + ' ' + parts[bestI + 1];
  return out.length > max ? out.slice(0, max).replace(/\s+\S*$/, '') + '…' : out;
}

// What the inbox shows an owner about an encounter: never the other side's key.
export function inboxEntry(enc, owner) {
  const other = enc.a === owner ? enc.b : enc.a;
  return {
    id: enc.id, with: other, with_name: enc.names[other], guest: Boolean(enc.guest), status: enc.status,
    created: enc.created, link: sideLink(enc, owner), stage: stageLink(enc), posted: enc.sides[owner].posted,
  };
}
