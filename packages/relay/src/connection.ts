import type { WebSocket } from "ws";

/**
 * A simple token-bucket rate limiter. Each connection gets one. Tokens refill
 * continuously at {@link refillPerSec} up to {@link capacity}; every inbound
 * frame costs one token. When the bucket is empty the frame is rejected with a
 * `rate_limited` error rather than processed.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /** Attempt to spend one token. Returns false if the bucket is empty. */
  tryRemove(now: number): boolean {
    const elapsedSec = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Per-connection state held by the relay. A connection becomes "joined" once a
 * valid `hello` arrives and {@link roomCode}/{@link handle} are populated.
 */
export interface Conn {
  /** Stable id for this socket (debugging only; never sent to peers). */
  readonly id: string;
  readonly ws: WebSocket;
  /** Set on `hello`. Undefined means the connection has not joined a room. */
  roomCode?: string;
  handle?: string;
  faceId?: string;
  /**
   * Epoch-ms of the last *application* message (hello/ping). Drives presence
   * `lastSeen` and idle detection. Pongs intentionally do not update this.
   */
  lastActivity: number;
  /** Liveness flag for the WebSocket ping/pong heartbeat. */
  alive: boolean;
  readonly limiter: RateLimiter;
}
