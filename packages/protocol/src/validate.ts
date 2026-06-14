import { MAX_PING_CHARS } from "./constants.js";

/** Result of {@link validatePingText}. */
export type PingTextResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate ping text against the 90-character rule, returning a friendly
 * result instead of throwing. Clients call this on send to show a clear error
 * before anything hits the wire; the zod {@link pingTextSchema} enforces the
 * same cap defensively on receipt.
 */
export function validatePingText(text: string): PingTextResult {
  if (typeof text !== "string" || text.length === 0) {
    return { ok: false, reason: "Message is empty." };
  }
  if (text.length > MAX_PING_CHARS) {
    const over = text.length - MAX_PING_CHARS;
    return {
      ok: false,
      reason: `Message is ${text.length} chars — ${over} over the ${MAX_PING_CHARS}-char limit.`,
    };
  }
  return { ok: true };
}
