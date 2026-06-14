import { afterEach, describe, expect, it } from "vitest";
import { LanMesh } from "./lan-mesh.js";
import type { Ping } from "@pingpal/protocol";

const ping = (over: Partial<Ping> = {}): Ping => ({
  type: "ping",
  id: "lan-1",
  from: "sarah",
  to: "me",
  text: "over the LAN",
  ts: 1,
  ...over,
});

describe("LanMesh peer-to-peer delivery", () => {
  const meshes: LanMesh[] = [];
  const track = (m: LanMesh): LanMesh => {
    meshes.push(m);
    return m;
  };

  afterEach(async () => {
    await Promise.all(meshes.splice(0).map((m) => m.stop()));
  });

  it("delivers a ping directly from one mesh to another", async () => {
    const received: Ping[] = [];
    const receiver = track(new LanMesh({ onPing: (p) => received.push(p) }));
    const sender = track(new LanMesh({ onPing: () => {} }));

    const port = await receiver.start("127.0.0.1");
    await sender.start("127.0.0.1");
    expect(port).toBeGreaterThan(0);

    const ok = await sender.send("127.0.0.1", port, ping());
    expect(ok).toBe(true);
    // Give the receiver a moment to process the inbound frame.
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("over the LAN");
  });

  it("returns false when the peer isn't listening", async () => {
    const sender = track(new LanMesh({ onPing: () => {} }));
    await sender.start("127.0.0.1");
    // Nothing is listening on this port.
    const ok = await sender.send("127.0.0.1", 9, ping(), 300);
    expect(ok).toBe(false);
  });
});
