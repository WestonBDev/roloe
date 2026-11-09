// Encounter lifecycle: tap → copies and key → overlap both ways. Each step is a span under the
// encounter's root span. Spans carry IDs, counts and HMACs only.
import { config } from './env.mjs';
import { state, save, newId, newKey } from './state.mjs';
import { startEncounterTrace, endEncounterTrace, destroyHmacKey, step, hmac } from './telemetry.mjs';
import { computeOverlap } from './overlap.mjs';
import { record } from './metrics.mjs';

export const sideLink = (enc, who) => `${config.publicUrl}/e/${enc.id}?k=${enc.sides[who].key}`;
export const stageLink = (enc) => `${config.publicUrl}/stage/${enc.id}?k=${enc.stageKey}`;

function newSide() {
  return { key: newKey('sk'), seal: null, posted: false, nothing_strong: false, retrieved_by_other: [], findings_seen: false };
}

export async function createEncounter(store, a, b, { guest = null, guestPassages = [] } = {}) {
  const id = newId('e', 5);
  const now = Date.now();
  const enc = {
    id, a: a.owner, b: b.owner, names: { [a.owner]: a.name, [b.owner]: b.name },
    created: new Date(now).toISOString(), status: 'open', guest,
    // Two cards of one person: allowed as a labelled last resort, and every screen says so.
    same_person: Boolean(a.same_person_as === b.owner || b.same_person_as === a.owner || (a.same_person_as && a.same_person_as === b.same_person_as)),
    stageKey: newKey('stk'), sides: { [a.owner]: newSide(), [b.owner]: newSide() },
    findings: [], dropped: [], tries: [], tryStatus: null, thanks: [],
    times: { tap: now, ready: null, first_findings: null, all_findings: null, green: null },
    overlap: {}, keyId: null, trace: null, closed: null,
  };
  enc.trace = startEncounterTrace(id, { 'roloe.guest': Boolean(guest) });
  const ref = { encounterId: id, ...enc.trace };
  try {
    await buildEncounter(store, enc, ref, a, b, guest, guestPassages);
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
  save();
  return enc;
}

async function buildEncounter(store, enc, ref, a, b, guest, guestPassages) {
  const id = enc.id;

  await step('roloe.tap', ref, { 'roloe.side_a': hmac(id, a.owner), 'roloe.side_b': hmac(id, b.owner) }, async (span) => {
    const owners = [a.owner, b.owner].filter((o) => !o.startsWith('guest-'));
    const copied = await store.copyCardsToEncounter(id, owners);
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
  enc.times.ready = Date.now();
}

// What the inbox shows an owner about an encounter: never the other side's key.
export function inboxEntry(enc, owner) {
  const other = enc.a === owner ? enc.b : enc.a;
  return {
    id: enc.id, with: other, with_name: enc.names[other], guest: Boolean(enc.guest), status: enc.status,
    created: enc.created, link: sideLink(enc, owner), posted: enc.sides[owner].posted,
  };
}
