import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  newId,
  validatePingText,
  handleSchema,
  type Ping,
} from "@pingpal/protocol";
import type { ResolvedConfig } from "./config.js";
import type { PingPalPaths } from "./paths.js";
import { PresenceStore } from "./presence.js";
import { PingBuffer } from "./ping-buffer.js";
import { IpcServer, type IpcAddress } from "./ipc-server.js";
import type { IpcRequest, IpcResponse, IpcResults } from "./ipc-protocol.js";
import {
  WsRelayClient,
  type RelayFactory,
  type RelayTransport,
} from "./relay-client.js";
import { LanMesh } from "./lan-mesh.js";
import {
  defaultDiscoveryFactory,
  type DiscoveryFactory,
  type LanDiscovery,
} from "./discovery.js";

/** Injectable seams for testing the daemon without real network or mDNS. */
export interface DaemonDeps {
  /** Build the relay transport. Default: a real {@link WsRelayClient}. */
  relayFactory?: RelayFactory;
  /** Build LAN discovery. Default: bonjour-service. `null` disables discovery. */
  discoveryFactory?: DiscoveryFactory | null;
  /** Override the wall clock (for deterministic timestamps in tests). */
  now?: () => number;
  /** Override how the notify command is spawned (so tests can observe it). */
  spawnNotify?: (command: string) => void;
}

/**
 * `pingpald` itself: the long-lived process that holds the relay link and LAN
 * mesh, merges presence, buffers incoming pings, and answers local IPC requests
 * from the Claude Code hook and the MCP server.
 *
 * The class is constructed with a resolved config and a set of injectable
 * factories; {@link start} brings every subsystem up and {@link stop} tears it
 * back down cleanly. Subsystem wiring lives here; the policy logic (presence
 * merge, routing, buffering) lives in the small focused modules it composes.
 */
export class Daemon {
  private readonly presence: PresenceStore;
  private readonly buffer: PingBuffer;
  private readonly ipc: IpcServer;
  private readonly nodeId = newId("node");
  private readonly now: () => number;
  private readonly spawnNotify: (command: string) => void;

  private relay: RelayTransport | null = null;
  private lanMesh: LanMesh | null = null;
  private discovery: LanDiscovery | null = null;
  private readonly relayFactory: RelayFactory;
  private readonly discoveryFactory: DiscoveryFactory | null;
  private started = false;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly paths: PingPalPaths,
    deps: DaemonDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.presence = new PresenceStore(config.handle);
    this.buffer = new PingBuffer(paths);
    this.ipc = new IpcServer(paths, (req) => this.handleIpc(req));
    this.relayFactory =
      deps.relayFactory ??
      ((cfg, cb) => new WsRelayClient(cfg, cb));
    this.discoveryFactory =
      deps.discoveryFactory === undefined
        ? defaultDiscoveryFactory
        : deps.discoveryFactory;
    this.spawnNotify = deps.spawnNotify ?? defaultSpawnNotify;
  }

  /** Bring up the home dir, LAN subsystem, relay link, and IPC server. */
  async start(): Promise<IpcAddress> {
    if (this.started) throw new Error("daemon already started");
    this.started = true;

    await mkdir(this.paths.home, { recursive: true });

    // 1. LAN subsystem (mesh listener + mDNS) — only if enabled in config.
    if (this.config.lanDiscovery) {
      await this.startLan();
    }

    // 2. Relay link.
    this.relay = this.relayFactory(this.config, {
      onPresence: (peers) => this.presence.setRelayPeers(peers),
      onPing: (ping) => this.onInboundPing(ping, "relay"),
      onConnected: () => {},
      onDisconnected: () => this.presence.clearRelayPeers(),
    });
    this.relay.start();

    // 3. Local IPC — last, so clients only connect once we can serve them.
    return this.ipc.start();
  }

  private async startLan(): Promise<void> {
    const mesh = new LanMesh({
      onPing: (ping) => this.onInboundPing(ping, "lan"),
    });
    let port: number;
    try {
      port = await mesh.start();
    } catch (err) {
      // Couldn't bind the LAN listener — degrade to relay-only.
      console.error(
        `[pingpald] LAN mesh disabled: ${err instanceof Error ? err.message : String(err)}`,
      );
      await mesh.stop().catch(() => {});
      return;
    }
    this.lanMesh = mesh;

    if (this.discoveryFactory) {
      const discovery = this.discoveryFactory(
        {
          nodeId: this.nodeId,
          handle: this.config.handle,
          faceId: this.config.faceId,
          room: this.config.roomCode,
          port,
        },
        {
          onPeerUp: (peer) =>
            this.presence.setLanPeer({
              nodeId: peer.nodeId,
              handle: peer.handle,
              faceId: peer.faceId,
              host: peer.host,
              port: peer.port,
              lastSeen: this.now(),
            }),
          onPeerDown: (nodeId) => this.presence.removeLanPeer(nodeId),
        },
      );
      this.discovery = discovery;
      discovery.start();
    }
  }

  /** Tear every subsystem down. Safe to call more than once. */
  async stop(): Promise<void> {
    await this.ipc.stop().catch(() => {});
    await this.relay?.stop().catch(() => {});
    await this.discovery?.stop().catch(() => {});
    await this.lanMesh?.stop().catch(() => {});
    this.relay = null;
    this.discovery = null;
    this.lanMesh = null;
    this.started = false;
  }

  /** Whether the relay link is currently up. */
  get relayConnected(): boolean {
    return this.relay?.connected ?? false;
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private onInboundPing(ping: Ping, via: "lan" | "relay"): void {
    const added = this.buffer.add(ping, via);
    if (added && this.config.notifyCommand) {
      try {
        this.spawnNotify(this.config.notifyCommand);
      } catch {
        /* best-effort: a broken notify command must not crash the daemon */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /**
   * Send a ping, routing each target over LAN when reachable there and falling
   * back to the relay otherwise. `to` may carry a leading `@`; null/empty means
   * a room broadcast.
   */
  async sendPing(
    rawTo: string | null | undefined,
    text: string,
  ): Promise<IpcResults["sendPing"]> {
    const check = validatePingText(text);
    if (!check.ok) throw new DeliveryError("text_too_long", check.reason);

    const to = this.resolveTarget(rawTo);
    const ping: Ping = {
      type: "ping",
      id: newId("ping"),
      from: this.config.handle,
      to,
      text,
      ts: this.now(),
    };

    const result =
      to === null
        ? await this.deliverBroadcast(ping)
        : await this.deliverDirected(to, ping);

    // Record our own outgoing ping so the chat view can show both sides of a
    // conversation. Stored read + outbound, so the notification hook ignores it.
    // ("none"/undelivered is recorded as relay — the path it was attempted on.)
    this.buffer.recordSent(ping, result.via === "lan" ? "lan" : "relay");

    return { id: ping.id, via: result.via, delivered: result.delivered };
  }

  /** Normalise a target handle; throws {@link DeliveryError} on a bad handle. */
  private resolveTarget(rawTo: string | null | undefined): string | null {
    if (rawTo == null) return null;
    const trimmed = rawTo.trim().replace(/^@/, "");
    if (trimmed === "") return null;
    const parsed = handleSchema.safeParse(trimmed);
    if (!parsed.success) {
      throw new DeliveryError(
        "bad_handle",
        parsed.error.issues[0]?.message ?? "invalid target handle",
      );
    }
    return parsed.data;
  }

  private async deliverDirected(
    to: string,
    ping: Ping,
  ): Promise<{ via: IpcResults["sendPing"]["via"]; delivered: boolean }> {
    const route = this.presence.routeFor(to);
    if (route.via === "lan" && this.lanMesh) {
      const ok = await this.lanMesh.send(route.host, route.port, ping);
      if (ok) return { via: "lan", delivered: true };
      // LAN attempt failed — fall through to the relay.
    }
    if (this.relay?.connected && this.relay.sendPing(ping)) {
      return { via: "relay", delivered: true };
    }
    return { via: "none", delivered: false };
  }

  private async deliverBroadcast(
    ping: Ping,
  ): Promise<{ via: IpcResults["sendPing"]["via"]; delivered: boolean }> {
    let usedRelay = false;
    let usedLan = false;

    if (this.relay?.connected) {
      usedRelay = this.relay.sendPing(ping);
      // Relay's `to: null` fan-out covers relay peers; LAN-unicast the rest so
      // a "both" peer isn't delivered to twice.
      if (this.lanMesh) {
        for (const peer of this.presence.lanOnlyPeers()) {
          if (await this.lanMesh.send(peer.host, peer.port, ping)) usedLan = true;
        }
      }
    } else if (this.lanMesh) {
      // No relay: reach every LAN peer directly.
      for (const peer of this.presence.lanPeers()) {
        if (await this.lanMesh.send(peer.host, peer.port, ping)) usedLan = true;
      }
    }

    const via: IpcResults["sendPing"]["via"] =
      usedRelay && usedLan
        ? "both"
        : usedRelay
          ? "relay"
          : usedLan
            ? "lan"
            : "none";
    return { via, delivered: usedRelay || usedLan };
  }

  // -------------------------------------------------------------------------
  // IPC
  // -------------------------------------------------------------------------

  private async handleIpc(req: IpcRequest): Promise<IpcResponse> {
    try {
      const result = await this.dispatch(req);
      return { id: req.id, ok: true, result };
    } catch (err) {
      const code = err instanceof DeliveryError ? err.code : "internal";
      const message = err instanceof Error ? err.message : String(err);
      return { id: req.id, ok: false, error: { code, message } };
    }
  }

  private async dispatch(req: IpcRequest): Promise<unknown> {
    switch (req.method) {
      case "getPresence": {
        const result: IpcResults["getPresence"] = {
          peers: this.presence.roster(),
        };
        return result;
      }
      case "getPings": {
        const result: IpcResults["getPings"] = {
          pings: this.buffer.list(req.params.markRead ?? false),
        };
        return result;
      }
      case "sendPing":
        return this.sendPing(req.params.to, req.params.text);
      case "status": {
        const result: IpcResults["status"] = {
          handle: this.config.handle,
          roomCode: this.config.roomCode,
          relayUrl: this.config.relayUrl,
          relayConnected: this.relayConnected,
          lanEnabled: this.discovery?.enabled ?? false,
          lanPeerCount: this.presence.lanCount(),
          relayPeerCount: this.presence.relayCount(),
          unread: this.buffer.unreadCount(),
        };
        return result;
      }
    }
  }
}

/** A send failure carrying a stable error code surfaced over IPC. */
export class DeliveryError extends Error {
  override readonly name = "DeliveryError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Default notify spawn: run the command in a detached shell, fully ignored. */
function defaultSpawnNotify(command: string): void {
  const child = spawn(command, {
    shell: true,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  child.on("error", () => {
    /* a broken notify command is non-fatal */
  });
}
