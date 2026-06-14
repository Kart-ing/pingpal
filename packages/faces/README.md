# @pingpal/faces

The ASCII face + message-bubble renderer for [PingPal](../../README.md) — the
soul of the product. Pure functions, no I/O, so it's trivially unit-tested and
safe to call from a hook that has milliseconds to spare.

```
   ╭────────────────────────────────────────╮
   │  ship it when green, I'll review at 3  │
   ╰──────┬─────────────────────────────────╯
          │
         ◜ ◝    ╭───────────╮
       ( ◕‿◕ )  │   sarah   │   ● online · 2s ago
         ◟ ◞    ╰───────────╯
```

## What it does

- **A library of preset faces.** A handle is hashed to a stable face via
  `pickFace(handle)`, so a teammate always looks the same — but a `faceId` can
  override it. `FACE_IDS` lists them; `getFace(id)` fetches one.
- **Mood by presence.** Faces have variants keyed to status (an `online` face
  beams; an `idle` one droops), so the roster reads at a glance.
- **Safe bubbles.** `renderPing(...)` wraps text to a sensible width with
  `wrapText` and never exceeds the 90-char message rule — it defensively wraps
  even if a longer string somehow reaches it.
- **Clean in 80 columns.** Box-drawing characters, with a no-color / ASCII-safe
  path that honours `NO_COLOR`. Width is measured with `displayWidth` so
  wide/zero-width glyphs don't break alignment.
- **`renderRoster(...)`** renders the who's-online list (faces + statuses).

## Usage

```ts
import { renderPing, pickFace } from "@pingpal/faces";

const out = renderPing({
  text: "ship it when green",
  handle: "sarah",
  faceId: pickFace("sarah"),
  status: "online",
  lastSeen: Date.now(),
});
console.log(out);
```

See the gallery with `pnpm --filter @pingpal/faces demo`.

## Development

```bash
pnpm --filter @pingpal/faces build
pnpm --filter @pingpal/faces test   # render shape/snapshot, wrapping, NO_COLOR fallback
```
