import { describe, expect, it, vi } from "vitest";
import {
  BonjourDiscovery,
  type AdvertiseInfo,
  type BonjourBrowser,
  type BonjourLike,
  type BonjourServiceUp,
  type DiscoveredPeer,
} from "./discovery.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const info: AdvertiseInfo = {
  nodeId: "self-node",
  handle: "me",
  faceId: "fox",
  room: "room-secret-1234",
  port: 51000,
};

/** A controllable in-memory Bonjour for exercising browse/publish wiring. */
class FakeBonjour implements BonjourLike {
  readonly published: Array<{ name: string; type: string; port: number }> = [];
  readonly browser: FakeBrowser = new FakeBrowser();
  destroyed = false;
  publish(opts: { name: string; type: string; port: number; txt: Record<string, string> }) {
    this.published.push({ name: opts.name, type: opts.type, port: opts.port });
    return { stop: (cb?: () => void) => cb?.() };
  }
  find(): BonjourBrowser {
    return this.browser;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeBrowser implements BonjourBrowser {
  private readonly handlers: { up: Array<(s: BonjourServiceUp) => void>; down: Array<(s: BonjourServiceUp) => void> } = {
    up: [],
    down: [],
  };
  on(event: "up" | "down", cb: (s: BonjourServiceUp) => void): void {
    this.handlers[event].push(cb);
  }
  emit(event: "up" | "down", svc: BonjourServiceUp): void {
    for (const cb of this.handlers[event]) cb(svc);
  }
  stop(): void {}
}

const svc = (txt: Record<string, string>, over: Partial<BonjourServiceUp> = {}): BonjourServiceUp => ({
  name: `pingpal-${txt.nodeId}`,
  port: 51001,
  addresses: ["192.168.1.50"],
  txt,
  ...over,
});

describe("BonjourDiscovery", () => {
  it("degrades gracefully when the bonjour module is unavailable", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const discovery = new BonjourDiscovery(info, { onPeerUp() {}, onPeerDown() {} }, () => {
      throw new Error("multicast unavailable");
    });

    // Must not throw, even though the loader does.
    expect(() => discovery.start()).not.toThrow();
    await tick();
    expect(discovery.enabled).toBe(false);
    expect(errSpy).toHaveBeenCalledOnce();

    // Stopping a never-enabled discovery is also safe.
    await expect(discovery.stop()).resolves.toBeUndefined();
    errSpy.mockRestore();
  });

  it("advertises and surfaces same-room peers while ignoring self and others", async () => {
    const fake = new FakeBonjour();
    const found: DiscoveredPeer[] = [];
    const gone: string[] = [];
    const discovery = new BonjourDiscovery(
      info,
      { onPeerUp: (p) => found.push(p), onPeerDown: (id) => gone.push(id) },
      () => fake,
    );

    discovery.start();
    await tick();
    expect(discovery.enabled).toBe(true);
    expect(fake.published).toHaveLength(1);
    expect(fake.published[0]!.type).toBe("pingpal");

    // Same room, different node → surfaced.
    fake.browser.emit(
      "up",
      svc({ nodeId: "sarah-node", handle: "sarah", faceId: "cat", room: info.room }),
    );
    // Our own advertisement echoed back → ignored.
    fake.browser.emit(
      "up",
      svc({ nodeId: info.nodeId, handle: info.handle, faceId: info.faceId, room: info.room }),
    );
    // Different room → ignored.
    fake.browser.emit(
      "up",
      svc({ nodeId: "x-node", handle: "x", faceId: "dog", room: "other-room" }),
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      nodeId: "sarah-node",
      handle: "sarah",
      faceId: "cat",
      host: "192.168.1.50",
      port: 51001,
    });

    fake.browser.emit("down", svc({ nodeId: "sarah-node", handle: "sarah", faceId: "cat", room: info.room }));
    expect(gone).toEqual(["sarah-node"]);

    await discovery.stop();
    expect(fake.destroyed).toBe(true);
  });
});
