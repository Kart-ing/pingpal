import { handleSchema, roomCodeSchema } from "@pingpal/protocol";
import type { PingPalPaths } from "@pingpal/daemon";
import { ZodError } from "zod";
import { readConfig, updateConfig } from "../config-store.js";
import { startDaemon, stopDaemon } from "./daemon-control.js";

export interface JoinOptions {
  handle?: string;
}

/**
 * `pingpal join <room> [--handle h]` — switch (or set) the room, optionally the
 * handle, then bounce the daemon so it reconnects with the new identity. Needs a
 * handle from somewhere: a prior config or the `--handle` flag.
 */
export async function joinCommand(
  paths: PingPalPaths,
  room: string,
  opts: JoinOptions,
): Promise<number> {
  const roomCode = roomCodeSchema.parse(room);
  const handle = opts.handle ? handleSchema.parse(opts.handle) : undefined;

  if (handle === undefined && (await readConfig(paths)) === null) {
    process.stderr.write(
      "pingpal: no handle yet — run `pingpal init` first, or pass --handle.\n",
    );
    return 1;
  }

  try {
    const config = await updateConfig(paths, { roomCode, handle });
    process.stdout.write(`pingpal: @${config.handle} joining room (${roomCode.slice(0, 4)}…)\n`);
  } catch (err) {
    if (err instanceof ZodError) {
      process.stderr.write(
        `pingpal: ${err.issues[0]?.message ?? "invalid config"} — run \`pingpal init\` first.\n`,
      );
      return 1;
    }
    throw err;
  }

  // Bounce the daemon so it picks up the new room. stop is a no-op if it's down.
  await stopDaemon(paths);
  return startDaemon(paths);
}
