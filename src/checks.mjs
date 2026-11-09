// The findings check, in code. A finding is dropped unless:
//  1. cites resolves under the encounter's key to a passage whose owner is the giver;
//  2. the quote (lowercased, whitespace-normalized) is 3+ words, at most 400 characters, and a
//     substring of that passage;
//  3. about, if present, resolves to a passage whose owner is the recipient;
//  4. any change only touches relative paths inside the project;
//  5. the egress gate passes on the whole finding.
import { gate } from './gate.mjs';
import { cleanLine } from './state.mjs';

export const normQuote = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().replace(/^["'“”]+|["'“”.…]+$/g, '').trim();

export function safePath(p) {
  const s = String(p || '');
  return Boolean(s) && s.length <= 300 && !s.startsWith('/') && !s.startsWith('~') && !/^[a-zA-Z]:/.test(s)
    && !s.split(/[\\/]/).some((seg) => seg === '..' || seg === '.git') && !/[\u0000-\u001f]/.test(s);
}

function cleanChange(change) {
  if (!change || !Array.isArray(change.edits) || !change.edits.length) return { change: null };
  const edits = change.edits.slice(0, 5).map((e) => ({ file: String(e.file || ''), find: String(e.find ?? ''), replace: String(e.replace ?? '') }));
  if (edits.some((e) => !safePath(e.file))) return { error: 'change path is not inside the project' };
  if (edits.some((e) => !e.find || e.find.length > 4000 || e.replace.length > 4000)) return { error: 'change edit is empty or too large' };
  return { change: { edits } };
}

// get(passageId) → passage under the encounter's key, or null.
export async function checkFinding(f, { get, giver, recipient, canaries = [] }) {
  const result = (reason, extra = {}) => ({ accepted: !reason, reason: reason || null, checks: extra });
  const checks = { citation: 'fail', quote: 'skip', about: 'skip', gate: 'skip' };
  if (!f || typeof f !== 'object') return result('not a finding', checks);
  const cited = /^p-[0-9a-f]{6}$/.test(String(f.cites)) ? await get(String(f.cites)) : null;
  if (!cited) return result('citation does not resolve', checks);
  if (cited.owner_id !== giver) return result('citation is not the giver\'s', checks);
  checks.citation = 'pass';

  const q = normQuote(f.quote);
  checks.quote = 'fail';
  if (q.split(' ').filter(Boolean).length < 3) return result('quote is under 3 words', checks);
  if (q.length > 400) return result('quote is over 400 characters', checks);
  if (!normQuote(cited.text).includes(q)) return result('quote is not verbatim', checks);
  checks.quote = 'pass';

  let about = null;
  if (f.about) {
    about = /^p-[0-9a-f]{6}$/.test(String(f.about)) ? await get(String(f.about)) : null;
    checks.about = 'fail';
    if (!about || about.owner_id !== recipient) return result('about is not the recipient\'s', checks);
    checks.about = 'pass';
  }

  const ch = cleanChange(f.change);
  if (ch.error) return result(ch.error, checks);

  const record = {
    cites: cited.passage_id,
    quote: String(f.quote).trim().replace(/^["“]|["”]$/g, '').slice(0, 400),
    about: about?.passage_id || null,
    what: cleanLine(f.what, 400),
    change: ch.change,
    credit: { name: cited.owner_name, ts: cited.ts, source: cited.source, locator: cited.locator, speaker: cited.speaker, kind: cited.kind, via: cited.via || '' },
    about_ref: about ? { source: about.source, locator: about.locator, kind: about.kind } : null,
  };
  const g = gate(JSON.stringify({ q: record.quote, w: record.what, c: record.change }), canaries);
  checks.gate = g.ok ? 'pass' : 'fail';
  if (!g.ok) return result('gate blocked', checks);
  return { ...result(null, checks), record };
}
