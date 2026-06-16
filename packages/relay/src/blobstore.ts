/**
 * In-memory blob store for relay-mediated file sharing.
 *
 * Each blob lives for at most {@link BLOB_TTL_MS} (30 minutes by default);
 * expired blobs are pruned lazily on access and eagerly on a sweep interval.
 * This keeps the relay stateless at rest — blobs only exist while a room has
 * active members, and they evaporate soon after the last member leaves.
 */
import { BLOB_TTL_MS, MAX_FILE_BYTES } from "@pingpal/protocol";

export interface BlobEntry {
  /** Raw binary content. */
  data: Buffer;
  /** Original filename. */
  name: string;
  /** Byte size of `data`. */
  size: number;
  /** Optional MIME type. */
  mime?: string;
  /** Which room the blob belongs to (scopes visibility). */
  roomKey: string;
  /** epoch-ms of when the blob was fully stored. */
  createdAt: number;
}

export class BlobStore {
  private blobs = new Map<string, BlobEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Max total bytes across all blobs. Defaults to 100 MB — enough for ~20
   * simultaneous 5 MB uploads. Exceeding this rejects new uploads.
   */
  private maxTotalBytes: number;

  constructor(
    private ttlMs = BLOB_TTL_MS,
    maxTotalBytes = 100 * 1024 * 1024,
    sweepIntervalMs = 60_000,
  ) {
    this.maxTotalBytes = maxTotalBytes;
    // Sweep expired blobs every minute.
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Total number of blobs currently stored. */
  get count(): number {
    return this.blobs.size;
  }

  /** Sum of all stored blob sizes in bytes. */
  get totalBytes(): number {
    let n = 0;
    for (const b of this.blobs.values()) n += b.size;
    return n;
  }

  /** Store a completed blob. Returns false if it would exceed the size cap. */
  store(
    id: string,
    data: Buffer,
    name: string,
    roomKey: string,
    mime?: string,
  ): boolean {
    this.sweep(); // prune before measuring
    if (data.byteLength > MAX_FILE_BYTES) return false;
    if (this.totalBytes + data.byteLength > this.maxTotalBytes) return false;

    this.blobs.set(id, {
      data,
      name,
      size: data.byteLength,
      mime,
      roomKey,
      createdAt: Date.now(),
    });
    return true;
  }

  /** Retrieve a blob by id. Returns undefined if not found or expired. */
  get(id: string): BlobEntry | undefined {
    const entry = this.blobs.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.blobs.delete(id);
      return undefined;
    }
    return entry;
  }

  /** Remove a blob explicitly (e.g. after all recipients have downloaded). */
  delete(id: string): void {
    this.blobs.delete(id);
  }

  /** Remove all expired blobs. */
  sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.blobs) {
      if (now - entry.createdAt > this.ttlMs) {
        this.blobs.delete(id);
      }
    }
  }

  /** Stop the sweep timer (call when shutting down the relay). */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.blobs.clear();
  }
}
