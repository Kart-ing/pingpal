import { afterEach, describe, expect, it } from "vitest";
import { startRelay, type RelayHandle } from "@pingpal/relay";
import { mintRoom, resolveCode, RoomControlError } from "./room-control.js";

describe("room-control (one-shot relay calls)", () => {
  let relay: RelayHandle;
  afterEach(async () => {
    await relay?.close();
  });

  it("mints a room and resolves its code back to the same roomId", async () => {
    relay = await startRelay({ port: 0 });
    const url = `ws://127.0.0.1:${relay.port}`;

    const { roomId, code } = await mintRoom(url);
    expect(roomId).toMatch(/^rm_/);
    expect(code).toMatch(/^[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{2}$/);

    const resolved = await resolveCode(url, code);
    expect(resolved).toBe(roomId);
  });

  it("resolves a messily-typed code (case/space) to the roomId", async () => {
    relay = await startRelay({ port: 0 });
    const url = `ws://127.0.0.1:${relay.port}`;
    const { roomId, code } = await mintRoom(url);
    expect(await resolveCode(url, `  ${code.toUpperCase()}  `)).toBe(roomId);
  });

  it("returns null for an unknown code (clean miss, not an error)", async () => {
    relay = await startRelay({ port: 0 });
    const url = `ws://127.0.0.1:${relay.port}`;
    expect(await resolveCode(url, "zzz-zzzz-zz")).toBeNull();
  });

  it("rejects with RoomControlError when the relay is unreachable", async () => {
    // Nothing is listening on this port.
    await expect(mintRoom("ws://127.0.0.1:9", { timeoutMs: 1500 })).rejects.toBeInstanceOf(
      RoomControlError,
    );
  });
});
