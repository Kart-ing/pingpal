import { describe, expect, it } from "vitest";
import type { Peer } from "@pingpal/protocol";
import { PresenceStore, type LanPeer } from "./presence.js";

const relayPeer = (handle: string, over: Partial<Peer> = {}): Peer => ({
  handle,
  faceId: "fox",
  status: "online",
  lastSeen: 1000,
  ...over,
});

const lanPeer = (handle: string, over: Partial<LanPeer> = {}): LanPeer => ({
  nodeId: `node-${handle}`,
  handle,
  faceId: "cat",
  host: "192.168.1.10",
  port: 51000,
  lastSeen: 2000,
  ...over,
});

describe("PresenceStore merge + routing", () => {
  it("drops self from both sources", () => {
    const store = new PresenceStore("me");
    store.setRelayPeers([relayPeer("me"), relayPeer("sarah")]);
    store.setLanPeer(lanPeer("me"));
    const roster = store.roster();
    expect(roster.map((p) => p.handle)).toEqual(["sarah"]);
  });

  it("dedupes a handle present on both transports and prefers LAN for routing", () => {
    const store = new PresenceStore("me");
    store.setRelayPeers([relayPeer("sarah", { status: "idle", lastSeen: 500 })]);
    store.setLanPeer(lanPeer("sarah", { lastSeen: 3000 }));

    const roster = store.roster();
    expect(roster).toHaveLength(1);
    const sarah = roster[0]!;
    expect(sarah.via).toBe("both");
    // Relay carries the richer status; newest lastSeen across sources wins.
    expect(sarah.status).toBe("idle");
    expect(sarah.lastSeen).toBe(3000);

    // Reachable on both → deliver over LAN.
    expect(store.routeFor("sarah")).toEqual({
      via: "lan",
      host: "192.168.1.10",
      port: 51000,
    });
  });

  it("classifies via as lan / relay / both correctly", () => {
    const store = new PresenceStore("me");
    store.setRelayPeers([relayPeer("relayonly")]);
    store.setLanPeer(lanPeer("lanonly"));
    store.setRelayPeers([relayPeer("relayonly"), relayPeer("bothpeer")]);
    store.setLanPeer(lanPeer("bothpeer"));

    const byHandle = Object.fromEntries(store.roster().map((p) => [p.handle, p.via]));
    expect(byHandle).toEqual({
      relayonly: "relay",
      lanonly: "lan",
      bothpeer: "both",
    });
  });

  it("routes relay-only peers via relay and unknown peers nowhere", () => {
    const store = new PresenceStore("me");
    store.setRelayPeers([relayPeer("sarah")]);
    expect(store.routeFor("sarah")).toEqual({ via: "relay" });
    expect(store.routeFor("ghost")).toEqual({ via: "none" });
  });

  it("lanOnlyPeers excludes peers also reachable via relay", () => {
    const store = new PresenceStore("me");
    store.setRelayPeers([relayPeer("bothpeer")]);
    store.setLanPeer(lanPeer("bothpeer"));
    store.setLanPeer(lanPeer("lanonly"));

    const lanOnly = store.lanOnlyPeers().map((p) => p.handle);
    expect(lanOnly).toEqual(["lanonly"]);
  });

  it("collapses two nodes advertising the same handle, newest wins", () => {
    const store = new PresenceStore("me");
    store.setLanPeer(lanPeer("sarah", { nodeId: "a", port: 1, lastSeen: 100 }));
    store.setLanPeer(lanPeer("sarah", { nodeId: "b", port: 2, lastSeen: 200 }));

    expect(store.lanCount()).toBe(1);
    expect(store.routeFor("sarah")).toEqual({
      via: "lan",
      host: "192.168.1.10",
      port: 2,
    });
  });

  it("removeLanPeer and clearRelayPeers drop reachability", () => {
    const store = new PresenceStore("me");
    store.setLanPeer(lanPeer("sarah", { nodeId: "n1" }));
    store.setRelayPeers([relayPeer("bob")]);

    store.removeLanPeer("n1");
    store.clearRelayPeers();

    expect(store.roster()).toEqual([]);
    expect(store.routeFor("sarah")).toEqual({ via: "none" });
    expect(store.routeFor("bob")).toEqual({ via: "none" });
  });
});
