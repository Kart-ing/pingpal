import { envelopeSchema } from "./schemas.js";
import type { Envelope } from "./types.js";

/** Thrown when a line cannot be parsed into a valid {@link Envelope}. */
export class FrameDecodeError extends Error {
  override readonly name = "FrameDecodeError";
  constructor(
    message: string,
    /** The raw line that failed to decode. */
    readonly line: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Encode an envelope as a single newline-delimited JSON frame. Used by both
 * the WebSocket relay and the local IPC socket. The message is validated first
 * so a malformed envelope never reaches the wire.
 */
export function encodeFrame(msg: Envelope): string {
  const parsed = envelopeSchema.parse(msg);
  return `${JSON.stringify(parsed)}\n`;
}

/**
 * Decode a single frame (one NDJSON line, with or without its trailing
 * newline) into a validated {@link Envelope}. Throws {@link FrameDecodeError}
 * on malformed JSON or an envelope that fails schema validation.
 */
export function decodeFrame(line: string): Envelope {
  const trimmed = line.replace(/\r?\n$/, "");
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (cause) {
    throw new FrameDecodeError("frame is not valid JSON", line, { cause });
  }
  const result = envelopeSchema.safeParse(json);
  if (!result.success) {
    throw new FrameDecodeError(
      `frame failed schema validation: ${result.error.message}`,
      line,
      { cause: result.error },
    );
  }
  return result.data;
}

/**
 * Create a stateful decoder for a byte/string stream that may deliver frames
 * split across chunks or batched together. Feed it whatever arrives off the
 * socket; it returns the complete envelopes decoded so far and retains any
 * trailing partial line for the next call.
 *
 * @example
 * const decode = createFrameDecoder();
 * socket.on("data", (chunk) => {
 *   for (const env of decode(chunk.toString("utf8"))) handle(env);
 * });
 */
export function createFrameDecoder(): (chunk: string) => Envelope[] {
  let buffer = "";
  return (chunk: string): Envelope[] => {
    buffer += chunk;
    const out: Envelope[] = [];
    let newlineAt = buffer.indexOf("\n");
    while (newlineAt !== -1) {
      const line = buffer.slice(0, newlineAt);
      buffer = buffer.slice(newlineAt + 1);
      if (line.trim().length > 0) {
        out.push(decodeFrame(line));
      }
      newlineAt = buffer.indexOf("\n");
    }
    return out;
  };
}
