import { describe, expect, it } from "vitest";
import { deriveRoomKey, seal, open, looksSealed } from "./crypto.js";

describe("E2E crypto", () => {
  it("round-trips a message with the same room code", () => {
    const key = deriveRoomKey("our-room-1234");
    const blob = seal("ship it when green 🚀", key);
    expect(open(blob, key)).toBe("ship it when green 🚀");
  });

  it("derives a stable key from a room code (same code → same key)", () => {
    expect(deriveRoomKey("abcd").equals(deriveRoomKey("abcd"))).toBe(true);
    expect(deriveRoomKey("abcd").equals(deriveRoomKey("abce"))).toBe(false);
  });

  it("cannot be decrypted with a different room code (the relay-operator case)", () => {
    const blob = seal("secret", deriveRoomKey("room-A"));
    // Someone with a different room code (or the relay, with none) gets null.
    expect(open(blob, deriveRoomKey("room-B"))).toBeNull();
  });

  it("rejects tampered ciphertext (GCM auth)", () => {
    const key = deriveRoomKey("r");
    const blob = seal("hello", key);
    const buf = Buffer.from(blob, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(open(buf.toString("base64"), key)).toBeNull();
  });

  it("produces a different blob each time (random nonce) but same plaintext", () => {
    const key = deriveRoomKey("r");
    const a = seal("dup", key);
    const b = seal("dup", key);
    expect(a).not.toBe(b);
    expect(open(a, key)).toBe("dup");
    expect(open(b, key)).toBe("dup");
  });

  it("open() returns null on garbage instead of throwing", () => {
    expect(open("not base64 !!!", deriveRoomKey("r"))).toBeNull();
    expect(open("", deriveRoomKey("r"))).toBeNull();
  });

  it("looksSealed recognises our blobs and rejects plaintext", () => {
    expect(looksSealed(seal("x", deriveRoomKey("r")))).toBe(true);
    expect(looksSealed("just a normal message")).toBe(false);
  });
});
