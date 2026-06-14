import { randomUUID } from "node:crypto";

/**
 * Generate a short, collision-resistant id for pings (and any other message
 * that needs one). Optionally prefixed for readability in logs, e.g.
 * `newId("ping")` → `"ping_3f9c1a2b8d7e4f60"`.
 */
export function newId(prefix?: string): string {
  const core = randomUUID().replace(/-/g, "").slice(0, 16);
  return prefix ? `${prefix}_${core}` : core;
}
