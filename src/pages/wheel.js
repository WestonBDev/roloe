// Your Roloe: the cards you scanned, on this phone only. Flick through them like a rotary file:
// spring flips, a soft click per card, and a new card drops in. Reduced motion turns it all off.
import { $, esc, api, hhmm, store } from '/roloe.js';

const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wheel = (store.get('roloe.wheel') || []).sort((a, b) => b.at - a.at);
let i = 0;
let soundOn = store.get('roloe.sound') ?? true;
let ctx = null;

// A soft "tick-thock": a short filtered noise tick and a falling sine, synthesized, no files.
function click() {
  if (!soundOn) return;
  try {
    ctx ||= new AudioContext();
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(95, t + 0.07);
    g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.1);
    const n = ctx.createBufferSource(); const b = ctx.createBuffer(1, 800, ctx.sampleRate); const d = b.getChannelData(0);
    for (let k = 0; k < d.length; k++) d[k] = (Math.random() * 2 - 1) * (1 - k / d.length);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2600; const ng = ctx.createGain(); ng.gain.value = 0.12;
    n.buffer = b; n.connect(f).connect(ng).connect(ctx.destination); n.start(t);
    navigator.vibrate?.(4);
  } catch { /* no audio here */ }
}

async function face(entry) {
  let v = null;
  try { v = await api(`/api/e/${entry.id}`, { key: entry.key }); } catch { /* offline or stopped: show what we have */ }
  const f = v?.findings?.[0];
  const body = f ? `<p class="quote${f.credit?.kind === 'file' ? ' code' : ''}">${esc(f.quote)}</p><p>${esc(f.what)}</p>`
    : v?.instant ? `<p class="quote">${esc(v.instant.text)}</p><p class="muted">Matched instantly from ${esc(entry.name)}'s card.</p>`
    : v?.their_side?.nothing_strong ? `<p class="quote" style="font-size:24px">Nothing strong this time.</p>`
    : v?.status === 'closed' ? '<p class="muted">This meeting was stopped.</p>'
    : v?.status === 'failed' ? '<p class="muted">This meeting couldn\'t be opened. Scan the card again.</p>'
    : !v ? '<p class="muted">This meeting is no longer available.</p>'
    : '<p class="muted">Still reading. Tap to open.</p>';
  const more = v?.findings?.length > 1 ? `<p class="label">and ${v.findings.length - 1} more</p>` : '';
  return `<span class="tab">${esc(entry.name)} <span class="mono">· ${esc(hhmm(entry.at))}</span></span>${body}${more}
    <p style="margin-top:8px"><a class="btn ghost" href="/e/${esc(entry.id)}?k=${encodeURIComponent(entry.key)}">Open this card</a></p>`;
}

let renderToken = 0;
async function render(dir = 0) {
  const token = ++renderToken;   // a later flip wins, even if its fetch finishes first
  const stack = $('#stack');
  if (!wheel.length) {
    stack.innerHTML = '<article class="card empty"><span class="tab">Empty</span><h2>No cards yet.</h2><p>Scan someone\'s Roloe QR, and they land here.</p></article>';
    return;
  }
  $('#controls').hidden = wheel.length < 2;
  $('#count').textContent = `${i + 1} / ${wheel.length}`;   // set again below once this card is drawn
  const front = document.createElement('article');
  front.className = 'card';
  const at = i;
  const html = await face(wheel[at]);
  if (token !== renderToken) return;
  front.innerHTML = html;
  const behind = wheel.slice(i + 1, i + 3).map((e, k) => `<article class="card behind" style="transform: translateY(${-(k + 1) * 10}px) scale(${1 - (k + 1) * 0.03}); opacity:${0.55 - k * 0.2}"><span class="tab">${esc(e.name)}</span><p>&nbsp;</p></article>`).reverse().join('');
  stack.innerHTML = behind;
  stack.append(front);
  if (!still && dir) front.animate([{ transform: `perspective(1100px) rotateX(${dir > 0 ? -70 : 70}deg)`, opacity: 0.2 }, { transform: 'perspective(1100px) rotateX(6deg)', opacity: 1, offset: 0.75 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.2,.9,.25,1.1)' });
  if (!still && dir === 0 && new URLSearchParams(location.search).get('new') === wheel[i].id) front.classList.add('dropin');
}

function go(d) {
  const n = Math.max(0, Math.min(wheel.length - 1, i + d));
  if (n === i) return;
  i = n; click(); render(d);
}
$('#prev').onclick = () => go(-1);
$('#next').onclick = () => go(1);
document.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowRight') go(1); if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') go(-1); });
let y0 = null;
$('#stack').addEventListener('pointerdown', (e) => { y0 = e.clientY; });
$('#stack').addEventListener('pointerup', (e) => { if (y0 != null && Math.abs(e.clientY - y0) > 40) go(e.clientY < y0 ? 1 : -1); y0 = null; });
$('#stack').addEventListener('pointercancel', () => { y0 = null; });
$('#sound').onclick = () => { soundOn = !soundOn; store.set('roloe.sound', soundOn); $('#sound').textContent = soundOn ? 'Sound on' : 'Sound off'; $('#sound').setAttribute('aria-pressed', String(soundOn)); };
$('#sound').textContent = soundOn ? 'Sound on' : 'Sound off';
$('#sound').setAttribute('aria-pressed', String(soundOn));
render();
