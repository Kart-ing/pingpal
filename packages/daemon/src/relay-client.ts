import WebSocket from "ws";
import {
  createFrameDecoder,
  encodeFrame,
  type Hello,
  type Peer,
  type Ping,
} from "@pingpal/protocol";
import type { ResolvedConfig } from "./config.js";

/**
 * Events the daemon cares about from its relay link. Implementations call these
 * synchronously; the daemon's handlers must not throw.
 */
export interface RelayCallbacks {
  /** A fresh roster arrived (relay → client `presence`). */
  onPresence(peers: Peer[]): void;
  /** A ping was routed to us by the relay. */
  onPing(ping: Ping): void;
  /** The link came up and the `hello` was sent. */
  onConnected(): void;
  /** The link went down (will auto-reconnect unless stopped). */
  onDisconnected(): void;
}

/**
 * The relay transport seen by the daemon. The real implementation is
 * {@link WsRelayClient}; tests inject a fake with the same surface so the
 * daemon can be exercised without a network.
 */
export interface RelayTransport {
  /** Open the link and begin reconnecting on drops. Idempotent. */
  start(): void;
  /** Stop reconnecting and close the socket. */
  stop(): Promise<void>;
  /** Send a ping to the relay. Returns false if not currently connected. */
  sendPing(ping: Ping): boolean;
  /** True while a socket is open and the `hello` has been sent. */
  readonly connected: boolean;
}

/** Factory the daemon uses to build its relay transport (swappable in tests). */
export type RelayFactory = (
  config: ResolvedConfig,
  callbacks: RelayCallbacks,
) => RelayTransport;

/** Reconnect/heartbeat tuning for {@link WsRelayClient}. */
export interface RelayClientOptions {
  /** First reconnect delay, doubled each failed attempt. Default 500ms. */
  backoffBaseMs?: number;
  /** Cap on the reconnect delay. Default 15s. */
  backoffMaxMs?: number;
  /** Interval between client→relay WebSocket pings. Default 20s. */
  heartbeatMs?: number;
  /** Injectable socket factory (tests). Defaults to the real `ws`. */
  createSocket?: (url: string) => WebSocket;
}

const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

/**
 * Holds the live WebSocket link to the relay on behalf of the daemon.
 *
 * Responsibilities:
 *  - dial the relay and send `hello` on open;
 *  - decode inbound `presence` / `ping` frames and fan them out via callbacks;
 *  - send a periodic WebSocket ping and drop a link that misses its pong;
 *  - reconnect with exponential backoff (+jitter) after any drop, re-sending
 *    `hello` so presence is restored, until {@link stop} is called.
 *
 * It deliberately ignores inbound `ack`/`error` frames beyond logging — v1 send
 * semantics are fire-and-forget with an immediate local ack.
 */
export class WsRelayClient implements RelayTransport {
  private ws: WebSocket | null = null;
  private decode = createFrameDecoder();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private alive = true;
  private stopped = false;
  private _connected = false;

  private readonly hello: Hello;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly heartbeatMs: number;
  private readonly createSocket: (url: string) => WebSocket;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly callbacks: RelayCallbacks,
    opts: RelayClientOptions = {},
  ) {
    this.hello = {
      type: "hello",
      roomCode: config.roomCode,
      handle: config.handle,
      faceId: config.faceId,
      clientVersion: config.clientVersion,
    };
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = opts.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.createSocket =
      opts.createSocket ?? ((url) => new WebSocket(url));
  }

  get connected(): boolean {
    return this._connected;
  }

  start(): void {
    if (this.ws || this.stopped) return;
    this.open();
  }

  private open(): void {
    let ws: WebSocket;
    try {
      ws = this.createSocket(this.config.relayUrl);
    } catch (err) {
      // A bad URL (or factory throw) shouldn't crash the daemon — just retry.
      this.warnOnce(`relay dial failed: ${stringifyError(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.decode = createFrameDecoder();

    ws.on("open", () => {
      this.attempt = 0;
      this.alive = true;
      this._connected = true;
      this.safeSend(encodeFrame(this.hello));
      this.startHeartbeat();
      this.callbacks.onConnected();
    });

    ws.on("pong", () => {
      this.alive = true;
    });

    ws.on("message", (data: WebSocket.RawData) => {
      let envelopes;
      try {
        envelopes = this.decode(data.toString());
      } catch {
        // A single malformed frame shouldn't tear down the link.
        return;
      }
      for (const env of envelopes) {
        if (env.type === "presence") this.callbacks.onPresence(env.peers);
        else if (env.type === "ping") this.callbacks.onPing(env);
        // ack/error: nothing actionable in v1.
      }
    });

    ws.on("close", () => this.handleDrop());
    ws.on("error", () => {
      // 'close' always follows 'error'; let it drive the reconnect.
    });
  }

  private handleDrop(): void {
    const wasConnected = this._connected;
    this._connected = false;
    this.stopHeartbeat();
    this.ws?.removeAllListeners();
    this.ws = null;
    if (wasConnected) this.callbacks.onDisconnected();
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const exp = Math.min(
      this.backoffMaxMs,
      this.backoffBaseMs * 2 ** this.attempt,
    );
    // Full jitter keeps a fleet of daemons from reconnecting in lockstep.
    const delay = Math.round(Math.random() * exp);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== ws.OPEN) return;
      if (!this.alive) {
        // Missed the previous pong — assume a half-open socket and recycle it.
        ws.terminate();
        return;
      }
      this.alive = false;
      try {
        ws.ping();
      } catch {
        // ignore; a failed ping means the socket is already going away
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  sendPing(ping: Ping): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    return this.safeSend(encodeFrame(ping));
  }

  private safeSend(frame: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    this._connected = false;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        ws.removeAllListeners();
        resolve();
      };
      ws.once("close", done);
      try {
        ws.close();
      } catch {
        ws.terminate();
        done();
        return;
      }
      // Don't wait forever for a polite close.
      const t = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        done();
      }, 1000);
      t.unref?.();
    });
  }

  private warnedOnce = false;
  private warnOnce(msg: string): void {
    if (this.warnedOnce) return;
    this.warnedOnce = true;
    console.error(`[pingpald] ${msg}`);
  }
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
