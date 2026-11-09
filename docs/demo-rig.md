# Demo rig

Two laptops, two phones, one coordinator. Each side is labelled honestly on screen.

| Machine | Runs | Its assistant reads |
| --- | --- | --- |
| **A: Weston's Mac** | The coordinator (`http://10.1.0.84:7420` until the Radar cluster is up, then `https://roloe.cnh.radarhq.io`), Weston's Claude Code with Roloe connected | today's Roloe work (`~/dev/roloe`), with off-limits names set |
| **Weston's iPhone** ("westo"), USB to A | the browser: scans Claire's card | nothing; it's a phone |
| **B: Claire's laptop** | Claude Code or Codex with Roloe connected (`roloe join`) | one clean, public-safe project folder only, never a whole monorepo |
| **Google Pixel**, USB to B | the browser: scans Weston's card | nothing; it's a phone |

## Setup (once per laptop)

```bash
git clone https://github.com/WestonBDev/roloe ~/roloe && cd ~/roloe && npm ci
node bin/roloe.mjs join --url <coordinator URL> --owner <short-name> --name "<Name>" --project <one folder>
node bin/roloe.mjs off-limits add "<names, clients, topics to never share>"
node bin/roloe.mjs show        # read exactly what the card shares
```

Then, in the assistant opened in that folder, say once:

> Wait for Roloe meetings: call roloe_wait_for_tap, follow the instructions it returns, post your findings, then call it again. Keep going until I say stop.

Show each card's QR full screen: `<coordinator URL>/q/<short-name>`.

## When the venue Wi-Fi won't carry it

The Radar URL is the primary route once the cluster is up; these are the USB fallbacks.

- **iPhone on A (Personal Hotspot over USB).** Turn on Personal Hotspot with the iPhone plugged into A. A joins the phone's network on `172.20.10.x` (`ifconfig | grep 172.20.10`). The phone opens `http://172.20.10.<A's address>:7420/g/<name>`.
- **Pixel on B (`adb reverse`).** `adb reverse` makes the Pixel's `localhost:7420` reach B, but the coordinator runs on A. So on B, forward first, then reverse:
  ```bash
  node ~/roloe/scripts/forward.mjs 7420 10.1.0.84:7420   # B's localhost:7420 → A
  adb reverse tcp:7420 tcp:7420                          # Pixel's localhost:7420 → B
  ```
  The Pixel opens `http://localhost:7420/g/<name>` (typed or from a bookmark: the QR encodes the public URL, not localhost).

## 60-second preflight

1. On A: `curl -s http://10.1.0.84:7420/healthz` shows `{"ok":true,"otlp":true}`.
2. From each phone: open `<coordinator URL>/healthz` (or the USB address above). It must show `ok`.
3. On B: `curl -s <coordinator URL>/healthz` (laptop to laptop).
4. One scan each way: the iPhone scans Claire's `/q/<name>`, the Pixel scans Weston's `/q/weston`. Type one sentence, Send. A finding or an honest "nothing strong" arrives within about a minute.
5. The stage: open the meeting's stage link (from `roloe inbox`) full screen; a judge QR sits in the corner.
