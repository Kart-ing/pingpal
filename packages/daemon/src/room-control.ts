import WebSocket from "ws";
import {
  createFrameDecoder,
  encodeFrame,
  newId,
  type CreateRoom,
  type ResolveCode,
} from "@pingpal/protocol";

/**
 * One-shot relay control calls used by the CLI, independent of the daemon: a
 * room is *minted* (`start-room`) and a code is *resolved* (`join`) before the
 * daemon ever runs, so these open a throwaway WebSocket, do a single
 * request/response, and close. They are intentionally tiny and dependency-free
 * beyond `ws` + the protocol package.
 */

const DEFAULT_TIMEOUT_MS = 8000;

export interface RoomControlOptions {
  /** Override the connect+round-trip timeout (ms). */
  timeoutMs?: number;
  /** Injectable socket factory (tests). Defaults to the real `ws`. */
  createSocket?: (url: string) => WebSocket;
}

/** A minted room: the secret roomId plus the short shareable code. */
export interface MintedRoom {
  roomId: string;
  code: string;
}

/** Raised when a control call can't reach/complete against the relay. */
export class RoomControlError extends Error {
  override readonly name = "RoomControlError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Ask the relay to mint a fresh ephemeral room. Resolves with `{roomId, code}`;
 * rejects with {@link RoomControlError} if the relay is unreachable or silent.
 */
export function mintRoom(
  relayUrl: string,
  opts: RoomControlOptions = {},
): Promise<MintedRoom> {
  const nonce = newId("mint");
  const req: CreateRoom = { type: "create_room", nonce };
  return oneShot(relayUrl, req, nonce, opts, (env) => {
    if (env.type === "room_created" && env.nonce === nonce) {
      return { roomId: env.roomId, code: env.code };
    }
    return undefined;
  });
}

/**
 * Resolve a short join code to its roomId via the relay. Resolves with the
 * roomId, or `null` if the relay has no such (live) room. Rejects only on a
 * transport problem (unreachable/timeout), not on a clean "not found".
 */
export function resolveCode(
  relayUrl: string,
  code: string,
  opts: RoomControlOptions = {},
): Promise<string | null> {
  const nonce = newId("resolve");
  const req: ResolveCode = { type: "resolve_code", nonce, code };
  return oneShot(relayUrl, req, nonce, opts, (env) => {
    if (env.type === "code_resolved" && env.nonce === nonce) {
      // Wrap so the matcher can distinguish "matched, value null" from "no match yet".
      return { value: env.roomId };
    }
    return undefined;
  }).then((r) => r.value);
}

/**
 * Open a socket, send one request, await the first frame the `match` fn accepts,
 * then close. Generic over the reply shape so both calls share the plumbing.
 */
function oneShot<T>(
  relayUrl: string,
  request: CreateRoom | ResolveCode,
  _nonce: string,
  opts: RoomControlOptions,
  match: (env: import("@pingpal/protocol").Envelope) => T | undefined,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const make = opts.createSocket ?? ((url: string) => new WebSocket(url));
  return new Promise<T>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = make(relayUrl);
    } catch (err) {
      reject(new RoomControlError("connect_failed", `could not open ${relayUrl}: ${String(err)}`));
      return;
    }
    const decode = createFrameDecoder();
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new RoomControlError("timeout", `relay did not respond within ${timeoutMs}ms`)));
    }, timeoutMs);

    ws.on("open", () => {
      try {
        ws.send(encodeFrame(request));
      } catch (err) {
        finish(() => reject(new RoomControlError("send_failed", String(err))));
      }
    });
    ws.on("message", (data: WebSocket.RawData) => {
      for (const env of decode(data.toString())) {
        if (env.type === "error") {
          finish(() => reject(new RoomControlError(env.code, env.message)));
          return;
        }
        const matched = match(env);
        if (matched !== undefined) {
          finish(() => resolve(matched));
          return;
        }
      }
    });
    ws.on("error", (err: Error) => {
      finish(() => reject(new RoomControlError("socket_error", err.message)));
    });
    ws.on("close", () => {
      finish(() => reject(new RoomControlError("closed", "relay closed the connection before replying")));
    });
  });
}
