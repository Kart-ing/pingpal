import type { z } from "zod";
import type {
  ackSchema,
  envelopeSchema,
  errorSchema,
  helloSchema,
  peerSchema,
  pingSchema,
  presenceSchema,
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

/** Any wire message. */
export type Envelope = z.infer<typeof envelopeSchema>;

/** The set of valid `type` discriminants. */
export type EnvelopeType = Envelope["type"];
