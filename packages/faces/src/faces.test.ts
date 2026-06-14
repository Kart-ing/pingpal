import { afterEach, describe, expect, it } from "vitest";
import { MAX_PING_CHARS } from "@pingpal/protocol";

import {
  FACE_IDS,
  displayWidth,
  getFace,
  pickFace,
  renderPing,
  renderRoster,
  stripAnsi,
  wrapText,
} from "./index.js";

const ESC = String.fromCharCode(27);

/** Split a rendered block into stripped (plain) lines. */
function plainLines(art: string): string[] {
  return stripAnsi(art).split("\n");
}

describe("pickFace — deterministic & stable", () => {
  it("always returns a known preset id", () => {
    for (const handle of ["sarah", "max-1", "jo", "kai", "a", "zzz"]) {
      expect(FACE_IDS).toContain(pickFace(handle));
    }
  });

  it("is stable for the same handle", () => {
    expect(pickFace("sarah")).toBe(pickFace("sarah"));
    expect(pickFace("max-1")).toBe(pickFace("max-1"));
  });

  it("distributes across more than one face for varied handles", () => {
    const ids = new Set(
      ["sarah", "max", "jo", "kai", "robin", "lee", "ada", "ben", "cy", "dot"].map(pickFace),
    );
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe("getFace — resolution & override", () => {
  it("honours an explicit, known faceId", () => {
    expect(getFace("robot", "sarah").id).toBe("robot");
  });

  it("falls back to a stable hash for an unknown faceId", () => {
    expect(getFace("does-not-exist", "sarah").id).toBe(pickFace("sarah"));
  });

  it("hashes the handle when no faceId is given", () => {
    expect(getFace(undefined, "sarah").id).toBe(pickFace("sarah"));
  });
});

describe("wrapText", () => {
  it("never exceeds the requested width", () => {
    const out = wrapText("the quick brown fox jumps over the lazy dog again and again", 12);
    for (const line of out) expect(displayWidth(line)).toBeLessThanOrEqual(12);
  });

  it("hard-breaks a single over-long word", () => {
    const out = wrapText("x".repeat(50), 10);
    expect(out.length).toBeGreaterThan(1);
    for (const line of out) expect(displayWidth(line)).toBeLessThanOrEqual(10);
  });

  it("returns one line for empty input", () => {
    expect(wrapText("", 20)).toEqual([""]);
  });
});

describe("renderPing — structure", () => {
  const art = renderPing({
    handle: "sarah",
    faceId: "fox",
    text: "ship it when green, I'll review at 3",
    status: "online",
    lastSeenText: "2s ago",
    color: false,
  });

  it("contains the handle", () => {
    expect(stripAnsi(art)).toContain("sarah");
  });

  it("contains the (short) message text verbatim", () => {
    expect(stripAnsi(art)).toContain("ship it when green, I'll review at 3");
  });

  it("contains the face glyph", () => {
    expect(stripAnsi(art)).toContain("◕");
  });

  it("shows the online status dot and label", () => {
    const plain = stripAnsi(art);
    expect(plain).toContain("●");
    expect(plain).toContain("online");
    expect(plain).toContain("2s ago");
  });

  it("draws a bubble and a connector", () => {
    const plain = stripAnsi(art);
    expect(plain).toContain("╭");
    expect(plain).toContain("┬");
    expect(plain).toContain("│");
  });

  it("stays within 80 columns for normal input", () => {
    for (const line of plainLines(art)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it("wraps long messages across multiple bubble lines without overflow", () => {
    const long = renderPing({
      handle: "bob",
      text: "deploy is stuck on the migration step again, taking a careful look now",
      color: false,
    });
    const plain = plainLines(long);
    // every word survives the wrap
    for (const word of ["deploy", "migration", "careful", "look", "now"]) {
      expect(stripAnsi(long)).toContain(word);
    }
    for (const line of plain) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });
});

describe("renderPing — 90-char hard cap", () => {
  it("never renders more message characters than the cap allows", () => {
    // handle/status carry no 'a', so every 'a' in the output is message text.
    const art = renderPing({ handle: "bob", text: "a".repeat(200), color: false });
    const aCount = (stripAnsi(art).match(/a/g) ?? []).length;
    expect(aCount).toBeLessThanOrEqual(MAX_PING_CHARS);
  });

  it("clamps even a single giant word and keeps lines bounded", () => {
    const art = renderPing({ handle: "bob", text: "z".repeat(300), color: false });
    for (const line of plainLines(art)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(80);
    }
  });
});

describe("renderPing — colour & NO_COLOR", () => {
  const original = process.env.NO_COLOR;
  afterEach(() => {
    if (original === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = original;
  });

  it("emits ANSI when colour is on", () => {
    const art = renderPing({ handle: "sarah", text: "hi", color: true });
    expect(art.includes(ESC)).toBe(true);
  });

  it("emits no ANSI when colour is off", () => {
    const art = renderPing({ handle: "sarah", text: "hi", color: false });
    expect(art.includes(ESC)).toBe(false);
  });

  it("honours NO_COLOR from the environment by default", () => {
    process.env.NO_COLOR = "1";
    const art = renderPing({ handle: "sarah", text: "hi" });
    expect(art.includes(ESC)).toBe(false);
  });
});

describe("renderPing — ASCII fallback", () => {
  const art = renderPing({
    handle: "sarah",
    faceId: "fox",
    text: "ship it",
    color: false,
    ascii: true,
  });

  it("uses no fancy box-drawing characters", () => {
    expect(/[╭╮╰╯─│┬]/.test(art)).toBe(false);
  });

  it("uses ASCII borders, an ASCII face, and an ASCII status marker", () => {
    expect(art).toContain("+");
    expect(art).toContain("( o.o )");
    expect(art).toContain("sarah");
    expect(art).not.toMatch(/[●◐○]/);
  });
});

describe("renderRoster", () => {
  const peers = [
    { handle: "sarah", faceId: "fox", status: "online" as const, lastSeen: 1_717_000_108_000 },
    { handle: "max-1", faceId: "robot", status: "idle" as const, lastSeen: 1_716_999_820_000 },
    { handle: "kai", faceId: "ghost", status: "offline" as const, lastSeen: 1_716_913_720_000 },
  ];
  const now = 1_717_000_120_000;

  it("lists every handle with a relative time", () => {
    const out = stripAnsi(renderRoster(peers, { now, color: false }));
    expect(out).toContain("sarah");
    expect(out).toContain("max-1");
    expect(out).toContain("kai");
    expect(out).toContain("12s ago");
    expect(out).toContain("m ago");
    expect(out).toContain("d ago");
  });

  it("includes a header with the count by default", () => {
    const out = stripAnsi(renderRoster(peers, { now, color: false }));
    expect(out).toContain("who's online (3)");
  });

  it("can omit the header", () => {
    const out = stripAnsi(renderRoster(peers, { now, color: false, noHeader: true }));
    expect(out).not.toContain("who's online");
  });

  it("handles an empty room gracefully", () => {
    const out = stripAnsi(renderRoster([], { color: false }));
    expect(out.toLowerCase()).toContain("no one");
  });

  it("strips ANSI when colour is off and emits it when on", () => {
    expect(renderRoster(peers, { now, color: false }).includes(ESC)).toBe(false);
    expect(renderRoster(peers, { now, color: true }).includes(ESC)).toBe(true);
  });
});
