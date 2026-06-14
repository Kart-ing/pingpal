/**
 * @pingpal/relay — the self-hostable WebSocket relay for PingPal.
 *
 * Routes pings between remote peers and tracks presence, all in memory (nothing
 * is persisted). See {@link startRelay} for the programmatic entry point; the
 * `pingpal-relay` bin (see ./bin.ts) wraps it for standalone use.
 */
export { startRelay } from "./relay.js";
export type { RelayHandle, RelayOptions } from "./relay.js";
export {
  DEFAULT_PORT,
  HEARTBEAT_MS,
  IDLE_AFTER_MS,
  RATE_CAPACITY,
  RATE_REFILL_PER_SEC,
} from "./constants.js";
