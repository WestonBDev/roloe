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

function title(v) {
  $('#title').textContent = `${v.my_name} ↔ ${v.their_name}`;
  $('#when').textContent = hhmm(v.created);
  document.title = `Roloe · ${v.their_name}`;
  $('#consent').textContent = v.guest
    ? `${v.their_name}'s assistant reads only the link you gave, if any. Nothing else about you is read.`
    : `${v.their_name}'s assistant reads only what you shared today, for this meeting. Stop ends it for both of you.`;
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
  if (v.status !== 'open' || theirs.posted) return '';
  const n = Math.round((Date.now() - firstSeen) / 1000);
  return `<div class="card"><span class="tab">${esc(v.their_name)}'s assistant is reading</span>
    <h2>Keep talking. We'll tap you when there's something.</h2>
    <p class="state wait"><span class="mono" id="secs">${n} s</span></p></div>`;
}

function findingsSection(v) {
  if (v.findings.length) return v.findings.map((f, i) => findingCard(f, v.their_name, { index: i, flip: !v.guest })).join('');
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
  const done = v.their_side.posted;
  return `${done ? `<div class="card"><span class="tab">Your turn, if you like</span>
      <p>Get findings from your own work too: <code>git clone https://github.com/WestonBDev/roloe</code>, then <code>roloe on</code>. It's an offer, not a gate.</p></div>` : ''}
    <form class="card" id="probe"><span class="tab">Try to extract something</span>
      <label for="q"><p>Type anything you think ${esc(v.their_name)} might have that wasn't shared. This asks the coordinator directly, not anyone's assistant.</p></label>
      <input id="q" type="text" autocomplete="off" spellcheck="false" placeholder="a word, a secret, a canary">
      <div class="row" style="margin-top:12px"><button type="submit">Try it</button></div>
      <p id="probeout" aria-live="polite" style="margin-top:12px"></p>
    </form>`;
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
  if (draw.findings(findingsSection(v))) wireTurns($('#findings'));
  draw.expect(expectSection(v));
  draw.thanks(thanksSection(v));
  if (draw.guest(guestSection(v))) wireProbe();
  draw.receipt(v.status === 'open' ? receiptSection(v) : `<div class="card"><span class="tab">Stopped</span><p>This meeting was stopped${v.closed ? ` at ${esc(hhmm(v.closed.at))}` : ''}. Its key is revoked and its ${v.closed?.deleted ?? ''} shared copies are deleted; a query with the old key now returns ${v.closed?.query_after_stop ?? 0}.</p></div>`);
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

async function refresh() {
  try {
    view = await api(`/api/e/${id}`, { key });
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
