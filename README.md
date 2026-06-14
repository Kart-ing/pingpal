# PingPal

> Ambient messaging for CLI coders. Little ASCII faces, live presence, and
> **90-character pings** that surface _right inside_ your Claude Code session.

PingPal lets a team of terminal-dwellers feel each other's company without
leaving the keyboard. You see everyone's charming ASCII face and presence; you
fire off tiny 90-char pings; and when one lands, it appears in your Claude Code
session unprompted — face, bubble, and all. You reply without ever tabbing away,
by asking Claude to send a ping for you.

```
   ╭────────────────────────────────────────╮
   │  ship it when green, I'll review at 3  │
   ╰──────┬─────────────────────────────────╯
          │
         ◜ ◝    ╭───────────╮
       ( ◕‿◕ )  │   sarah   │   ● online · 2s ago
         ◟ ◞    ╰───────────╯
```

---

## Quickstart

```bash
# 1. Set your handle, room, and face — and wire up Claude Code (hook + MCP).
npx pingpal init

# 2. Join a room (a shared, unguessable code is the v1 secret).
npx pingpal join our-team-hunter2

# 3. Start the background daemon and get coding.
npx pingpal start
```

> **Tip:** for the daemon and Claude Code integrations to persist, install
> PingPal so it lives at a stable path: `npm i -g pingpal`. `npx` is great for a
> one-off `init`, but the daemon needs to stick around.

That's it. From now on:

- Incoming pings pop into your Claude Code session as a face + bubble.
- Ask Claude to reply — _"reply to sarah: on it, pushing now"_ — and the MCP
  `send_ping` tool delivers it.
- `pingpal status` shows who's online; `pingpal whoami` shows your identity.

---

## The CLI

| Command | What it does |
| --- | --- |
| `pingpal init` | Prompt for handle / room / face, write `~/.pingpal/config.json`, install the Claude Code notification **hook**, and register the **MCP server**. Fully idempotent. |
| `pingpal join <room>` | Switch (or set) your room and bounce the daemon so it reconnects. `--handle` to change your handle too. |
| `pingpal start` | Start the background daemon (`pingpald`) if it isn't already up. |
| `pingpal stop` | Stop the daemon. |
| `pingpal status` | Show daemon + relay + LAN status and a who's-online roster. |
| `pingpal pings` | Show unread pings as ASCII faces and mark them read. `--announce` / `--quiet-when-empty` make it a clean unit for `/loop`. |
| `pingpal statusline` | Print a one-line live who's-online roster, for use as a Claude Code `statusLine` (see below). |
| `pingpal whoami` | Print your current handle, room, and face. |

`pingpal init` takes flags to skip the prompts:
`--handle <h> --room <code> --face <id>` (and `--no-hook` / `--no-mcp` to skip
either Claude Code integration). Run `pingpal --help` for everything.

---

## Live room roster in your status line

`pingpal statusline` prints a one-line, always-current who's-online roster —
presence dots + handles, plus an unread badge — meant for Claude Code's
`statusLine`. Point your status line at it and set a `refreshInterval` so it
updates on its own, even while the session is idle:

```jsonc
// ~/.claude/settings.json
{
  "statusLine": {
    "type": "command",
    "command": "pingpal statusline",
    "refreshInterval": 2
  }
}
```

```
PingPal  ● sarah  ◐ max  ○ jo        ← ● online · ◐ idle · ○ offline, with a 📨 badge when pings wait
```

This is the ambient "who's around" surface — a little room presence on the side,
the way a status-line pet lives in your terminal. It pairs naturally with the
push hook (incoming pings) and the MCP server (replies).

### Works with Kickbacks.ai

The idea of putting something *ambient and alive in the status line* — the
most-watched strip of the terminal — is owed to
**[Kickbacks.ai](https://kickbacks.ai)** (Andrew McCalip), which turns AI
wait-states into a sponsored status line and shares the revenue with you.
PingPal is designed to **coexist** with it rather than fight for that space: if
Kickbacks (a.k.a. the `vibe-ads` status line) is already installed, PingPal
slots its roster into Kickbacks' own status-line **chain** so you get the
sponsor line *and* your room roster, stacked:

```
ad· Linera Markets — Trade, Simply.   ← Kickbacks.ai sponsor line (you earn 50%)
PingPal  ● sarah  ◐ max               ← PingPal's live room roster, chained below
```

Concretely, PingPal registers `pingpal statusline` as Kickbacks' downstream
chained command (`~/.vibe-ads/cli-prev-statusline.json`) instead of overwriting
your `statusLine`. Earn while you wait; see your team while you code. 🙏

---

## How Claude Code integration works

`pingpal init` performs two **idempotent** merges into your Claude Code config.
Both read-modify-write JSON and never clobber unrelated keys; re-running `init`
updates entries in place rather than duplicating them.

### 1. The notification hook (push)

We add a `command` hook on the **`Notification`** event in
`~/.claude/settings.json`. We chose `Notification` because it fires at natural,
low-noise moments (e.g. Claude Code goes idle waiting on you) — a good time to
flush any pings that arrived while you were heads-down. The hook itself is the
shipped script `pingpal-hook.mjs`: it asks the local daemon for unread pings,
renders each as a face + bubble to stdout, and marks them read. It's fast and,
if the daemon isn't running, exits silently — it never spams your session.

> The buffer-and-flush design means the event choice only affects _when_ pings
> appear, never whether they're lost: the daemon holds them until the hook
> drains them. Swap the event freely if you prefer (e.g. `UserPromptSubmit`).

### 2. The MCP server (pull / reply)

We register a stdio MCP server named `pingpal` under `mcpServers` in
`~/.claude.json` — the same user-scope location `claude mcp add --scope user`
writes to. It exposes three tools to Claude:

- `whos_online` — the roster with handles, faces, and statuses.
- `list_pings` — recent/unread pings (and marks them read).
- `send_ping({ to?, text })` — send a ≤90-char ping; omit `to` to broadcast to
  the room, or pass `@handle` / `handle` to direct it.

Both the hook command and the MCP server are registered by **absolute path** to
the bundled Node entry points, so they keep working after a global install where
dependency bins aren't on your `PATH`.

---

## LAN auto-discovery

If teammates share a local network, their daemons find each other **peer-to-peer
over mDNS/Bonjour** — no relay hop, no room code round-trip. Same-LAN pings go
direct; remote teammates go through the relay. Presence merges both sources into
one roster. If mDNS is unavailable, PingPal degrades gracefully to relay-only.
Disable it with `"lanDiscovery": false` in `~/.pingpal/config.json`.

---

## Self-hosting the relay

The relay only routes pings and tracks presence **in memory** — it stores
nothing long-term and needs no database. Point clients at your instance with the
`PINGPAL_RELAY` environment variable.

```bash
# Run it locally…
node packages/relay/dist/index.js
# …or with Docker.
docker build -t pingpal-relay packages/relay && docker run -p 8080:8080 pingpal-relay
```

A `fly.toml` is included for one-command Fly.io deploys. See
`packages/relay/README.md` for details.

---

## Environment variables

| Variable | Effect |
| --- | --- |
| `PINGPAL_RELAY` | Relay WebSocket URL. Overrides `relayUrl` in config. Defaults to the documented placeholder `wss://relay.pingpal.dev` — replace it with your instance or the public one. |
| `PINGPAL_HOME` | Base directory for PingPal's state (default `~/.pingpal`). |
| `NO_COLOR` | Honoured by the face renderer for color-free output. |
| `CLAUDE_HOME` | Override the base dir for the Claude Code config that `init` writes (handy for dry runs). |

---

## Architecture

```
                       ┌───────────────────────────┐
   remote teammates ──▶│   relay (WebSocket, RAM)   │◀── remote teammates
                       └─────────────┬─────────────┘
                                     │  wss
                       ┌─────────────▼─────────────┐      mDNS / LAN
                       │     pingpald (daemon)      │◀────────────────▶ same-LAN peers
                       │  presence · ping buffer    │
                       │   Unix-socket IPC server   │
                       └───────┬───────────┬────────┘
                  IPC (NDJSON) │           │ IPC (NDJSON)
                       ┌───────▼───┐   ┌───▼────────────┐
                       │   hook    │   │   MCP server   │
                       │  (push)   │   │ (pull / reply) │
                       └─────┬─────┘   └───────┬────────┘
                             └──────┬──────────┘
                              Claude Code session
```

A momentary hook or MCP call can't hold a socket open, so a tiny per-machine
daemon (`pingpald`) owns the live connections, tracks presence, and buffers
incoming pings. The hook and MCP server are thin clients that talk to it over a
local Unix domain socket (a TCP fallback on Windows).

---

## Packages

| Package | What it is |
| --- | --- |
| `pingpal` | The user-facing CLI (this is what you `npx`). |
| `@pingpal/daemon` | `pingpald` — relay client, mDNS mesh, presence, ping buffer, IPC server. |
| `@pingpal/mcp` | The stdio MCP server Claude Code launches. |
| `@pingpal/relay` | The self-hostable WebSocket relay. |
| `@pingpal/faces` | The ASCII face + bubble renderer (pure, unit-tested). |
| `@pingpal/protocol` | Shared zod schemas, the 90-char rule, and NDJSON framing. |

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
```

## License

MIT
