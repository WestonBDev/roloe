// Card indexer: today's working sessions for one project, its tracked text files and recent
// commits, scrubbed into passages. Runs on the owner's machine; only passages leave it.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scrub, applyOffLimits } from './scrub.mjs';

const MAX_TEXT = 1500;
const MAX_PASSAGES = 420;

export function passageId(owner, locator, text) {
  return 'p-' + createHash('sha256').update(`${owner}|${locator}|${text.slice(0, 40)}`).digest('hex').slice(0, 6);
}

export function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

function chunks(text, max = MAX_TEXT) {
  const out = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// User turns that the owner didn't type: tool output, system notes, other sessions' briefs.
function notOwnerTyped(t) {
  const s = t.trimStart();
  return !s
    || s.startsWith('<')
    || s.startsWith('Background (from the session')
    || s.startsWith('This session is being continued')
    || s.startsWith('Caveat:')
    || s.startsWith('[Request interrupted')
    || s.startsWith('# AGENTS.md')
    || s.startsWith('# Context from my IDE');
}
// Roloe's own meeting tools, and the instruction that starts the waiting loop.
const ROLOE_TOOL = /roloe_(wait_for_tap|pull|post_findings|search_mine|findings_for_me)/;
const ROLOE_PROMPT = /roloe_wait_for_tap|Wait for Roloe meetings|Roloe (encounter|meeting) e-[0-9a-f]{10}/i;
const looksPasted = (t) => t.length > 2500 || /<pasted_content|```[\s\S]{1200,}```/.test(t);

// ---------- Claude Code ----------
export function claudeProjectDir(projectDir) {
  return join(homedir(), '.claude', 'projects', resolve(projectDir).replace(/[^A-Za-z0-9]/g, '-'));
}

export function readClaudeSessions(projectDir, since) {
  const dir = claudeProjectDir(projectDir);
  if (!existsSync(dir)) return [];
  const msgs = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const path = join(dir, f);
    if (statSync(path).mtime < since) continue;
    const session = basename(f, '.jsonl').replace(/-/g, '').slice(0, 8);
    let i = 0;
    // Once the assistant calls a Roloe meeting tool, what it says restates someone else's material:
    // skip it until the owner types something new.
    let inMeeting = false;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.isSidechain || o.isMeta || o.isCompactSummary) continue;
      const ts = o.timestamp ? new Date(o.timestamp) : null;
      if (!ts || ts < since) continue;
      const c = o.message?.content;
      if (o.type === 'user') {
        const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text) : [];
        for (const t of texts) {
          if (notOwnerTyped(t)) continue;
          if (ROLOE_PROMPT.test(t)) continue;
          inMeeting = false;
          msgs.push({ kind: 'session', speaker: looksPasted(t) ? 'pasted' : 'owner', session, n: i++, ts, text: t, via: 'Claude Code' });
        }
      } else if (o.type === 'assistant' && Array.isArray(c)) {
        if (c.some((b) => b.type === 'tool_use' && ROLOE_TOOL.test(b.name || ''))) inMeeting = true;
        if (inMeeting) continue;
        const t = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (t.length >= 40) msgs.push({ kind: 'session', speaker: 'assistant', session, n: i++, ts, text: t, via: 'Claude Code' });
      }
    }
  }
  return msgs;
}

// ---------- Codex ----------
export function readCodexSessions(projectDir, since) {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const want = resolve(projectDir);
  const msgs = [];
  const days = [];
  for (let d = new Date(since); d <= new Date(); d.setDate(d.getDate() + 1)) {
    days.push(join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  for (const dir of days) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      const path = join(dir, f);
      if (statSync(path).mtime < since) continue;
      const lines = readFileSync(path, 'utf8').split('\n');
      let meta; try { meta = JSON.parse(lines[0]).payload; } catch { continue; }
      const cwd = meta?.cwd ? resolve(meta.cwd) : '';
      if (!(cwd === want || cwd.startsWith(want + '/'))) continue;
      const session = String(meta.id || meta.session_id || f).replace(/-/g, '').slice(-8);
      let i = 0;
      let inMeeting = false;
      for (const line of lines) {
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const p = o.payload;
        if (o.type === 'response_item' && /call/.test(p?.type || '') && ROLOE_TOOL.test(p?.name || '')) { inMeeting = true; continue; }
        if (o.type !== 'response_item' || p?.type !== 'message') continue;
        const ts = o.timestamp ? new Date(o.timestamp) : null;
        if (!ts || ts < since) continue;
        if (p.role === 'user') {
          for (const b of p.content || []) {
            if (b.type !== 'input_text' || notOwnerTyped(b.text) || ROLOE_PROMPT.test(b.text)) continue;
            inMeeting = false;
            msgs.push({ kind: 'session', speaker: looksPasted(b.text) ? 'pasted' : 'owner', session, n: i++, ts, text: b.text, via: 'Codex' });
          }
        } else if (p.role === 'assistant') {
          if (inMeeting) continue;
          const t = (p.content || []).filter((b) => b.type === 'output_text').map((b) => b.text).join('\n').trim();
          if (t.length >= 40) msgs.push({ kind: 'session', speaker: 'assistant', session, n: i++, ts, text: t, via: 'Codex' });
        }
      }
    }
  }
  return msgs;
}

// ---------- Files and commits ----------
const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.rb', '.php', '.c', '.h', '.cpp', '.cs', '.sh', '.yaml', '.yml', '.toml', '.json', '.html', '.css', '.sql', '.txt', '.vue', '.svelte', '']);
const SKIP_FILE = /(^|\/)(\.env[^/]*|.*\.(pem|key|p12|pfx|crt|lock)|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|id_[a-z0-9]+|node_modules\/.*|dist\/.*|build\/.*|vendor\/.*|.*\.min\.js|LICENSE)$/i;

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

export function listProjectFiles(projectDir) {
  try {
    return git(projectDir, ['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean);
  } catch { return []; }
}

export function readFiles(projectDir, removed = []) {
  const out = [];
  for (const rel of listProjectFiles(projectDir)) {
    if (SKIP_FILE.test(rel) || !TEXT_EXT.has(extname(rel).toLowerCase())) continue;
    const path = join(projectDir, rel);
    let st; try { st = statSync(path); } catch { continue; }
    if (!st.isFile() || st.size > 200_000 || st.size === 0) continue;
    const raw = readFileSync(path, 'utf8');
    if (raw.includes('\u0000')) continue;
    // Scrub the whole file first: a secret that crosses a window boundary is removed whole.
    const sc = scrub(raw);
    removed.push(...sc.removed);
    const lines = sc.text.split('\n');
    for (let start = 0; start < lines.length; start += 50) {
      const body = lines.slice(start, start + 50).join('\n').slice(0, MAX_TEXT);
      if (body.trim().length < 20) continue;
      out.push({ kind: 'file', speaker: '', source: rel, locator: `${rel}:L${start + 1}-${Math.min(start + 50, lines.length)}`, ts: st.mtime, text: body });
    }
  }
  return out;
}

export function readCommits(projectDir, n = 25) {
  let raw; try { raw = git(projectDir, ['log', `-${n}`, '--format=%h%x1f%ct%x1f%s%x1f%b%x1e']); } catch { return []; }
  return raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [h, ct, subject, body] = r.split('\x1f');
    const text = `${subject}\n\n${(body || '').replace(/^Co-Authored-By:.*$/gim, '').trim()}`.trim();
    return { kind: 'commit', speaker: 'owner', source: `commit ${h}`, locator: `commit ${h}`, ts: new Date(Number(ct) * 1000), text };
  });
}

// ---------- Build the card ----------
export function buildCard({ owner, projectDir, since = startOfToday(), sessions = true, offLimits = [] }) {
  const dir = resolve(projectDir);
  const raw = [];
  const removed = [];
  if (sessions) {
    for (const m of [...readClaudeSessions(dir, since), ...readCodexSessions(dir, since)]) {
      // Scrub the whole message before chunking, for the same reason.
      const sc = scrub(m.text);
      removed.push(...sc.removed);
      chunks(sc.text).forEach((t, j) => raw.push({
        kind: 'session', speaker: m.speaker, via: m.via, source: `session ${m.session}`,
        locator: `session ${m.session} #${m.n}${j ? '.' + j : ''}`, ts: m.ts, text: t,
      }));
    }
  }
  raw.push(...readCommits(dir));
  raw.push(...readFiles(dir, removed));

  const passages = [];
  const seen = new Set();
  // Newest sessions first, then commits, then files: when the cap bites, old file chunks go first.
  const order = { session: 0, commit: 1, file: 2 };
  raw.sort((a, b) => order[a.kind] - order[b.kind] || b.ts - a.ts);
  let offLimitsRemoved = 0;
  const ol = (t) => { const r = applyOffLimits(t, offLimits); offLimitsRemoved += r.count; return r.text; };
  for (const p of raw) {
    const s = scrub(p.text);
    removed.push(...s.removed);
    const text = ol(s.text).slice(0, MAX_TEXT);
    const id = passageId(owner, p.locator, text);
    if (seen.has(id)) continue;
    seen.add(id);
    passages.push({ passage_id: id, kind: p.kind, speaker: p.speaker, source: ol(scrub(p.source).text), locator: ol(scrub(p.locator).text), ts: new Date(p.ts).toISOString(), text, via: p.via || '' });
    if (passages.length >= MAX_PASSAGES) break;
  }
  const totals = {
    passages: passages.length,
    sessions: new Set(passages.filter((p) => p.kind === 'session').map((p) => p.source)).size,
    files: new Set(passages.filter((p) => p.kind === 'file').map((p) => p.source)).size,
    commits: passages.filter((p) => p.kind === 'commit').length,
    owner_messages: passages.filter((p) => p.speaker === 'owner' && p.kind === 'session').length,
    secrets_removed: removed.length,
    off_limits_removed: offLimitsRemoved,
  };
  return { passages, totals, removed: [...new Set(removed.map((r) => r.value))] };
}
