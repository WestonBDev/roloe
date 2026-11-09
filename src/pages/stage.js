// Stage screen. The clock runs from the tap and stops green when Try it passes. If the live read
// isn't in by the cutoff (1:40), the recorded run is shown, labelled, while the live clock runs.
import { $, esc, api, hhmm, short, secs, whoseWords, isCode, replayView, replayEndMs, renderer, poll } from '/roloe.js';

const id = location.pathname.split('/').pop();
const qs = new URLSearchParams(location.search);
const key = qs.get('k') || '';
const recId = qs.get('recorded');
const recKey = qs.get('rk');
const cutoffS = Number(qs.get('cutoff') || 100);
const replayOnly = qs.get('replay') === '1';   // replay this meeting itself, from its tap, on its own clock
let recStart = null;
const replayStart = Date.now();
if (qs.get('theme')) document.documentElement.dataset.theme = qs.get('theme');
const drawA = renderer($('#colA')), drawB = renderer($('#colB')), drawTry = renderer($('#tryline')), drawStrip = renderer($('#strip'));
let live = null, recorded = null, skew = 0;

const fmt = (ms) => { const s = Math.max(0, ms) / 1000; return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`; };

function column(v, who, other) {
  const s = v.sides[who];
  const seal = s.seal;
  const sealHtml = !seal ? '<p class="hash">no line sealed yet</p>'
    : seal.skipped ? '<p class="hash">skipped the sealed line</p>'
    : seal.line ? `<p class="label">${esc(s.name)} expected</p><p class="sealed">${esc(seal.line)}</p>`
    : `<p class="hash">sealed ${esc(hhmm(seal.ts))} · ${esc(short(seal.hash))}</p>`;
  let body;
  if (s.top) {
    const f = s.top;
    body = `<article class="card deal"><span class="tab">From ${esc(s.name)} <span class="mono">· today ${esc(hhmm(f.credit?.ts))}</span></span>
      <p class="quote${isCode(f) ? ' code' : ''}">${esc(f.quote)}</p><p class="label">${esc(whoseWords(f.credit, s.name))}</p>
      <p>${esc(f.what)}</p><p class="cite">cites ${esc(f.cites)} · ${esc(f.credit?.locator)}</p></article>
      ${s.more ? `<p class="more">and ${s.more} more filed behind it</p>` : ''}`;
  } else if (s.posted && s.nothing_strong) {
    body = `<article class="card deal"><span class="tab">From ${esc(s.name)}</span><p class="quote" style="font-size:40px">Nothing strong this time.</p><p>An honest answer, filed.</p></article>`;
  } else if (v.guest && who.startsWith('guest-')) {
    body = `<p class="state">${esc(s.name)} is a guest: nothing about them is read unless they gave a link.</p>`;
  } else {
    body = `<p class="state wait">${esc(s.name)}'s assistant is reading ${esc(v.names[other])}'s overlap</p>`;
  }
  return `<div class="who">${esc(s.name)} → ${esc(v.names[other])}</div>${sealHtml}${body}`;
}

const TRY = { review: 'Try it: reading the diff', installing: 'Try it: installing dependencies', testing: 'Try it: running their tests with no network', passed: 'Try it passed', failed: 'Try it failed', declined: 'Try it declined', 'did-not-apply': "Try it: the change didn't apply" };

function strip(v, label) {
  const p = Object.entries(v.prepared).map(([o, c]) => `<span>${esc(v.names[o])}'s card <b>${c.passages}</b> passages</span>`).join('');
  const l = v.live;
  const posted = [v.a, v.b].filter((w) => v.sides[w].posted_ms != null).map((w) => `<span>${esc(v.names[w])} posted <b>${secs(v.sides[w].posted_ms)}</b></span>`).join('');
  return `<div class="group"><span class="label">Prepared before</span>${p || '<span>–</span>'}</div>
    <div class="group"><span class="label live">${esc(label)}</span><span>tap → overlap <b>${secs(l.ready_ms)}</b></span><span>scope <b>${esc(v.scope.split(' (')[0])}</b></span>${posted}<span>tap → green <b>${secs(l.green_ms)}</b></span><span>trace ${esc((v.trace_id || '').slice(0, 12))}</span></div>`;
}

function render() {
  if (!live) return;
  const now = Date.now() + skew;
  let v, clockMs, label, recLabel = '';
  if (replayOnly) {
    clockMs = Math.min(now - skew - replayStart, replayEndMs(live));
    v = replayView(live, clockMs);
    label = `Recorded ${hhmm(live.tap)}`;
    recLabel = `Recorded ${hhmm(live.tap)} · replayed on its real clock`;
    if (v.live.green_ms != null) clockMs = v.live.green_ms;
  } else {
    clockMs = live.live.green_ms ?? (now - live.tap);
    const liveDone = live.live.all_findings_ms != null || live.live.green_ms != null;
    const useRec = recorded && !liveDone && clockMs > cutoffS * 1000;
    if (useRec) {
      if (recStart == null) recStart = Date.now();
      v = replayView(recorded, Date.now() - recStart);
      label = `Recorded ${hhmm(recorded.tap)}`;
      recLabel = `Showing the run recorded at ${hhmm(recorded.tap)} · live clock still running`;
    } else { v = live; label = 'Read live'; }
  }
  const clock = $('#clock');
  clock.textContent = fmt(clockMs);
  const green = v.live.green_ms != null;
  clock.classList.toggle('green', green);
  $('#clocklabel').textContent = green ? 'tap → working help · stopped at Try it passed' : 'tap → working help';
  $('#reclabel').hidden = !recLabel;
  $('#reclabel').textContent = recLabel;
  $('#names').innerHTML = `${esc(v.names[v.a])} ↔ ${esc(v.names[v.b])}${v.same_person ? ' <span class="label rec">same person, two projects</span>' : ''}`;
  drawA(column(v, v.a, v.b));
  drawB(column(v, v.b, v.a));
  drawTry(v.try ? `<span class="state ${v.try.state === 'passed' ? 'ok' : v.try.state === 'failed' ? 'bad' : 'wait'}">${esc(TRY[v.try.state] || v.try.state)}${v.try.state === 'passed' && v.try.passed != null ? ` · ${v.try.passed} tests, ${secs(v.try.test_ms)}, no network` : ''}</span>` : '');
  drawStrip(strip(v, label));
}

async function refresh() {
  try {
    live = await api(`/api/e/${id}/stage?k=${encodeURIComponent(key)}`);
    skew = live.now - Date.now();
    if (recId && !recorded) recorded = await api(`/api/e/${recId}/stage?k=${encodeURIComponent(recKey)}`).catch(() => null);
  } catch (e) {
    $('#names').textContent = e.offline ? 'Offline: reconnecting…' : e.status === 401 ? 'This stage link is missing its key.' : e.message;
  }
}
poll(refresh, 1000);
(function tick() { render(); requestAnimationFrame(tick); })();
