# PingPal — manual end-to-end smoke test

This walks through a **real two-user ping** on a single machine: a local relay,
two isolated PingPal identities ("alice" and "bob"), a ping sent from one, and
that ping surfacing for the other via **both** the notification hook (push) and
the MCP `list_pings` tool (pull).

The trick is to give each fake user its own `PINGPAL_HOME` (so they get separate
config, sockets, and ping buffers) and its own `CLAUDE_HOME` (so `init`'s writes
don't collide). We force the **relay path** by disabling LAN discovery; see the
note at the end for testing the direct LAN path instead.

> Build first: `pnpm install && pnpm -r build`. All commands below assume the
> repo root as the working directory and `node`/`pnpm` on `PATH`.

---

## Terminal 0 — the relay

```bash
node packages/relay/dist/bin.js
# → listening on :8787
```

Leave it running. Everything else points at `ws://localhost:8787`.

---

## Terminal A — alice

```bash
export PINGPAL_HOME="$PWD/.smoke/alice"
export CLAUDE_HOME="$PWD/.smoke/alice"          # keep init's settings writes isolated
export PINGPAL_RELAY="ws://localhost:8787"

# Identity + Claude Code wiring, no prompts:
node packages/cli/dist/index.js init \
  --handle alice --room demo-room-1234 --face fox

# Force the relay path for a deterministic test (skip mDNS):
node -e 'const f="'$PINGPAL_HOME'/config.json",fs=require("fs");const c=JSON.parse(fs.readFileSync(f));c.lanDiscovery=false;fs.writeFileSync(f,JSON.stringify(c,null,2))'

# Start alice's daemon:
node packages/cli/dist/index.js start
node packages/cli/dist/index.js status          # should show the relay connected
```

---

## Terminal B — bob

```bash
export PINGPAL_HOME="$PWD/.smoke/bob"
export CLAUDE_HOME="$PWD/.smoke/bob"
export PINGPAL_RELAY="ws://localhost:8787"

node packages/cli/dist/index.js init \
  --handle bob --room demo-room-1234 --face owl

node -e 'const f="'$PINGPAL_HOME'/config.json",fs=require("fs");const c=JSON.parse(fs.readFileSync(f));c.lanDiscovery=false;fs.writeFileSync(f,JSON.stringify(c,null,2))'

node packages/cli/dist/index.js start
node packages/cli/dist/index.js status          # alice should appear in the roster
```

Both daemons are now joined to `demo-room-1234` through the relay and should see
each other's presence.

---

## Send a ping (alice → bob)

There's no `pingpal send` command — sending is what the MCP `send_ping` tool is
for. To do it from the shell, talk to **alice's** daemon over its IPC socket
(the same NDJSON request the MCP server sends). In **Terminal A**:

```bash
node -e '
const net = require("net");
const sock = process.env.PINGPAL_HOME + "/daemon.sock";
const c = net.connect(sock, () => {
  c.write(JSON.stringify({ id: "smoke-1", method: "sendPing",
    params: { to: "bob", text: "ship it when green, I will review at 3" } }) + "\n");
});
c.setEncoding("utf8");
c.on("data", d => { process.stdout.write(d); c.end(); });
'
# → {"id":"smoke-1","ok":true,"result":{"id":"...","via":"relay","delivered":true}}
```

`via:"relay"` confirms it went through the relay (it would say `"lan"` if LAN
discovery were on and the peer were found locally).

---

## See it on bob's side

### Push — the notification hook

This is exactly what Claude Code runs on the `Notification` event. In
**Terminal B**:

```bash
PINGPAL_HOME="$PWD/.smoke/bob" node packages/cli/hook/pingpal-hook.mjs
```

You should see the rendered face + bubble (the face is chosen by hashing the
sender's handle, so it's stable per teammate):

```
   ╭──────────────────────────────────────────╮
   │  ship it when green, I will review at 3  │
   ╰──────┬───────────────────────────────────╯
          │
        ✦ · ✦   ╭───────────╮
       ( ✪‿✪ )  │   alice   │   ● online · just now
        ·✦ ✦·   ╰───────────╯
```

Run it again — it prints nothing, because the hook marked the ping read. That's
the buffer-and-flush behaviour: pings are never lost, never repeated.

### Pull — the MCP `list_pings` tool

To exercise the same path Claude uses to read mail, run bob's MCP server and
call `list_pings` over stdio. (Re-send a fresh ping from Terminal A first if you
already drained the buffer with the hook.) In **Terminal B**:

```bash
PINGPAL_HOME="$PWD/.smoke/bob" node packages/mcp/dist/bin.js
```

Then paste these two MCP JSON-RPC lines (stdin):

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_pings","arguments":{}}}
```

The response's content includes alice's ping (rendered face + structured data).
You can likewise call `whos_online` and `send_ping` to reply.

---

## Cleanup

```bash
node packages/cli/dist/index.js stop   # in BOTH Terminal A and Terminal B (with their env set)
# Ctrl-C the relay in Terminal 0
rm -rf .smoke                          # throwaway homes + the isolated Claude config
```

---

## Variation — test the LAN direct path

Skip the two `lanDiscovery=false` edits. With mDNS on, the two same-host daemons
discover each other as `_pingpal._tcp` peers in the same room and deliver pings
**directly** — the `sendPing` result will report `via:"lan"` and the relay never
sees the message. If your environment blocks multicast, the daemons log an mDNS
warning once and fall back to the relay automatically.
