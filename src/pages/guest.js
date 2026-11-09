// What the QR opens. A stranger: a sentence, a link, or skip → keep talking.
// Someone with their own card on this phone: "Meet as {me}".
import { $, esc, api, hhmm, store } from '/roloe.js';

const owner = location.pathname.split('/').pop();
const me = store.get('roloe.me');

function err(e) {
  $('#err').hidden = false;
  $('#err').textContent = e.offline ? 'You seem to be offline. Check the connection and try again.'
    : e.status === 404 ? 'There is no card by that name on this Roloe.' : e.status === 409 ? e.message : `Something went wrong: ${e.message}`;
}

async function start(link, text) {
  $('#send').disabled = $('#skip').disabled = true;
  $('#send').textContent = link ? 'Reading your link…' : 'Opening…';
  try {
    const r = await api(`/api/g/${owner}/start`, { method: 'POST', body: { ...(link ? { link } : {}), ...(text ? { text } : {}) } });
    store.set(`roloe.guest.${owner}`, { id: r.id, key: r.key, at: Date.now() });
    location.href = `/e/${r.id}?k=${encodeURIComponent(r.key)}`;
  } catch (e) { err(e); $('#send').disabled = $('#skip').disabled = false; $('#send').textContent = 'Send'; }
}

async function main() {
  let card;
  try { card = await api(`/api/cards/${owner}`); } catch (e) { $('#tab').textContent = 'No card'; return err(e); }
  $('#tab').innerHTML = `${esc(card.name)} <span class="mono">· Roloe</span>`;
  $('#name').textContent = card.name;
  $('#line').textContent = card.line || '';
  $('#meta').textContent = card.sharing ? `${card.passages} passages from today's work${card.updated ? ` · updated ${hhmm(card.updated)}` : ''}` : 'This card is not sharing right now.';
  document.title = `Roloe · ${card.name}`;
  $('#how').textContent = `${card.name}'s own assistant reads what you give against today's work and sends you what it finds, usually within a minute. Roloe's server runs no model.`;
  if (!card.sharing) return;
  if (me?.owner && me.owner !== owner && me.key) {
    $('#as').innerHTML = `<div class="row"><button id="tapas">Meet as ${esc(me.name || me.owner)}</button><button class="ghost" id="guest">Continue as a guest</button></div>`;
    $('#tapas').onclick = async () => {
      try { const r = await api('/api/tap', { method: 'POST', bearer: me.key, body: { to: owner } }); location.href = r.link.replace(/^https?:\/\/[^/]+/, ''); } catch (e) { err(e); }
    };
    $('#guest').onclick = () => { $('#as').hidden = true; $('#start').hidden = false; };
  } else {
    $('#start').hidden = false;
  }
  const w = store.get('roloe.wheel') || [];
  if (w.length) $('#how').insertAdjacentHTML('afterend', `<p><a href="/r">Your Roloe on this phone (${w.length})</a></p>`);
  const prev = store.get(`roloe.guest.${owner}`);
  if (prev && Date.now() - prev.at < 3 * 3600e3) {
    $('#how').insertAdjacentHTML('afterend', `<p><a href="/e/${esc(prev.id)}?k=${encodeURIComponent(prev.key)}">Back to your meeting with ${esc(card.name)}</a></p>`);
  }
  $('#start').onsubmit = (e) => { e.preventDefault(); start($('#link').value.trim(), $('#text').value.trim()); };
  $('#skip').onclick = () => start('', '');
}
main();
