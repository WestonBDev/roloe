// Your Roloe: the cards you scanned, on this phone only, as a rotary card file in CSS 3D.
// Cards stand on a spindle. The one you're reading is upright; the ones you've passed lean back in
// a fan; the ones to come lean toward you. Drag or flick to turn it, with a soft click per card.
// Blank cards fill out the file, as in a real one. Reduced motion: it jumps instead of turning.
import { $, esc, api, hhmm, store } from '/roloe.js';

const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wheel = (store.get('roloe.wheel') || []).sort((a, b) => b.at - a.at);
const fresh = new URLSearchParams(location.search).get('new');
const BACK = 5, FRONT = 3;   // blank cards behind the first card and ahead of the last
let target = 0;               // the card standing up
let p = 0;                    // where the file is right now (fractional mid-turn)
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

// Where a card leans, by how far it is from the reading position (degrees about the spindle;
// positive leans back, negative leans toward you). The reading card leans back a touch.
const READ = 8;
const FLAT = -78;   // cards to come lie almost flat toward you, below the reading card, so they never cover it
export const angleFor = (d) => (d <= -1 ? READ + 22 + (-d - 1) * 4.2 : d <= 0 ? READ + 22 * -d : d >= 1 ? FLAT - (d - 1) * 2.4 : FLAT + (READ - FLAT) * (1 - d));

async function face(entry) {
  let v = null;
  try { v = await api(`/api/e/${entry.id}`, { key: entry.key }); } catch { /* offline or stopped: show what we have */ }
  const f = v?.findings?.[0];
  if (f) return `<p class="quote${f.credit?.kind === 'file' ? ' code' : ''}">${esc(f.quote)}</p><p class="what">${esc(f.what)}</p>`;
  if (v?.instant) return `<p class="quote${v.instant.kind === 'file' ? ' code' : ''}">${esc(v.instant.text)}</p><p class="what">Matched instantly from ${esc(entry.name)}'s card.</p>`;
  if (v?.their_side?.nothing_strong) return '<p class="quote">Nothing strong this time.</p>';
  if (v?.status === 'closed') return '<p class="what">This meeting was stopped.</p>';
  if (v?.status === 'failed') return '<p class="what">This meeting couldn\'t be opened. Scan the card again.</p>';
  if (!v) return '<p class="what">This meeting is no longer available.</p>';
  return '<p class="what">Still reading. Open the card to watch.</p>';
}

// Draw the file before requests finish. Each face updates as its request resolves (or shows a prompt
// after 2.5 s), then its result is reused on resize; turns only change card angles.
let faces = [];

const rolo = $('#rolo');
const spin = $('#spin');
let leaves = [];

function build() {
  const W = Math.min(innerWidth - 44, 470);
  const H = Math.round(W * 0.78);
  rolo.style.setProperty('--w', `${W}px`); rolo.style.setProperty('--h', `${H}px`); rolo.style.setProperty('--hub', '24px');
  let html = '';
  for (let i = -BACK; i <= wheel.length - 1 + FRONT; i++) {
    const e = wheel[i];
    const tabLeft = 6 + ((((i % 4) + 4) % 4) * 16);
    html += `<div class="leaf" data-i="${i}"><span class="ltab" style="left:${tabLeft}%">${e ? esc(e.name) : ''}</span>
      <div class="paper${e ? '' : ' blank'}">${e ? `<div class="face">${faces[i] || ''}</div>` : ''}</div></div>`;
  }
  spin.innerHTML = `${html}<div class="hub"></div><div class="knob l"></div><div class="knob r"></div>`;
  leaves = [...spin.querySelectorAll('.leaf')].map((el) => ({ el, i: Number(el.dataset.i) }));
}

// Only one thing ever changes on a card: its angle, animated by the compositor (a CSS transition
// on transform). A turn never repaints a card.
function paint() {
  for (const l of leaves) l.el.style.transform = `rotateX(${angleFor(l.i - p).toFixed(2)}deg)`;
}

function label() {
  const e = wheel[target];
  $('#count').textContent = `${target + 1} / ${wheel.length}`;
  $('#open').hidden = !e;
  if (e) { $('#open').href = `/e/${e.id}?k=${encodeURIComponent(e.key)}`; $('#say').textContent = `${e.name}, ${hhmm(e.at)}. Card ${target + 1} of ${wheel.length}.`; }
}

// Turn to `target`: set where every card ends up and let the transition carry it there.
function settle() {
  rolo.classList.remove('dragging');
  p = target;
  paint();
}

function go(d) {
  const n = Math.max(0, Math.min(wheel.length - 1, target + d));
  if (n === target) { settle(); return; }
  target = n; click(); label(); settle();
}

if (!wheel.length) {
  rolo.hidden = true;
  $('#empty').innerHTML = '<article class="card empty"><span class="tab">Empty</span><h2>No cards yet.</h2><p>Scan someone\'s Roloe, and they land here.</p></article>';
} else {
  faces = wheel.map(() => '<p class="what">Loading card…</p>');
  build();
  $('#controls').hidden = wheel.length < 2;
  label();
  // A card you just got flips up into place.
  if (!still && fresh && wheel[0]?.id === fresh) { rolo.classList.add('dragging'); p = -0.98; paint(); setTimeout(() => { click(); settle(); }, 350); } else paint();
  let lastW = innerWidth;
  addEventListener('resize', () => { if (innerWidth !== lastW) { lastW = innerWidth; build(); paint(); } });   // a phone's toolbar sliding away is not a new layout

  $('#prev').onclick = () => go(-1);
  $('#next').onclick = () => go(1);
  document.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowRight') go(1); if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') go(-1); });

  // Drag turns the file under your finger; letting go settles on the nearest card (a flick carries one more).
  let y0 = null, p0 = 0, moved = 0, lastY = 0, lastT = 0, vel = 0;
  rolo.addEventListener('pointerdown', (e) => { y0 = lastY = e.clientY; p0 = p; moved = 0; vel = 0; lastT = e.timeStamp; rolo.setPointerCapture?.(e.pointerId); });
  rolo.addEventListener('pointermove', (e) => {
    if (y0 == null) return;
    const dy = y0 - e.clientY;   // up = forward
    moved = Math.max(moved, Math.abs(dy));
    vel = (lastY - e.clientY) / Math.max(1, e.timeStamp - lastT); lastY = e.clientY; lastT = e.timeStamp;
    if (!still && moved > 8) { rolo.classList.add('dragging'); p = Math.max(-0.35, Math.min(wheel.length - 0.65, p0 + dy / 170)); paint(); }
  });
  const release = (e) => {
    if (y0 == null) return;
    const dy = y0 - e.clientY; y0 = null;
    if (moved < 8) { const o = $('#open'); if (!o.hidden) location.href = o.href; return; }   // a tap opens the card
    const flick = Math.abs(vel) > 0.45 ? Math.sign(vel) : 0;
    const want = still ? target + Math.sign(dy) : Math.round(p + flick * 0.5);
    const n = Math.max(0, Math.min(wheel.length - 1, want));
    if (n !== target) { target = n; click(); label(); }
    settle();
  };
  rolo.addEventListener('pointerup', release);
  rolo.addEventListener('pointercancel', () => { y0 = null; settle(); });

  const showFace = (i, html) => {
    faces[i] = html;
    const faceEl = leaves.find((l) => l.i === i)?.el.querySelector('.face');
    if (faceEl) faceEl.innerHTML = html;
  };
  wheel.forEach((entry, i) => {
    const timeout = setTimeout(() => showFace(i, '<p class="what">Open the card to read it.</p>'), 2500);
    face(entry).then((html) => {
      clearTimeout(timeout);
      showFace(i, html);
    });
  });
}

$('#sound').onclick = () => { soundOn = !soundOn; store.set('roloe.sound', soundOn); $('#sound').textContent = soundOn ? 'Sound on' : 'Sound off'; $('#sound').setAttribute('aria-pressed', String(soundOn)); };
$('#sound').textContent = soundOn ? 'Sound on' : 'Sound off';
$('#sound').setAttribute('aria-pressed', String(soundOn));
