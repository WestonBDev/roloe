// Egress gate: code that checks outgoing text for known secrets and secret-shaped strings.
// It looks at the text and its base64, base64url and hex-decoded views; it catches known values
// verbatim, with spacing or punctuation changed, or as their distinctive fragments.
import { secretShaped, applyOffLimits } from './scrub.mjs';

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9@.]/g, '').replace(/\./g, '');

function decodedViews(text) {
  const views = [text];
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{16,}/g)) {
    const t = m[0];
    try {
      const b = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/^[\x20-\x7e\s]{8,}$/.test(b)) views.push(b);
    } catch { /* not base64 */ }
    if (/^(?:[0-9a-fA-F]{2}){8,}$/.test(t)) {
      const h = Buffer.from(t, 'hex').toString('utf8');
      if (/^[\x20-\x7e\s]{8,}$/.test(h)) views.push(h);
    }
  }
  return views;
}

// A known secret must look like one: 10+ chars mixing letters and digits, or an email.
// Plain words would block the project's own vocabulary.
export function usableSecret(v) {
  const s = String(v || '');
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s)) return true;
  return s.length >= 10 && /[a-z]/i.test(s) && /\d/.test(s);
}

// Share of the secret covered by pieces of 6+ characters that appear in the text, so a secret
// split anywhere (and the pieces spread out) is still caught.
export function coverage(secret, text) {
  let covered = 0;
  let i = 0;
  while (i < secret.length) {
    let len = 0;
    for (let L = secret.length - i; L >= 6; L--) { if (text.includes(secret.slice(i, i + L))) { len = L; break; } }
    if (len) { covered += len; i += len; } else i++;
  }
  return covered / secret.length;
}

export function gate(text, knownSecrets = [], offLimits = []) {
  const s = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  if (offLimits.length && applyOffLimits(s, offLimits).count) return { ok: false, reason: 'off-limits' };
  const views = decodedViews(s);
  const normViews = views.map(norm);
  for (const v of views) {
    const kind = secretShaped(v);
    if (kind) return { ok: false, reason: 'secret-shaped', kind };
  }
  for (const secret of knownSecrets.filter(usableSecret)) {
    if (views.some((v) => v.includes(secret))) return { ok: false, reason: 'known secret', match: 'verbatim' };
    const ns = norm(secret);
    if (ns.length >= 8 && normViews.some((v) => v.includes(ns))) return { ok: false, reason: 'known secret', match: 'normalized' };
    if (ns.length >= 12 && normViews.some((v) => coverage(ns, v) >= 0.8)) return { ok: false, reason: 'known secret', match: 'fragments' };
  }
  return { ok: true };
}
