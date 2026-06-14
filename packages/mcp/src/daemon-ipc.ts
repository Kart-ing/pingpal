/**
 * A tiny, dependency-light client for the pingpald local IPC socket.
 *
 * The MCP server is a momentary, per-session process: Claude Code launches it
 * over stdio, it makes a request or two, and it exits. So it can't hold the
 * live relay/LAN connections itself — the daemon does. This module opens a
 * fresh connection to the daemon's Unix socket (`~/.pingpal/daemon.sock`, or
 * the Windows TCP fallback advertised in `~/.pingpal/daemon.port`), makes one
 * NDJSON request/response round-trip, and closes.
 *
 * The request/response shapes mirror `@pingpal/daemon`'s `ipc-protocol.ts`
 * (the source of truth). We intentionally re-declare the small slice we need
 * rather than depend on `@pingpal/daemon`, so the MCP server stays lightweight
 * and doesn't drag the relay/mDNS runtime (ws, bonjour-service) into every
 * Claude Code session. Framing is the same newline-delimited JSON used
 * everywhere else in PingPal.
 */
import { connect, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Ping, Status } from "@pingpal/protocol";

/** How a peer is currently reachable for delivery (mirrors the daemon). */
export type Reachability = "lan" | "relay" | "both";

/** One peer in the daemon's merged (LAN ∪ relay) roster. */
export interface MergedPeer {
  handle: string;
  faceId: string;
  status: Status;
  lastSeen: number;
  via: Reachability;
}

/** A received ping plus its local read flag and arrival transport. */
export interface BufferedPing extends Ping {
  read: boolean;
  via: "lan" | "relay";
}

/** Result of a `sendPing` request. `via: "none"` means it couldn't be sent. */
export interface SendPingResult {
  id: string;
  via: Reachability | "none";
  delivered: boolean;
}

/** The methods the daemon exposes and their result payloads. */
export interface DaemonResults {
  getPresence: { peers: MergedPeer[] };
  getPings: { pings: BufferedPing[] };
  sendPing: SendPingResult;
}

type Method = keyof DaemonResults;

/** Resolved IPC endpoint locations under the PingPal home directory. */
export interface DaemonEndpoint {
  /** Unix domain socket the daemon listens on (POSIX). */
  sock: string;
  /** File holding the TCP port for the Windows/localhost fallback. */
  portFile: string;
}

/** Resolve the IPC endpoint from `PINGPAL_HOME` or `~/.pingpal`. */
export function resolveEndpoint(home?: string): DaemonEndpoint {
  const base = home ?? process.env.PINGPAL_HOME ?? join(homedir(), ".pingpal");
  return { sock: join(base, "daemon.sock"), portFile: join(base, "daemon.port") };
}

/**
 * Raised when the daemon can't be reached or replies with a structured error.
 * `code === "unreachable"` (or `"timeout"`) is what the MCP tools turn into the
 * friendly "daemon not running" message.
 */
export class DaemonError extends Error {
  override readonly name = "DaemonError";
  constructor(
    message: string,
    /** Stable code: a daemon error code, or `unreachable`/`timeout`. */
    readonly code: string,
  ) {
    super(message);
  }
}

/** True when the failure means "the daemon isn't up", not "the call failed". */
export function isUnreachable(err: unknown): boolean {
  return (
    err instanceof DaemonError &&
    (err.code === "unreachable" || err.code === "timeout")
  );
}

/** What the MCP tools call. Abstracted so tests can supply a fake. */
export interface DaemonClient {
  getPresence(): Promise<DaemonResults["getPresence"]>;
  getPings(markRead: boolean): Promise<DaemonResults["getPings"]>;
  sendPing(
    to: string | undefined,
    text: string,
  ): Promise<DaemonResults["sendPing"]>;
}

interface IpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

let requestCounter = 0;
function nextId(): string {
  requestCounter += 1;
  return `mcp-${process.pid}-${requestCounter}`;
}

/** Split a possibly-chunked NDJSON stream into whole lines. */
function createLineSplitter(): (chunk: string) => string[] {
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

async function openSocket(endpoint: DaemonEndpoint): Promise<Socket> {
  if (process.platform === "win32") {
    let port: number;
    try {
      port = Number((await readFile(endpoint.portFile, "utf8")).trim());
    } catch {
      throw new DaemonError("daemon is not running", "unreachable");
    }
    if (!Number.isInteger(port) || port <= 0) {
      throw new DaemonError("daemon port file is invalid", "unreachable");
    }
    return await dial({ port, host: "127.0.0.1" });
  }
  return await dial({ path: endpoint.sock });
}

function dial(
  target: { path: string } | { port: number; host: string },
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(target as never);
    const onError = (): void =>
      reject(new DaemonError("daemon is not running", "unreachable"));
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

/**
 * Make one IPC request and resolve with the typed result. Opens a fresh
 * connection (the daemon is local; these are momentary) and times out so a
 * wedged daemon can't hang the Claude Code session.
 */
async function request<M extends Method>(
  endpoint: DaemonEndpoint,
  method: M,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<DaemonResults[M]> {
  const socket = await openSocket(endpoint);
  const id = nextId();
  const frame = `${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`;

  return await new Promise<DaemonResults[M]>((resolve, reject) => {
    const split = createLineSplitter();
    let settled = false;
    const fail = (err: DaemonError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const done = (value: DaemonResults[M]): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const timer = setTimeout(
      () => fail(new DaemonError("daemon timed out", "timeout")),
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
        if (resp.ok) done(resp.result as DaemonResults[M]);
        else
          fail(
            new DaemonError(
              resp.error?.message ?? "daemon returned an error",
              resp.error?.code ?? "error",
            ),
          );
        return;
      }
    });
    socket.on("error", () =>
      fail(new DaemonError("daemon connection failed", "unreachable")),
    );
    socket.on("close", () =>
      fail(new DaemonError("daemon closed the connection", "unreachable")),
    );

    socket.write(frame);
  });
}

/**
 * The real {@link DaemonClient}: each method is one IPC round-trip to pingpald.
 * Pass an explicit endpoint in tests; otherwise it resolves from the
 * environment.
 */
export function createDaemonClient(
  endpoint: DaemonEndpoint = resolveEndpoint(),
  timeoutMs = 3000,
): DaemonClient {
  return {
    getPresence: () => request(endpoint, "getPresence", undefined, timeoutMs),
    getPings: (markRead) =>
      request(endpoint, "getPings", { markRead }, timeoutMs),
    sendPing: (to, text) =>
      request(
        endpoint,
        "sendPing",
        { to: to ?? null, text },
        timeoutMs,
      ),
  };
}
