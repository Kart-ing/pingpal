/**
 * Builds the PingPal MCP server: an `McpServer` (from the official SDK) with
 * exactly three tools — `whos_online`, `list_pings`, `send_ping` — each a thin
 * wrapper over the pingpald daemon's IPC socket.
 *
 * The actual tool logic lives in {@link ./tools.ts} as plain functions so it's
 * unit-testable without a transport; this module only does the SDK wiring.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createDaemonClient, type DaemonClient } from "./daemon-ipc.js";
import {
  listPings,
  listPingsInputSchema,
  listPingsOutputSchema,
  sendPing,
  sendPingInputSchema,
  whosOnline,
  whosOnlineOutputSchema,
} from "./tools.js";

const VERSION = "0.1.0";

/** Names of the tools this server exposes, in registration order. */
export const TOOL_NAMES = ["whos_online", "list_pings", "send_ping"] as const;

export interface BuildServerOptions {
  /** Inject a daemon client (tests pass a fake; default talks to the socket). */
  client?: DaemonClient;
}

/**
 * Construct the MCP server and register its three tools. The returned server is
 * not yet connected to a transport — call `.connect(transport)` (see
 * {@link ./bin.ts}) or hand it an in-memory transport in tests.
 */
export function buildServer(opts: BuildServerOptions = {}): McpServer {
  const client = opts.client ?? createDaemonClient();
  const server = new McpServer({ name: "pingpal", version: VERSION });

  server.registerTool(
    "whos_online",
    {
      title: "Who's online",
      description:
        "List the teammates currently in your PingPal room — handles, faces, and presence (online/idle/offline). Use this to see who you can ping.",
      inputSchema: {},
      outputSchema: whosOnlineOutputSchema,
    },
    () => whosOnline(client),
  );

  server.registerTool(
    "list_pings",
    {
      title: "List pings",
      description:
        "Show recent/unread pings from teammates (sender, text, and how long ago). By default this marks them read; pass markRead:false to peek without clearing.",
      inputSchema: listPingsInputSchema,
      outputSchema: listPingsOutputSchema,
    },
    (args) => listPings(client, args),
  );

  server.registerTool(
    "send_ping",
    {
      title: "Send a ping",
      description:
        "Send a short ping (90 characters max). Omit `to` to broadcast to the whole room, or set `to` to a teammate's handle (with or without a leading @) to direct it.",
      inputSchema: sendPingInputSchema,
    },
    (args) => sendPing(client, args),
  );

  return server;
}
