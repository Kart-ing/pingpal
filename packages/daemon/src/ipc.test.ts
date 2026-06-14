import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PING_CHARS, type Peer, type Ping } from "@pingpal/protocol";
import { Daemon } from "./daemon.js";
import { resolvePaths, type PingPalPaths } from "./paths.js";
import { resolveConfig, type ResolvedConfig } from "./config.js";
import { sendRequest, IpcClientError } from "./ipc-client.js";
import type {
  RelayCallbacks,
  RelayTransport,
} from "./relay-client.js";

/**
 * A stand-in relay transport: the daemon drives it exactly like the real one,
 * and the test drives its callbacks to simulate inbound presence/pings, while
 * inspecting what the daemon sent outbound.
 */
class FakeRelay implements RelayTransport {
  connected = false;
  readonly sent: Ping[] = [];
  constructor(
    _config: ResolvedConfig,
    readonly cb: RelayCallbacks,
  ) {}
  start(): void {
    this.connected = true;
    this.cb.onConnected();
  }
  stop(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }
  sendPing(ping: Ping): boolean {
    if (!this.connected) return false;
    this.sent.push(ping);
    return true;
  }
}

const peer = (handle: string): Peer => ({
  handle,
  faceId: "fox",
  status: "online",
  lastSeen: 1000,
});

describe("daemon IPC round-trip (mocked relay)", () => {
  let home: string;
  let paths: PingPalPaths;
  let daemon: Daemon;
  let fake: FakeRelay;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pingpal-ipc-"));
    paths = resolvePaths(home);
    const config: ResolvedConfig = resolveConfig(
      { handle: "me", roomCode: "room-secret-1234", faceId: "fox", lanDiscovery: false },
      {},
    );
    daemon = new Daemon(config, paths, {
      relayFactory: (cfg, cb) => {
        fake = new FakeRelay(cfg, cb);
        return fake;
      },
      now: () => 1234,
    });
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    await rm(home, { recursive: true, force: true });
  });

  it("serves an empty presence roster before any relay frames", async () => {
    const res = await sendRequest(paths, "getPresence");
    expect(res.peers).toEqual([]);
  });

  it("reflects relay presence over IPC", async () => {
    fake.cb.onPresence([peer("sarah"), peer("bob"), peer("me")]);
    const res = await sendRequest(paths, "getPresence");
    // self is filtered; roster is sorted by handle.
    expect(res.peers.map((p) => p.handle)).toEqual(["bob", "sarah"]);
    expect(res.peers.every((p) => p.via === "relay")).toBe(true);
  });

  it("sends a directed ping out via the relay and stamps the sender", async () => {
    fake.cb.onPresence([peer("sarah")]);
    const res = await sendRequest(paths, "sendPing", { to: "@sarah", text: "on it" });
    expect(res.delivered).toBe(true);
    expect(res.via).toBe("relay");
    expect(fake.sent).toHaveLength(1);
    const out = fake.sent[0]!;
    expect(out.from).toBe("me");
    expect(out.to).toBe("sarah");
    expect(out.text).toBe("on it");
    expect(out.ts).toBe(1234);
  });

  it("treats an omitted/empty target as a room broadcast", async () => {
    const res = await sendRequest(paths, "sendPing", { to: null, text: "standup in 5" });
    expect(res.delivered).toBe(true);
    expect(fake.sent[0]!.to).toBeNull();
  });

  it("rejects text over the 90-char cap with a friendly error", async () => {
    const tooLong = "x".repeat(MAX_PING_CHARS + 1);
    await expect(
      sendRequest(paths, "sendPing", { to: null, text: tooLong }),
    ).rejects.toMatchObject({ code: "text_too_long" });
    expect(fake.sent).toHaveLength(0);
  });

  it("buffers inbound pings and marks them read on demand", async () => {
    const incoming: Ping = {
      type: "ping",
      id: "ping-abc",
      from: "sarah",
      to: "me",
      text: "ship it when green",
      ts: 50,
    };
    fake.cb.onPing(incoming);
    // A duplicate id (e.g. also seen via LAN) must not double-buffer.
    fake.cb.onPing(incoming);

    const first = await sendRequest(paths, "getPings");
    expect(first.pings).toHaveLength(1);
    expect(first.pings[0]!.read).toBe(false);
    expect(first.pings[0]!.via).toBe("relay");

    // The unread flag file (a best-effort mirror the hook polls) lands shortly
    // after the in-memory buffer — wait for it rather than racing the write.
    await expect
      .poll(async () => (await readFile(paths.unread, "utf8").catch(() => "")).trim())
      .toBe("1");

    const status = await sendRequest(paths, "status");
    expect(status.unread).toBe(1);

    const marked = await sendRequest(paths, "getPings", { markRead: true });
    expect(marked.pings).toHaveLength(1);

    const afterStatus = await sendRequest(paths, "status");
    expect(afterStatus.unread).toBe(0);
    // The flag file is removed shortly after the buffer is marked read.
    await expect
      .poll(() => readFile(paths.unread, "utf8").then(() => false).catch(() => true))
      .toBe(true);
  });

  it("reports daemon status over IPC", async () => {
    const status = await sendRequest(paths, "status");
    expect(status.handle).toBe("me");
    expect(status.relayConnected).toBe(true);
    expect(status.lanEnabled).toBe(false);
  });

  it("errors clearly when the daemon socket is gone", async () => {
    await daemon.stop();
    await expect(sendRequest(paths, "status")).rejects.toBeInstanceOf(
      IpcClientError,
    );
  });
});
