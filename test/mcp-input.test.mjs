// The assistant reads untrusted text, so every id it passes back is validated before it reaches a URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP tools refuse an encounter_id that isn\'t one (Gitar)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'roloe-mcpin-'));
  mkdirSync(join(home, '.roloe'));
  writeFileSync(join(home, '.roloe', 'x.json'), JSON.stringify({ owner: 'x', url: 'http://127.0.0.1:9', key: 'rk_test', project: home, removed: [] }));
  writeFileSync(join(home, '.roloe', 'current'), 'x');
  const transport = new StdioClientTransport({ command: 'node', args: [new URL('../bin/roloe.mjs', import.meta.url).pathname, 'mcp'], env: { ...process.env, HOME: home, ROLOE_HOME: join(home, '.roloe'), ROLOE_REFRESH_MS: '0', ROLOE_CHANNEL_POLL_MS: '60000' }, stderr: 'ignore' });
  const client = new Client({ name: 't', version: '1' });
  await client.connect(transport);
  try {
    for (const [name, args] of [['roloe_pull', { encounter_id: '../../cards/ada' }], ['roloe_post_findings', { encounter_id: 'X/stop?', nothing_strong: true }], ['roloe_search_mine', { encounter_id: 'e-1/../x', query: 'q' }]]) {
      let refused = false;
      try { const r = await client.callTool({ name, arguments: args }); refused = r.isError === true && /encounter/i.test(r.content[0].text); } catch { refused = true; }
      assert.ok(refused, `${name} refused ${args.encounter_id}`);
    }
  } finally { await client.close(); }
});
