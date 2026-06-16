import { WebSocketServer, type WebSocket } from "ws";
import {
  encodeFrame,
  envelopeSchema,
  MAX_PING_CHARS,
  newId,
  type Ack,
  type Envelope,
  type Ping,
  type Presence,
  type ProtocolError,
} from "@pingpal/protocol";
import {
  DEFAULT_PORT,
  HEARTBEAT_MS,
  IDLE_AFTER_MS,
  RATE_CAPACITY,
  RATE_REFILL_PER_SEC,
} from "./constants.js";
import { RateLimiter, type Conn } from "./connection.js";
import { RoomRegistry } from "./rooms.js";

/** Options for {@link startRelay}. All have sensible defaults. */
export interface RelayOptions {
  /** Port to listen on. Use 0 for an ephemeral port (handy in tests). */
  port?: number;
  /** Host/interface to bind. Defaults to all interfaces. */
  host?: string;
  /** Heartbeat sweep interval in ms. */
  heartbeatMs?: number;
  /** How long with no activity before a peer is reported idle. */
  idleAfterMs?: number;
  /** Per-connection rate-limit burst capacity. */
  rateCapacity?: number;
  /** Per-connection rate-limit refill, tokens/sec. */
  rateRefillPerSec?: number;
}

/** A running relay. Resolve from {@link startRelay}; call {@link close} to stop. */
export interface RelayHandle {
  /** The actual bound port (resolved even when port 0 was requested). */
  readonly port: number;
  /** The underlying ws server, exposed for advanced use/inspection. */
  readonly wss: WebSocketServer;
  /** Terminate all connections and close the server. */
  close(): Promise<void>;
}

type Classified =
  | { ok: true; env: Envelope }
  | { ok: false; code: string; message: string };

/**
 * Parse one inbound NDJSON line into a validated envelope, distinguishing the
 * oversized-text case so the relay can return a specific error. This is defence
 * in depth: well-behaved clients already validate via @pingpal/protocol.
 */
function classifyInbound(line: string): Classified {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { ok: false, code: "bad_frame", message: "frame is not valid JSON" };
  }
  if (
    json !== null &&
    typeof json === "object" &&
    (json as { type?: unknown }).type === "ping"
  ) {
    const text = (json as { text?: unknown }).text;
    if (typeof text === "string" && text.length > MAX_PING_CHARS) {
      return {
        ok: false,
        code: "text_too_long",
        message: `ping text exceeds the ${MAX_PING_CHARS}-character limit`,
      };
    }
  }
  const res = envelopeSchema.safeParse(json);
  if (!res.success) {
    return {
      ok: false,
      code: "bad_frame",
      message: `frame failed validation: ${res.error.issues[0]?.message ?? "invalid envelope"}`,
    };
  }
  return { ok: true, env: res.data };
}

/**
 * Start the PingPal WebSocket relay.
 *
 * The relay groups connections by room code, tracks presence in memory, routes
 * directed (`to: handle`) and broadcast (`to: null`) pings, acks every send,
 * and rejects malformed/oversized/over-rate frames with an `error` envelope. It
 * persists nothing: state lives only as long as connections do.
 */
export function startRelay(opts: RelayOptions = {}): Promise<RelayHandle> {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const idleAfterMs = opts.idleAfterMs ?? IDLE_AFTER_MS;
  const rateCapacity = opts.rateCapacity ?? RATE_CAPACITY;
  const rateRefillPerSec = opts.rateRefillPerSec ?? RATE_REFILL_PER_SEC;

  const registry = new RoomRegistry();
  const conns = new Set<Conn>();

  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: opts.port ?? DEFAULT_PORT, host: opts.host });

    const send = (ws: WebSocket, env: Envelope): void => {
      if (ws.readyState === ws.OPEN) ws.send(encodeFrame(env));
    };
    const sendError = (ws: WebSocket, code: string, message: string): void => {
      const err: ProtocolError = { type: "error", code, message };
      send(ws, err);
    };

    const broadcastPresence = (code: string): void => {
      const room = registry.room(code);
      if (!room) return;
      const now = Date.now();
      const presence: Presence = {
        type: "presence",
        peers: registry.roster(code, now, idleAfterMs),
      };
      const frame = encodeFrame(presence);
      for (const c of room) {
        if (c.ws.readyState === c.ws.OPEN) c.ws.send(frame);
      }
      registry.markSignature(code, now, idleAfterMs);
    };

    const refreshPresenceIfChanged = (code: string): void => {
      if (registry.signatureChanged(code, Date.now(), idleAfterMs)) {
        broadcastPresence(code);
      }
    };

    const onHello = (conn: Conn, env: Extract<Envelope, { type: "hello" }>, now: number): void => {
      if (conn.roomCode) {
        sendError(conn.ws, "already_joined", "this connection has already joined a room");
        return;
      }
      // Password gate: the first joiner sets the room's expected proof; everyone
      // after must match. A wrong/missing proof is rejected here — so guessing
      // room codes can't get you into a password-protected room. (The relay
      // never sees the raw password, only the proof.)
      if (registry.checkAuth(env.roomCode, env.roomAuth) === "denied") {
        sendError(conn.ws, "auth_failed", "wrong or missing room password");
        return;
      }
      conn.roomCode = env.roomCode;
      conn.handle = env.handle;
      conn.faceId = env.faceId;
      conn.lastActivity = now;
      registry.join(conn);
      broadcastPresence(env.roomCode);
    };

    const onPing = (conn: Conn, env: Ping, now: number): void => {
      if (!conn.roomCode || !conn.handle) {
        sendError(conn.ws, "not_joined", "send a 'hello' frame before pinging");
        return;
      }
      conn.lastActivity = now;
      const room = registry.room(conn.roomCode);
      // Stamp `from` with the authenticated handle so a client can't spoof it.
      const out: Ping = { ...env, from: conn.handle };
      const frame = encodeFrame(out);
      if (room) {
        if (out.to === null) {
          // Broadcast: everyone in the room except the sender (all their conns).
          for (const c of room) {
            if (c.handle !== conn.handle && c.ws.readyState === c.ws.OPEN) c.ws.send(frame);
          }
        } else {
          // Directed: every connection bound to the target handle.
          for (const c of room) {
            if (c.handle === out.to && c.ws.readyState === c.ws.OPEN) c.ws.send(frame);
          }
        }
      }
      const ack: Ack = { type: "ack", id: out.id };
      send(conn.ws, ack);
      // Sending may have flipped the sender idle -> online.
      refreshPresenceIfChanged(conn.roomCode);
    };

    const handleLine = (conn: Conn, line: string, now: number): void => {
      if (!conn.limiter.tryRemove(now)) {
        sendError(conn.ws, "rate_limited", "too many messages — slow down");
        return;
      }
      const parsed = classifyInbound(line);
      if (!parsed.ok) {
        sendError(conn.ws, parsed.code, parsed.message);
        return;
      }
      const env = parsed.env;
      switch (env.type) {
        case "hello":
          onHello(conn, env, now);
          return;
        case "ping":
          onPing(conn, env, now);
          return;
        default:
          sendError(
            conn.ws,
            "unexpected",
            `relay does not accept '${env.type}' frames from clients`,
          );
      }
    };

    wss.on("connection", (ws: WebSocket) => {
      const conn: Conn = {
        id: newId(),
        ws,
        lastActivity: Date.now(),
        alive: true,
        limiter: new RateLimiter(rateCapacity, rateRefillPerSec, Date.now()),
      };
      conns.add(conn);

      ws.on("pong", () => {
        conn.alive = true;
      });

      ws.on("message", (data) => {
        const now = Date.now();
        // A ws message is already framed, but a client may batch NDJSON lines.
        for (const line of data.toString("utf8").split("\n")) {
          if (line.trim().length === 0) continue;
          handleLine(conn, line, now);
        }
      });

      ws.on("close", () => {
        conns.delete(conn);
        const code = conn.roomCode;
        if (code) {
          registry.leave(conn);
          broadcastPresence(code);
        }
      });

      // Swallow socket errors; a 'close' will follow and do the cleanup.
      ws.on("error", () => {});
    });

    const timer = setInterval(() => {
      // Liveness sweep: drop sockets that missed the previous ping.
      for (const conn of [...conns]) {
        if (!conn.alive) {
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        try {
          conn.ws.ping();
        } catch {
          // ignore; a failed ping means the socket is going away anyway
        }
      }
      // Re-broadcast presence for any room whose roster status changed (idle).
      const now = Date.now();
      for (const code of registry.codes()) {
        if (registry.signatureChanged(code, now, idleAfterMs)) broadcastPresence(code);
      }
    }, heartbeatMs);
    // Don't keep the process alive solely for the heartbeat.
    timer.unref?.();

    const close = (): Promise<void> => {
      clearInterval(timer);
      return new Promise<void>((res) => {
        for (const conn of [...conns]) {
          try {
            conn.ws.terminate();
          } catch {
            // already gone
          }
        }
        wss.close(() => res());
      });
    };

    wss.on("error", reject);
    wss.on("listening", () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? DEFAULT_PORT);
      resolve({ port, wss, close });
    });
  });
}
