# @pingpal/mcp

The [Model Context Protocol](https://modelcontextprotocol.io) server for
[PingPal](../../README.md). It's how you **reply** to pings without leaving
Claude Code: Claude calls these tools on your behalf when you say something like
_"reply to sarah: on it, pushing now."_

It's a thin stdio server built on `@modelcontextprotocol/sdk`. It holds no
state and no connection of its own — every tool call proxies to the local
`pingpald` daemon over the Unix-socket IPC. `pingpal init` registers it under
`mcpServers` in `~/.claude.json` so Claude Code launches it automatically.

## Tools

| Tool | Args | What it does |
| --- | --- | --- |
| `whos_online` | — | Returns the room roster — handles, faces (as text), and statuses. |
| `list_pings` | — | Returns recent/unread pings and marks them read. |
| `send_ping` | `{ to?, text }` | Sends a ≤90-char ping. Omit `to` to broadcast to the room; pass `@handle` or `handle` to direct it. |

`send_ping` validates the 90-char cap before it leaves your machine and returns
a friendly error if you go over. The read tools return both human-readable text
(rendered faces, via `@pingpal/faces`) and structured content.

## Run it

It's normally launched by Claude Code over stdio, but you can run it by hand to
sanity-check the wiring (it'll talk to whatever daemon is up):

```bash
pnpm --filter @pingpal/mcp build
node packages/mcp/dist/bin.js     # or, once installed: pingpal-mcp
```

If the daemon isn't running, the tools return a clear "daemon not reachable"
error rather than hanging.

## Development

```bash
pnpm --filter @pingpal/mcp build
pnpm --filter @pingpal/mcp test   # tool schemas/handlers, server registration, IPC proxying
```
