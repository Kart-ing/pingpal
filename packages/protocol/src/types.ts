import type { z } from "zod";
import type {
  ackSchema,
  codeResolvedSchema,
  createRoomSchema,
  envelopeSchema,
  errorSchema,
  helloSchema,
  peerSchema,
  pingSchema,
  presenceSchema,
  resolveCodeSchema,
  roomCreatedSchema,
  statusSchema,
} from "./schemas.js";

/** Presence status of a peer in the room. */
export type Status = z.infer<typeof statusSchema>;

/** client → relay: join a room under a handle. */
export type Hello = z.infer<typeof helloSchema>;

/** One peer as seen in a presence roster. */
export type Peer = z.infer<typeof peerSchema>;

/** relay → client: the current room roster. */
export type Presence = z.infer<typeof presenceSchema>;

/** A directed (`to: handle`) or broadcast (`to: null`) ping. */
export type Ping = z.infer<typeof pingSchema>;

/** Acknowledgement that a message with the given id was received. */
export type Ack = z.infer<typeof ackSchema>;

/** A structured protocol error. */
export type ProtocolError = z.infer<typeof errorSchema>;

/** client → relay: mint a fresh ephemeral room. */
export type CreateRoom = z.infer<typeof createRoomSchema>;

/** relay → client: a freshly minted room (roomId + short code). */
export type RoomCreated = z.infer<typeof roomCreatedSchema>;

/** client → relay: resolve a short join code to its roomId. */
export type ResolveCode = z.infer<typeof resolveCodeSchema>;

/** relay → client: result of a code lookup (`roomId: null` ⇒ not found). */
export type CodeResolved = z.infer<typeof codeResolvedSchema>;

/** Any wire message. */
export type Envelope = z.infer<typeof envelopeSchema>;

/** The set of valid `type` discriminants. */
export type EnvelopeType = Envelope["type"];
