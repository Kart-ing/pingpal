import { describe, expect, it } from "vitest";
import { normalizeCode } from "@pingpal/protocol";
import { RoomDirectory } from "./directory.js";

describe("RoomDirectory", () => {
  it("mints a code+roomId and resolves the code back to the roomId", () => {
    const dir = new RoomDirectory();
    const { code, roomId } = dir.create();
    expect(roomId).toMatch(/^rm_/);
    expect(dir.resolve(code)).toBe(roomId);
  });

  it("resolves a messily-typed code (case / dashes / spaces) to the same roomId", () => {
    const dir = new RoomDirectory();
    const { code, roomId } = dir.create();
    expect(dir.resolve(code.toUpperCase())).toBe(roomId);
    expect(dir.resolve(`  ${code}  `)).toBe(roomId);
    expect(dir.resolve(normalizeCode(code))).toBe(roomId); // dashless form
  });

  it("returns null for an unknown code", () => {
    const dir = new RoomDirectory();
    dir.create();
    expect(dir.resolve("no-such-code")).toBeNull();
  });

  it("forgets a room's code once it empties (single-meeting codes)", () => {
    const dir = new RoomDirectory();
    const { code, roomId } = dir.create();
    expect(dir.resolve(code)).toBe(roomId);
    dir.forget(roomId);
    expect(dir.resolve(code)).toBeNull();
    expect(dir.size).toBe(0);
  });

  it("forget is a harmless no-op for rooms it never minted (legacy roomCode)", () => {
    const dir = new RoomDirectory();
    const { roomId } = dir.create();
    expect(() => dir.forget("rm_neverminted")).not.toThrow();
    // The real room is untouched.
    expect(dir.size).toBe(1);
    dir.forget(roomId);
    expect(dir.size).toBe(0);
  });

  it("hands out distinct codes/roomIds across many mints", () => {
    const dir = new RoomDirectory();
    const codes = new Set<string>();
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const { code, roomId } = dir.create();
      codes.add(normalizeCode(code));
      ids.add(roomId);
    }
    expect(codes.size).toBe(500);
    expect(ids.size).toBe(500);
  });
});
