// Full-screen QR for a card: hold the phone out at arm's length, or project it.
const owner = location.pathname.split('/').pop();
const info = await fetch(`/api/cards/${owner}/qr.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (!info) {
  document.getElementById('title').textContent = 'No card by that name on this Roloe.';
} else {
  document.getElementById('title').textContent = `Scan to meet ${info.name}`;
  document.title = `Roloe · scan to meet ${info.name}`;
  document.getElementById('url').textContent = info.short;
  document.getElementById('qr').innerHTML = await (await fetch(`/api/cards/${owner}/qr.svg`)).text();
}
// Keep the screen awake while it's being scanned; tap for full screen.
try { await navigator.wakeLock?.request('screen'); } catch { /* not allowed here: fine */ }
document.body.addEventListener('click', () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {}); });
