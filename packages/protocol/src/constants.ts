/**
 * Hard cap on the length of a ping's text, in characters.
 *
 * This is the single source of truth for the "90-character ping" rule. It is
 * enforced in the zod schema (see {@link ./schemas.ts}), surfaced to clients
 * via {@link validatePingText}, and respected defensively by the faces
 * renderer. Do not duplicate this number anywhere — import it.
 */
export const MAX_PING_CHARS = 90 as const;

/** Current wire-protocol version. Bump on any breaking envelope change. */
export const PROTOCOL_VERSION = 1 as const;
