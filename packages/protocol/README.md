# @pingpal/protocol

The shared wire protocol for [PingPal](../../README.md). Every other package
depends on this one, and it depends on nothing but [zod](https://zod.dev) — so
it stays tiny and fast to test.

It defines the messages that travel over **both** transports: the WebSocket link
to the relay and the local Unix-socket IPC between the daemon and its clients.

## What's in here

- **Zod schemas + types** for every envelope: `hello`, `presence`, `ping`,
  `ack`, and `error`. Parsing and type are derived from the same schema, so the
  validator and the TypeScript type can never drift apart.
- **The 90-char rule.** `MAX_PING_CHARS = 90` and `validatePingText(text)`
  (returns a `PingTextResult`) are the single source of truth for the cap. The
  `ping` schema enforces it too, so an over-long ping cannot pass validation
  anywhere — client, relay, or IPC.
- **NDJSON framing.** Newline-delimited JSON helpers used by both the relay
  socket and the IPC socket: encode an envelope to a line, and decode a byte
  stream into envelopes (handling partial frames).
- **`newId()`** for stable, collision-resistant ping ids.
- **`PROTOCOL_VERSION`** so peers can detect a version skew.

## Usage

```ts
import { PingSchema, validatePingText, MAX_PING_CHARS } from "@pingpal/protocol";

const result = validatePingText(text);
if (!result.ok) throw new Error(`ping too long (max ${MAX_PING_CHARS})`);

const ping = PingSchema.parse({ id, from, to: null, text, ts });
```

## Development

```bash
pnpm --filter @pingpal/protocol build
pnpm --filter @pingpal/protocol test   # schemas, the 90-char boundary, framing round-trips
```
