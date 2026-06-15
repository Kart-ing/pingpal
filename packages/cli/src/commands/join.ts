import { handleSchema, roomCodeSchema, faceIdSchema } from "@pingpal/protocol";
import type { PingPalPaths } from "@pingpal/daemon";
import { ZodError, z } from "zod";
import { readConfig, updateConfig } from "../config-store.js";
import { startDaemon, stopDaemon } from "./daemon-control.js";
import {
  facePreview,
  isInteractive,
  promptFace,
  promptValidated,
} from "../prompt.js";

export interface JoinOptions {
  handle?: string;
  /** Relay URL to use for this room (from an invite). Persisted to config. */
  relay?: string;
  /** Face id; otherwise prompted (newcomer) or kept (returning user). */
  face?: string;
}

const relayUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((u) => /^wss?:\/\//i.test(u), "relay must be a ws:// or wss:// URL");

/**
 * `pingpal join <room>` — the newcomer's entry point (and room-switcher for
 * existing users). Sets the room (and optional relay from an invite), then makes
 * sure we have a handle + face: when interactive and either is missing, it runs
 * a short guided first-run (prompt for handle, then pick a face) so someone who
 * just pasted an invite gets walked through setup. Finally it (re)starts the
 * daemon so presence + pings come alive. Non-interactive still works via flags.
 */
export async function joinCommand(
  paths: PingPalPaths,
  room: string,
  opts: JoinOptions,
): Promise<number> {
  let roomCode: string;
  let relay: string | undefined;
  try {
    roomCode = roomCodeSchema.parse(room);
    relay = opts.relay ? relayUrlSchema.parse(opts.relay) : undefined;
  } catch (err) {
    if (err instanceof ZodError) {
      process.stderr.write(`pingpal: ${err.issues[0]?.message ?? "invalid input"}\n`);
      return 1;
    }
    throw err;
  }

  const existing = await readConfig(paths);
  const newcomer = existing === null;
  const interactive = isInteractive();

  // Resolve a handle: flag → existing config → prompt → error.
  let handle = opts.handle ? handleSchema.parse(opts.handle) : existing?.handle;
  if (!handle) {
    if (!interactive) {
      process.stderr.write(
        "pingpal: no handle — pass --handle, or run `pingpal join` interactively.\n",
      );
      return 1;
    }
    if (newcomer) {
      process.stdout.write("\n  👋  Welcome to PingPal — let's get you into the room.\n\n");
    }
    handle = await promptValidated("Your handle", handleSchema);
  }

  // Resolve a face: flag → existing → prompt (newcomers only) → leave unset.
  let faceId = opts.face ? faceIdSchema.parse(opts.face) : existing?.faceId;
  if (!faceId && interactive) {
    faceId = await promptFace(handle);
  }

  try {
    const config = await updateConfig(paths, { roomCode, handle, faceId, relayUrl: relay });
    if (interactive && newcomer) {
      process.stdout.write(
        `\n${facePreview(config.faceId, config.handle)}  you're set as @${config.handle}\n`,
      );
    }
    const relayNote = relay ? ` via ${relay}` : "";
    process.stdout.write(
      `pingpal: @${config.handle} joining room (${roomCode.slice(0, 4)}…)${relayNote}\n`,
    );
  } catch (err) {
    if (err instanceof ZodError) {
      process.stderr.write(
        `pingpal: ${err.issues[0]?.message ?? "invalid config"} — run \`pingpal init\` first.\n`,
      );
      return 1;
    }
    throw err;
  }

  // Bounce the daemon so it picks up the new room/relay. stop is a no-op if down.
  await stopDaemon(paths);
  const code = await startDaemon(paths);
  if (code === 0) {
    process.stdout.write("  connected. `pingpal status` to see who's around, `pingpal chat` to talk.\n");
  }
  return code;
}
