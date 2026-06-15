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

## Install

```bash
npm install -g pingpal
```

> Installing globally (rather than `npx` each time) matters here: PingPal runs a
> small background daemon and wires itself into Claude Code, so it needs to live
> at a stable path. Node 18+.

## Quickstart — you in 1 minute

```bash
pingpal init                 # pick a handle + face; wires up Claude Code (hook + MCP + status line)
pingpal join our-room-7f3a   # join a room (the code is the shared secret)
pingpal start                # launch the background daemon
```

That's it. From now on:

- **Incoming pings** pop into your Claude Code session as a face + bubble (and
  show on your next prompt).
- **Reply from Claude** — _"ping sarah: on it, pushing now"_ — the MCP
  `send_ping` tool delivers it. Messages are **end-to-end encrypted**.
- **`pingpal chat`** opens a full-screen group-chat window (faces, history,
  presence). **`pingpal status`** shows who's online; the **status line** keeps a
  live roster on the side.

## Bring a friend — 2 minutes

**You (host):** create an invite and send the line it prints.

```bash
pingpal invite
#   room code:  our-room-7f3a
#   relay:      wss://<your-relay>.fly.dev
#     npx pingpal join our-room-7f3a --relay wss://<your-relay>.fly.dev --handle <your-handle>
```

**Your friend:** install, then paste that line. A short wizard asks for their
handle + face, then connects them.

```bash
npm install -g pingpal
pingpal join our-room-7f3a --relay wss://<your-relay>.fly.dev
#   👋  Welcome to PingPal — let's get you into the room.
#   connected. `pingpal status` to see who's around, `pingpal chat` to talk.
```

Now you're both in the room: pings surface in each other's Claude Code, and
`pingpal chat` is a live group chat. Same Wi-Fi? You don't even need a relay —
PingPal auto-discovers same-network peers over mDNS.

---

## Inviting teammates

A room is just a shared, unguessable **room code** plus a **relay** everyone can
reach. To bring someone in, generate an invite:

```bash
pingpal invite
```

```
  📨  PingPal invite
  room code:  our-team-hunter2
  relay:      wss://relay.example.com
  Send a teammate this — they run it, pick a handle + face, and they're in:

    npx pingpal join our-team-hunter2 --relay wss://relay.example.com --handle <your-handle>
```

`pingpal invite` is the **only** place the room code is shown in full (everywhere
else masks it — sharing the secret is a deliberate act). Send that line to your
teammate. When they run it, PingPal walks them through a short guided first-run —
pick a handle, choose a face — then connects them and starts their daemon:

```bash
npx pingpal join our-team-hunter2 --relay wss://relay.example.com
#   👋  Welcome to PingPal — let's get you into the room.
#   Your handle: ▸ sarah
#   Pick a face: ▸ ( =◕ᆽ◕= ) cat
#   connected. `pingpal status` to see who's around, `pingpal chat` to talk.
```

That's the whole sign-up: one command, two prompts, in.

> **Reachability matters.** The relay in your invite has to be reachable by the
> person joining:
> - **Same Wi-Fi / LAN?** You don't even need a shared relay — PingPal
>   auto-discovers same-network peers over mDNS. The room code + `pingpal join`
>   is enough.
> - **Remote teammates?** You need a relay both of you can reach over the
>   internet. `pingpal invite` warns you when your relay is `localhost` (it can't
>   be reached off your machine). Deploy one (see
>   [Self-hosting the relay](#self-hosting-the-relay)) and set `PINGPAL_RELAY`,
>   then re-invite.

---

## The CLI

| Command | What it does |
| --- | --- |
| `pingpal init` | Prompt for handle / room / face, write `~/.pingpal/config.json`, install the Claude Code notification **hook**, and register the **MCP server**. Fully idempotent. |
| `pingpal join <room>` | Join a room from an invite (guided first-run: prompts for handle + face), or switch rooms. `--relay <url>` carries the invite's relay; `--handle` / `--face` skip the prompts. |
| `pingpal invite` | Print a shareable invite — room code + relay + a copy-paste `join` command. The one place the room code is shown in full. `--short` for just the command. |
| `pingpal start` | Start the background daemon (`pingpald`) if it isn't already up. |
| `pingpal stop` | Stop the daemon. |
| `pingpal status` | Show daemon + relay + LAN status and a who's-online roster. |
| `pingpal pings` | Show unread pings as ASCII faces and mark them read. `--announce` / `--quiet-when-empty` make it a clean unit for `/loop`. |
| `pingpal statusline` | Print a one-line live who's-online roster, for use as a Claude Code `statusLine` (see below). |
| `pingpal chat` | Open the full-screen group-chat TUI for your room — faces, live scrollback, an input line. `@name <msg>` to DM, Enter to send, `q` to quit. |
| `pingpal launch` | Open `pingpal chat` in a new terminal window (or, inside a VS Code / Cursor integrated terminal, tell you to run it in a split). Backs the `/pingpal` command. |
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
# Run it locally (listens on :8787)…
PORT=8787 node packages/relay/dist/bin.js

# …or with Docker (build from the repo root — the relay needs the workspace):
docker build -f packages/relay/Dockerfile -t pingpal-relay .
docker run -p 8787:8787 pingpal-relay
```

**One-command Fly.io deploy** (the easiest way to get a real `wss://` URL your
remote teammates can reach):

```bash
# one-time: curl -L https://fly.io/install.sh | sh   &&   fly auth login
bash scripts/deploy-relay.sh pingpal-relay-<you>     # global name; pick a unique one
# → prints wss://pingpal-relay-<you>.fly.dev
```

Then either point clients at it per-session (`export PINGPAL_RELAY=wss://…`), or
bake it in as the default for everyone and republish:

```bash
node scripts/set-default-relay.mjs wss://pingpal-relay-<you>.fly.dev
pnpm -r build && bash scripts/publish.sh
```

The same Dockerfile deploys cleanly on Railway/Render too. See
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
