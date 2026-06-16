import {
  mintRoom,
  resolveConfig,
  RoomControlError,
  type PingPalPaths,
} from "@pingpal/daemon";
import { readConfig, updateConfig } from "../config-store.js";
import { startDaemon, stopDaemon } from "./daemon-control.js";
import { resolveIdentity } from "./identity.js";
import { facePreview } from "../prompt.js";

export interface StartRoomOptions {
  handle?: string;
  face?: string;
  /** Relay to mint the room on (else config/env/default). */
  relay?: string;
}

/**
 * `pingpal start-room` — create a brand-new room, Google-Meet style. Asks the
 * relay to mint a fresh roomId + short join code, stores them, starts the
 * daemon, and prints the code prominently so you can share it. A new code (and a
 * new, ephemeral room) every time — clean separation from `join`, which enters
 * an existing room by code.
 */
export async function startRoomCommand(
  paths: PingPalPaths,
  opts: StartRoomOptions = {},
): Promise<number> {
  const existing = await readConfig(paths);

  const identity = await resolveIdentity(existing, {
    handle: opts.handle,
    face: opts.face,
    greetNewcomer: true,
  });
  if (!identity) return 1;

  // Resolve the relay the same way the daemon will (flag > env > config > default).
  const relayUrl = resolveConfig(
    { handle: identity.handle, relayUrl: opts.relay ?? existing?.relayUrl },
  ).relayUrl;

  process.stdout.write(`pingpal: creating a room on ${relayUrl}…\n`);
  let minted;
  try {
    minted = await mintRoom(relayUrl);
  } catch (err) {
    const why = err instanceof RoomControlError ? err.message : String(err);
    process.stderr.write(
      `pingpal: couldn't create a room — ${why}\n` +
        `  (is the relay reachable? set PINGPAL_RELAY or pass --relay)\n`,
    );
    return 1;
  }

  // Persist: roomId is the secret, roomCode holds the short display code.
  const config = await updateConfig(paths, {
    roomId: minted.roomId,
    roomCode: minted.code,
    handle: identity.handle,
    faceId: identity.faceId,
    relayUrl: opts.relay ?? existing?.relayUrl,
  });

  // Bounce the daemon so it connects to the new room.
  await stopDaemon(paths);
  const code = await startDaemon(paths);

  const face = facePreview(config.faceId, config.handle);
  process.stdout.write(
    [
      "",
      "  🎉  Room created!",
      "  ────────────────────────────────────────",
      `  ${face}  you're @${config.handle}, hosting`,
      "",
      "  Share this code — teammates run:",
      "",
      `      pingpal join ${minted.code}`,
      "",
      "  The code works until everyone leaves the room, then it retires.",
      "",
    ].join("\n"),
  );
  if (code === 0) {
    process.stdout.write("  `pingpal status` to see who's around, `pingpal chat` to talk.\n");
  }
  return code;
}
