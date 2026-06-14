import { describe, expect, it } from "vitest";

import { MAX_PING_CHARS } from "@pingpal/protocol";
import {
  listPings,
  normalizeTarget,
  sendPing,
  whosOnline,
  type ToolResult,
} from "./tools.js";
import type {
  BufferedPing,
  DaemonClient,
  MergedPeer,
  SendPingResult,
} from "./daemon-ipc.js";
import { DaemonError } from "./daemon-ipc.js";

/**
 * A fake daemon client whose responses + recorded calls the tests inspect.
 * Recording wraps the (possibly overridden) implementations, so every call is
 * captured regardless of what `over` returns.
 */
function fakeClient(over: Partial<DaemonClient> = {}): DaemonClient & {
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  const impl: DaemonClient = {
    getPresence: async () => ({ peers: [] }),
    getPings: async () => ({ pings: [] }),
    sendPing: async () =>
      ({ id: "p1", via: "relay", delivered: true }) satisfies SendPingResult,
    ...over,
  };
  return {
    calls,
    getPresence: (...a) => {
      calls.push({ method: "getPresence", args: a });
      return impl.getPresence();
    },
    getPings: (...a) => {
      calls.push({ method: "getPings", args: a });
      return impl.getPings(...a);
    },
    sendPing: (...a) => {
      calls.push({ method: "sendPing", args: a });
      return impl.sendPing(...a);
    },
  };
}

const onlyText = (r: ToolResult): string =>
  r.content.map((c) => c.text).join("\n");

const peer = (over: Partial<MergedPeer> = {}): MergedPeer => ({
  handle: "sarah",
  faceId: "fox",
  status: "online",
  lastSeen: 1000,
  via: "relay",
  ...over,
});

const ping = (over: Partial<BufferedPing> = {}): BufferedPing => ({
  type: "ping",
  id: "ping-1",
  from: "sarah",
  to: null,
  text: "ship it when green",
  ts: 1000,
  read: false,
  via: "relay",
  ...over,
});

describe("whos_online", () => {
  it("renders a roster and returns structured peers", async () => {
    const client = fakeClient({
      getPresence: async () => ({
        peers: [peer(), peer({ handle: "li", status: "idle", via: "lan" })],
      }),
    });
    const res = await whosOnline(client);
    expect(onlyText(res)).toContain("sarah");
    expect(onlyText(res)).toContain("li");
    expect(res.structuredContent).toEqual({
      count: 2,
      peers: [
        { handle: "sarah", status: "online", faceId: "fox", via: "relay", lastSeen: 1000 },
        { handle: "li", status: "idle", faceId: "fox", via: "lan", lastSeen: 1000 },
      ],
    });
  });

  it("handles an empty room gracefully", async () => {
    const res = await whosOnline(fakeClient());
    expect(res.structuredContent).toEqual({ count: 0, peers: [] });
    expect(res.isError).toBeUndefined();
  });
});

describe("list_pings", () => {
  it("marks read by default and renders pings + structured data", async () => {
    const client = fakeClient({
      getPings: async () => ({ pings: [ping(), ping({ id: "ping-2", to: "me", read: true })] }),
    });
    const res = await listPings(client, {}, 100_000);
    expect(client.calls).toEqual([{ method: "getPings", args: [true] }]);
    const body = onlyText(res);
    expect(body).toContain("2 pings (marked read)");
    expect(body).toContain("@sarah");
    expect(body).toContain("ship it when green");
    const structured = res.structuredContent as { count: number; pings: unknown[] };
    expect(structured.count).toBe(2);
    expect(structured.pings).toHaveLength(2);
  });

  it("passes markRead:false through to the daemon", async () => {
    const client = fakeClient();
    await listPings(client, { markRead: false });
    expect(client.calls).toEqual([{ method: "getPings", args: [false] }]);
  });

  it("reports an empty inbox", async () => {
    const res = await listPings(fakeClient(), {});
    expect(onlyText(res)).toContain("inbox is quiet");
    expect(res.structuredContent).toEqual({ count: 0, pings: [] });
  });
});

describe("send_ping", () => {
  it("sends a broadcast when `to` is omitted", async () => {
    const client = fakeClient();
    const res = await sendPing(client, { text: "hello room" });
    expect(client.calls).toEqual([
      { method: "sendPing", args: [undefined, "hello room"] },
    ]);
    expect(onlyText(res)).toContain("Sent to the room via relay");
    expect(res.isError).toBeUndefined();
  });

  it("normalizes a leading @ in the target", async () => {
    const client = fakeClient();
    await sendPing(client, { to: "@sarah", text: "on it" });
    expect(client.calls[0]?.args).toEqual(["sarah", "on it"]);
  });

  it("rejects text over the 90-char limit without calling the daemon", async () => {
    const client = fakeClient();
    const tooLong = "x".repeat(MAX_PING_CHARS + 1);
    const res = await sendPing(client, { text: tooLong });
    expect(res.isError).toBe(true);
    expect(onlyText(res)).toContain("over the 90-char limit");
    expect(client.calls).toHaveLength(0);
  });

  it("accepts text at exactly the 90-char boundary", async () => {
    const client = fakeClient();
    const res = await sendPing(client, { text: "y".repeat(MAX_PING_CHARS) });
    expect(res.isError).toBeUndefined();
    expect(client.calls).toHaveLength(1);
  });

  it("notes when a ping could not be delivered", async () => {
    const client = fakeClient({
      sendPing: async () => ({ id: "p9", via: "none", delivered: false }),
    });
    const res = await sendPing(client, { to: "ghost", text: "anyone?" });
    expect(onlyText(res)).toContain("no one is reachable");
  });
});

describe("normalizeTarget", () => {
  it("strips @, trims, and maps empty to broadcast", () => {
    expect(normalizeTarget(undefined)).toBeUndefined();
    expect(normalizeTarget("  @sarah  ")).toBe("sarah");
    expect(normalizeTarget("li")).toBe("li");
    expect(normalizeTarget("@")).toBeUndefined();
    expect(normalizeTarget("   ")).toBeUndefined();
  });
});

describe("daemon unreachable", () => {
  const down = (): never => {
    throw new DaemonError("daemon is not running", "unreachable");
  };
  it("every tool returns a friendly message instead of throwing", async () => {
    const client: DaemonClient = {
      getPresence: async () => down(),
      getPings: async () => down(),
      sendPing: async () => down(),
    };
    for (const res of [
      await whosOnline(client),
      await listPings(client, {}),
      await sendPing(client, { text: "hi" }),
    ]) {
      expect(onlyText(res)).toContain("daemon not running");
      expect(res.isError).toBeUndefined();
    }
  });
});
