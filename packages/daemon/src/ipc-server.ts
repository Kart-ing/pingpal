import { createServer, type Server, type Socket, type AddressInfo } from "node:net";
import { rm, writeFile } from "node:fs/promises";
import {
  createLineSplitter,
  encodeIpc,
  ipcRequestSchema,
  type IpcRequest,
  type IpcResponse,
} from "./ipc-protocol.js";
import type { PingPalPaths } from "./paths.js";

/** Handles a validated request, producing the response to send back. */
export type IpcHandler = (req: IpcRequest) => Promise<IpcResponse>;

/** How the IPC server ended up listening, for `status`/logging. */
export interface IpcAddress {
  /** Unix socket path, when listening on a domain socket. */
  socketPath?: string;
  /** TCP port, when on the Windows/localhost fallback. */
  port?: number;
}

/**
 * Local IPC server the hook and MCP server connect to. On POSIX it binds a Unix
 * domain socket at `~/.pingpal/daemon.sock`; on Windows (no AF_UNIX) it falls
 * back to a localhost TCP port written to `~/.pingpal/daemon.port` so clients
 * can find it.
 *
 * The framing is NDJSON: one {@link IpcRequest} per line in, one
 * {@link IpcResponse} per line out. Malformed lines get a structured error
 * response rather than dropping the connection.
 */
export class IpcServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private address: IpcAddress = {};

  constructor(
    private readonly paths: PingPalPaths,
    private readonly handler: IpcHandler,
  ) {}

  /** Bind the socket and start accepting clients. Resolves with the address. */
  async start(): Promise<IpcAddress> {
    const useTcp = process.platform === "win32";
    // A stale socket file from a crash would make bind fail with EADDRINUSE.
    if (!useTcp) await rm(this.paths.sock, { force: true });

    const server = createServer((socket) => this.onConnection(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      const onListening = (): void => {
        server.off("error", reject);
        resolve();
      };
      if (useTcp) server.listen(0, "127.0.0.1", onListening);
      else server.listen(this.paths.sock, onListening);
    });

    if (useTcp) {
      const addr = server.address() as AddressInfo | null;
      const port = addr ? addr.port : 0;
      this.address = { port };
      await writeFile(this.paths.portFile, String(port), "utf8");
    } else {
      this.address = { socketPath: this.paths.sock };
    }
    return this.address;
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    const split = createLineSplitter();

    socket.on("data", (chunk: string) => {
      for (const line of split(chunk)) {
        void this.dispatch(socket, line);
      }
    });
    socket.on("error", () => {
      /* client vanished mid-write; 'close' cleans up */
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
    });
  }

  private async dispatch(socket: Socket, line: string): Promise<void> {
    let response: IpcResponse;
    let requestId = "0";
    try {
      const json: unknown = JSON.parse(line);
      if (json && typeof json === "object" && "id" in json) {
        requestId = String((json as { id: unknown }).id ?? "0");
      }
      const parsed = ipcRequestSchema.safeParse(json);
      if (!parsed.success) {
        response = {
          id: requestId,
          ok: false,
          error: {
            code: "bad_request",
            message:
              parsed.error.issues[0]?.message ?? "request failed validation",
          },
        };
      } else {
        response = await this.handler(parsed.data);
      }
    } catch {
      response = {
        id: requestId,
        ok: false,
        error: { code: "bad_request", message: "request is not valid JSON" },
      };
    }
    if (!socket.destroyed) socket.write(encodeIpc(response));
  }

  /** Close the server, drop clients, and remove the socket/port files. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.address.socketPath) {
      await rm(this.paths.sock, { force: true }).catch(() => {});
    }
    if (this.address.port !== undefined) {
      await rm(this.paths.portFile, { force: true }).catch(() => {});
    }
    this.address = {};
  }
}
