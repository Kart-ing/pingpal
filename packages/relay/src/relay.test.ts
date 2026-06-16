import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createFrameDecoder,
  encodeFrame,
  newId,
  type Envelope,
} from "@pingpal/protocol";
import { startRelay, type RelayHandle } from "./index.js";

/**
 * A tiny test client: connects, decodes NDJSON frames into an inbox, and lets a
 * test await the next envelope matching a predicate (with a timeout so a missing
 * message fails fast instead of hanging).
 */
class TestClient {
  private readonly ws: WebSocket;
  private readonly inbox: Envelope[] = [];
  private readonly waiters: Array<{
    pred: (e: Envelope) => boolean;
    resolve: (e: Envelope) => void;
  }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    const decode = createFrameDecoder();
    ws.on("message", (data) => {
      for (const env of decode(data.toString("utf8"))) {
        const idx = this.waiters.findIndex((w) => w.pred(env));
        if (idx !== -1) {
          const [w] = this.waiters.splice(idx, 1);
          w!.resolve(env);
        } else {
          this.inbox.push(env);
        }
      }
    });
  }

  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once("open", () => resolve(new TestClient(ws)));
      ws.once("error", reject);
    });
  }

  send(env: Envelope): void {
    this.ws.send(encodeFrame(env));
  }

  /** Send a raw string, bypassing protocol validation (to test relay defenses). */
  sendRaw(raw: string): void {
    this.ws.send(raw);
  }

  wait(pred: (e: Envelope) => boolean, timeoutMs = 1500): Promise<Envelope> {
    const existing = this.inbox.findIndex(pred);
    if (existing !== -1) {
      const [env] = this.inbox.splice(existing, 1);
      return Promise.resolve(env!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new Error("timed out waiting for matching frame"));
      }, timeoutMs);
      this.waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  }

  waitType<T extends Envelope["type"]>(
    type: T,
    extra: (e: Extract<Envelope, { type: T }>) => boolean = () => true,
  ): Promise<Extract<Envelope, { type: T }>> {
    return this.wait(
      (e) => e.type === type && extra(e as Extract<Envelope, { type: T }>),
    ) as Promise<Extract<Envelope, { type: T }>>;
  }

  close(): void {
    this.ws.close();
  }
}

const hello = (roomCode: string, handle: string): Envelope => ({
  type: "hello",
  roomCode,
  handle,
  faceId: "fox",
  clientVersion: "test",
});

describe("@pingpal/relay integration", () => {
  let relay: RelayHandle;

  afterEach(async () => {
    await relay?.close();
  });

  it("tracks presence, routes directed + broadcast pings, and acks", async () => {
    relay = await startRelay({ port: 0 });
    const room = "room-secret-1234";

    const alice = await TestClient.connect(relay.port);
    const bob = await TestClient.connect(relay.port);

    alice.send(hello(room, "alice"));
    bob.send(hello(room, "bob"));

    // Both clients should converge on a roster containing both handles.
    const rosterA = await alice.waitType("presence", (p) => p.peers.length === 2);
    const rosterB = await bob.waitType("presence", (p) => p.peers.length === 2);
    expect(rosterA.peers.map((p) => p.handle).sort()).toEqual(["alice", "bob"]);
    expect(rosterB.peers.every((p) => p.status === "online")).toBe(true);

    // Directed ping alice -> bob.
    const directedId = newId();
    alice.send({
      type: "ping",
      id: directedId,
      from: "alice",
      to: "bob",
      text: "ship it when green",
      ts: 1,
    });

    const got = await bob.waitType("ping", (p) => p.id === directedId);
    expect(got.from).toBe("alice");
    expect(got.to).toBe("bob");
    expect(got.text).toBe("ship it when green");

    const ackA = await alice.waitType("ack", (a) => a.id === directedId);
    expect(ackA.id).toBe(directedId);

    // Broadcast ping alice -> room (to: null). Bob receives it; alice does not.
    const bcastId = newId();
    alice.send({
      type: "ping",
      id: bcastId,
      from: "alice",
      to: null,
      text: "standup in 5",
      ts: 2,
    });

    const bcast = await bob.waitType("ping", (p) => p.id === bcastId);
    expect(bcast.to).toBeNull();
    expect(bcast.from).toBe("alice");
    await alice.waitType("ack", (a) => a.id === bcastId);

    alice.close();
    bob.close();
  });

  it("rejects oversized text and malformed frames with an error envelope", async () => {
    relay = await startRelay({ port: 0 });
    const room = "room-secret-5678";
    const client = await TestClient.connect(relay.port);
    client.send(hello(room, "carol"));
    await client.waitType("presence");

    // Oversized text (91 chars) sent raw to bypass client-side validation.
    const tooLong = "x".repeat(91);
    client.sendRaw(
      JSON.stringify({ type: "ping", id: "raw1", from: "carol", to: null, text: tooLong, ts: 3 }),
    );
    const err1 = await client.waitType("error");
    expect(err1.code).toBe("text_too_long");

    // Not even JSON.
    client.sendRaw("this is not json");
    const err2 = await client.waitType("error", (e) => e.code === "bad_frame");
    expect(err2.code).toBe("bad_frame");

    client.close();
  });

  it("broadcasts presence when a peer leaves", async () => {
    relay = await startRelay({ port: 0 });
    const room = "room-secret-9012";
    const alice = await TestClient.connect(relay.port);
    const bob = await TestClient.connect(relay.port);
    alice.send(hello(room, "alice"));
    bob.send(hello(room, "bob"));
    await alice.waitType("presence", (p) => p.peers.length === 2);

    bob.close();
    const after = await alice.waitType("presence", (p) => p.peers.length === 1);
    expect(after.peers[0]?.handle).toBe("alice");
  });

  // ---------------------------------------------------------------------------
  // Meet-style room control plane: create_room → resolve_code → join by roomId.
  // ---------------------------------------------------------------------------

  it("mints a room (create_room → room_created) and resolves its code", async () => {
    relay = await startRelay({ port: 0 });
    const host = await TestClient.connect(relay.port);

    host.send({ type: "create_room", nonce: "n1" });
    const created = await host.waitType("room_created", (e) => e.nonce === "n1");
    expect(created.code).toMatch(/^[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{2}$/);
    expect(created.roomId).toMatch(/^rm_/);

    // A second client resolves the shared code back to the same roomId.
    const joiner = await TestClient.connect(relay.port);
    joiner.send({ type: "resolve_code", nonce: "n2", code: created.code });
    const resolved = await joiner.waitType("code_resolved", (e) => e.nonce === "n2");
    expect(resolved.roomId).toBe(created.roomId);
  });

  it("lets two clients meet by roomId after a code handshake", async () => {
    relay = await startRelay({ port: 0 });
    const host = await TestClient.connect(relay.port);
    host.send({ type: "create_room", nonce: "c" });
    const { roomId, code } = await host.waitType("room_created", (e) => e.nonce === "c");

    const joiner = await TestClient.connect(relay.port);
    joiner.send({ type: "resolve_code", nonce: "r", code });
    const { roomId: joinerRoomId } = await joiner.waitType("code_resolved");

    // Both enter by roomId (the field the daemon actually sends).
    host.send({ type: "hello", roomId, handle: "host", faceId: "fox", clientVersion: "test" });
    joiner.send({ type: "hello", roomId: joinerRoomId!, handle: "guest", faceId: "owl", clientVersion: "test" });

    const roster = await host.waitType("presence", (p) => p.peers.length === 2);
    expect(roster.peers.map((p) => p.handle).sort()).toEqual(["guest", "host"]);
  });

  it("returns roomId:null for an unknown code", async () => {
    relay = await startRelay({ port: 0 });
    const c = await TestClient.connect(relay.port);
    c.send({ type: "resolve_code", nonce: "x", code: "zzz-zzzz-zz" });
    const resolved = await c.waitType("code_resolved", (e) => e.nonce === "x");
    expect(resolved.roomId).toBeNull();
  });

  it("forgets a code once the room empties (single-meeting codes)", async () => {
    relay = await startRelay({ port: 0 });
    const host = await TestClient.connect(relay.port);
    host.send({ type: "create_room", nonce: "c" });
    const { roomId, code } = await host.waitType("room_created", (e) => e.nonce === "c");

    host.send({ type: "hello", roomId, handle: "host", faceId: "fox", clientVersion: "test" });
    await host.waitType("presence", (p) => p.peers.length === 1);

    // Host leaves → room empties → code should stop resolving.
    host.close();
    // Give the relay a tick to process the close before we probe.
    await new Promise((r) => setTimeout(r, 100));

    const probe = await TestClient.connect(relay.port);
    probe.send({ type: "resolve_code", nonce: "p", code });
    const resolved = await probe.waitType("code_resolved", (e) => e.nonce === "p");
    expect(resolved.roomId).toBeNull();
    probe.close();
  });

  it("rejects a hello that carries both roomId and roomCode", async () => {
    relay = await startRelay({ port: 0 });
    const c = await TestClient.connect(relay.port);
    // Bypass client-side validation to exercise the relay's own guard.
    c.sendRaw(
      JSON.stringify({
        type: "hello",
        roomId: "rm_deadbeefdeadbeefdeadbeefdeadbeef",
        roomCode: "legacy-1234",
        handle: "x",
        faceId: "fox",
        clientVersion: "test",
      }) + "\n",
    );
    const err = await c.waitType("error", (e) => e.code === "bad_frame");
    expect(err.message).toMatch(/exactly one/);
    c.close();
  });
});
