import { mkdir } from "node:fs/promises";
import { writeFile, readFile } from "node:fs/promises";
import { basename, join as pathJoin } from "node:path";
import { spawn } from "node:child_process";
import {
  newId,
  validatePingText,
  handleSchema,
  deriveRoomKey,
  seal,
  open as openSealed,
  type FileShare,
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
  /** E2E key derived from the room code; messages are sealed/opened with it. */
  private readonly roomKey: Buffer;

  private relay: RelayTransport | null = null;
  private lanMesh: LanMesh | null = null;
  private discovery: LanDiscovery | null = null;
  private readonly relayFactory: RelayFactory;
  private readonly discoveryFactory: DiscoveryFactory | null;
  private started = false;

  /** Received file metadata (loaded from disk on start). */
  private fileMeta: IpcResults["listFiles"] = [];

  constructor(
    private readonly config: ResolvedConfig,
    private readonly paths: PingPalPaths,
    deps: DaemonDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    // Derive the E2E key from the room SECRET (roomId). Legacy rooms promoted
    // their old roomCode into roomId, so existing rooms keep the same key.
    this.roomKey = deriveRoomKey(config.roomId);
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
    await mkdir(this.paths.files, { recursive: true });

    // Load received-file metadata from disk.
    try {
      const raw = await readFile(this.paths.filesLog, "utf8");
      this.fileMeta = JSON.parse(raw);
    } catch {
      this.fileMeta = [];
    }

    // 1. LAN subsystem (mesh listener + mDNS) — only if enabled in config.
    if (this.config.lanDiscovery) {
      await this.startLan();
    }

    // 2. Relay link.
    this.relay = this.relayFactory(this.config, {
      onPresence: (peers) => this.presence.setRelayPeers(peers),
      onPing: (ping) => this.onInboundPing(ping, "relay"),
      onFileShare: (fs) => this.onInboundFileShare(fs),
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
          // Group LAN peers by the room SECRET, matching the relay's grouping
          // (and keeping the human code out of mDNS broadcasts).
          room: this.config.roomId,
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
    // Decrypt an end-to-end payload into plaintext for local use. If it can't be
    // opened (wrong room key, tampering, unknown format), surface a placeholder
    // rather than dropping it silently — a message arrived, we just can't read it.
    const local = this.decryptInbound(ping);
    const added = this.buffer.add(local, via);
    if (added && this.config.notifyCommand) {
      try {
        this.spawnNotify(this.config.notifyCommand);
      } catch {
        /* best-effort: a broken notify command must not crash the daemon */
      }
    }
  }

  /** Auto-download a file when a file_share announcement arrives. */
  private async onInboundFileShare(fs: FileShare): Promise<void> {
    if (!this.relay) return;
    try {
      const buf = await this.relay.downloadFile(fs.blobId, 30000);
      const senderDir = pathJoin(this.paths.files, fs.from);
      await mkdir(senderDir, { recursive: true });
      const filePath = pathJoin(senderDir, fs.name);
      await writeFile(filePath, buf);

      const record: IpcResults["listFiles"][number] = {
        blobId: fs.blobId,
        name: fs.name,
        size: fs.size,
        from: fs.from,
        savedAt: Date.now(),
        path: filePath,
      };
      this.fileMeta.push(record);
      await writeFile(this.paths.filesLog, JSON.stringify(this.fileMeta, null, 2), "utf8");

      // Notify about the new file (reuse notifyCommand if configured).
      if (this.config.notifyCommand) {
        try {
          this.spawnNotify(this.config.notifyCommand);
        } catch {
          /* best-effort */
        }
      }
    } catch (err) {
      // Download failed — file may have expired or relay was unreachable.
      // Don't crash the daemon; the user can retry with `pingpal pull`.
      if (this.config.notifyCommand) {
        try {
          this.spawnNotify(this.config.notifyCommand);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  /**
   * Turn a wire ping into its local form: if it carries an `enc` payload, open it
   * with the room key into a plaintext `text`. Returns a ping with `text` set and
   * `enc` stripped. An undecryptable payload becomes a clear placeholder so it's
   * still visible (a message arrived) without leaking that we failed.
   */
  private decryptInbound(ping: Ping): Ping {
    if (ping.enc == null) return ping; // already plaintext
    const text = openSealed(ping.enc, this.roomKey);
    const { enc: _enc, ...rest } = ping;
    return { ...rest, text: text ?? "🔒 [encrypted — can't decrypt with this room]" };
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
    const id = newId("ping");
    const ts = this.now();
    const base = { type: "ping" as const, id, from: this.config.handle, to, ts };

    // Local form keeps plaintext (for our own chat history). The WIRE form carries
    // only the sealed `enc` payload — the relay/peers never see our plaintext.
    const localPing: Ping = { ...base, text };
    const wirePing: Ping = { ...base, enc: seal(text, this.roomKey) };

    const result =
      to === null
        ? await this.deliverBroadcast(wirePing)
        : await this.deliverDirected(to, wirePing);

    // Record our own outgoing ping (plaintext, locally) so the chat view can show
    // both sides. Stored read + outbound, so the notification hook ignores it.
    // ("none"/undelivered is recorded as relay — the path it was attempted on.)
    this.buffer.recordSent(localPing, result.via === "lan" ? "lan" : "relay");

    return { id, via: result.via, delivered: result.delivered };
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
  // File sharing
  // -------------------------------------------------------------------------

  /**
   * Share a file with the room via the relay blob store.
   * For files ≤5 MB the relay hosts it (30 min TTL). For larger files the caller
   * should use git-backed sharing (handled by the CLI).
   */
  async sendFile(
    filePath: string,
    rawTo: string | null | undefined,
  ): Promise<IpcResults["sendFile"]> {
    if (!this.relay?.connected) {
      throw new DeliveryError("no_relay", "relay is not connected");
    }

    const buf = await readFile(filePath);
    if (buf.byteLength > 5_242_880) {
      throw new DeliveryError(
        "file_too_large",
        "files over 5 MB must be shared via git — run `pingpal share --git <file>`",
      );
    }

    const name = basename(filePath);
    const blobId = newId("blob");
    const to = rawTo?.trim().replace(/^@/, "") || null;

    await this.relay.uploadFile(blobId, filePath, name);

    // Announce the file to the room.
    const fs: FileShare = {
      type: "file_share",
      id: newId("fshare"),
      from: this.config.handle,
      to,
      blobId,
      name,
      size: buf.byteLength,
      ts: this.now(),
    };
    this.relay.sendFileShare(fs);

    return { blobId, name, size: buf.byteLength, via: "relay", delivered: true };
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
      case "sendFile":
        return this.sendFile(req.params.path, req.params.to);
      case "listFiles": {
        const result: IpcResults["listFiles"] = this.fileMeta;
        return result;
      }
      case "status": {
        const result: IpcResults["status"] = {
          handle: this.config.handle,
          // Report the short, human-recognisable code (not the secret roomId).
          roomCode: this.config.displayCode,
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
