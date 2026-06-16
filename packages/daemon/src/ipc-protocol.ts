import { z } from "zod";
import {
  handleSchema,
  newId,
  pingSchema,
  statusSchema,
} from "@pingpal/protocol";

/** Generate a unique id for an IPC request (for matching responses). */
export function newRequestId(): string {
  return newId("rpc");
}

/**
 * The local IPC protocol spoken over `~/.pingpal/daemon.sock` (or the Windows
 * TCP fallback). It is deliberately separate from the wire protocol in
 * `@pingpal/protocol`: that one models room traffic (hello/presence/ping/…),
 * whereas this one is a tiny request/response RPC between the daemon and its
 * in-process-momentary clients — the Claude Code hook and the MCP server.
 *
 * Framing is the same NDJSON style used everywhere else: one JSON object per
 * line. See {@link createLineSplitter}.
 */

/** How a peer is currently reachable for delivery. */
export const reachabilitySchema = z.enum(["lan", "relay", "both"]);
export type Reachability = z.infer<typeof reachabilitySchema>;

/**
 * A peer in the *merged* roster (LAN-discovered ∪ relay-reported, deduped by
 * handle). `via` records how we'd actually deliver to them.
 */
export const mergedPeerSchema = z.object({
  handle: handleSchema,
  faceId: z.string(),
  status: statusSchema,
  lastSeen: z.number().int().nonnegative(),
  via: reachabilitySchema,
});
export type MergedPeer = z.infer<typeof mergedPeerSchema>;

/** A buffered ping plus local metadata (read flag, transport, direction). */
export const bufferedPingSchema = pingSchema.extend({
  read: z.boolean(),
  /** Which transport the ping arrived on (or was sent over). */
  via: z.enum(["lan", "relay"]),
  /** True for pings WE sent (kept for the chat view; ignored by the hook). */
  outbound: z.boolean().optional(),
});
export type BufferedPing = z.infer<typeof bufferedPingSchema>;

// ---------------------------------------------------------------------------
// Requests (client → daemon)
// ---------------------------------------------------------------------------

const baseRequest = z.object({ id: z.string().min(1) });

export const getPresenceRequestSchema = baseRequest.extend({
  method: z.literal("getPresence"),
});

export const getPingsRequestSchema = baseRequest.extend({
  method: z.literal("getPings"),
  params: z
    .object({ markRead: z.boolean().optional() })
    .optional()
    .default({}),
});

export const sendPingRequestSchema = baseRequest.extend({
  method: z.literal("sendPing"),
  params: z.object({
    /** Target handle (with or without a leading `@`), or null/absent = broadcast. */
    to: z.string().nullish(),
    text: z.string(),
  }),
});

export const statusRequestSchema = baseRequest.extend({
  method: z.literal("status"),
});

export const sendFileRequestSchema = baseRequest.extend({
  method: z.literal("sendFile"),
  params: z.object({
    /** Absolute or relative path to the file on disk. */
    path: z.string().min(1),
    /** Optional target handle (like sendPing). Omit to broadcast. */
    to: z.string().nullish(),
  }),
});

export const listFilesRequestSchema = baseRequest.extend({
  method: z.literal("listFiles"),
});

/** Every request the daemon understands. */
export const ipcRequestSchema = z.discriminatedUnion("method", [
  getPresenceRequestSchema,
  getPingsRequestSchema,
  sendPingRequestSchema,
  statusRequestSchema,
  sendFileRequestSchema,
  listFilesRequestSchema,
]);
export type IpcRequest = z.infer<typeof ipcRequestSchema>;
export type IpcMethod = IpcRequest["method"];

// ---------------------------------------------------------------------------
// Responses (daemon → client)
// ---------------------------------------------------------------------------

/** Result payloads keyed by method, for precise typing of `sendRequest`. */
export interface IpcResults {
  getPresence: { peers: MergedPeer[] };
  getPings: { pings: BufferedPing[] };
  sendPing: { id: string; via: Reachability | "none"; delivered: boolean };
  sendFile: {
    blobId: string;
    name: string;
    size: number;
    via: "relay";
    delivered: boolean;
  };
  listFiles: Array<{
    blobId: string;
    name: string;
    size: number;
    from: string;
    savedAt: number;
    path: string;
  }>;
  status: {
    handle: string;
    roomCode: string;
    relayUrl: string;
    relayConnected: boolean;
    lanEnabled: boolean;
    lanPeerCount: number;
    relayPeerCount: number;
    unread: number;
  };
}

export type IpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

/**
 * Split a possibly-chunked, possibly-batched UTF-8 stream into whole lines,
 * retaining any trailing partial line for the next call. Generic counterpart to
 * `createFrameDecoder` in `@pingpal/protocol`, but yielding raw strings so each
 * side can parse with its own schema.
 */
export function createLineSplitter(): (chunk: string) => string[] {
  let buffer = "";
  return (chunk: string): string[] => {
    buffer += chunk;
    const lines: string[] = [];
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) lines.push(line);
      nl = buffer.indexOf("\n");
    }
    return lines;
  };
}

/** Encode any JSON-serialisable IPC message as one NDJSON frame. */
export function encodeIpc(msg: IpcRequest | IpcResponse): string {
  return `${JSON.stringify(msg)}\n`;
}
