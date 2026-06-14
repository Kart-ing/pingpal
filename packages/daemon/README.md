# @pingpal/daemon — `pingpald`

The per-machine PingPal daemon. It is the only long-lived process in PingPal:
the Claude Code hook and the MCP server are momentary, so they can't hold a
socket open. `pingpald` does that for them.

```
   relay (wss)  ◀──────┐
                       │   ┌───────────────────────── pingpald ─────────────┐
   LAN peers (mDNS) ◀──┼──▶│  relay link · LAN mesh · presence · ping buffer │
                       │   └──────────────┬──────────────────────────────────┘
                       │      Unix socket │  ~/.pingpal/daemon.sock  (NDJSON IPC)
                       │         ┌────────┴────────┐
                       │     Claude Code hook   MCP server
                       └─────────  (thin clients)  ──────────
```

What it does:

- **Holds the relay link.** A `ws` connection to `PINGPAL_RELAY`, sending
  `hello`, auto-reconnecting with exponential backoff + jitter, heart-beating,
  and decoding `presence`/`ping` frames (all via `@pingpal/protocol`).
- **LAN auto-discovery.** Advertises `_pingpal._tcp` over mDNS
  (`bonjour-service`) and browses for same-room peers. Discovered peers are
  reached **directly** over a tiny per-machine WebSocket mesh, so same-LAN pings
  skip the relay entirely. If mDNS is unavailable it logs once and runs
  relay-only.
- **Merged presence.** LAN-discovered and relay-reported peers are deduped by
  handle into one roster; a peer reachable both ways is delivered to over LAN.
- **Ping buffer.** Incoming pings are buffered in memory with a read/unread
  flag and mirrored to disk (`~/.pingpal/pings.ndjson` + an `~/.pingpal/unread`
  flag file) so the hook can detect new mail without an IPC round-trip.
- **Local IPC.** A Unix-domain-socket server (Windows: localhost TCP, port in
  `~/.pingpal/daemon.port`) speaking the request/response protocol below.

## CLI

```bash
pingpald start        # spawn the daemon in the background (detached)
pingpald stop         # stop a running daemon
pingpald status       # is it running? + a presence summary
pingpald --foreground # run in the foreground (what `start` spawns; logs to stdout)
```

The foreground process owns `~/.pingpal/daemon.pid` — it writes the pidfile only
once the IPC server is listening, and removes it on a clean shutdown, so a
present pidfile means "ready to serve".

## Configuration

`pingpald` reads `~/.pingpal/config.json` (written by `pingpal init`):

```json
{
  "handle": "sarah",
  "roomCode": "your-shared-room-code",
  "faceId": "fox",
  "relayUrl": "wss://relay.pingpal.dev",
  "notifyCommand": "terminal-notifier -message 'new ping'",
  "lanDiscovery": true
}
```

| Setting | Default | Notes |
| --- | --- | --- |
| `handle` | — (required) | unique within the room |
| `roomCode` | — (required) | shared secret for the room |
| `faceId` | the handle | ASCII face preset id |
| `relayUrl` | `wss://relay.pingpal.dev` | overridden by `PINGPAL_RELAY` |
| `notifyCommand` | — | optional shell command run when a ping arrives |
| `lanDiscovery` | `true` | set `false` to run relay-only |

Environment: **`PINGPAL_RELAY`** wins over `relayUrl`. **`PINGPAL_HOME`**
overrides `~/.pingpal` (handy for tests / multiple identities).

## IPC protocol

NDJSON over the socket: one JSON request per line in, one response per line out.
This is intentionally separate from the wire protocol in `@pingpal/protocol`.

Requests (`{ id, method, params? }`):

| Method | Params | Result |
| --- | --- | --- |
| `getPresence` | — | `{ peers: MergedPeer[] }` |
| `getPings` | `{ markRead?: boolean }` | `{ pings: BufferedPing[] }` |
| `sendPing` | `{ to?: string \| null, text: string }` | `{ id, via, delivered }` |
| `status` | — | daemon + presence summary |

Responses are `{ id, ok: true, result }` or `{ id, ok: false, error: { code, message } }`.
`sendPing` validates the **90-character** cap (`code: "text_too_long"`); `to`
may carry a leading `@`, and `null`/empty means a room broadcast.

`MergedPeer` carries `via: "lan" | "relay" | "both"`; `BufferedPing` is a wire
`ping` plus `read: boolean` and `via: "lan" | "relay"`.

The package also exports a typed `sendRequest(paths, method, params?)` client so
the hook and MCP server don't have to reimplement the framing.

## Development

```bash
pnpm --filter @pingpal/daemon build
pnpm --filter @pingpal/daemon test   # IPC round-trip, presence merge, mDNS-degrade, reconnect
```
