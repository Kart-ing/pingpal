import { randomInt } from "node:crypto";

/**
 * Human-friendly, Meet-style join codes — the short string you read to a
 * teammate ("vee-em-double-u-q…"). Two distinct things travel together in the
 * room system and must not be confused:
 *
 *  - the **code** (this file): short, low-entropy, human-typed, single purpose —
 *    look up a room on the relay at join time. Looks like `vmwq-kztp-h`.
 *  - the **roomId** ({@link newRoomId}): long, full-entropy, never typed, the
 *    actual shared secret. It is both the relay routing label and the material
 *    the E2E key is derived from. A code maps to a roomId via the relay; the
 *    code never derives the key, so a rotated/expired code decrypts nothing.
 *
 * Alphabet excludes easily-confused glyphs (0/O, 1/I/L) so a code read aloud or
 * copied by hand round-trips. We use Crockford base32 minus vowels-that-confuse;
 * concretely: digits 2-9 and lowercase consonants, dropping `l`, `o`, `i`.
 */

/** Unambiguous code alphabet: no 0/o/1/l/i, lowercase for easy typing. */
export const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/** Number of significant characters in a join code (excludes dashes). */
export const CODE_LENGTH = 9;

/** Where dashes go, Meet-style, purely for readability: `xxx-xxxx-xx`. */
const GROUPS = [3, 4, 2] as const;

/**
 * Generate a fresh join code like `vmwq-kztp-h` → grouped as `vmw-qkzt-ph`.
 * Uses {@link randomInt} (CSPRNG) for unbiased picks. ~9 chars over a 31-symbol
 * alphabet ≈ 44 bits — fine for a short-lived lookup token (the real secret is
 * the roomId), and the relay rejects collisions at mint time anyway.
 */
export function genCode(): string {
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return group(raw);
}

/** Insert the readability dashes into a raw (dashless) code. */
function group(raw: string): string {
  const parts: string[] = [];
  let pos = 0;
  for (const n of GROUPS) {
    parts.push(raw.slice(pos, pos + n));
    pos += n;
  }
  // Any remainder (if CODE_LENGTH changes) trails as a final group.
  if (pos < raw.length) parts.push(raw.slice(pos));
  return parts.filter(Boolean).join("-");
}

/**
 * Normalise user-typed code input for lookup: l-case, strip spaces/dashes, and
 * fold the classic look-alikes a human might mistype back onto the alphabet
 * (O→0 is NOT in our set, so map o→ a no, instead map the confusables that ARE
 * outside the set onto nothing). We simply remove separators and lowercase; we
 * do not silently "correct" letters, to avoid mapping a valid code onto a
 * different one. Returns the canonical dashless form used as the registry key.
 */
export function normalizeCode(input: string): string {
  return input.trim().toLowerCase().replace(/[\s-]+/g, "");
}

/**
 * A full-entropy room identifier: 32 hex chars (128 bits) from the CSPRNG. This
 * is the shared secret — the relay's routing label and the E2E key material.
 * Never shown for typing; carried in config and on the `hello` frame.
 */
export function newRoomId(): string {
  // 16 bytes → 32 hex chars. Distinct prefix keeps it identifiable in logs.
  let hex = "";
  const bytes = 16;
  for (let i = 0; i < bytes; i++) hex += randomInt(256).toString(16).padStart(2, "0");
  return `rm_${hex}`;
}
