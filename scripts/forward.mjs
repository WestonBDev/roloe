// A plain TCP forward, no dependencies: makes a coordinator on another machine reachable on this
// machine's localhost (e.g. for a phone on USB with `adb reverse tcp:7420 tcp:7420`).
//   node scripts/forward.mjs 7420 10.1.0.84:7420
import net from 'node:net';
const [listen = '7420', target = ''] = process.argv.slice(2);
const [host, port] = target.split(':');
if (!host || !port) { console.log('Usage: node scripts/forward.mjs <local port> <host:port>'); process.exit(1); }
net.createServer((c) => { const u = net.connect(Number(port), host); c.pipe(u).pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy()); })
  .listen(Number(listen), '127.0.0.1', () => console.log(`localhost:${listen} → ${host}:${port}`));
