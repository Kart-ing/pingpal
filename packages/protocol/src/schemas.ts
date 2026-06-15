import { z } from "zod";
import { MAX_PING_CHARS } from "./constants.js";

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

/** client → relay: join a room under a handle. */
export const helloSchema = z.object({
  type: z.literal("hello"),
  roomCode: roomCodeSchema,
  handle: handleSchema,
  faceId: faceIdSchema,
  clientVersion: z.string().min(1),
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
]);
