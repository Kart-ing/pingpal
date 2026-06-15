import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * End-to-end encryption for ping payloads.
 *
 * Goal: a relay only ever forwards opaque ciphertext, so whoever runs the relay
 * cannot read messages. The encryption key is derived **client-side** from the
 * room code (the shared secret every room member already has) and is NEVER sent
 * to the relay — the relay routes by room code but cannot decrypt with it,
 * because it only sees the code as an opaque routing label, while the key comes
 * from running it through HKDF here.
 *
 * Honest limits (documented for users, not hidden):
 *  - This protects message *content*, not *metadata*. The relay still sees who
 *    is in a room, who is messaging whom, message sizes, and timing.
 *  - The room code IS the key material. Anyone with the room code can decrypt
 *    (they are, by definition, "in the room"). Use a strong, unguessable code.
 *  - No forward secrecy: the key is static per room code, so a code leaked later
 *    can decrypt previously-captured ciphertext. Rotating keys / ratcheting is a
 *    much larger design; this is a deliberate, simpler middle ground.
 *
 * Scheme: AES-256-GCM (authenticated). key = HKDF-SHA256(roomCode, salt, info).
 * Wire format of a sealed payload (base64): version(1) | nonce(12) | tag(16) | ct.
 */

const VERSION = 1; // bump if the scheme changes; lets us reject/adapt old blobs
const SALT = Buffer.from("pingpal/e2e/v1/salt");
const INFO = Buffer.from("pingpal/e2e/v1/ping-text");
const KEY_LEN = 32; // AES-256
const NONCE_LEN = 12; // GCM standard
const TAG_LEN = 16;

/** Derive the room's symmetric key from its code. Deterministic per code. */
export function deriveRoomKey(roomCode: string): Buffer {
  const ikm = Buffer.from(roomCode, "utf8");
  // hkdfSync returns an ArrayBuffer; wrap as Buffer.
  const out = hkdfSync("sha256", ikm, SALT, INFO, KEY_LEN);
  return Buffer.from(out);
}

/** Encrypt plaintext with a room key → base64 blob. */
export function seal(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), nonce, tag, ct]).toString("base64");
}

/**
 * Decrypt a base64 blob with a room key. Returns null on ANY failure (wrong
 * key, tampering, malformed, unknown version) — callers treat null as
 * "undecryptable" rather than throwing, so one bad message can't crash a reader.
 */
export function open(blob: string, key: Buffer): string | null {
  try {
    const buf = Buffer.from(blob, "base64");
    if (buf.length < 1 + NONCE_LEN + TAG_LEN) return null;
    if (buf[0] !== VERSION) return null;
    const nonce = buf.subarray(1, 1 + NONCE_LEN);
    const tag = buf.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + TAG_LEN);
    const ct = buf.subarray(1 + NONCE_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

/** Heuristic: does this look like one of our sealed blobs? (version byte check) */
export function looksSealed(blob: string): boolean {
  try {
    const buf = Buffer.from(blob, "base64");
    return buf.length >= 1 + NONCE_LEN + TAG_LEN && buf[0] === VERSION;
  } catch {
    return false;
  }
}
