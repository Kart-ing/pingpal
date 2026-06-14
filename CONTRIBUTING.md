# Contributing to PingPal

Thanks for wanting to make ambient messaging for terminal-dwellers better! This
is a small, friendly project. Contributions of all sizes are welcome — a new
ASCII face is just as appreciated as a daemon fix.

## Getting set up

PingPal is a [pnpm](https://pnpm.io) workspace targeting **Node 18+**.

```bash
pnpm install        # install everything
pnpm -r build       # build every package (strict TypeScript)
pnpm -r test        # run every package's tests
```

`pnpm -r build && pnpm -r test` from a clean checkout is the bar every change
has to clear — it's the same gate CI runs. Please make sure it's green before
opening a PR.

To work on one package: `pnpm --filter @pingpal/faces test`, etc. Many packages
have handy scripts (`pnpm --filter @pingpal/faces demo`,
`pnpm --filter @pingpal/relay start`).

## Repo layout

```
packages/
  protocol/   @pingpal/protocol — zod schemas, the 90-char rule, NDJSON framing
  faces/      @pingpal/faces    — the ASCII face + bubble renderer (pure)
  relay/      @pingpal/relay    — the self-hostable WebSocket relay
  daemon/     @pingpal/daemon   — pingpald: relay link, mDNS mesh, presence, IPC
  mcp/        @pingpal/mcp      — the stdio MCP server Claude Code launches
  cli/        pingpal           — the user-facing CLI + the Claude Code hook
```

Each package has its own README describing its role — start there.

## Conventions

- **TypeScript, strict, ESM.** No loosening `tsconfig.base.json`. New code is
  typed; `any` needs a reason.
- **Import packages by their workspace name** (`@pingpal/protocol`), never by a
  relative path that reaches across package boundaries.
- **Keep `protocol` and `faces` dependency-light.** They're meant to stay
  portable and fast to test — don't add runtime deps to them without a strong
  reason.
- **The 90-char ping cap is sacred.** It's enforced in `@pingpal/protocol`; rely
  on that single source of truth rather than re-hardcoding `90` elsewhere.
- **Tests for behaviour, not coverage theatre.** A small, real test beats a big
  mocked one. The protocol boundary cases, the renderer's output shape, the
  idempotent settings merge, and the IPC round-trip are the things that matter.

## Submitting changes

1. Branch off `main`.
2. Make the change, add/adjust tests, and run the gate (`pnpm -r build && pnpm -r test`).
3. Open a PR with a short description of *what* and *why*. Screenshots are very
   welcome for anything that changes the rendered face.

## A note on the relay

The v1 relay stores **nothing** long-term and has **no database** — rooms and
presence live in memory and a room code is the only shared secret. Please keep
it that way for v1; persistence and real auth are deliberately out of scope.

## Code of conduct

Be kind. Assume good faith. We're here to make a delightful little tool together.
