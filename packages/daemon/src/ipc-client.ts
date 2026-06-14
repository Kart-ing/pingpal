import { connect, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import {
  createLineSplitter,
  encodeIpc,
  newRequestId,
  type IpcMethod,
  type IpcRequest,
  type IpcResponse,
  type IpcResults,
} from "./ipc-protocol.js";
import type { PingPalPaths } from "./paths.js";

/** Raised when the daemon isn't reachable or returns a structured error. */
export class IpcClientError extends Error {
  override readonly name = "IpcClientError";
  constructor(
    message: string,
    /** Stable error code from the daemon, or `unreachable`/`timeout`. */
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Connect to the daemon's IPC endpoint (Unix socket, or the Windows TCP
 * fallback discovered via `daemon.port`). Returns the connected socket; callers
 * use {@link sendRequest} to make a single round-trip.
 */
async function openSocket(paths: PingPalPaths): Promise<Socket> {
  if (process.platform === "win32") {
    let port: number;
    try {
      port = Number((await readFile(paths.portFile, "utf8")).trim());
    } catch {
      throw new IpcClientError("daemon is not running", "unreachable");
    }
    if (!Number.isInteger(port) || port <= 0) {
      throw new IpcClientError("daemon port file is invalid", "unreachable");
    }
    return await dial({ port, host: "127.0.0.1" });
  }
  return await dial({ path: paths.sock });
}

function dial(target: { path: string } | { port: number; host: string }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(target as never);
    const onError = (): void =>
      reject(new IpcClientError("daemon is not running", "unreachable"));
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

/**
 * Make one IPC request and resolve with the typed result. Opens a fresh
 * connection per call (the daemon is local and these are momentary), and times
 * out so a wedged daemon can't hang the hook or MCP server.
 */
export async function sendRequest<M extends IpcMethod>(
  paths: PingPalPaths,
  method: M,
  params?: Extract<IpcRequest, { method: M }> extends { params: infer P }
    ? P
    : undefined,
  timeoutMs = 3000,
): Promise<IpcResults[M]> {
  const socket = await openSocket(paths);
  const id = newRequestId();
  const request = { id, method, ...(params ? { params } : {}) } as IpcRequest;

  return await new Promise<IpcResults[M]>((resolve, reject) => {
    const split = createLineSplitter();
    const fail = (err: IpcClientError): void => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new IpcClientError("daemon timed out", "timeout")),
      timeoutMs,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.destroy();
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of split(chunk)) {
        let resp: IpcResponse;
        try {
          resp = JSON.parse(line) as IpcResponse;
        } catch {
          continue;
        }
        if (resp.id !== id) continue;
        cleanup();
        if (resp.ok) resolve(resp.result as IpcResults[M]);
        else reject(new IpcClientError(resp.error.message, resp.error.code));
        return;
      }
    });
    socket.on("error", () =>
      fail(new IpcClientError("daemon connection failed", "unreachable")),
    );
    socket.on("close", () =>
      fail(new IpcClientError("daemon closed the connection", "unreachable")),
    );

    socket.write(encodeIpc(request));
  });
}
