import type { Peer, Status } from "@pingpal/protocol";
import type { MergedPeer, Reachability } from "./ipc-protocol.js";

/** A LAN-discovered peer with the address needed to deliver to it directly. */
export interface LanPeer {
  readonly nodeId: string;
  readonly handle: string;
  readonly faceId: string;
  readonly host: string;
  readonly port: number;
  /** epoch-ms we last saw this peer advertised. */
  lastSeen: number;
}

/** Where and how to deliver to a given handle. */
export type Route =
  | { via: "lan"; host: string; port: number }
  | { via: "relay" }
  | { via: "none" };

/**
 * Holds the two presence sources — relay-reported peers and LAN-discovered
 * peers — and merges them into one roster deduped by handle. The merge is the
 * daemon's source of truth for both "who's online" and "how do I reach them".
 *
 * Delivery preference: when a peer is reachable on both transports we prefer the
 * LAN path (lower latency, no relay hop), which is why {@link routeFor} checks
 * LAN first. All logic here is pure and synchronous so it is trivially testable.
 */
export class PresenceStore {
  /** handle → relay peer (wholesale-replaced on each `presence` frame). */
  private relayPeers = new Map<string, Peer>();
  /** nodeId → LAN peer (one node can advertise; deduped to handle on read). */
  private lanByNode = new Map<string, LanPeer>();

  constructor(private readonly selfHandle: string) {}

  /** Replace the relay roster wholesale from a `presence` frame. */
  setRelayPeers(peers: Peer[]): void {
    this.relayPeers = new Map(
      peers.filter((p) => p.handle !== this.selfHandle).map((p) => [p.handle, p]),
    );
  }

  /** Clear all relay peers (e.g. on disconnect — they're no longer reachable). */
  clearRelayPeers(): void {
    this.relayPeers.clear();
  }

  /** Add or refresh a LAN-discovered peer. */
  setLanPeer(peer: LanPeer): void {
    if (peer.handle === this.selfHandle) return;
    this.lanByNode.set(peer.nodeId, peer);
  }

  /** Remove a LAN peer that went away (by its mDNS nodeId). */
  removeLanPeer(nodeId: string): void {
    this.lanByNode.delete(nodeId);
  }

  /** Most-recent LAN peer for a handle (a handle may briefly map to 2 nodes). */
  private lanForHandle(handle: string): LanPeer | undefined {
    let best: LanPeer | undefined;
    for (const peer of this.lanByNode.values()) {
      if (peer.handle !== handle) continue;
      if (!best || peer.lastSeen > best.lastSeen) best = peer;
    }
    return best;
  }

  /** Distinct LAN peers, latest-per-handle. */
  private lanPeersByHandle(): Map<string, LanPeer> {
    const out = new Map<string, LanPeer>();
    for (const peer of this.lanByNode.values()) {
      const existing = out.get(peer.handle);
      if (!existing || peer.lastSeen > existing.lastSeen) {
        out.set(peer.handle, peer);
      }
    }
    return out;
  }

  /** Count of LAN-reachable distinct handles. */
  lanCount(): number {
    return this.lanPeersByHandle().size;
  }

  /** All distinct LAN-reachable peers (latest advertisement per handle). */
  lanPeers(): LanPeer[] {
    return [...this.lanPeersByHandle().values()];
  }

  /** Count of relay-reachable handles. */
  relayCount(): number {
    return this.relayPeers.size;
  }

  /**
   * The merged roster: union of relay + LAN handles (minus self), each tagged
   * with how it's reachable. A peer present on both transports keeps the more
   * "alive" status and the newer `lastSeen`, and reports `via: "both"`.
   */
  roster(): MergedPeer[] {
    const lan = this.lanPeersByHandle();
    const handles = new Set<string>([...this.relayPeers.keys(), ...lan.keys()]);
    const out: MergedPeer[] = [];

    for (const handle of handles) {
      const relay = this.relayPeers.get(handle);
      const lanPeer = lan.get(handle);
      const via: Reachability =
        relay && lanPeer ? "both" : lanPeer ? "lan" : "relay";

      // A LAN advertisement implies the peer is up right now; the relay carries
      // a richer online/idle/offline status. Prefer the relay's status when we
      // have it, otherwise treat a freshly-advertised LAN peer as online.
      const status: Status = relay?.status ?? "online";
      const lastSeen = Math.max(relay?.lastSeen ?? 0, lanPeer?.lastSeen ?? 0);
      const faceId = relay?.faceId ?? lanPeer?.faceId ?? handle;

      out.push({ handle, faceId, status, lastSeen, via });
    }

    out.sort((a, b) => a.handle.localeCompare(b.handle));
    return out;
  }

  /**
   * Resolve how to deliver a directed ping to `handle`, preferring LAN. Returns
   * `{ via: "none" }` if the handle is unknown on either transport.
   */
  routeFor(handle: string): Route {
    const lanPeer = this.lanForHandle(handle);
    if (lanPeer) return { via: "lan", host: lanPeer.host, port: lanPeer.port };
    if (this.relayPeers.has(handle)) return { via: "relay" };
    return { via: "none" };
  }

  /**
   * LAN-only peers (reachable on the LAN but NOT on the relay). Used for
   * broadcasts: the relay's `to: null` fan-out already covers relay peers, so we
   * unicast to these to reach them without double-delivering to "both" peers.
   */
  lanOnlyPeers(): LanPeer[] {
    const out: LanPeer[] = [];
    for (const [handle, peer] of this.lanPeersByHandle()) {
      if (!this.relayPeers.has(handle)) out.push(peer);
    }
    return out;
  }
}
