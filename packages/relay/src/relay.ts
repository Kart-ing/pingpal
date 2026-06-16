import { WebSocketServer, type WebSocket } from "ws";
import {
  encodeFrame,
  envelopeSchema,
  helloHasOneRoom,
  helloRoomKey,
  MAX_PING_CHARS,
  newId,
  type Ack,
  type CodeResolved,
  type CreateRoom,
  type Envelope,
  type FileBegin,
  type FileChunk,
  type FileDownload,
  type FileEnd,
  type FileShare,
  type Ping,
  type Presence,
  type ProtocolError,
  type ResolveCode,
  type RoomCreated,
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
import { RoomDirectory } from "./directory.js";
import { BlobStore } from "./blobstore.js";

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
  const directory = new RoomDirectory();
  const conns = new Set<Conn>();
  const blobs = new BlobStore();

  // Track in-progress uploads: blobId → { chunks: Map<index, Buffer>, name, size, mime, roomKey, conn }
  const uploads = new Map<
    string,
    {
      chunks: Map<number, Buffer>;
      name: string;
      size: number;
      mime?: string;
      roomKey: string;
      conn: Conn;
    }
  >();

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
      // A hello must carry exactly one room key: the new roomId, or (legacy) a
      // self-chosen roomCode. Either becomes the opaque grouping key.
      if (!helloHasOneRoom(env)) {
        sendError(conn.ws, "bad_frame", "hello must carry exactly one of roomId / roomCode");
        return;
      }
      const roomKey = helloRoomKey(env);
      if (!roomKey) {
        sendError(conn.ws, "bad_frame", "hello is missing a room");
        return;
      }
      conn.roomCode = roomKey;
      conn.handle = env.handle;
      conn.faceId = env.faceId;
      conn.lastActivity = now;
      registry.join(conn);
      broadcastPresence(roomKey);
    };

    const onCreateRoom = (conn: Conn, env: CreateRoom): void => {
      // Minting a room needs no prior join — it's the very first step of
      // `start-room`. We simply hand back a fresh code + roomId; the client then
      // sends a normal `hello` with that roomId to actually enter.
      const { code, roomId } = directory.create();
      const reply: RoomCreated = { type: "room_created", nonce: env.nonce, roomId, code };
      send(conn.ws, reply);
    };

    const onResolveCode = (conn: Conn, env: ResolveCode): void => {
      const roomId = directory.resolve(env.code);
      const reply: CodeResolved = {
        type: "code_resolved",
        nonce: env.nonce,
        code: env.code,
        roomId,
      };
      send(conn.ws, reply);
    };

    // --- File sharing handlers ---

    const onFileBegin = (conn: Conn, env: FileBegin): void => {
      if (!conn.roomCode) {
        sendError(conn.ws, "not_joined", "join a room before uploading files");
        return;
      }
      if (uploads.has(env.blobId)) {
        sendError(conn.ws, "duplicate", "a transfer with this blobId is already in progress");
        return;
      }
      uploads.set(env.blobId, {
        chunks: new Map(),
        name: env.name,
        size: env.size,
        mime: env.mime,
        roomKey: conn.roomCode,
        conn,
      });
    };

    const onFileChunk = (conn: Conn, env: FileChunk): void => {
      const up = uploads.get(env.blobId);
      if (!up) {
        sendError(conn.ws, "unknown_blob", "no upload in progress with this blobId");
        return;
      }
      if (up.conn !== conn) {
        sendError(conn.ws, "forbidden", "only the uploader may send chunks");
        return;
      }
      const buf = Buffer.from(env.data, "base64");
      up.chunks.set(env.index, buf);
    };

    const onFileEnd = (conn: Conn, env: FileEnd): void => {
      const up = uploads.get(env.blobId);
      if (!up) {
        sendError(conn.ws, "unknown_blob", "no upload in progress with this blobId");
        return;
      }
      if (up.conn !== conn) {
        sendError(conn.ws, "forbidden", "only the uploader may finalise");
        return;
      }
      uploads.delete(env.blobId);

      if (!env.ok) {
        // Client signalling failure — nothing to store.
        return;
      }

      // Assemble chunks in order.
      const ordered: Buffer[] = [];
      for (let i = 0; i < up.chunks.size; i++) {
        const c = up.chunks.get(i);
        if (!c) {
          sendError(conn.ws, "incomplete", `missing chunk ${i}`);
          return;
        }
        ordered.push(c);
      }
      const data = Buffer.concat(ordered);
      if (data.byteLength !== up.size) {
        sendError(
          conn.ws,
          "size_mismatch",
          `declared ${up.size}, got ${data.byteLength}`,
        );
        return;
      }

      const stored = blobs.store(env.blobId, data, up.name, up.roomKey, up.mime);
      if (!stored) {
        sendError(conn.ws, "storage_full", "relay blob store is full or file too large");
        return;
      }

      // Confirm to uploader.
      const ok: FileEnd = { type: "file_end", blobId: env.blobId, ok: true };
      send(conn.ws, ok);
    };

    const onFileShare = (conn: Conn, env: FileShare): void => {
      if (!conn.roomCode || !conn.handle) {
        sendError(conn.ws, "not_joined", "join a room before sharing files");
        return;
      }
      // Verify the blob exists.
      if (!blobs.get(env.blobId)) {
        sendError(conn.ws, "unknown_blob", "blob not found — upload first");
        return;
      }
      const room = registry.room(conn.roomCode);
      const out: FileShare = { ...env, from: conn.handle };
      const frame = encodeFrame(out);
      if (room) {
        if (out.to === null) {
          for (const c of room) {
            if (c.handle !== conn.handle && c.ws.readyState === c.ws.OPEN) c.ws.send(frame);
          }
        } else {
          for (const c of room) {
            if (c.handle === out.to && c.ws.readyState === c.ws.OPEN) c.ws.send(frame);
          }
        }
      }
    };

    const onFileDownload = (conn: Conn, env: FileDownload): void => {
      if (!conn.roomCode) {
        sendError(conn.ws, "not_joined", "join a room before downloading");
        return;
      }
      const blob = blobs.get(env.blobId);
      if (!blob) {
        sendError(conn.ws, "unknown_blob", "blob not found or expired");
        return;
      }
      // Scope check: only room members can download.
      // (The roomCode may differ from the blob's roomKey if someone joined via
      // a legacy code or direct roomId; relax the check to same relay group.)
      if (blob.roomKey !== conn.roomCode) {
        sendError(conn.ws, "forbidden", "blob belongs to a different room");
        return;
      }

      // Send file_begin
      const totalChunks = Math.ceil(blob.size / 65536);
      const begin: FileBegin = {
        type: "file_begin",
        blobId: env.blobId,
        name: blob.name,
        size: blob.size,
        mime: blob.mime,
        totalChunks,
      };
      send(conn.ws, begin);

      // Send chunks
      const CHUNK = 65536;
      for (let i = 0; i < totalChunks; i++) {
        const chunk = blob.data.subarray(i * CHUNK, (i + 1) * CHUNK);
        const chunkMsg: FileChunk = {
          type: "file_chunk",
          blobId: env.blobId,
          index: i,
          data: chunk.toString("base64"),
        };
        send(conn.ws, chunkMsg);
      }

      // Send file_end
      const end: FileEnd = {
        type: "file_end",
        blobId: env.blobId,
        ok: true,
      };
      send(conn.ws, end);
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
        case "create_room":
          onCreateRoom(conn, env);
          return;
        case "resolve_code":
          onResolveCode(conn, env);
          return;
        case "file_begin":
          onFileBegin(conn, env);
          return;
        case "file_chunk":
          onFileChunk(conn, env);
          return;
        case "file_end":
          onFileEnd(conn, env);
          return;
        case "file_share":
          onFileShare(conn, env);
          return;
        case "file_download":
          onFileDownload(conn, env);
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
          // If that was the last member, the room is gone — forget its join code
          // too, so a minted code is single-meeting (it stops resolving once the
          // room empties). Legacy roomCode rooms aren't in the directory: no-op.
          if (!registry.room(code)) directory.forget(code);
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
      blobs.dispose();
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
