import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type RelayHandle } from "@pingpal/relay";
import { WsRelayClient } from "./relay-client.js";
import type { ResolvedConfig } from "./config.js";
import type { Peer, Ping } from "@pingpal/protocol";

const configFor = (port: number): ResolvedConfig => ({
  handle: "alice",
  roomCode: "room-secret-1234",
  faceId: "fox",
  relayUrl: `ws://127.0.0.1:${port}`,
  lanDiscovery: false,
  clientVersion: "test",
});

/** Resolve once a predicate holds, polling briefly (for async convergence). */
async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("WsRelayClient", () => {
  let relay: RelayHandle | undefined;
  let client: WsRelayClient | undefined;

  afterEach(async () => {
    await client?.stop();
    await relay?.close();
    client = undefined;
    relay = undefined;
  });

  it("connects, sends hello, and receives presence", async () => {
    relay = await startRelay({ port: 0 });
    const rosters: Peer[][] = [];
    client = new WsRelayClient(configFor(relay.port), {
      onPresence: (peers) => rosters.push(peers),
      onPing: () => {},
      onConnected: () => {},
      onDisconnected: () => {},
    });
    client.start();

    await until(() => client!.connected && rosters.length > 0);
    expect(rosters.at(-1)!.some((p) => p.handle === "alice")).toBe(true);
  });

  it("delivers a ping it sends to a second client", async () => {
    relay = await startRelay({ port: 0 });
    const received: Ping[] = [];
    // A second real client (via the relay's own ws) to receive the ping.
    const bob = new WsRelayClient(
      { ...configFor(relay.port), handle: "bob" },
      {
        onPresence: () => {},
        onPing: (ping) => received.push(ping),
        onConnected: () => {},
        onDisconnected: () => {},
      },
    );
    client = new WsRelayClient(configFor(relay.port), {
      onPresence: () => {},
      onPing: () => {},
      onConnected: () => {},
      onDisconnected: () => {},
    });
    bob.start();
    client.start();
    await until(() => bob.connected && client!.connected);

    const ok = client.sendPing({
      type: "ping",
      id: "p1",
      from: "alice",
      to: "bob",
      text: "ahoy",
      ts: 1,
    });
    expect(ok).toBe(true);
    await until(() => received.length > 0);
    expect(received[0]!.text).toBe("ahoy");
    await bob.stop();
  });

  it("reconnects with backoff after the relay drops, restoring presence", async () => {
    relay = await startRelay({ port: 0 });
    const port = relay.port;

    let connects = 0;
    let disconnects = 0;
    const rosters: Peer[][] = [];
    client = new WsRelayClient(configFor(port), {
      onPresence: (peers) => rosters.push(peers),
      onPing: () => {},
      onConnected: () => {
        connects += 1;
      },
      onDisconnected: () => {
        disconnects += 1;
      },
    }, { backoffBaseMs: 50, backoffMaxMs: 200 });
    client.start();

    await until(() => connects === 1 && client!.connected);

    // Drop the relay; the client should notice and start reconnecting.
    await relay.close();
    await until(() => disconnects === 1 && !client!.connected);

    // Bring the relay back on the same port; the client should reconnect and
    // re-send hello, so presence is restored.
    relay = await startRelay({ port });
    await until(() => connects === 2 && client!.connected);
    await until(() => rosters.at(-1)?.some((p) => p.handle === "alice") === true);
  });

  it("sendPing returns false while disconnected", () => {
    const c = new WsRelayClient(configFor(1), {
      onPresence: () => {},
      onPing: () => {},
      onConnected: () => {},
      onDisconnected: () => {},
    });
    // Never started → not connected.
    expect(
      c.sendPing({ type: "ping", id: "x", from: "alice", to: null, text: "hi", ts: 1 }),
    ).toBe(false);
  });
});
