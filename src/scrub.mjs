// Scrubber: removes secret-shaped strings before anything is indexed.
// Removed values stay on the owner's machine (for the local egress gate); the card shows [removed: kind].

export const PATTERNS = [
  ['private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ['anthropic key', /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ['openai key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['github token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['aws key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g],
  ['vercel id', /\b(?:team|prj)_[A-Za-z0-9]{20,}\b/g],
  ['roloe key', /\b(?:rk|sk|gk|stk)_[A-Za-z0-9_-]{24,}/g],
  ['dash0 token', /\bauth_[A-Za-z0-9]{20,}\b/g],
  ['google key', /\bAIza[0-9A-Za-z_-]{30,}/g],
  ['stripe key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['url credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/gi],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['long hex', /\b[0-9a-fA-F]{40,}\b/g],
];

// NAME_KEY=value, "password": "value". Skip references and digit-free identifiers
// (process.env.X, ${X}, STEAM_KEY): those are names, not secrets.
const ASSIGN = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;)}\]]+)/gi;

function isReference(v) {
  return /^(process\.env|\$\{|\$[A-Z_]|env\.|os\.environ|import\.meta|<|\[removed)/i.test(v)
    || /^[A-Za-z_.-]+$/.test(v)          // digit-free identifier
    || v.length < 8;
}

export function scrub(text) {
  let out = String(text ?? '');
  const removed = [];
  const take = (kind) => (m) => { removed.push({ kind, value: m }); return `[removed: ${kind}]`; };
  for (const [kind, re] of PATTERNS) out = out.replace(re, take(kind));
  out = out.replace(ASSIGN, (m, name, sep, value) => {
    if (isReference(value)) return m;
    removed.push({ kind: 'secret value', value });
    return `${name}${sep}[removed: secret value]`;
  });
  // Home paths name the person and their machine layout.
  out = out.replace(/\/(?:Users|home)\/[^/\s"'`]+/g, '~');
  return { text: out, removed };
}

// True when the text still holds something secret-shaped (used by the gate on the way out).
export function secretShaped(text) {
  const s = String(text ?? '');
  for (const [kind, re] of PATTERNS) {
    if (kind === 'email' || kind === 'long hex') continue; // too common in normal findings once scrubbed
    re.lastIndex = 0;
    if (re.test(s)) { re.lastIndex = 0; return kind; }
  }
  ASSIGN.lastIndex = 0;
  let m;
  while ((m = ASSIGN.exec(s))) { if (!isReference(m[3])) { ASSIGN.lastIndex = 0; return 'secret value'; } }
  ASSIGN.lastIndex = 0;
  return null;
}
