#!/usr/bin/env node
// Applies Roloe's Elastic definitions: two Agent Builder ES|QL tools, one agent, one Workflow,
// plus the two index mappings they read. Safe to run twice. Prints one line per object, no secrets.
//
//   node scripts/elastic-setup.mjs            create or update everything
//   node scripts/elastic-setup.mjs --check    only report what exists
//   node scripts/elastic-setup.mjs --verify   prove tools and workflow on throwaway indices, then clean up
//                                             (add --converse to also ask a throwaway agent one question)
//
// Kibana's URL is the Elasticsearch URL with ".es." replaced by ".kb."; set KIBANA_URL to override.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from '../src/env.mjs';

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const VERIFY = args.has('--verify');
const CONVERSE = args.has('--converse');

const MEETINGS = 'roloe-meetings';
const PASSAGES = 'roloe-passages';
const SAMPLE = 'roloe-test-meetings-sample';
const MEETINGS_MAPPING = {
  dynamic: 'strict',
  properties: {
    meeting_id: { type: 'keyword' },
    kind: { type: 'keyword' },
    started_at: { type: 'date' },
    updated_at: { type: 'date' },
    findings_accepted: { type: 'integer' },
    findings_dropped: { type: 'integer' },
    nothing_strong: { type: 'boolean' },
    time_to_findings_s: { type: 'float' },
    try_state: { type: 'keyword' },
    time_to_help_s: { type: 'float' },
    stopped: { type: 'boolean' },
  },
};

if (!config.esUrl || !config.esApiKey) {
  console.error('ELASTIC_URL and ELASTIC_API_KEY are required (set ROLOE_ENV_FILE or .env).');
  process.exit(2);
}
const ES = config.esUrl.replace(/\/$/, '');
const KB = (process.env.KIBANA_URL || ES.replace('.es.', '.kb.')).replace(/\/$/, '');
const scrub = (s) => String(s)
  .replaceAll(new URL(ES).hostname, '<es>')
  .replaceAll(new URL(KB).hostname, '<kibana>')
  .replaceAll(config.esApiKey, '<key>');

async function call(base, method, path, body, extra = {}) {
  const headers = { authorization: `ApiKey ${config.esApiKey}`, 'content-type': 'application/json', ...extra };
  if (base === KB) Object.assign(headers, { 'kbn-xsrf': 'true', 'x-elastic-internal-origin': 'kibana' });
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}
const es = (m, p, b, h) => call(ES, m, p, b, h);
const kb = (m, p, b, h) => call(KB, m, p, b, h);

let failures = 0;
function line(kind, id, action, r, note = '') {
  const bad = r && !r.ok && !(action === 'absent' && r.status === 404);
  if (bad) failures++;
  const msg = bad ? ` ${scrub(r.json?.message || r.json?.error?.reason || r.text).slice(0, 300)}` : '';
  console.log(`${kind.padEnd(9)} ${id.padEnd(40)} ${action.padEnd(9)} ${r ? r.status : '-'}${note ? ' ' + note : ''}${msg}`);
}
function expect(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}      ${label}${detail ? ': ' + detail : ''}`);
}

// ---- definitions on disk ----
const AB_DIR = join(ROOT, 'elastic', 'agent-builder');
const readJson = (f) => JSON.parse(readFileSync(join(AB_DIR, f), 'utf8'));
const abFiles = readdirSync(AB_DIR).filter((f) => f.endsWith('.json')).sort();
const tools = abFiles.filter((f) => f.startsWith('tool.')).map(readJson);
const agents = abFiles.filter((f) => f.startsWith('agent.')).map(readJson);
const WF_DIR = join(ROOT, 'elastic', 'workflows');
const workflows = readdirSync(WF_DIR).filter((f) => f.endsWith('.yaml')).sort().map((f) => {
  const yaml = readFileSync(join(WF_DIR, f), 'utf8');
  const name = yaml.match(/^name:\s*(\S+)\s*$/m)?.[1];
  if (!name) throw new Error(`${f}: no top-level name`);
  return { id: name, yaml }; // Kibana derives the workflow id from its name
});

// ---- upserts ----
async function ensureIndex(index, mappings) {
  const head = await es('HEAD', `/${index}`);
  if (head.status === 200) return line('index', index, 'exists', head);
  if (CHECK) return line('index', index, 'absent', head);
  line('index', index, 'created', await es('PUT', `/${index}`, { mappings }));
}
async function ensureField(index, field, mapping) {
  const id = `${index}.${field}`;
  // GET _mapping/field/<name> answers 410 on Serverless, so read the whole mapping.
  const r = await es('GET', `/${index}/_mapping`);
  if (r.status === 404) return line('field', id, 'absent', r, '(index missing; the app creates it)');
  if (!r.ok) return line('field', id, 'error', r);
  const present = Object.values(r.json || {}).some((v) => v.mappings?.properties?.[field]);
  if (present) return line('field', id, 'exists', r);
  if (CHECK) return line('field', id, 'absent', { status: 404, ok: false });
  line('field', id, 'added', await es('PUT', `/${index}/_mapping`, { properties: { [field]: mapping } }));
}
async function upsertTool(def) {
  const got = await kb('GET', `/api/agent_builder/tools/${def.id}`);
  if (CHECK) return line('tool', def.id, got.ok ? 'exists' : 'absent', got);
  if (got.ok) {
    const { id, type, ...rest } = def; // id and type are fixed after creation
    return line('tool', id, 'updated', await kb('PUT', `/api/agent_builder/tools/${id}`, rest));
  }
  line('tool', def.id, 'created', await kb('POST', '/api/agent_builder/tools', def));
}
async function upsertAgent(def) {
  const got = await kb('GET', `/api/agent_builder/agents/${def.id}`);
  if (CHECK) {
    const ids = (got.json?.configuration?.tools || []).flatMap((t) => t.tool_ids || []);
    const note = got.ok ? `tools=[${ids.join(',')}] elastic_capabilities=${got.json?.configuration?.enable_elastic_capabilities}` : '';
    return line('agent', def.id, got.ok ? 'exists' : 'absent', got, note);
  }
  if (got.ok) {
    const { id, ...rest } = def;
    return line('agent', id, 'updated', await kb('PUT', `/api/agent_builder/agents/${id}`, rest));
  }
  line('agent', def.id, 'created', await kb('POST', '/api/agent_builder/agents', def));
}
async function upsertWorkflow({ id, yaml }) {
  const got = await kb('GET', `/api/workflows/workflow/${id}`);
  if (CHECK) return line('workflow', id, got.ok ? 'exists' : 'absent', got, got.ok ? `enabled=${got.json?.enabled} valid=${got.json?.valid}` : '');
  if (got.ok) {
    if (got.json?.yaml === yaml && got.json?.enabled) return line('workflow', id, 'unchanged', got, `enabled=${got.json.enabled} valid=${got.json.valid}`);
    return line('workflow', id, 'updated', await kb('PUT', `/api/workflows/workflow/${id}`, { yaml }));
  }
  const r = await kb('POST', '/api/workflows', { workflows: [{ yaml }] });
  const made = r.json?.created?.[0];
  if (r.ok && !made) { r.ok = false; r.text = JSON.stringify(r.json?.failed || r.json).slice(0, 300); r.json = null; }
  line('workflow', made?.id || id, 'created', r, made ? `enabled=${made.enabled}` : '');
}

// ---- verification on throwaway data ----
const bulk = (docs) => docs.map(([id, d]) => `${JSON.stringify({ index: { _id: id } })}\n${JSON.stringify(d)}\n`).join('');
const ago = (hours) => new Date(Date.now() - hours * 3600e3).toISOString();
const rows = (r) => {
  const d = (r.json?.results || []).map((x) => x.data).find((x) => x?.columns && x?.values);
  return d ? d.values.map((v) => Object.fromEntries(d.columns.map((c, i) => [c.name, v[i]]))) : null;
};

async function verifyTools() {
  const testId = (id) => id.replace('roloe.', 'roloe.test_');
  const testTools = tools.map((t) => ({
    ...t,
    id: testId(t.id),
    configuration: { ...t.configuration, query: t.configuration.query.replace(`FROM ${MEETINGS}`, `FROM ${SAMPLE}`) },
  }));
  const testAgent = 'roloe-test-organizer';
  try {
    await es('DELETE', `/${SAMPLE}`);
    line('index', SAMPLE, 'created', await es('PUT', `/${SAMPLE}`, { mappings: MEETINGS_MAPPING }));
    // 8 meetings: 7 inside the last 24 hours, 1 from 30 hours ago.
    const m = (id, kind, h, fa, fd, ttf, ts, tth, stopped = false) => [id, {
      meeting_id: id, kind, started_at: ago(h), updated_at: ago(h), findings_accepted: fa, findings_dropped: fd,
      nothing_strong: fa === 0, ...(ttf == null ? {} : { time_to_findings_s: ttf }), try_state: ts,
      ...(tth == null ? {} : { time_to_help_s: tth }), stopped,
    }];
    const docs = [
      m('e-s000000001', 'pair', 0.2, 3, 1, 41.5, 'passed', 88),
      m('e-s000000002', 'pair', 0.6, 2, 0, 55, 'passed', 131),
      m('e-s000000003', 'guest', 1.2, 1, 2, 72.25, 'failed', null),
      m('e-s000000004', 'pair', 1.4, 0, 3, null, 'did-not-apply', null),
      m('e-s000000005', 'same_person', 1.7, 0, 0, null, 'did-not-apply', null, true),
      m('e-s000000006', 'pair', 2.3, 4, 0, 38, 'passed', 64.5),
      m('e-s000000007', 'guest', 2.5, 2, 1, 61, 'declined', null),
      m('e-s000000008', 'pair', 30, 5, 0, 20, 'passed', 30, true),
    ];
    const b = await es('POST', `/${SAMPLE}/_bulk?refresh=true`, bulk(docs), { 'content-type': 'application/x-ndjson' });
    line('sample', SAMPLE, 'indexed', b, `docs=${docs.length} errors=${b.json?.errors}`);

    for (const t of testTools) {
      await kb('DELETE', `/api/agent_builder/tools/${t.id}`);
      line('tool', t.id, 'created', await kb('POST', '/api/agent_builder/tools', t));
    }
    const pulse = await kb('POST', '/api/agent_builder/tools/_execute', { tool_id: testId('roloe.conference_pulse'), tool_params: { hours_back: 24 } });
    const pr = rows(pulse) || [];
    const sum = (k) => pr.reduce((n, r) => n + (r[k] || 0), 0);
    line('execute', testId('roloe.conference_pulse'), 'ran', pulse, `hours=${pr.length}`);
    expect('conference_pulse on 8 sample meetings (7 in window)',
      sum('meetings') === 7 && sum('pair') === 4 && sum('guest') === 2 && sum('same_person') === 1 && sum('with_findings') === 5 && sum('try_passed') === 3,
      `meetings=${sum('meetings')} pair=${sum('pair')} guest=${sum('guest')} same_person=${sum('same_person')} with_findings=${sum('with_findings')} try_passed=${sum('try_passed')}`);

    const help = await kb('POST', '/api/agent_builder/tools/_execute', { tool_id: testId('roloe.help_outcomes'), tool_params: {} });
    const hr = rows(help) || [];
    const by = Object.fromEntries(hr.map((r) => [r.try_state, r]));
    line('execute', testId('roloe.help_outcomes'), 'ran', help, `rows=${hr.length} (no params: default hours_back)`);
    expect('help_outcomes on the same sample',
      by.passed?.meetings === 3 && by.passed?.within_slo === 2 && by.passed?.share_within_slo === 0.667 && by['did-not-apply']?.meetings === 2 && by.failed?.meetings === 1 && by.declined?.meetings === 1,
      hr.map((r) => `${r.try_state}=${r.meetings}`).join(' ') + ` passed.within_slo=${by.passed?.within_slo}/${by.passed?.timed} share=${by.passed?.share_within_slo} overall=${by.passed?.overall_share_within_slo}`);

    const mcp = await kb('POST', '/api/agent_builder/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { accept: 'application/json, text/event-stream' });
    let mj = mcp.json;
    if (!mj) { const d = mcp.text.match(/^data: (.*)$/m); try { mj = JSON.parse(d?.[1]); } catch { /* leave null */ } }
    const names = (mj?.result?.tools || []).map((t) => t.name);
    const want = tools.map((t) => t.id.replaceAll('.', '_'));
    line('mcp', 'tools/list', 'listed', mcp, `tools=${names.length}`);
    expect('MCP endpoint lists the two real tools', want.every((w) => names.includes(w)), want.map((w) => `${w}=${names.includes(w)}`).join(' '));

    if (CONVERSE) {
      await kb('DELETE', `/api/agent_builder/agents/${testAgent}`);
      const a = agents[0];
      line('agent', testAgent, 'created', await kb('POST', '/api/agent_builder/agents', {
        ...a, id: testAgent, name: `${a.name} (test)`,
        configuration: { ...a.configuration, tools: [{ tool_ids: testTools.map((t) => t.id) }] },
      }));
      const c = await kb('POST', '/api/agent_builder/converse', { agent_id: testAgent, input: 'How is the conference going?' });
      const calls = (c.json?.steps || []).filter((s) => s.type === 'tool_call').map((s) => s.tool_id);
      line('converse', testAgent, 'answered', c, `answer_chars=${(c.json?.response?.message || '').length} tool_calls=[${calls.join(',')}]`);
      expect('agent answered by calling a Roloe tool', c.ok && calls.length > 0 && calls.every((id) => id.startsWith('roloe.test_')));
      if (c.json?.conversation_id) await kb('DELETE', `/api/agent_builder/conversations/${c.json.conversation_id}`);
    }
  } finally {
    line('agent', testAgent, 'deleted', await kb('DELETE', `/api/agent_builder/agents/${testAgent}`).then((r) => (r.status === 404 ? { ...r, ok: true } : r)));
    for (const t of testTools) line('tool', t.id, 'deleted', await kb('DELETE', `/api/agent_builder/tools/${t.id}`).then((r) => (r.status === 404 ? { ...r, ok: true } : r)));
    line('index', SAMPLE, 'deleted', await es('DELETE', `/${SAMPLE}`));
  }
}

async function verifyWorkflow({ id, yaml }) {
  const stamp = Date.now();
  const passages = `roloe-test-wf-${stamp}`;
  const meetings = `${passages}-meetings`;
  const testId = `roloe-test-conference-close-${stamp}`;
  const testYaml = yaml
    .replace(`name: ${id}`, `name: ${testId}`)
    .replace(`passages_index: ${PASSAGES}`, `passages_index: ${passages}`)
    .replace(`meetings_index: ${MEETINGS}`, `meetings_index: ${meetings}`);
  if (testYaml.includes(`: ${PASSAGES}`) || testYaml.includes(`: ${MEETINGS}`) || !testYaml.includes(passages) || !testYaml.includes(meetings)) {
    failures++;
    return console.log('FAIL      workflow test copy still points at a real index; not running it');
  }
  try {
    line('index', passages, 'created', await es('PUT', `/${passages}`, {
      mappings: { properties: { encounter_id: { type: 'keyword' }, owner_id: { type: 'keyword' }, kind: { type: 'keyword' }, ts: { type: 'date' }, shared_at: { type: 'date' } } },
    }));
    line('index', meetings, 'created', await es('PUT', `/${meetings}`, { mappings: MEETINGS_MAPPING }));
    const old = ago(20), recent = ago(0.2);
    await es('POST', `/${passages}/_bulk?refresh=true`, bulk([
      ['card-old', { encounter_id: 'card:x', owner_id: 'x', kind: 'card', ts: old, shared_at: old }],
      ['e-old', { encounter_id: 'e-old', owner_id: 'x', kind: 'copy', ts: old, shared_at: old }],
      ['e-new', { encounter_id: 'e-new', owner_id: 'x', kind: 'copy', ts: recent, shared_at: recent }],
      ['e-undated', { encounter_id: 'e-undated', owner_id: 'x', kind: 'copy', ts: old }],
    ]), { 'content-type': 'application/x-ndjson' });
    await es('POST', `/${meetings}/_bulk?refresh=true`, bulk([
      ['e-old', { meeting_id: 'e-old', kind: 'pair', started_at: old, updated_at: old, stopped: false }],
      ['e-new', { meeting_id: 'e-new', kind: 'pair', started_at: recent, updated_at: recent, stopped: false }],
    ]), { 'content-type': 'application/x-ndjson' });

    const made = await kb('POST', '/api/workflows', { workflows: [{ yaml: testYaml }] });
    line('workflow', testId, 'created', made);
    const run = await kb('POST', `/api/workflows/workflow/${testId}/run`, { inputs: {} });
    const execId = run.json?.workflowExecutionId;
    line('workflow', testId, 'run', run, `execution=${execId}`);
    let status = 'unknown', steps = [];
    for (let i = 0; execId && i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const e = await kb('GET', `/api/workflows/executions/${execId}`);
      status = e.json?.status || status;
      steps = (e.json?.stepExecutions || []).map((s) => `${s.stepId}=${s.status}`);
      if (!['pending', 'running', 'waiting', 'unknown'].includes(status)) break;
    }
    expect('test workflow run completed', status === 'completed', `status=${status} ${steps.join(' ')}`);

    await es('POST', `/${passages},${meetings}/_refresh`);
    const left = await es('POST', `/${passages}/_search`, { size: 10, _source: false, sort: ['_doc'] });
    const ids = (left.json?.hits?.hits || []).map((h) => h._id).sort();
    expect('only the old shared copy was deleted', ids.join(',') === 'card-old,e-new,e-undated', `remaining=[${ids.join(',')}] deleted=${4 - ids.length} of 4`);
    const ms = await es('POST', `/${meetings}/_search`, { size: 10, _source: ['stopped'] });
    const st = Object.fromEntries((ms.json?.hits?.hits || []).map((h) => [h._id, h._source.stopped]));
    expect('only the old meeting was marked stopped', st['e-old'] === true && st['e-new'] === false, `e-old.stopped=${st['e-old']} e-new.stopped=${st['e-new']}`);
  } finally {
    line('workflow', testId, 'deleted', await kb('DELETE', `/api/workflows/workflow/${testId}`));
    line('index', passages, 'deleted', await es('DELETE', `/${passages}`));
    line('index', meetings, 'deleted', await es('DELETE', `/${meetings}`));
  }
}

// ---- main ----
console.log(`mode: ${CHECK ? 'check' : VERIFY ? 'verify' : 'apply'}`);
if (VERIFY) {
  await verifyTools();
  for (const w of workflows) await verifyWorkflow(w);
} else {
  await ensureIndex(MEETINGS, MEETINGS_MAPPING);
  await ensureField(PASSAGES, 'shared_at', { type: 'date' });
  for (const t of tools) await upsertTool(t);
  for (const a of agents) await upsertAgent(a);
  for (const w of workflows) await upsertWorkflow(w);
}
if (failures) { console.error(`${failures} problem(s)`); process.exit(1); }
