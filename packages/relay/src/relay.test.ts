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

const hello = (roomCode: string, handle: string, roomAuth?: string): Envelope => ({
  type: "hello",
  roomCode,
  handle,
  faceId: "fox",
  clientVersion: "test",
  ...(roomAuth ? { roomAuth } : {}),
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

  it("password-gates a room: first joiner sets it, wrong/missing proof is rejected", async () => {
    relay = await startRelay({ port: 0 });
    const room = "locked-room-9999";
    const PROOF = "the-correct-proof";

    // First joiner establishes the room's password proof.
    const owner = await TestClient.connect(relay.port);
    owner.send(hello(room, "owner", PROOF));
    await owner.waitType("presence", (p) => p.peers.some((x) => x.handle === "owner"));

    // A brute-forcer guesses the room code but has no/wrong proof → auth_failed,
    // and must NOT appear in presence.
    const attacker = await TestClient.connect(relay.port);
    attacker.send(hello(room, "attacker", "wrong-proof"));
    const err = await attacker.waitType("error");
    expect(err.code).toBe("auth_failed");

    const noProof = await TestClient.connect(relay.port);
    noProof.send(hello(room, "sneaky")); // no roomAuth at all
    expect((await noProof.waitType("error")).code).toBe("auth_failed");

    // A legit joiner with the right proof gets in.
    const friend = await TestClient.connect(relay.port);
    friend.send(hello(room, "friend", PROOF));
    const roster = await friend.waitType("presence", (p) => p.peers.length === 2);
    expect(roster.peers.map((x) => x.handle).sort()).toEqual(["friend", "owner"]);
    // The rejected handles never made it into the room.
    expect(roster.peers.some((x) => x.handle === "attacker")).toBe(false);

    owner.close();
    friend.close();
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
});
