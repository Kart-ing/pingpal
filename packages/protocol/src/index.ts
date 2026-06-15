/**
 * @pingpal/protocol — the shared wire contract for PingPal.
 *
 * Everything that crosses a socket (the WebSocket relay and the local IPC
 * socket) is described here: zod schemas, inferred TypeScript types, the
 * 90-character ping rule, NDJSON framing helpers, and an id generator. This
 * package depends only on `zod` so it stays portable and fast to test.
 */
export { MAX_PING_CHARS, PROTOCOL_VERSION } from "./constants.js";

export {
  ackSchema,
  envelopeSchema,
  errorSchema,
  faceIdSchema,
  handleSchema,
  helloSchema,
  peerSchema,
  pingSchema,
  pingTextSchema,
  presenceSchema,
  roomCodeSchema,
  statusSchema,
} from "./schemas.js";

export type {
  Ack,
  Envelope,
  EnvelopeType,
  Hello,
  Peer,
  Ping,
  Presence,
  ProtocolError,
  Status,
} from "./types.js";

export { validatePingText } from "./validate.js";
export type { PingTextResult } from "./validate.js";

export {
  createFrameDecoder,
  decodeFrame,
  encodeFrame,
  FrameDecodeError,
} from "./framing.js";

export { newId } from "./id.js";

export { deriveRoomKey, seal, open, looksSealed } from "./crypto.js";
