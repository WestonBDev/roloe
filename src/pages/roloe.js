// Shared helpers for Roloe pages. No framework; every page renders from the coordinator's JSON.
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const hhmm = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
export const hhmmss = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
export const secs = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)} s`);
export const short = (h) => (h ? `${h.slice(0, 4)}…${h.slice(-4)}` : '');

export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: page still works */ } },
};

export async function api(path, { method = 'GET', body, key, bearer } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-roloe-key'] = key;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch {
    const e = new Error('offline'); e.offline = true; throw e;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.message || `Error ${res.status}`); e.status = res.status; e.code = json.error; throw e; }
  return json;
}

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const nonce = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Whose words: only a passage the giver typed is "their words".
export function whoseWords(credit, name) {
  if (!credit) return '';
  if (credit.kind === 'commit') return `${name}'s commit`;
  if (credit.speaker === 'owner') return `${name}'s words`;
  if (credit.speaker === 'pasted') return `pasted by ${name}`;
  if (credit.kind === 'file') return `from ${name}'s ${credit.source}`;
  return `from ${name}'s session`;
}

// A quote lifted from code reads as code, not handwriting.
export const isCode = (f) => f.credit?.kind === 'file' && /[{};=()]|=>/.test(f.quote || '');

export function findingCard(f, name, { index = 0, flip = true } = {}) {
  const when = f.credit?.ts ? `today ${hhmm(f.credit.ts)}` : '';
  const edits = f.change?.edits || [];
  const back = edits.length ? `<div class="back" hidden>
      <p class="label">The change, for ${esc(f.change ? 'your files' : '')}</p>
      ${edits.map((e) => `<p class="cite">${esc(e.file)}</p><div class="diff">${e.find.split('\n').map((l) => `<span class="del">-${esc(l)}</span>`).join('')}${e.replace.split('\n').map((l) => `<span class="add">+${esc(l)}</span>`).join('')}</div>`).join('')}
      <p class="muted" style="margin-top:8px">Try it on your laptop: <code>roloe try</code>. It shows the literal diff and runs your tests with no network.</p>
    </div>` : '';
  return `<article class="card deal finding" style="animation-delay:${index * 900}ms, ${index * 900 + 500}ms" data-id="${esc(f.id)}">
    <span class="tab">${esc(name)} <span class="mono">· ${esc(when)}</span></span>
    <div class="front">
      <p class="quote${isCode(f) ? ' code' : ''}">${esc(f.quote)}</p>
      <p class="label">${esc(whoseWords(f.credit, name))}</p>
      <p style="margin-top:6px">${esc(f.what)}</p>
      <p class="cite">cites ${esc(f.cites)} · ${esc(f.credit?.locator || '')}</p>
      ${edits.length && flip ? `<div class="row" style="margin-top:6px"><button class="ghost turn">Turn over: the change</button></div>` : ''}
    </div>
    ${back}
  </article>`;
}

export function wireTurns(root) {
  root.querySelectorAll('.finding .turn').forEach((b) => {
    b.onclick = () => {
      const card = b.closest('.finding');
      const back = card.querySelector('.back');
      const front = card.querySelector('.front');
      const showBack = back.hidden;
      card.animate?.([{ transform: 'perspective(900px) rotateY(0)' }, { transform: 'perspective(900px) rotateY(90deg)' }], { duration: 225 }).finished.then(() => {
        back.hidden = !showBack; front.hidden = showBack;
        card.animate?.([{ transform: 'perspective(900px) rotateY(-90deg)' }, { transform: 'perspective(900px) rotateY(0)' }], { duration: 225 });
      });
      if (!card.animate) { back.hidden = !showBack; front.hidden = showBack; }
      if (showBack && !back.querySelector('.unturn')) {
        const u = document.createElement('button'); u.className = 'ghost unturn'; u.textContent = 'Turn back'; u.style.marginTop = '10px';
        u.onclick = () => { back.hidden = true; front.hidden = false; };
        back.append(u);
      }
    };
  });
}

// Redraw only when the content changes: a redraw restarts the card animations.
export function renderer(el) {
  let last = '';
  return (html) => { if (html !== last) { last = html; el.innerHTML = html; return true; } return false; };
}

export function poll(fn, ms) {
  let stopped = false;
  const tick = async () => { if (stopped) return; try { await fn(); } finally { if (!stopped) setTimeout(tick, document.hidden ? ms * 3 : ms); } };
  tick();
  return () => { stopped = true; };
}

// Replay a recorded meeting on its own clock: show only what had happened `elapsed` ms after its tap.
export function replayView(rec, elapsed) {
  const at = (ms) => ms != null && ms <= elapsed;
  const sides = {};
  const findingsIn = at(rec.live.first_findings_ms);
  for (const [who, s] of Object.entries(rec.sides)) {
    const done = at(s.posted_ms);
    let seal = null;
    if (s.seal && at(Date.parse(s.seal.ts) - rec.tap)) seal = { ...s.seal, line: findingsIn ? s.seal.line : null };
    sides[who] = { ...s, posted: done, posted_ms: done ? s.posted_ms : null, top: done ? s.top : null, more: done ? s.more : 0, nothing_strong: done && s.nothing_strong, seal };
  }
  const live = Object.fromEntries(Object.entries(rec.live).map(([k, v]) => [k, at(v) ? v : null]));
  let tryState = null;
  if (rec.try) {
    if (at(rec.live.green_ms) || (rec.live.green_ms == null && at(rec.live.all_findings_ms))) tryState = rec.try;
    else if (at(rec.live.first_findings_ms)) tryState = { state: 'testing' };
  }
  return { ...rec, sides, live, try: tryState, recorded: true };
}

// When a replay is over: three seconds after the last thing that was recorded.
export function replayEndMs(rec) {
  const times = [...Object.values(rec.live || {}), ...Object.values(rec.sides || {}).map((x) => x.posted_ms)].filter((x) => x != null);
  return (times.length ? Math.max(...times) : 0) + 3000;
}
