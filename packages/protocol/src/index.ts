/**
 * @pingpal/protocol — the shared wire contract for PingPal.
 *
 * Everything that crosses a socket (the WebSocket relay and the local IPC
 * socket) is described here: zod schemas, inferred TypeScript types, the
 * 90-character ping rule, NDJSON framing helpers, and an id generator. This
 * package depends only on `zod` so it stays portable and fast to test.
 */
export { MAX_PING_CHARS, PROTOCOL_VERSION, MAX_FILE_BYTES, FILE_CHUNK_BYTES, BLOB_TTL_MS } from "./constants.js";

export {
  ackSchema,
  codeResolvedSchema,
  createRoomSchema,
  envelopeSchema,
  errorSchema,
  faceIdSchema,
  fileBeginSchema,
  fileChunkSchema,
  fileDownloadSchema,
  fileEndSchema,
  fileShareSchema,
  handleSchema,
  helloSchema,
  helloHasOneRoom,
  helloRoomKey,
  joinCodeSchema,
  peerSchema,
  pingSchema,
  pingHasMessage,
  pingTextSchema,
  presenceSchema,
  resolveCodeSchema,
  roomCodeSchema,
  roomCreatedSchema,
  roomIdSchema,
  statusSchema,
} from "./schemas.js";

export type {
  Ack,
  CodeResolved,
  CreateRoom,
  Envelope,
  EnvelopeType,
  FileBegin,
  FileChunk,
  FileDownload,
  FileEnd,
  FileShare,
  Hello,
  Peer,
  Ping,
  Presence,
  ProtocolError,
  ResolveCode,
  RoomCreated,
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

export {
  genCode,
  newRoomId,
  normalizeCode,
  CODE_ALPHABET,
  CODE_LENGTH,
} from "./code.js";

export { deriveRoomKey, seal, open, looksSealed } from "./crypto.js";
