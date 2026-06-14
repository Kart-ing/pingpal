/**
 * Tuning constants for the relay. These are deliberately conservative defaults
 * for a small, in-memory, self-hosted relay; every one can be overridden per
 * call via {@link import("./relay.js").RelayOptions}.
 */

/** Default TCP port the standalone relay listens on. */
export const DEFAULT_PORT = 8787 as const;

/**
 * How often the relay sweeps connections: it sends a WebSocket ping to each
 * client (terminating any that missed the previous one) and re-broadcasts
 * presence to rooms whose roster status changed (e.g. someone went idle).
 */
export const HEARTBEAT_MS = 15_000 as const;

/**
 * A peer is reported as `idle` once this long has passed since its last
 * *application* message (hello/ping). Liveness pongs do NOT reset this — only
 * real user activity does — so an open-but-quiet session correctly goes idle.
 */
export const IDLE_AFTER_MS = 60_000 as const;

/** Token-bucket burst capacity per connection. */
export const RATE_CAPACITY = 30 as const;

/** Token-bucket refill rate per connection, in tokens per second. */
export const RATE_REFILL_PER_SEC = 10 as const;
