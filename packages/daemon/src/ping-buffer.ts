import { appendFile, rm, writeFile } from "node:fs/promises";
import type { Ping } from "@pingpal/protocol";
import type { BufferedPing } from "./ipc-protocol.js";
import type { PingPalPaths } from "./paths.js";

/** Cap on retained pings so a long-lived daemon can't grow unbounded. */
const MAX_BUFFERED = 200;

/**
 * In-memory ring of received pings with a read/unread flag, mirrored to disk so
 * the Claude Code hook can detect new mail without an IPC round-trip:
 *
 *  - `~/.pingpal/unread` holds the current unread count (absent when zero);
 *  - `~/.pingpal/pings.ndjson` is an append-only log of every ping received.
 *
 * Disk writes are best-effort and fire-and-forget: a transient FS error must
 * never drop a ping from the in-memory view the IPC server serves.
 */
export class PingBuffer {
  private readonly buffer: BufferedPing[] = [];
  /** Dedup guard: ids already seen (a peer reachable two ways won't double-add). */
  private readonly seen = new Set<string>();

  constructor(private readonly paths: PingPalPaths) {}

  /**
   * Record a newly-received ping. Returns false (and does nothing) if a ping
   * with this id was already buffered — the daemon may receive the same id over
   * both LAN and relay. New pings start unread.
   */
  add(ping: Ping, via: "lan" | "relay"): boolean {
    if (this.seen.has(ping.id)) return false;
    this.seen.add(ping.id);

    const entry: BufferedPing = { ...ping, read: false, via };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFERED) {
      const dropped = this.buffer.shift();
      if (dropped) this.seen.delete(dropped.id);
    }

    void this.persist(entry);
    return true;
  }

  /**
   * Record a ping WE sent, so the chat view can show both sides of a
   * conversation. Stored already-read and flagged `outbound:true` so the
   * notification hook (which surfaces incoming mail) ignores it. Idempotent by id.
   */
  recordSent(ping: Ping, via: "lan" | "relay"): boolean {
    if (this.seen.has(ping.id)) return false;
    this.seen.add(ping.id);

    const entry: BufferedPing = { ...ping, read: true, via, outbound: true };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFERED) {
      const dropped = this.buffer.shift();
      if (dropped) this.seen.delete(dropped.id);
    }

    void this.persist(entry);
    return true;
  }

  /** Snapshot of buffered pings, newest last. Optionally mark them all read. */
  list(markRead = false): BufferedPing[] {
    const snapshot = this.buffer.map((p) => ({ ...p }));
    if (markRead) this.markAllRead();
    return snapshot;
  }

  /** Number of unread pings currently buffered. */
  unreadCount(): number {
    let n = 0;
    for (const p of this.buffer) if (!p.read) n += 1;
    return n;
  }

  /** Mark every buffered ping read and clear the on-disk unread flag. */
  markAllRead(): void {
    for (const p of this.buffer) p.read = true;
    void this.clearUnreadFlag();
  }

  private async persist(entry: BufferedPing): Promise<void> {
    try {
      await appendFile(this.paths.pings, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      /* best-effort: in-memory buffer remains authoritative */
    }
    await this.writeUnreadFlag();
  }

  private async writeUnreadFlag(): Promise<void> {
    const count = this.unreadCount();
    try {
      if (count > 0) {
        await writeFile(this.paths.unread, String(count), "utf8");
      } else {
        await this.clearUnreadFlag();
      }
    } catch {
      /* best-effort */
    }
  }

  private async clearUnreadFlag(): Promise<void> {
    try {
      await rm(this.paths.unread, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
