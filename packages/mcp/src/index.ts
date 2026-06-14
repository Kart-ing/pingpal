/**
 * @pingpal/mcp — the PingPal MCP (Model Context Protocol) server.
 *
 * A thin stdio server that lets Claude Code see and send pings: it exposes
 * `whos_online`, `list_pings`, and `send_ping`, each proxying to the local
 * pingpald daemon over its IPC socket. Run it via the `pingpal-mcp` bin (see
 * {@link ./bin.ts}); the exports below let the CLI and tests build it
 * programmatically.
 */
export { buildServer, TOOL_NAMES } from "./server.js";
export type { BuildServerOptions } from "./server.js";

export {
  listPings,
  normalizeTarget,
  sendPing,
  whosOnline,
} from "./tools.js";
export type { ToolResult } from "./tools.js";

export {
  createDaemonClient,
  DaemonError,
  isUnreachable,
  resolveEndpoint,
} from "./daemon-ipc.js";
export type {
  BufferedPing,
  DaemonClient,
  DaemonEndpoint,
  DaemonResults,
  MergedPeer,
  Reachability,
  SendPingResult,
} from "./daemon-ipc.js";
