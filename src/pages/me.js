// The owner's card page: the one switch, totals, open meetings, and every shared passage with
// Keep private. The card key arrives in the URL fragment (never sent to the server in the URL)
// and is remembered on this device so scanning someone else's card offers "Meet as you".
import { $, esc, api, hhmm, store } from '/roloe.js';

const owner = location.pathname.split('/').pop();
const fromHash = location.hash.slice(1);
if (fromHash) { store.set('roloe.me', { owner, key: fromHash, name: owner }); history.replaceState(null, '', location.pathname); }
const me = store.get('roloe.me');
const key = me?.owner === owner ? me.key : '';
$('#cardlink').href = `/q/${owner}`;

function err(e) { $('#err').hidden = false; $('#err').textContent = e.status === 401 ? 'Open this page from the link `roloe me` prints; it carries your card key.' : e.offline ? 'Offline.' : e.message; }

async function load() {
  if (!key) return err({ status: 401 });
  const r = await api(`/api/cards/${owner}/passages`, { bearer: key });
  store.set('roloe.me', { owner, key, name: r.name });
  $('#tab').innerHTML = `${esc(r.name)} <span class="mono">· updated ${esc(hhmm(r.card?.updated))}</span>`;
  $('#toggle').setAttribute('aria-checked', String(r.sharing));
  $('#scope').textContent = r.sharing ? `Scope: ${r.card?.scope || "today's project"}` : 'Off: your card is empty and nobody can scan it.';
  const t = r.card?.totals || {};
  $('#totals').innerHTML = [['passages', r.passages.length], ['sessions', t.sessions], ['files', t.files], ['commits', t.commits], ['secrets removed', t.secrets_removed], ['kept private', r.private.length]]
    .map(([k, v]) => `<div><b>${v ?? 0}</b><span class="muted" style="font-size:14px">${k}</span></div>`).join('');
  const groups = {};
  for (const p of r.passages) (groups[p.source] ||= []).push(p);
  $('#passages').innerHTML = Object.entries(groups).map(([src, ps]) => `<details class="card" ${Object.keys(groups).length < 4 ? 'open' : ''}><summary>${esc(src)} <span class="muted">&nbsp;· ${ps.length}</span></summary>
    ${ps.map((p) => `<div class="passage"><p class="cite">${esc(p.passage_id)} · ${esc(p.locator)} · ${esc(p.speaker === 'owner' ? 'you' : p.speaker === 'pasted' ? 'you pasted' : p.speaker || p.kind)}</p>
      <button class="ghost" data-private="${esc(p.passage_id)}">Keep private</button><p class="text">${esc(p.text)}</p></div>`).join('')}</details>`).join('');
  $('#passages').querySelectorAll('[data-private]').forEach((b) => {
    b.onclick = async () => { b.disabled = true; await api(`/api/cards/${owner}/private`, { method: 'POST', bearer: key, body: { passage_id: b.dataset.private } }).catch(err); load(); };
  });
  const m = await api('/api/me/encounters', { bearer: key });
  $('#meetings').innerHTML = m.encounters.length ? `<h2 style="font-size:20px">Open meetings</h2>${m.encounters.map((e) => `<p><a href="${esc(e.link.replace(/^https?:\/\/[^/]+/, ''))}">${esc(e.with_name)}${e.guest ? ' (guest)' : ''} · ${esc(hhmm(e.created))}</a></p>`).join('')}` : '';
}
$('#toggle').onclick = async () => {
  const on = $('#toggle').getAttribute('aria-checked') !== 'true';
  if (!on && !confirm('Turn sharing off? Your card empties at once.')) return;
  await api(`/api/cards/${owner}/switch`, { method: 'POST', bearer: key, body: { on } }).catch(err);
  if (on) $('#scope').textContent = 'On. Your card refills the next time your assistant (or `roloe refresh`) indexes today\'s work.';
  load().catch(err);
};
load().catch(err);
