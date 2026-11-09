// The MCP server end to end: a real stdio client, a real coordinator, two cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestServer } from './helpers.mjs';

const run = promisify(execFile);
const BIN = new URL('../bin/roloe.mjs', import.meta.url).pathname;

async function cardOnDisk(s, owner, name, note) {
  const home = mkdtempSync(join(tmpdir(), `roloe-mcp-${owner}-`));
  const project = join(home, 'proj');
  mkdirSync(project);
  const git = (...a) => execFileSync('git', ['-C', project, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(join(project, 'notes.md'), note);
  git('add', '.'); git('commit', '-qm', 'notes');
  const env = { ...process.env, HOME: home, ROLOE_HOME: join(home, '.roloe') };
  await run('node', [BIN, 'on', '--url', s.base, '--owner', owner, '--name', name, '--project', project], { env });
  const cfg = JSON.parse(readFileSync(join(home, '.roloe', `${owner}.json`), 'utf8'));
  return { env, cfg };
}

async function connect(env) {
  const transport = new StdioClientTransport({ command: 'node', args: [BIN, 'mcp'], env: { ...env, ROLOE_CHANNEL_POLL_MS: '200', ROLOE_REFRESH_MS: '0' }, stderr: 'ignore' });
  const client = new Client({ name: 'test', version: '1' });
  const channel = [];
  client.fallbackNotificationHandler = async (n) => { if (n.method === 'notifications/claude/channel') channel.push(n.params); };
  await client.connect(transport);
  return { client, channel };
}
const json = (r) => JSON.parse(r.content[0].text);

test('MCP: wait for a tap, pull, local gate blocks an owner secret, post, findings arrive for the other side', async () => {
  const s = await startTestServer();
  const wes = await cardOnDisk(s, 'wes', 'Wes', 'The card watcher records the refresh as done before the push succeeds.\nContact wes.dev@example.com\n');
  const ada = await cardOnDisk(s, 'ada', 'Ada', 'Retry the push when it fails, and mark the combined total partial until it lands.\n');
  const { client, channel } = await connect(ada.env);
  try {
    const caps = client.getServerCapabilities();
    assert.ok(caps.experimental?.['claude/channel'], 'declares the Claude Code channel');
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['roloe_findings_for_me', 'roloe_inbox', 'roloe_post_findings', 'roloe_pull', 'roloe_search_mine', 'roloe_wait_for_tap']);

    const waiting = client.callTool({ name: 'roloe_wait_for_tap', arguments: { timeout_s: 10 } });
    await new Promise((r) => setTimeout(r, 300));
    const tap = await s.call('POST', '/api/tap', { to: 'ada' }, { authorization: `Bearer ${wes.cfg.key}` });
    const pulled = json(await waiting);
    assert.equal(pulled.encounter_id, tap.body.id);
    assert.equal(pulled.them, 'Wes');
    assert.ok(pulled.theirs.length >= 1);
    assert.ok(pulled.mine.length >= 1);
    assert.match(pulled.instructions, /roloe_post_findings/);

    // The channel pushed the tap into the session too, with plain names only.
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(channel.some((c) => c.meta?.encounter_id === tap.body.id && /Wes just met you through Roloe/.test(c.content)));

    const mine = pulled.mine[0];
    const theirs = pulled.theirs[0];
    const quote = mine.text.split(/\s+/).slice(0, 8).join(' ');

    // Ada's own scrubbed value can't leave her machine, even inside a finding.
    const leakedValue = ada.cfg.removed[0] || 'ada.private@example.com';
    if (!ada.cfg.removed.length) {
      const cfgPath = join(ada.env.ROLOE_HOME, 'ada.json');
      const c = JSON.parse(readFileSync(cfgPath, 'utf8')); c.removed = [leakedValue]; writeFileSync(cfgPath, JSON.stringify(c));
    }
    const blocked = await client.callTool({ name: 'roloe_post_findings', arguments: { encounter_id: tap.body.id, findings: [{ cites: mine.passage_id, quote, about: theirs.passage_id, what: `email ${leakedValue} about it` }] } });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /Blocked on this machine/);
    assert.ok(!blocked.content[0].text.includes(leakedValue));
    assert.equal(s.state().encounters[tap.body.id].sides.ada.posted, false, 'nothing reached the coordinator');

    const posted = json(await client.callTool({ name: 'roloe_post_findings', arguments: { encounter_id: tap.body.id, findings: [{ cites: mine.passage_id, quote, about: theirs.passage_id, what: 'Ada retries the push and marks the total partial; your watcher marks done first.' }] } }));
    assert.equal(posted.accepted, 1);

    // Wes's assistant reads what arrived for him.
    const wesSide = await connect(wes.env);
    try {
      const forWes = json(await wesSide.client.callTool({ name: 'roloe_findings_for_me', arguments: { encounter_id: tap.body.id } }));
      assert.equal(forWes.findings.length, 1);
      assert.equal(forWes.findings[0].credit.name, 'Ada');
      const inbox = json(await wesSide.client.callTool({ name: 'roloe_inbox', arguments: {} }));
      assert.equal(inbox.encounters[0].id, tap.body.id);
    } finally { await wesSide.client.close(); }
  } finally { await client.close(); await s.close(); }
});
