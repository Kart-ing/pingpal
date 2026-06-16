import { readFile, writeFile } from "node:fs/promises";
import type { PingPalPaths } from "@pingpal/daemon";
import { stopDaemon } from "./daemon-control.js";

/**
 * `pingpal leave` — leave the current room: stop the daemon (which drops you
 * from presence) and clear the room (and its password) from config so a later
 * `pingpal start` doesn't silently rejoin. Your handle + face are kept, so
 * `pingpal join <room>` gets you back into action quickly.
 */
export async function leaveCommand(paths: PingPalPaths): Promise<number> {
  // Stop the daemon first so we actually disconnect from the room.
  await stopDaemon(paths);

  // Clear roomCode + password from the on-disk config (keep handle/face/relay).
  let raw: string;
  try {
    raw = await readFile(paths.config, "utf8");
  } catch {
    process.stdout.write("pingpal: not in a room (no config).\n");
    return 0;
  }
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(raw);
  } catch {
    process.stdout.write("pingpal: config unreadable — left the room (daemon stopped).\n");
    return 0;
  }

  const wasIn = typeof cfg.roomCode === "string" ? cfg.roomCode : null;
  delete cfg.roomCode;
  delete cfg.password;
  await writeFile(paths.config, JSON.stringify(cfg, null, 2) + "\n", "utf8");

  if (wasIn) {
    process.stdout.write(
      `pingpal: left room ${wasIn.slice(0, 4)}…  ` +
        `(rejoin with \`pingpal join <room>\`)\n`,
    );
  } else {
    process.stdout.write("pingpal: not in a room.\n");
  }
  return 0;
}
