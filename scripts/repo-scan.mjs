// Fails when any tracked file holds a secret-shaped string, using Roloe's own scrubber patterns.
// A privacy product's repo should pass its own check. Run in CI: node scripts/repo-scan.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATTERNS } from '../src/scrub.mjs';

const ENV_SECRET = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*[:=]\s*["']?([A-Za-z0-9_+/=.-]{10,})/g;
const SKIP_KINDS = new Set(['email', 'long hex', 'url credentials']);   // too common in docs and lockfiles to mean a secret

export function scanText(file, text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    let hit = false;
    for (const [kind, re] of PATTERNS) {
      if (SKIP_KINDS.has(kind)) continue;
      re.lastIndex = 0;
      if (re.test(line)) { found.push({ file, line: i + 1, kind }); hit = true; }
      re.lastIndex = 0;
    }
    // Env-style NAME_KEY=value with a real-looking value (letters and digits, 10+). Code such as
    // `const key = bearer(req)`, references and empty slots pass.
    if (!hit) for (const m of line.matchAll(ENV_SECRET)) if (/\d/.test(m[2]) && /[A-Za-z]/.test(m[2])) { found.push({ file, line: i + 1, kind: 'secret value' }); break; }
  });
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter((f) => f && !/\.(png|jpe?g|gif|ico|woff2?|lock)$|package-lock\.json$/.test(f));
  const found = files.flatMap((f) => { try { return scanText(f, readFileSync(f, 'utf8')); } catch { return []; } });
  for (const f of found) console.log(`${f.file}:${f.line}  secret-shaped (${f.kind})`);
  if (found.length) { console.log(`\n${found.length} secret-shaped string(s) in tracked files. Assemble test values at runtime instead.`); process.exit(1); }
  console.log(`Scanned ${files.length} tracked files: no secret-shaped strings.`);
}
