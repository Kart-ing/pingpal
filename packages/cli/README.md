# pingpal

The user-facing CLI for [PingPal](../../README.md) — this is the package
published as **`pingpal`** and the thing you `npx`. It owns identity, config, and
the one-command Claude Code setup; the long-lived work happens in the
`@pingpal/daemon` it starts.

```bash
npx pingpal init                 # set handle/room/face + wire up Claude Code
npx pingpal join our-team-code   # switch rooms (restarts the daemon)
npx pingpal start                # start the background daemon
```

## Commands

| Command | What it does |
| --- | --- |
| `pingpal init` | Prompt for handle / room / face, write `~/.pingpal/config.json`, install the **Notification hook** into `~/.claude/settings.json`, and register the **MCP server** under `mcpServers` in `~/.claude.json`. Idempotent. |
| `pingpal join <room>` | Set/switch your room and restart the daemon so it reconnects. `--handle` to change handle too. |
| `pingpal start` / `stop` | Start / stop the background `pingpald` daemon. |
| `pingpal status` | Daemon + relay + LAN status and a who's-online roster. |
| `pingpal whoami` | Print your current handle, room, and face. |

`init` accepts `--handle`, `--room`, `--face` to skip the prompts, and
`--no-hook` / `--no-mcp` to skip either Claude Code integration. `pingpal --help`
documents everything.

## What `init` touches (and how safely)

Both writes are **read-modify-write JSON merges** that never clobber unrelated
keys, and re-running `init` updates the existing entry in place instead of
duplicating it (see `claude-settings.ts` and its tests):

- **Hook** → a `command` hook on the `Notification` event in
  `~/.claude/settings.json`, running the bundled `hook/pingpal-hook.mjs`.
- **MCP** → a stdio server entry named `pingpal` under `mcpServers` in
  `~/.claude.json`.

Both are registered by **absolute path** to the bundled Node entry points, so
they keep working after a global install where dependency bins aren't on
`PATH`. `CLAUDE_HOME` overrides the base directory (handy for dry runs and the
tests).

## Development

```bash
pnpm --filter pingpal build
pnpm --filter pingpal test   # idempotent settings.json merge, config store
```
