import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// A fake home with one Claude Code session and one Codex session for the project, plus a git repo.
const home = mkdtempSync(join(tmpdir(), 'roloe-home-'));
process.env.HOME = home;
const project = join(home, 'work', 'proj');
mkdirSync(project, { recursive: true });
const git = (...a) => execFileSync('git', ['-C', project, ...a], { stdio: 'ignore' });
git('init', '-q');
git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
writeFileSync(join(project, 'README.md'), '# Proj\n\nRetry the upload when the push fails, and mark the total partial.\n');
writeFileSync(join(project, '.env'), 'TOKEN=abc123abc123abc123\n');
writeFileSync(join(project, '.gitignore'), '.env\n');
git('add', '.'); git('commit', '-qm', 'Mark totals partial when one fetch fails');

const now = new Date().toISOString();
const old = new Date(Date.now() - 3 * 86400e3).toISOString();
const claudeDir = join(home, '.claude', 'projects', project.replace(/[^A-Za-z0-9]/g, '-'));
mkdirSync(claudeDir, { recursive: true });
const lines = [
  { type: 'user', timestamp: now, message: { content: 'why does the push fail silently after a retry?' } },
  { type: 'user', timestamp: now, message: { content: 'Background (from the session that started this one): brief' } },
  { type: 'user', timestamp: now, message: { content: '<system-reminder>noise</system-reminder>' } },
  { type: 'user', timestamp: now, message: { content: [{ type: 'tool_result', content: 'tool output' }] } },
  { type: 'user', timestamp: now, isSidechain: true, message: { content: 'subagent prompt' } },
  { type: 'user', timestamp: old, message: { content: 'an old message from days ago' } },
  { type: 'assistant', timestamp: now, message: { content: [{ type: 'text', text: 'The push promise was not awaited, so the error was swallowed and the refresh was recorded as done.' }, { type: 'tool_use', name: 'Bash', input: {} }] } },
  { type: 'user', timestamp: now, message: { content: 'my key is sk-ant-api03-' + 'Zz9'.repeat(10) } },
];
writeFileSync(join(claudeDir, 'abcd1234-0000-0000-0000-000000000000.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));

const d = new Date();
const codexDir = join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
mkdirSync(codexDir, { recursive: true });
const cx = [
  { type: 'session_meta', payload: { id: 'cdx-1111-2222-3333-44445555', cwd: project } },
  { type: 'response_item', timestamp: now, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
  { type: 'response_item', timestamp: now, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add rate limiting to the upload endpoint' }] } },
  { type: 'response_item', timestamp: now, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added a token bucket limiter on upload with a 429 and Retry-After header.' }] } },
];
writeFileSync(join(codexDir, 'rollout-x.jsonl'), cx.map((l) => JSON.stringify(l)).join('\n'));
const otherCx = [{ type: 'session_meta', payload: { id: 'other', cwd: join(home, 'elsewhere') } },
  { type: 'response_item', timestamp: now, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a different project entirely' }] } }];
writeFileSync(join(codexDir, 'rollout-y.jsonl'), otherCx.map((l) => JSON.stringify(l)).join('\n'));

const { buildCard, passageId } = await import('../src/indexer.mjs');

test('indexes only the owner\'s typed words and assistant prose from today, for this project', () => {
  const { passages } = buildCard({ owner: 'w', projectDir: project });
  const texts = passages.map((p) => p.text);
  assert.ok(texts.includes('why does the push fail silently after a retry?'));
  assert.ok(texts.some((t) => t.startsWith('The push promise was not awaited')));
  assert.ok(texts.includes('add rate limiting to the upload endpoint'), 'codex owner message');
  assert.ok(texts.some((t) => t.startsWith('Added a token bucket')), 'codex assistant prose');
  for (const bad of ['Background (from', 'system-reminder', 'tool output', 'subagent prompt', 'old message', 'different project', 'environment_context']) {
    assert.ok(!texts.some((t) => t.includes(bad)), bad);
  }
  const owner = passages.find((p) => p.text.startsWith('why does'));
  assert.equal(owner.speaker, 'owner');
  assert.equal(owner.kind, 'session');
  assert.equal(owner.via, 'Claude Code');
});

test('scrubs secrets, skips .env, includes tracked files and commits', () => {
  const { passages, totals, removed } = buildCard({ owner: 'w', projectDir: project });
  const all = JSON.stringify(passages);
  assert.ok(!all.includes('Zz9Zz9'), 'secret leaked');
  assert.ok(all.includes('[removed: anthropic key]'));
  assert.ok(!all.includes('abc123abc123'), '.env leaked');
  assert.ok(!all.includes(home), 'home path leaked');
  assert.ok(passages.some((p) => p.kind === 'file' && p.locator === 'README.md:L1-4'));
  assert.ok(passages.some((p) => p.kind === 'commit' && p.text.startsWith('Mark totals partial')));
  assert.equal(totals.secrets_removed, 1);
  assert.equal(removed.length, 1);
});

test('passage IDs are stable while the text is unchanged', () => {
  const a = buildCard({ owner: 'w', projectDir: project }).passages.map((p) => p.passage_id);
  const b = buildCard({ owner: 'w', projectDir: project }).passages.map((p) => p.passage_id);
  assert.deepEqual(a, b);
  assert.match(passageId('w', 'README.md:L1-4', 'x'), /^p-[0-9a-f]{6}$/);
  assert.notEqual(passageId('w', 'L', 'one text'), passageId('w', 'L', 'two text'));
});

test('a private key that crosses a chunk boundary is removed whole (Gitar)', async () => {
  const { writeFileSync } = await import('node:fs');
  const body = Array.from({ length: 30 }, (_, i) => 'MIIEow' + String(i).padStart(2, '0') + 'QwErTy'.repeat(10)).join('\n');
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
  const lines = Array.from({ length: 35 }, (_, i) => `filler line ${i} about retries`).join('\n');
  writeFileSync(join(project, 'keys.md'), `${lines}\n${pem}\nafter\n`);
  git('add', '.'); git('commit', '-qm', 'add keys doc');
  const sessionLines = [{ type: 'user', timestamp: new Date().toISOString(), message: { content: 'x'.repeat(1400) + '\n' + pem } }];
  writeFileSync(join(claudeDir, 'pem00000-0000-0000-0000-000000000000.jsonl'), sessionLines.map((l) => JSON.stringify(l)).join('\n'));
  const { passages } = buildCard({ owner: 'w', projectDir: project });
  const all = JSON.stringify(passages);
  assert.ok(!all.includes('QwErTyQwErTy'), 'no key body in any passage');
  assert.ok(!all.includes('PRIVATE KEY-----'), 'no key armor in any passage');
});
