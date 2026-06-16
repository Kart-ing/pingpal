/**
 * @pingpal/daemon — `pingpald`, the per-machine PingPal runtime.
 *
 * It holds the live relay WebSocket link and the LAN (mDNS) mesh, merges the
 * two presence sources into one roster, buffers incoming pings, and exposes a
 * tiny local IPC server (Unix socket / Windows TCP) that the Claude Code hook
 * and MCP server talk to. The exports below let those thin clients — and tests
 * — drive the daemon programmatically.
 */
export { Daemon, DeliveryError } from "./daemon.js";
export type { DaemonDeps } from "./daemon.js";

export { resolvePaths } from "./paths.js";
export type { PingPalPaths } from "./paths.js";

export {
  DEFAULT_RELAY_URL,
  ConfigError,
  configFileSchema,
  loadConfig,
  resolveConfig,
} from "./config.js";
export type { ConfigFile, ResolvedConfig } from "./config.js";

export { PresenceStore } from "./presence.js";
export type { LanPeer, Route } from "./presence.js";

export { PingBuffer } from "./ping-buffer.js";

export { WsRelayClient } from "./relay-client.js";
export type {
  RelayCallbacks,
  RelayClientOptions,
  RelayFactory,
  RelayTransport,
} from "./relay-client.js";

export { LanMesh } from "./lan-mesh.js";
export type { LanMeshCallbacks } from "./lan-mesh.js";

export {
  BonjourDiscovery,
  defaultDiscoveryFactory,
} from "./discovery.js";
export type {
  AdvertiseInfo,
  BonjourLike,
  BonjourLoader,
  DiscoveredPeer,
  DiscoveryCallbacks,
  DiscoveryFactory,
  LanDiscovery,
} from "./discovery.js";

export { IpcServer } from "./ipc-server.js";
export type { IpcAddress, IpcHandler } from "./ipc-server.js";

export { IpcClientError, sendRequest } from "./ipc-client.js";

export { mintRoom, resolveCode, RoomControlError } from "./room-control.js";
export type { MintedRoom, RoomControlOptions } from "./room-control.js";

export {
  createLineSplitter,
  encodeIpc,
  ipcRequestSchema,
  newRequestId,
} from "./ipc-protocol.js";
export type {
  BufferedPing,
  IpcMethod,
  IpcRequest,
  IpcResponse,
  IpcResults,
  MergedPeer,
  Reachability,
} from "./ipc-protocol.js";
