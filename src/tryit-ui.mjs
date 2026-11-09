// The recipient's Try it page, on 127.0.0.1 only: their code never reaches the coordinator.
// Only status and counts go up, for the stage clock and the giver's thank-you.
import http from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { api } from './client.mjs';
import { copyProject, applyEdits, literalDiff, runSandboxed, patchText, dockerAvailable } from './tryit.mjs';

const CSS = readFileSync(new URL('./pages/roloe.css', import.meta.url), 'utf8');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function diffHtml(diff) {
  return diff.split('\n').map((l) => {
    const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'meta'
      : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
    return `<span class="${cls}">${esc(l) || ' '}</span>`;
  }).join('');
}

function page({ finding, from, diff, applyError }) {
  const when = finding?.credit?.ts ? new Date(finding.credit.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Roloe · Try it</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500&family=IBM+Plex+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>${CSS}
main.try { max-width: 1240px; display: grid; grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr); gap: 24px; align-items: start; }
@media (max-width: 980px) { main.try { grid-template-columns: 1fr; } }
.side { display: flex; flex-direction: column; gap: 18px; position: sticky; top: 16px; }
</style></head><body>
<header class="top" style="max-width:1240px"><span class="wordmark">Roloe</span><span>Try it · on this laptop only</span></header>
<main class="try">
  <section aria-label="The change">
    <p class="label" style="margin-bottom:10px">Change from ${esc(from)}, via Roloe · the literal diff</p>
    ${applyError ? `<div class="card"><span class="tab">Didn't apply</span><p>${esc(applyError)}</p><p class="muted">Your project wasn't touched. The finding still stands as advice.</p></div>`
      : `<div class="diff" role="region" aria-label="git diff" tabindex="0">${diffHtml(diff)}</div>`}
  </section>
  <aside class="side">
    <div class="card"><span class="tab">${esc(from)} <span class="mono">· ${esc(when)}</span></span>
      <p class="quote">${esc(finding?.quote)}</p>
      <p>${esc(finding?.what)}</p>
      <p class="cite">cites ${esc(finding?.cites)} · ${esc(finding?.credit?.locator)}</p>
    </div>
    <div class="card"><span class="tab">The sandbox</span>
      <p>Runs in a temporary copy of your project. No network, no credentials, no environment, no home folder. Deleted after.</p>
      <p class="muted">Dependencies install from your lockfile first; then the network is cut and your tests run.</p>
    </div>
    <div id="act" class="row" ${applyError ? 'hidden' : ''}>
      <button id="approve">Approve and run tests</button><button id="decline" class="ghost">Decline</button>
    </div>
    <p id="status" class="state wait" hidden></p>
    <div id="result" hidden></div>
    <pre id="out" class="output" hidden aria-live="polite"></pre>
  </aside>
</main>
<script>
const $ = (id) => document.getElementById(id);
const label = { installing: 'Installing dependencies (network on)', testing: 'Running your tests with no network', passed: 'Passed', failed: 'Failed', declined: 'Declined', review: 'Waiting for you' };
async function post(p) { return fetch(p, { method: 'POST' }); }
$('approve').onclick = async () => { $('act').hidden = true; await post('approve'); poll(); };
$('decline').onclick = async () => { $('act').hidden = true; await post('decline'); poll(); };
async function poll() {
  const s = await (await fetch('status')).json();
  const st = $('status'); st.hidden = false; st.textContent = label[s.state] || s.state;
  st.className = 'state ' + (s.state === 'passed' ? 'ok' : s.state === 'failed' ? 'bad' : 'wait');
  if (s.output) { $('out').hidden = false; $('out').textContent = s.output; $('out').scrollTop = 1e9; }
  if (s.state === 'passed') {
    $('result').hidden = false;
    $('result').innerHTML = '<div class="card"><span class="tab">Passed</span><p><b>' + s.passed + ' tests passed</b> in ' + (s.test_ms / 1000).toFixed(1) + ' s, with no network.</p><p>Your project is unchanged.</p><div class="row" style="margin-top:8px"><button id="save">Save as a patch</button></div><p id="saved" class="cite"></p></div>';
    $('save').onclick = async () => { const r = await (await post('save')).json(); $('saved').textContent = 'Saved ' + r.path + ' · git apply to use it, git apply -R to undo'; };
  } else if (s.state === 'failed') {
    $('result').hidden = false;
    $('result').innerHTML = '<div class="card"><span class="tab">Failed</span><p>' + (s.reason || ((s.failed ?? '?') + ' failed, ' + (s.passed ?? 0) + ' passed')) + '</p><p>Your project is unchanged.</p></div>';
  } else if (s.state !== 'declined' && s.state !== 'review') setTimeout(poll, 600);
}
</script></body></html>`;
}

export async function startTryUi({ cfg, encounterId, findingId, port = 7421 }) {
  const forMe = await api(cfg, 'GET', `/api/e/${encounterId}/for-me`);
  const finding = forMe.findings.find((f) => (findingId ? f.id === findingId : f.change)) || null;
  if (!finding) throw new Error(findingId ? 'No finding with that id.' : forMe.findings.length ? 'None of the findings carries a change to try.' : 'No findings for you yet.');
  if (!finding.change?.edits?.length) throw new Error('This finding carries no change to try; it stands as advice.');
  const report = (state, extra = {}) => api(cfg, 'POST', `/api/e/${encounterId}/try`, { finding: finding.id, state, ...extra }).catch(() => {});

  const status = { state: 'review', output: '' };
  let copy = copyProject(cfg.project, encounterId);
  const applied = applyEdits(copy, finding.change.edits);
  let diff = '';
  if (!applied.ok) {
    status.state = 'did-not-apply'; status.reason = applied.reason;
    rmSync(copy, { recursive: true, force: true }); copy = null;
    await report('did-not-apply');
  } else {
    diff = literalDiff(copy);
    await report('review');
  }
  // If the page is abandoned (Ctrl-C or a kill), the throwaway copy still goes. Node emits no
  // 'exit' for an unhandled signal, so handle the signals themselves.
  const cleanup = () => { if (copy) { rmSync(copy, { recursive: true, force: true }); copy = null; } };
  process.once('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { cleanup(); process.exit(130); });
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  if (!applied.ok) resolveDone({ state: 'did-not-apply', reason: applied.reason });

  const html = page({ finding, from: forMe.from, diff, applyError: applied.ok ? null : applied.reason });
  const server = http.createServer(async (req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    // Only this machine: refuse anything that isn't a same-origin local request.
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(403, { error: 'local only' });
    if (req.method !== 'GET' && req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin)) return json(403, { error: 'local only' });
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html); }
    if (req.method === 'GET' && req.url === '/status') return json(200, { ...status, output: status.output.slice(-6000) });
    if (req.method === 'POST' && req.url === '/approve' && status.state === 'review' && copy) {
      status.state = 'installing';
      json(202, { state: status.state });
      if (!dockerAvailable()) {
        rmSync(copy, { recursive: true, force: true }); copy = null;
        status.state = 'failed'; status.reason = 'Docker is not running on this laptop'; await report('failed'); return resolveDone(status);
      }
      let r;
      try {
        r = await runSandboxed(copy, {
          onState: (st) => { status.state = st; if (st === 'installing' || st === 'testing') report(st); },
          onOutput: (d) => { status.output += d; },
        });
      } catch (e) {
        // runSandboxed already deleted the copy in its finally.
        r = { state: 'failed', reason: `The run could not start: ${e.message}`.slice(0, 200), output: '' };
      }
      copy = null;
      Object.assign(status, { state: r.state, passed: r.passed, failed: r.failed, test_ms: r.test_ms, reason: r.reason });
      await report(r.state, { passed: r.passed, failed: r.failed, test_ms: r.test_ms, sandbox: 'docker-network-none' });
      return resolveDone({ ...status, output: r.output });
    }
    if (req.method === 'POST' && req.url === '/decline' && status.state === 'review') {
      status.state = 'declined';
      if (copy) rmSync(copy, { recursive: true, force: true }); copy = null;
      await report('declined');
      json(200, { state: 'declined' });
      return resolveDone(status);
    }
    if (req.method === 'POST' && req.url === '/save' && diff) {
      const dir = join(homedir(), 'roloe-patches');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${encounterId}-${finding.id}.patch`);
      writeFileSync(path, patchText(diff, { giver: forMe.from, finding: finding.id, cites: finding.cites }));
      return json(200, { path });
    }
    json(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  return { url, done, finding, get copyPath() { return copy; }, close: () => new Promise((r) => server.close(r)) };
}
