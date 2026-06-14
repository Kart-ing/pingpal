/**
 * mDNS / Bonjour LAN discovery. Advertises this peer under `_pingpal._tcp` with
 * a TXT record (handle, faceId, room, listener port, nodeId) and browses for
 * others. Same-room peers are surfaced to the daemon, which then talks to them
 * directly over the LAN mesh — no relay hop.
 *
 * Everything here degrades gracefully: if `bonjour-service` can't load or the
 * platform has no working multicast, we log once and run relay-only.
 */

/** A same-LAN peer we discovered (already filtered to our room, excluding self). */
export interface DiscoveredPeer {
  readonly nodeId: string;
  readonly handle: string;
  readonly faceId: string;
  readonly room: string;
  readonly host: string;
  readonly port: number;
}

export interface DiscoveryCallbacks {
  onPeerUp(peer: DiscoveredPeer): void;
  onPeerDown(nodeId: string): void;
}

/** The discovery surface the daemon depends on. */
export interface LanDiscovery {
  start(): void;
  stop(): Promise<void>;
  /** False if mDNS was unavailable and we fell back to relay-only. */
  readonly enabled: boolean;
}

/** What this peer advertises about itself. */
export interface AdvertiseInfo {
  nodeId: string;
  handle: string;
  faceId: string;
  room: string;
  port: number;
}

// --- Minimal structural typing of bonjour-service ---------------------------
// We import it dynamically and type it structurally so the daemon builds and
// tests run even when the package isn't installed, and so a fake can be injected.

export interface BonjourServiceUp {
  name?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, string | undefined>;
  referer?: { address?: string };
}
export interface BonjourBrowser {
  on(event: "up" | "down", cb: (service: BonjourServiceUp) => void): void;
  stop?(): void;
}
export interface BonjourPublished {
  stop?(cb?: () => void): void;
}
export interface BonjourLike {
  publish(opts: {
    name: string;
    type: string;
    port: number;
    txt: Record<string, string>;
  }): BonjourPublished;
  find(opts: { type: string }): BonjourBrowser;
  unpublishAll?(cb?: () => void): void;
  destroy?(): void;
}

/** Loads a Bonjour instance. The default does a dynamic import; tests inject. */
export type BonjourLoader = () => BonjourLike | Promise<BonjourLike>;

const SERVICE_TYPE = "pingpal"; // becomes `_pingpal._tcp` on the wire

const defaultLoader: BonjourLoader = async () => {
  const mod = (await import("bonjour-service")) as unknown as {
    Bonjour: new () => BonjourLike;
  };
  return new mod.Bonjour();
};

/**
 * Concrete {@link LanDiscovery} backed by bonjour-service. Construction never
 * throws; failures during {@link start} flip {@link enabled} to false instead
 * of propagating, so the daemon keeps running relay-only.
 */
export class BonjourDiscovery implements LanDiscovery {
  private bonjour: BonjourLike | null = null;
  private published: BonjourPublished | null = null;
  private browser: BonjourBrowser | null = null;
  private _enabled = false;
  private warnedOnce = false;
  private started = false;

  constructor(
    private readonly info: AdvertiseInfo,
    private readonly callbacks: DiscoveryCallbacks,
    private readonly loader: BonjourLoader = defaultLoader,
  ) {}

  get enabled(): boolean {
    return this._enabled;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Loading may be async (dynamic import); kick it off and swallow failures.
    void this.bootstrap().catch((err) => this.disable(err));
  }

  private async bootstrap(): Promise<void> {
    const bonjour = await this.loader();
    if (!this.started) {
      // stop() raced ahead of us; tear the instance back down.
      bonjour.destroy?.();
      return;
    }
    this.bonjour = bonjour;

    this.published = bonjour.publish({
      name: `pingpal-${this.info.nodeId}`,
      type: SERVICE_TYPE,
      port: this.info.port,
      txt: {
        nodeId: this.info.nodeId,
        handle: this.info.handle,
        faceId: this.info.faceId,
        room: this.info.room,
      },
    });

    const browser = bonjour.find({ type: SERVICE_TYPE });
    this.browser = browser;
    browser.on("up", (svc) => this.handleUp(svc));
    browser.on("down", (svc) => this.handleDown(svc));

    this._enabled = true;
  }

  private handleUp(svc: BonjourServiceUp): void {
    const txt = svc.txt ?? {};
    const nodeId = txt.nodeId;
    const handle = txt.handle;
    const faceId = txt.faceId;
    const room = txt.room;
    if (!nodeId || !handle || !room) return; // not one of ours
    if (nodeId === this.info.nodeId) return; // that's us
    if (room !== this.info.room) return; // different room — ignore
    const host = pickAddress(svc);
    const port = svc.port;
    if (!host || !port) return;
    this.callbacks.onPeerUp({
      nodeId,
      handle,
      faceId: faceId ?? handle,
      room,
      host,
      port,
    });
  }

  private handleDown(svc: BonjourServiceUp): void {
    const nodeId = svc.txt?.nodeId;
    if (nodeId && nodeId !== this.info.nodeId) this.callbacks.onPeerDown(nodeId);
  }

  private disable(err: unknown): void {
    this._enabled = false;
    if (this.warnedOnce) return;
    this.warnedOnce = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[pingpald] LAN discovery unavailable (relay-only): ${msg}`,
    );
  }

  async stop(): Promise<void> {
    this.started = false;
    this._enabled = false;
    this.browser?.stop?.();
    this.browser = null;
    await new Promise<void>((resolve) => {
      const published = this.published;
      this.published = null;
      if (!published?.stop) {
        resolve();
        return;
      }
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        published.stop(finish);
      } catch {
        finish();
        return;
      }
      const t = setTimeout(finish, 500);
      t.unref?.();
    });
    this.bonjour?.unpublishAll?.();
    this.bonjour?.destroy?.();
    this.bonjour = null;
  }
}

/** Pick a usable IPv4-ish address for a discovered service. */
function pickAddress(svc: BonjourServiceUp): string | null {
  const addrs = svc.addresses ?? [];
  // Prefer a dotted IPv4 address; fall back to the first address or referer.
  const ipv4 = addrs.find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
  return ipv4 ?? addrs[0] ?? svc.referer?.address ?? null;
}

/** Factory used by the daemon; tests pass their own loader. */
export type DiscoveryFactory = (
  info: AdvertiseInfo,
  callbacks: DiscoveryCallbacks,
) => LanDiscovery;

export const defaultDiscoveryFactory: DiscoveryFactory = (info, callbacks) =>
  new BonjourDiscovery(info, callbacks);
