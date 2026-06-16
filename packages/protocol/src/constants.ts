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
export const PROTOCOL_VERSION = 2 as const;

/** Max file size accepted by the relay blob store (5 MB). */
export const MAX_FILE_BYTES = 5242880 as const; // 5 * 1024 * 1024

/** Per-chunk raw byte size for file transfers (~64 KB, ~85 KB in base64). */
export const FILE_CHUNK_BYTES = 65536 as const;

/** How long a relay blob lives before it's pruned (30 minutes). */
export const BLOB_TTL_MS = 1800000 as const; // 30 * 60 * 1000
