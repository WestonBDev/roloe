// One metadata record per meeting: IDs, counts, times and outcomes. Never names, keys, links or
// text. It feeds the organizer's view (Elastic Agent Builder tools over this index only) and is
// the first piece of meeting state to live in Elasticsearch rather than on the pod's volume.
export const MEETING_FIELDS = ['meeting_id', 'kind', 'started_at', 'updated_at', 'findings_accepted', 'findings_dropped', 'nothing_strong', 'time_to_findings_s', 'try_state', 'time_to_help_s', 'stopped'];

const secs = (from, to) => (from && to ? Math.round((to - from) / 100) / 10 : null);

export function meetingRecord(enc, now = Date.now()) {
  const t = enc.times || {};
  const accepted = (enc.findings || []).length;
  const posted = Object.values(enc.sides || {}).some((s) => s.posted);
  return {
    meeting_id: enc.id,
    kind: enc.guest ? 'guest' : enc.same_person ? 'same_person' : 'pair',
    started_at: new Date(t.tap || now).toISOString(),
    updated_at: new Date(now).toISOString(),
    findings_accepted: accepted,
    findings_dropped: (enc.dropped || []).length,
    nothing_strong: posted && accepted === 0,
    time_to_findings_s: secs(t.tap, t.first_findings),
    try_state: (enc.tries || []).at(-1)?.state || null,
    time_to_help_s: secs(t.tap, t.green),
    stopped: enc.status === 'closed',
  };
}

// Fire and forget: a meeting never waits on, or fails because of, its own record.
export function syncMeeting(store, enc) {
  if (!store?.recordMeeting || !enc?.id) return;
  Promise.resolve().then(() => store.recordMeeting(meetingRecord(enc))).catch(() => {});
}
