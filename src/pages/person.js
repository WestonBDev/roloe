// The person's meeting page: seal a line or skip → keep talking → findings dealt one at a time
// → what you expected, revealed → thank-you → receipt → stop. Guests get the same page without
// the seal, plus the install offer and the extraction attempt.
import { $, esc, api, hhmm, hhmmss, short, store, sha256hex, nonce, findingCard, wireTurns, renderer, poll } from '/roloe.js';

const id = location.pathname.split('/').pop();
const key = new URLSearchParams(location.search).get('k') || '';
const sealKey = `roloe.seal.${id}`;
const draw = {
  seal: renderer($('#seal')), wait: renderer($('#wait')), findings: renderer($('#findings')), expect: renderer($('#expect')),
  thanks: renderer($('#thanks')), receipt: renderer($('#receipt')), guest: renderer($('#guest')),
};
let view = null;
let firstSeen = Date.now();
let justFiled = false;

function title(v) {
  // A guest has no name here: the page is simply the person they scanned.
  $('#title').innerHTML = v.guest && String(v.me).startsWith('guest-') ? esc(v.their_name)
    : `${esc(v.my_name)} ↔ ${esc(v.their_name)}${v.same_person ? ' <span class="label rec">same person, two projects</span>' : ''}`;
  $('#when').textContent = hhmm(v.created);
  document.title = `Roloe · ${v.their_name}`;
  $('#consent').textContent = v.guest ? '' : `${v.their_name}'s assistant reads only what you shared today, for this meeting. Stop ends it for both of you.`;
  $('#stop').hidden = v.status !== 'open';
}

function sealSection(v) {
  if (v.guest) return '';
  const m = v.seal.mine;
  if (!m) {
    return `<form class="card" id="sealform"><span class="tab">Before you look</span>
      <label for="line"><h2>What do you expect ${esc(v.their_name)} could do for you?</h2></label>
      <input id="line" type="text" maxlength="120" autocomplete="off" placeholder="one short line" enterkeyhint="done">
      <div class="row" style="margin-top:14px"><button type="submit">Seal</button><button type="button" class="ghost" id="skip">Skip</button></div>
      <p class="muted" style="font-size:14px;margin-top:10px">Only a hash is sent now. Your line opens when the findings land, so everyone can see what you didn't expect.</p>
    </form>`;
  }
  if (m.skipped) return '';
  return `<p class="mono muted">Sealed ${esc(hhmmss(m.ts))} · ${esc(short(m.hash))}</p>`;
}

function waitSection(v) {
  const theirs = v.their_side;
  if (v.status === 'preparing') {
    return `<div class="card"><span class="tab">Opening your meeting with ${esc(v.their_name)}</span>
      <h2>${v.guest_input?.kind === 'reading' ? 'Reading what you gave…' : 'Getting the cards side by side…'}</h2>
      <p class="state wait">Keep talking.</p></div>`;
  }
  if (v.status === 'failed') {
    return `<div class="card"><span class="tab">Couldn't open</span><h2>${esc(v.guest_input?.error || 'This meeting could not be opened.')}</h2>
      <p><a href="/g/${esc(v.them)}">Scan again</a></p></div>`;
  }
  if (v.status !== 'open' || theirs.posted) return '';
  if (v.guest && v.instant) return '';   // the instant card carries the waiting state
  const n = Math.round((Date.now() - firstSeen) / 1000);
  return `<div class="card"><span class="tab">${esc(v.their_name)}'s assistant is reading</span>
    <h2>Keep talking.</h2>
    <p class="state wait"><span class="mono" id="secs">${n} s</span></p>
    ${n > 60 ? `<p class="muted" style="margin-top:6px">Still reading. ${esc(v.their_name)}'s assistant sometimes takes a little longer. This page updates by itself, and this link keeps working if you come back later.</p>` : ''}</div>`;
}

const diffLines = (d) => `<div class="diff" role="region" aria-label="the change, as a git diff" tabindex="0">${String(d || '').split('\n').map((l) => `<span class="${l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'meta' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}">${esc(l) || ' '}</span>`).join('')}</div>`;

// A guest's Try it: prepared on the card owner's laptop, approved here, run there with no network.
function tryBlock(f, v) {
  const t = f.try;
  if (!t) return '';
  const who = esc(v.their_name);
  const head = '<p class="label" style="margin:6px 0 10px">Try it on your repo</p>';
  const secs = ((t.test_ms || 0) / 1000).toFixed(1);
  switch (t.state) {
    case 'diff-pending': return `<div class="card">${head}<p class="state wait">Putting the change on a copy of your repo…</p></div>`;
    case 'review': return `<div class="card">${head}${diffLines(t.diff)}
      <p class="cite" style="margin-top:10px">deps install from your lockfile (network on) · then ${esc(t.test_command || 'your tests')} with no network · nothing pushed</p>
      <button class="wide" style="margin-top:12px" data-approve="${esc(f.id)}">Approve and run my tests</button>
      <button class="ghost wide quiet" style="margin-top:6px" data-decline="${esc(f.id)}">No thanks</button></div>`;
    case 'no-tests': return `<div class="card">${head}${diffLines(t.diff)}<p style="margin-top:8px"><b>No tests to run.</b> ${esc(t.reason || 'This project has no test command, so the change was not run.')}</p></div>`;
    case 'did-not-apply': return `<div class="card">${head}<p><b>The change didn't apply to your repo as it is now.</b> ${esc(t.reason || '')}</p></div>`;
    case 'approved': return `<div class="card">${head}<p class="state wait">Starting the sandbox on ${who}'s laptop…</p></div>`;
    case 'installing': return `<div class="card">${head}<p class="state wait">Installing your dependencies…</p></div>`;
    case 'testing': return `<div class="card">${head}<p class="state wait">Running your tests with no network…</p></div>`;
    case 'passed': return `<div class="card">${head}<p class="verdict">${t.passed} tests passed</p><p class="cite">${t.passed} of your tests passed with this change · ${secs} s · no network · nothing pushed</p></div>`;
    case 'failed': return `<div class="card">${head}<p class="verdict bad">${t.reason ? esc(t.reason) : `${t.failed ?? '?'} failed, ${t.passed ?? 0} passed`}</p><p class="cite">your repo is unchanged</p></div>`;
    case 'declined': return `<div class="card">${head}<p>Declined. Nothing was run.</p></div>`;
    default: return '';
  }
}

const WHOSE = { owner: (n) => `${n}'s own words`, commit: (n) => `${n}'s commit message`, file: (n) => `from ${n}'s code`, session: (n) => `from ${n}'s working session` };

// Their words, instantly: shown before any model runs, replaced in place when findings land.
function instantCard(v) {
  const i = v.instant;
  if (!i || v.findings.length || v.their_side.posted) return '';
  const name = esc(v.their_name);
  const status = v.their_assistant === 'online'
    ? `<p class="state wait">${name}'s agent is reading the rest…</p>`
    : `<p class="state">${name}'s agent will answer when it's back.</p>`;
  return `<article class="card deal instant"><span class="tab">${name} <span class="mono">· matched instantly</span></span>
    <p class="quote${i.kind === 'file' ? ' code' : ''}">${esc(i.text)}</p>
    <p class="label">${esc((WHOSE[i.whose] || WHOSE.session)(v.their_name))}</p>
    <p class="cite">cites ${esc(i.passage_id)} · ${esc(i.locator)}</p>
    ${status}</article>`;
}

function findingsSection(v) {
  if (v.guest && !v.findings.length && v.instant && !v.their_side.posted) return instantCard(v);
  if (v.findings.length) return v.findings.map((f, i) => findingCard(f, v.their_name, { index: i, flip: !v.guest }) + (v.guest ? tryBlock(f, v) : '')).join('');
  if (v.their_side.posted && v.their_side.nothing_strong) {
    return `<article class="card deal"><span class="tab">${esc(v.their_name)}</span><h2>Nothing strong this time.</h2>
      <p>${esc(v.their_name)}'s assistant read the overlap and found nothing worth your time. That's an honest answer, not an error.</p></article>`;
  }
  return '';
}

function expectSection(v) {
  if (!v.their_side.posted) return '';
  const mine = v.seal.mine?.line;
  const theirs = v.seal.theirs?.line;
  if (!mine && !theirs) return '';
  return `<div class="card"><span class="tab">What you each expected</span>
    ${mine ? `<p class="label">You sealed</p><p class="quote" style="font-size:26px">${esc(mine)}</p>` : ''}
    ${theirs ? `<p class="label">${esc(v.their_name)} sealed</p><p class="quote" style="font-size:26px">${esc(theirs)}</p>` : ''}
  </div>`;
}

function thanksSection(v) {
  if (!v.thanks.length) return '';
  return v.thanks.map((t) => `<div class="card deal"><span class="tab">Thank you, from ${esc(v.their_name)}</span>
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">Your help worked.</h2><span class="stamp">Helped · ${esc(hhmm(t.at))}</span></div>
    <p>${t.tests_passed != null ? `${t.tests_passed} of their tests passed with your change, ` : ''}${(t.ms_to_green / 1000).toFixed(0)} s after you tapped.</p></div>`).join('');
}

function receiptSection(v) {
  if (v.guest) return '';
  const read = v.receipt.read_by_them;
  return `<details class="card"><summary style="cursor:pointer;min-height:44px;display:flex;align-items:center"><b>Receipt</b>&nbsp;<span class="muted">· ${read.length} of your passages read by ${esc(v.their_name)}'s assistant</span></summary>
    <p class="cite">${read.map(esc).join(' · ') || 'None yet.'}</p>
    <p class="muted" style="font-size:14px">See each one on your card page. Stop deletes this meeting's copies; it can't recall what an assistant already read.</p></details>`;
}

function guestSection(v) {
  if (!v.guest) return '';
  const gi = v.guest_input || {};
  const read = gi.error ? `<div class="card"><span class="tab">About your link</span><p>${esc(gi.error)}</p></div>`
    : gi.kind === 'github' ? `<p class="cite">read ${gi.files ?? 0} files from your repo · this meeting only</p>`
    : gi.kind === 'page' ? '<p class="cite">read the text of your link · this meeting only</p>' : '';
  // The extraction attempt stays one tap away: it is for the curious, not for everyone's first read.
  return `${read}
    <details class="card"><summary>Try to extract something</summary>
    <form id="probe">
      <label for="q"><p>Type anything you think ${esc(v.their_name)} might have that wasn't shared. This asks the coordinator directly, not anyone's assistant.</p></label>
      <input id="q" type="text" autocomplete="off" spellcheck="false" placeholder="a word, a secret, a canary">
      <button type="submit" class="wide" style="margin-top:12px">Try it</button>
      <p id="probeout" aria-live="polite" style="margin-top:12px"></p>
    </form></details>`;
}

async function maybeReveal(v) {
  const s = store.get(sealKey);
  if (!s || !v.seal.mine?.hash || v.seal.mine.line || !v.their_side.posted) return;
  try { await api(`/api/e/${id}/reveal`, { method: 'POST', key, body: s }); } catch { /* already revealed or mismatch: nothing to show */ }
}

function render(v) {
  title(v);
  if (draw.seal(sealSection(v))) wireSeal(v);
  draw.wait(waitSection(v));
  $('#stack-edges').hidden = !v.findings.length;
  if (draw.findings(findingsSection(v))) { wireTurns($('#findings')); wireTry(); }
  draw.expect(expectSection(v));
  draw.thanks(thanksSection(v));
  if (draw.guest(guestSection(v))) wireProbe();
  draw.receipt(v.status === 'open' ? receiptSection(v) : v.status !== 'closed' ? '' : `<div class="card"><span class="tab">Stopped</span><p>This meeting was stopped${v.closed ? ` at ${esc(hhmm(v.closed.at))}` : ''}. Its key is revoked and its ${v.closed?.deleted ?? ''} shared copies are deleted; a query with the old key now returns ${v.closed?.query_after_stop ?? 0}.</p></div>`);
}

function wireSeal(v) {
  const form = $('#sealform');
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const line = $('#line').value.trim();
    if (!line) return $('#line').focus();
    const n = nonce();
    store.set(sealKey, { line, nonce: n });
    await api(`/api/e/${id}/seal`, { method: 'POST', key, body: { hash: await sha256hex(`${n}|${line}`) } }).catch(showErr);
    refresh();
  };
  $('#skip').onclick = async () => { await api(`/api/e/${id}/seal`, { method: 'POST', key, body: { skipped: true } }).catch(showErr); refresh(); };
}

function wireTry() {
  document.querySelectorAll('[data-approve],[data-decline]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      const finding = b.dataset.approve || b.dataset.decline;
      await api(`/api/e/${id}/try-approve`, { method: 'POST', key, body: { finding, decline: Boolean(b.dataset.decline) } }).catch(showErr);
      refresh();
    };
  });
}

function wireProbe() {
  const form = $('#probe');
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#q').value;
    const out = $('#probeout');
    out.className = 'state wait'; out.textContent = 'Asking the coordinator…';
    try {
      const r = await api(`/api/e/${id}/probe`, { method: 'POST', key, body: { q } });
      out.className = `state ${r.result === 'found' ? 'wait' : 'ok'}`;
      out.innerHTML = `${esc(r.message)}${r.matches ? ` <span class="mono">${r.matches.map((m) => esc(m.passage_id)).join(', ')}</span>` : ''}${r.trace_id ? `<br><span class="cite">scope check: ${esc(r.scope_check || 'request refused')} · trace ${esc(r.trace_id.slice(0, 12))}</span>` : ''}`;
    } catch (err) { showErr(err); }
  };
}

function showErr(e) {
  const el = $('#err');
  el.hidden = false;
  el.textContent = e.offline ? 'Offline. Your meeting is safe; this page will catch up when you reconnect.' : e.status === 401 ? 'This link is missing its key. Open the link you were given.' : e.status === 404 ? 'This meeting does not exist (or was never created here).' : e.message;
}

// File this meeting in this phone's own Roloe (no account; stays on the phone).
function fileInWheel(v) {
  const w = store.get('roloe.wheel') || [];
  if (w.some((e) => e.id === id)) return false;
  w.push({ id, key, name: v.their_name, at: Date.parse(v.created) || Date.now() });
  store.set('roloe.wheel', w.slice(-200));
  return true;
}

async function refresh() {
  try {
    view = await api(`/api/e/${id}`, { key });
    // Only the guest's phone files the meeting, never the card owner's.
    if (view.guest && String(view.me).startsWith('guest-')) {
      if (fileInWheel(view)) justFiled = true;
      $('#filed').innerHTML = `<a class="btn ghost wide" href="/r${justFiled ? `?new=${esc(id)}` : ''}">Your Roloe</a>`;
    }
    if (view.times?.tap) firstSeen = view.times.tap;
    $('#err').hidden = true;
    await maybeReveal(view);
    render(view);
  } catch (e) { showErr(e); }
}

$('#stop').onclick = async () => {
  if (!confirm('Stop this meeting for both of you? Its key is revoked and its shared copies are deleted.')) return;
  await api(`/api/e/${id}/stop`, { method: 'POST', key }).catch(showErr);
  refresh();
};

setInterval(() => { const s = $('#secs'); if (s) s.textContent = `${Math.round((Date.now() - firstSeen) / 1000)} s`; }, 1000);
poll(refresh, 1500);
