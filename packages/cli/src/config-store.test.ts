import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths, type PingPalPaths } from "@pingpal/daemon";
import { readConfig, updateConfig, writeConfig } from "./config-store.js";

describe("config-store", () => {
  let home: string;
  let paths: PingPalPaths;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pingpal-cli-"));
    paths = resolvePaths(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("returns null when no config exists yet", async () => {
    expect(await readConfig(paths)).toBeNull();
  });

  it("round-trips a written config", async () => {
    await writeConfig(paths, { handle: "sarah", roomCode: "open-sesame", faceId: "fox" });
    const read = await readConfig(paths);
    expect(read).toEqual({ handle: "sarah", roomCode: "open-sesame", faceId: "fox" });
  });

  it("rejects an invalid handle on write", async () => {
    await expect(
      writeConfig(paths, { handle: "no spaces!", roomCode: "abcd" }),
    ).rejects.toThrow();
  });

  it("updateConfig merges a patch and preserves untouched keys", async () => {
    await writeConfig(paths, { handle: "sarah", roomCode: "room-one", faceId: "cat" });
    const updated = await updateConfig(paths, { roomCode: "room-two" });
    expect(updated).toEqual({ handle: "sarah", roomCode: "room-two", faceId: "cat" });
    // undefined values in the patch don't clobber existing keys
    const again = await updateConfig(paths, { handle: undefined, roomCode: "room-three" });
    expect(again.handle).toBe("sarah");
    expect(again.faceId).toBe("cat");
  });

  it("creates the config from an update when none existed (with a handle)", async () => {
    const created = await updateConfig(paths, { handle: "neo", roomCode: "matrix" });
    expect(created).toEqual({ handle: "neo", roomCode: "matrix" });
  });
});
