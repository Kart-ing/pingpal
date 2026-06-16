import { describe, expect, it } from "vitest";
import {
  genCode,
  newRoomId,
  normalizeCode,
  CODE_ALPHABET,
  CODE_LENGTH,
} from "./code.js";
import { joinCodeSchema, roomIdSchema } from "./schemas.js";

describe("genCode", () => {
  it("produces a grouped, dashed code that validates as a join code", () => {
    const code = genCode();
    expect(code).toMatch(/^[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{2}$/);
    expect(joinCodeSchema.safeParse(code).success).toBe(true);
  });

  it("uses only the unambiguous alphabet (no 0/o/1/l/i)", () => {
    for (let i = 0; i < 200; i++) {
      const dashless = normalizeCode(genCode());
      expect(dashless).toHaveLength(CODE_LENGTH);
      for (const ch of dashless) expect(CODE_ALPHABET).toContain(ch);
    }
    // Explicitly assert the confusable glyphs never appear.
    const blob = Array.from({ length: 200 }, () => normalizeCode(genCode())).join("");
    expect(blob).not.toMatch(/[01loi]/);
  });

  it("is overwhelmingly unique across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(genCode());
    // 1000 draws over ~31^9 space: collisions are astronomically unlikely.
    expect(seen.size).toBe(1000);
  });
});

describe("normalizeCode", () => {
  it("lowercases and strips dashes/spaces to the registry key form", () => {
    expect(normalizeCode("VMW-QKZT-PH")).toBe("vmwqkztph");
    expect(normalizeCode("  vmw-qkzt-ph ")).toBe("vmwqkztph");
    expect(normalizeCode("v m w q k z t p h")).toBe("vmwqkztph");
  });

  it("round-trips a generated code to a stable dashless key", () => {
    const code = genCode();
    const a = normalizeCode(code);
    const b = normalizeCode(code.toUpperCase());
    const c = normalizeCode(code.replace(/-/g, " "));
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
});

describe("newRoomId", () => {
  it("is a high-entropy, prefixed hex id that validates", () => {
    const id = newRoomId();
    expect(id).toMatch(/^rm_[0-9a-f]{32}$/);
    expect(roomIdSchema.safeParse(id).success).toBe(true);
  });

  it("is unique across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(newRoomId());
    expect(seen.size).toBe(1000);
  });

  it("is clearly distinct from a human join code", () => {
    const id = newRoomId();
    // A roomId must never be mistaken for (or accepted as) a short code shape.
    expect(id.length).toBeGreaterThan(20);
  });
});
