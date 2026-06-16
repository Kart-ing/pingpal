import { z } from "zod";
import {
  BLOB_TTL_MS,
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  MAX_PING_CHARS,
} from "./constants.js";

/**
 * A handle is a teammate's display name, unique within a room. Kept to a
 * conservative character set so it renders cleanly in a terminal and is safe
 * to embed in box-drawn faces and `@handle` mentions.
 */
export const handleSchema = z
  .string()
  .trim()
  .min(1, "handle is required")
  .max(32, "handle must be at most 32 characters")
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "handle may only contain letters, numbers, '.', '_' and '-'",
  );

/**
 * The shared, unguessable room code that acts as the lightweight v1 secret.
 * We only validate shape here (relays compare it as an opaque token).
 */
export const roomCodeSchema = z
  .string()
  .trim()
  .min(4, "room code must be at least 4 characters")
  .max(128, "room code must be at most 128 characters");

/**
 * A full-entropy room identifier (see {@link import("./code.js").newRoomId}):
 * the real shared secret, the relay's routing label, and the E2E key material.
 * Distinct from the short human {@link joinCodeSchema}. Validated as an opaque
 * token of reasonable length — the relay never interprets it.
 */
export const roomIdSchema = z
  .string()
  .trim()
  .min(8, "roomId must be at least 8 characters")
  .max(128, "roomId must be at most 128 characters");

/**
 * A short, human-typed join code (Meet-style, e.g. `vmw-qkzt-ph`). Only used to
 * look a room up on the relay; never key material. We accept dashes/spacing and
 * a generous length so normalisation (lowercasing, stripping separators) can
 * happen client-side before lookup.
 */
export const joinCodeSchema = z
  .string()
  .trim()
  .min(3, "join code is too short")
  .max(40, "join code is too long");

/** Identifier of an ASCII face preset (or a custom override). */
export const faceIdSchema = z
  .string()
  .trim()
  .min(1, "faceId is required")
  .max(64, "faceId must be at most 64 characters");

/** Presence status of a peer in the room. */
export const statusSchema = z.enum(["online", "idle", "offline"]);

/**
 * The body of a ping. Enforces the {@link MAX_PING_CHARS} hard cap at the
 * schema layer so every transport (WebSocket relay + local IPC) rejects
 * over-long text identically.
 */
export const pingTextSchema = z
  .string()
  .min(1, "ping text must not be empty")
  .max(MAX_PING_CHARS, `ping text must be at most ${MAX_PING_CHARS} characters`);

// ---------------------------------------------------------------------------
// Envelope members. Every message carries a `type` discriminant.
// ---------------------------------------------------------------------------

/**
 * client → relay: join a room under a handle.
 *
 * Rooms are addressed by {@link roomIdSchema} (`roomId`) — the full-entropy
 * secret minted by `create_room`. `roomCode` is retained as an optional legacy
 * field so pre-Meet clients (which sent a self-chosen room code) still connect;
 * the relay treats whichever is present as the opaque room key, preferring
 * `roomId`. Exactly one of the two must be set.
 */
export const helloSchema = z.object({
  type: z.literal("hello"),
  roomId: roomIdSchema.optional(),
  roomCode: roomCodeSchema.optional(),
  handle: handleSchema,
  faceId: faceIdSchema,
  clientVersion: z.string().min(1),
});

/**
 * client → relay: mint a brand-new ephemeral room. The relay generates a fresh
 * `roomId` and a short human join `code`, registers the mapping, and replies
 * with {@link roomCreatedSchema}. No room state persists beyond the first
 * member connecting — the code is forgotten once the room empties.
 */
export const createRoomSchema = z.object({
  type: z.literal("create_room"),
  /** Correlates the reply, so a client can have one in flight unambiguously. */
  nonce: z.string().min(1).max(64),
});

/** relay → client: a freshly minted room. */
export const roomCreatedSchema = z.object({
  type: z.literal("room_created"),
  nonce: z.string().min(1).max(64),
  roomId: roomIdSchema,
  code: joinCodeSchema,
});

/**
 * client → relay: resolve a short join code to its `roomId` (the join path).
 * The relay looks up the code it minted; a miss yields a {@link codeResolvedSchema}
 * with `roomId: null` so the CLI can print a friendly "no such room" message.
 */
export const resolveCodeSchema = z.object({
  type: z.literal("resolve_code"),
  nonce: z.string().min(1).max(64),
  code: joinCodeSchema,
});

/** relay → client: the result of a code lookup (`roomId: null` ⇒ not found). */
export const codeResolvedSchema = z.object({
  type: z.literal("code_resolved"),
  nonce: z.string().min(1).max(64),
  code: joinCodeSchema,
  roomId: roomIdSchema.nullable(),
});

/** One peer as seen in a presence roster. */
export const peerSchema = z.object({
  handle: handleSchema,
  faceId: faceIdSchema,
  status: statusSchema,
  /** epoch-ms timestamp of when the peer was last seen. */
  lastSeen: z.number().int().nonnegative(),
});

/** relay → client: the current room roster. */
export const presenceSchema = z.object({
  type: z.literal("presence"),
  peers: z.array(peerSchema),
});

/**
 * Either direction: a directed or broadcast ping.
 * `to: null` means a room broadcast; a handle means a directed message.
 */
export const pingSchema = z.object({
  type: z.literal("ping"),
  id: z.string().min(1),
  from: handleSchema,
  to: handleSchema.nullable(),
  /**
   * Plaintext message. Present on plaintext pings and on the LOCAL view of a
   * decrypted ping; OMITTED on the wire when `enc` is set (end-to-end mode), so
   * the relay never sees plaintext. The 90-char cap is enforced here and checked
   * on the *plaintext* before sealing. Exactly one of `text`/`enc` is set — see
   * {@link pingHasMessage}; kept as a plain object (not refined) so it can be a
   * `z.discriminatedUnion` member.
   */
  text: pingTextSchema.optional(),
  /**
   * End-to-end-encrypted payload (base64 AES-256-GCM blob, see crypto.ts). When
   * present, the relay forwards it opaquely and cannot read the message;
   * recipients decrypt it back into `text` locally. Length-bounded so a relay can
   * still reject absurd blobs (90 chars of UTF-8 seals well under this).
   */
  enc: z.string().min(1).max(512).optional(),
  /** epoch-ms timestamp of when the ping was created. */
  ts: z.number().int().nonnegative(),
});

/** A ping is well-formed iff it carries exactly one of `text` / `enc`. */
export function pingHasMessage(p: { text?: unknown; enc?: unknown }): boolean {
  return (p.text != null) !== (p.enc != null);
}

/** Acknowledgement that a message with the given id was received. */
export const ackSchema = z.object({
  type: z.literal("ack"),
  id: z.string().min(1),
});

/** A structured error, usable on either transport. */
export const errorSchema = z.object({
  type: z.literal("error"),
  code: z.string().min(1),
  message: z.string().min(1),
});

// ---------------------------------------------------------------------------
// File sharing — chunked upload/download over the relay WebSocket
// ---------------------------------------------------------------------------

/** A blob identifier minted by the uploader (opaque to the relay). */
const blobIdSchema = z.string().min(8).max(64);

/** MIME type, optionally provided with a file upload. */
const mimeSchema = z.string().min(1).max(128).optional();

/**
 * A file_share ping travels through the relay to room members (like a ping,
 * the relay routes it without interpreting the payload). It carries enough
 * metadata that recipients can auto-download or decide to skip.
 */
export const fileShareSchema = z.object({
  type: z.literal("file_share"),
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1).nullable(),
  blobId: blobIdSchema,
  name: z.string().min(1).max(256),
  size: z.number().int().positive().max(MAX_FILE_BYTES),
  mime: mimeSchema,
  ts: z.number().int().nonnegative(),
});

/**
 * client → relay (upload) OR relay → client (download):
 * announces a file transfer about to begin.
 */
export const fileBeginSchema = z.object({
  type: z.literal("file_begin"),
  blobId: blobIdSchema,
  name: z.string().min(1).max(256),
  size: z.number().int().positive().max(MAX_FILE_BYTES),
  mime: mimeSchema,
  totalChunks: z.number().int().positive().max(1024),
});

/**
 * client ↔ relay: a single base64-encoded chunk of file data.
 * Each chunk carries up to {@link FILE_CHUNK_BYTES} raw bytes (≈85 KB base64).
 */
export const fileChunkSchema = z.object({
  type: z.literal("file_chunk"),
  blobId: blobIdSchema,
  index: z.number().int().nonnegative().max(1023),
  data: z
    .string()
    .min(1)
    .max(FILE_CHUNK_BYTES * 2), // generous headroom for base64 expansion
});

/** client → relay OR relay → client: signals the end of a file transfer. */
export const fileEndSchema = z.object({
  type: z.literal("file_end"),
  blobId: blobIdSchema,
  ok: z.boolean(),
  error: z.string().optional(),
});

/** client → relay: request to download a blob by id. */
export const fileDownloadSchema = z.object({
  type: z.literal("file_download"),
  blobId: blobIdSchema,
});

/**
 * The discriminated union of every wire message. Use this to parse any line
 * coming off the relay socket or the local IPC socket.
 */
export const envelopeSchema = z.discriminatedUnion("type", [
  helloSchema,
  presenceSchema,
  pingSchema,
  ackSchema,
  errorSchema,
  createRoomSchema,
  roomCreatedSchema,
  resolveCodeSchema,
  codeResolvedSchema,
  fileShareSchema,
  fileBeginSchema,
  fileChunkSchema,
  fileEndSchema,
  fileDownloadSchema,
]);

/** True iff a `hello` carries exactly one room key (roomId XOR legacy roomCode). */
export function helloHasOneRoom(h: { roomId?: unknown; roomCode?: unknown }): boolean {
  return (h.roomId != null) !== (h.roomCode != null);
}

/** The opaque room key the relay routes by: prefer roomId, fall back to legacy code. */
export function helloRoomKey(h: { roomId?: string; roomCode?: string }): string | undefined {
  return h.roomId ?? h.roomCode;
}
