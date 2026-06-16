import { describe, expect, it } from "vitest";
import {
  MAX_PING_CHARS,
  PROTOCOL_VERSION,
  ackSchema,
  createFrameDecoder,
  decodeFrame,
  encodeFrame,
  envelopeSchema,
  errorSchema,
  FrameDecodeError,
  helloSchema,
  newId,
  pingSchema,
  pingTextSchema,
  presenceSchema,
  validatePingText,
} from "./index.js";
import type { Envelope } from "./index.js";

const validHello: Envelope = {
  type: "hello",
  roomCode: "lobby-1234",
  handle: "sarah",
  faceId: "owl",
  clientVersion: "0.1.0",
};

const validPresence: Envelope = {
  type: "presence",
  peers: [
    { handle: "sarah", faceId: "owl", status: "online", lastSeen: 1717000000000 },
    { handle: "max-1", faceId: "cat", status: "idle", lastSeen: 0 },
  ],
};

const validPing: Envelope = {
  type: "ping",
  id: "ping_abc123",
  from: "sarah",
  to: "max-1",
  text: "ship it when green, I'll review at 3",
  ts: 1717000000000,
};

const validAck: Envelope = { type: "ack", id: "ping_abc123" };
const validError: Envelope = { type: "error", code: "BAD_ROOM", message: "no such room" };

describe("constants", () => {
  it("locks the ping cap at 90", () => {
    expect(MAX_PING_CHARS).toBe(90);
    expect(PROTOCOL_VERSION).toBe(2);
  });
});

describe("envelope schemas — valid messages", () => {
  it.each<[string, Envelope]>([
    ["hello", validHello],
    ["presence", validPresence],
    ["ping (directed)", validPing],
    ["ping (broadcast)", { ...validPing, to: null }],
    ["ack", validAck],
    ["error", validError],
  ])("accepts a valid %s envelope", (_name, msg) => {
    expect(envelopeSchema.safeParse(msg).success).toBe(true);
  });
});

describe("envelope schemas — invalid messages", () => {
  it("rejects an unknown type", () => {
    expect(envelopeSchema.safeParse({ type: "nope" }).success).toBe(false);
  });

  it("rejects hello missing required fields", () => {
    expect(helloSchema.safeParse({ type: "hello", handle: "sarah" }).success).toBe(false);
  });

  it("rejects a handle with illegal characters", () => {
    expect(helloSchema.safeParse({ ...validHello, handle: "sa rah!" }).success).toBe(false);
  });

  it("rejects a room code that is too short", () => {
    expect(helloSchema.safeParse({ ...validHello, roomCode: "ab" }).success).toBe(false);
  });

  it("rejects presence with a bad status", () => {
    const bad = { type: "presence", peers: [{ handle: "x", faceId: "owl", status: "away", lastSeen: 1 }] };
    expect(presenceSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a negative lastSeen", () => {
    const bad = { type: "presence", peers: [{ handle: "x", faceId: "owl", status: "online", lastSeen: -1 }] };
    expect(presenceSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects ping with a non-integer ts", () => {
    expect(pingSchema.safeParse({ ...validPing, ts: 1.5 }).success).toBe(false);
  });

  it("rejects ack/error missing fields", () => {
    expect(ackSchema.safeParse({ type: "ack" }).success).toBe(false);
    expect(errorSchema.safeParse({ type: "error", code: "X" }).success).toBe(false);
  });
});

describe("90-char boundary", () => {
  const text = (n: number) => "x".repeat(n);

  it("accepts 89 chars", () => {
    expect(pingTextSchema.safeParse(text(89)).success).toBe(true);
    expect(validatePingText(text(89))).toEqual({ ok: true });
  });

  it("accepts exactly 90 chars", () => {
    expect(pingTextSchema.safeParse(text(90)).success).toBe(true);
    expect(validatePingText(text(90))).toEqual({ ok: true });
  });

  it("rejects 91 chars", () => {
    expect(pingTextSchema.safeParse(text(91)).success).toBe(false);
    const res = validatePingText(text(91));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("90");
  });

  it("rejects empty text", () => {
    expect(pingTextSchema.safeParse("").success).toBe(false);
    expect(validatePingText("")).toEqual({ ok: false, reason: "Message is empty." });
  });

  it("rejects an over-long ping at the envelope level too", () => {
    expect(pingSchema.safeParse({ ...validPing, text: text(91) }).success).toBe(false);
  });
});

describe("framing — encode/decode round-trip", () => {
  it.each<[string, Envelope]>([
    ["hello", validHello],
    ["presence", validPresence],
    ["ping", validPing],
    ["broadcast ping", { ...validPing, to: null }],
    ["ack", validAck],
    ["error", validError],
  ])("round-trips a %s envelope", (_name, msg) => {
    const frame = encodeFrame(msg);
    expect(frame.endsWith("\n")).toBe(true);
    expect(frame.indexOf("\n")).toBe(frame.length - 1); // exactly one trailing newline
    expect(decodeFrame(frame)).toEqual(msg);
  });

  it("decodes a line without a trailing newline", () => {
    const line = JSON.stringify(validAck);
    expect(decodeFrame(line)).toEqual(validAck);
  });

  it("encodeFrame rejects an invalid envelope", () => {
    expect(() => encodeFrame({ type: "ping", text: "x".repeat(91) } as unknown as Envelope)).toThrow();
  });

  it("decodeFrame throws FrameDecodeError on bad JSON", () => {
    expect(() => decodeFrame("{not json")).toThrow(FrameDecodeError);
  });

  it("decodeFrame throws FrameDecodeError on a valid-JSON but invalid envelope", () => {
    expect(() => decodeFrame(JSON.stringify({ type: "ping", text: "x".repeat(91) }))).toThrow(
      FrameDecodeError,
    );
  });
});

describe("createFrameDecoder — streaming", () => {
  it("reassembles frames split across chunks", () => {
    const decode = createFrameDecoder();
    const full = encodeFrame(validHello) + encodeFrame(validPing);
    const mid = Math.floor(full.length / 2);
    const first = decode(full.slice(0, mid));
    const second = decode(full.slice(mid));
    expect([...first, ...second]).toEqual([validHello, validPing]);
  });

  it("ignores blank lines between frames", () => {
    const decode = createFrameDecoder();
    const out = decode(`${encodeFrame(validAck)}\n\n${encodeFrame(validError)}`);
    expect(out).toEqual([validAck, validError]);
  });

  it("retains a partial trailing line until completed", () => {
    const decode = createFrameDecoder();
    expect(decode('{"type":"ack",')).toEqual([]);
    expect(decode('"id":"ping_abc123"}\n')).toEqual([validAck]);
  });
});

describe("newId", () => {
  it("produces unique ids and honours a prefix", () => {
    const a = newId();
    const b = newId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(newId("ping")).toMatch(/^ping_[0-9a-f]{16}$/);
  });
});
