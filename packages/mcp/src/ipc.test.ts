import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDaemonClient,
  isUnreachable,
  resolveEndpoint,
  type DaemonEndpoint,
} from "./daemon-ipc.js";

/**
 * A minimal stand-in for pingpald: it accepts NDJSON requests on a Unix socket,
 * records them, and replies with whatever the test queued. This lets us assert
 * the exact request shape the MCP client puts on the wire, and the response
 * shape it parses back.
 */
class FakeDaemon {
  private server: Server | null = null;
  readonly requests: Array<{ id: string; method: string; params?: unknown }> = [];
  reply: (req: { id: string; method: string }) => Record<string, unknown> = () => ({});

  constructor(private readonly endpoint: DaemonEndpoint) {}

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((socket: Socket) => {
        socket.setEncoding("utf8");
        let buffer = "";
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          let nl = buffer.indexOf("\n");
          while (nl !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf("\n");
            if (!line) continue;
            const req = JSON.parse(line) as { id: string; method: string };
            this.requests.push(req);
            const result = this.reply(req);
            socket.write(`${JSON.stringify({ id: req.id, ok: true, result })}\n`);
          }
        });
      });
      this.server.listen(this.endpoint.sock, () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

const onPosix = process.platform !== "win32";

describe.skipIf(!onPosix)("daemon IPC client round-trip", () => {
  let home: string;
  let endpoint: DaemonEndpoint;
  let daemon: FakeDaemon;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pingpal-mcp-"));
    endpoint = resolveEndpoint(home);
    daemon = new FakeDaemon(endpoint);
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    await rm(home, { recursive: true, force: true });
  });

  it("getPresence sends the right method and parses the roster", async () => {
    daemon.reply = () => ({
      peers: [{ handle: "sarah", faceId: "fox", status: "online", lastSeen: 9, via: "relay" }],
    });
    const client = createDaemonClient(endpoint);
    const res = await client.getPresence();
    expect(daemon.requests[0]?.method).toBe("getPresence");
    expect(res.peers[0]?.handle).toBe("sarah");
  });

  it("getPings forwards markRead as a param and parses pings", async () => {
    daemon.reply = () => ({
      pings: [
        {
          type: "ping",
          id: "p1",
          from: "li",
          to: null,
          text: "hi",
          ts: 1,
          read: false,
          via: "lan",
        },
      ],
    });
    const client = createDaemonClient(endpoint);
    const res = await client.getPings(false);
    expect(daemon.requests[0]).toMatchObject({
      method: "getPings",
      params: { markRead: false },
    });
    expect(res.pings[0]?.from).toBe("li");
  });

  it("sendPing forwards {to, text} and returns the ack", async () => {
    daemon.reply = () => ({ id: "x", via: "both", delivered: true });
    const client = createDaemonClient(endpoint);
    const res = await client.sendPing("sarah", "yo");
    expect(daemon.requests[0]).toMatchObject({
      method: "sendPing",
      params: { to: "sarah", text: "yo" },
    });
    expect(res).toEqual({ id: "x", via: "both", delivered: true });
  });

  it("sends to:null for a broadcast", async () => {
    daemon.reply = () => ({ id: "x", via: "relay", delivered: true });
    const client = createDaemonClient(endpoint);
    await client.sendPing(undefined, "all");
    expect(daemon.requests[0]).toMatchObject({ params: { to: null, text: "all" } });
  });

  it("flags an unreachable daemon when nothing is listening", async () => {
    const client = createDaemonClient(resolveEndpoint(await mkdtemp(join(tmpdir(), "pingpal-none-"))));
    await expect(client.getPresence()).rejects.toSatisfy(isUnreachable);
  });
});
