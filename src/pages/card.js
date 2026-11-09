import { $, api } from '/roloe.js';
const owner = location.pathname.split('/').pop();
const c = await api(`/api/cards/${owner}`).catch(() => null);
if (c) { $('#nm').textContent = c.name; $('#ln').textContent = c.line || ''; $('#tab').textContent = c.name; }
$('#qr').innerHTML = await (await fetch(`/api/cards/${owner}/qr.svg`)).text();
$('#url').textContent = `${location.host}/g/${owner}`;
