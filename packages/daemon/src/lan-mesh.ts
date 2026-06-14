import { WebSocketServer } from "ws";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import {
  createFrameDecoder,
  encodeFrame,
  type Ping,
} from "@pingpal/protocol";

/** Callbacks the {@link LanMesh} fires back into the daemon. */
export interface LanMeshCallbacks {
  /** A ping arrived directly from a same-LAN peer. */
  onPing(ping: Ping): void;
}

/**
 * The peer-to-peer LAN transport. Each daemon opens one small WebSocket
 * listener on an ephemeral port (advertised over mDNS), and dials peers'
 * listeners to deliver pings — so two teammates on the same network never
 * touch the relay.
 *
 * The LAN wire format is the same NDJSON envelope framing as the relay, but the
 * only frame type exchanged here is `ping`. A connection is opened per send and
 * closed once flushed; ping volume is tiny, so pooling isn't worth the
 * complexity in v1.
 */
export class LanMesh {
  private server: WebSocketServer | null = null;
  private _port: number | null = null;

  constructor(private readonly callbacks: LanMeshCallbacks) {}

  /** The bound listener port once {@link start} resolves, else null. */
  get port(): number | null {
    return this._port;
  }

  /**
   * Open the inbound listener on an ephemeral port. Resolves with the bound
   * port (which the caller advertises via mDNS), or rejects if the socket can't
   * bind — the daemon treats that as "LAN unavailable" and stays relay-only.
   */
  start(host = "0.0.0.0"): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ port: 0, host });
      this.server = server;

      server.on("connection", (ws: WebSocket) => {
        const decode = createFrameDecoder();
        ws.on("message", (data: WebSocket.RawData) => {
          let envelopes;
          try {
            envelopes = decode(data.toString());
          } catch {
            return; // ignore a malformed frame from a peer
          }
          for (const env of envelopes) {
            if (env.type === "ping") this.callbacks.onPing(env);
          }
        });
        ws.on("error", () => {
          /* peer hiccup; the close handler (if any) cleans up */
        });
      });

      server.on("error", (err) => {
        this.server = null;
        reject(err);
      });

      server.on("listening", () => {
        const addr = server.address() as AddressInfo | null;
        const port = addr ? addr.port : 0;
        this._port = port;
        resolve(port);
      });
    });
  }

  /**
   * Dial a peer's listener and deliver one ping. Resolves true once the frame
   * is flushed, false on any connection/timeout/send failure (the daemon then
   * falls back to the relay, or just records the failure for a LAN-only peer).
   */
  send(host: string, port: number, ping: Ping, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://${formatHost(host)}:${port}`);
      } catch {
        finish(false);
        return;
      }

      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        finish(false);
      }, timeoutMs);
      timer.unref?.();

      ws.on("open", () => {
        try {
          ws.send(encodeFrame(ping), (err) => {
            // Close once the frame is actually flushed to the socket.
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            finish(!err);
          });
        } catch {
          finish(false);
        }
      });
      ws.on("error", () => finish(false));
    });
  }

  /** Close the inbound listener. Safe to call when never started. */
  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this._port = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      for (const client of server.clients) {
        try {
          client.terminate();
        } catch {
          /* already gone */
        }
      }
      server.close(() => resolve());
    });
  }
}

/** IPv6 literals need bracketing in a ws:// URL; IPv4/hostnames pass through. */
function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
