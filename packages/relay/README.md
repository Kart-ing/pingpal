# @pingpal/relay

The self-hostable WebSocket relay for [PingPal](../../README.md). It routes
pings between teammates who aren't on the same LAN and tracks who's online — and
it stores **nothing** long-term. All state (rooms, presence) lives in memory and
disappears when connections close.

The relay is only needed for *remote* peers; same-LAN teammates connect directly
via mDNS. You only run this if you want to talk to people off your network.

## What it does

- **Rooms by code.** A client opens a socket and sends a `hello` with its
  `roomCode` + `handle`. The room code is the lightweight shared secret — peers
  only ever see and message others in the same room.
- **Presence.** Maintains an in-memory roster per room and broadcasts `presence`
  updates on join, leave, and status change. Peers go `idle` after ~60s of no
  activity and vanish on disconnect.
- **Ping routing.** `to: null` broadcasts to everyone else in the room;
  `to: "handle"` delivers only to that handle's connection(s). The sender always
  gets an `ack`. The relay re-stamps `from` with the authenticated handle so it
  can't be spoofed.
- **Defensive validation.** Malformed JSON, non-envelope frames, and text over
  the 90-char cap are rejected with an `error` envelope. Each connection is
  rate-limited with a token bucket.

## Run it

```bash
# From a clean checkout of the monorepo:
pnpm install
pnpm --filter @pingpal/relay build

# Start it (PORT defaults to 8787):
node packages/relay/dist/bin.js
# or, once installed: pingpal-relay
```

Environment variables: `PORT` (default `8787`) and `HOST` (default all
interfaces).

Point clients at your instance with `PINGPAL_RELAY=ws://your-host:8787`.

## Deploy

### Docker

Build from the **repo root** (the workspace must be in the build context):

```bash
docker build -f packages/relay/Dockerfile -t pingpal-relay .
docker run -p 8787:8787 pingpal-relay
```

### Fly.io

```bash
fly launch --no-deploy --copy-config --dockerfile packages/relay/Dockerfile
fly deploy --config packages/relay/fly.toml --dockerfile packages/relay/Dockerfile
```

Rename `app` in `fly.toml` first. Clients then use
`PINGPAL_RELAY=wss://<app>.fly.dev`.

### Railway / Render

Point either platform at `packages/relay/Dockerfile` and let it expose `$PORT`
(8787). No other configuration is required.

## Programmatic use

```ts
import { startRelay } from "@pingpal/relay";

const relay = await startRelay({ port: 8787 });
console.log(`listening on :${relay.port}`);
// …later
await relay.close();
```

`startRelay(opts)` accepts `port`, `host`, `heartbeatMs`, `idleAfterMs`,
`rateCapacity`, and `rateRefillPerSec`. Use `port: 0` for an ephemeral port
(handy in tests).

## Manual smoke test

Two simulated clients exchanging a ping is exactly what the vitest integration
test does (`pnpm --filter @pingpal/relay test`). To do it by hand, start the
relay and connect with any WebSocket client, sending newline-delimited JSON:

```json
{"type":"hello","roomCode":"demo-room-1234","handle":"alice","faceId":"fox","clientVersion":"manual"}
{"type":"ping","id":"1","from":"alice","to":null,"text":"hello room","ts":0}
```
