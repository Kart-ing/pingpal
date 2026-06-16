import { joinCodeSchema, roomCodeSchema } from "@pingpal/protocol";
import {
  resolveCode,
  resolveConfig,
  RoomControlError,
  type PingPalPaths,
} from "@pingpal/daemon";
import { ZodError, z } from "zod";
import { readConfig, updateConfig } from "../config-store.js";
import { startDaemon, stopDaemon } from "./daemon-control.js";
import { resolveIdentity } from "./identity.js";
import { facePreview } from "../prompt.js";

export interface JoinOptions {
  handle?: string;
  /** Relay URL to use for this room (from an invite). Persisted to config. */
  relay?: string;
  /** Face id; otherwise prompted (newcomer) or kept (returning user). */
  face?: string;
  /**
   * Treat the argument as a raw legacy room code (the pre-Meet model where the
   * typed string IS the room secret), skipping relay code resolution. For old
   * invites and self-hosted rooms created before `start-room`.
   */
  legacy?: boolean;
}

const relayUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((u) => /^wss?:\/\//i.test(u), "relay must be a ws:// or wss:// URL");

/**
 * `pingpal join <code>` — enter an existing room by its short join code
 * (Meet-style). The code is resolved to a roomId via the relay, then we connect
 * by roomId like everyone else. Doubles as the room-switcher and the newcomer
 * entry point: when interactive and an identity is missing, it runs a short
 * guided first-run (handle, then face).
 *
 * Backward compatibility: a `--legacy` code (or a code the relay can't resolve,
 * when the user opts in) is stored as a raw room code — the old model where the
 * typed string is itself the room secret — so pre-`start-room` invites keep
 * working.
 */
export async function joinCommand(
  paths: PingPalPaths,
  rawArg: string,
  opts: JoinOptions,
): Promise<number> {
  let relay: string | undefined;
  try {
    relay = opts.relay ? relayUrlSchema.parse(opts.relay) : undefined;
  } catch (err) {
    if (err instanceof ZodError) {
      process.stderr.write(`pingpal: ${err.issues[0]?.message ?? "invalid relay"}\n`);
      return 1;
    }
    throw err;
  }

  const existing = await readConfig(paths);
  const identity = await resolveIdentity(existing, {
    handle: opts.handle,
    face: opts.face,
    greetNewcomer: existing === null,
  });
  if (!identity) return 1;

  // The relay we'll resolve the code on (and the daemon will use).
  const relayUrl = resolveConfig({
    handle: identity.handle,
    relayUrl: relay ?? existing?.relayUrl,
  }).relayUrl;

  // -- Legacy path: the typed string IS the room (old model). ----------------
  if (opts.legacy) {
    const parsed = roomCodeSchema.safeParse(rawArg);
    if (!parsed.success) {
      process.stderr.write(`pingpal: ${parsed.error.issues[0]?.message ?? "invalid room code"}\n`);
      return 1;
    }
    return enter(paths, {
      roomId: parsed.data, // legacy: roomCode doubles as the secret
      displayCode: parsed.data,
      identity,
      relay: relay ?? existing?.relayUrl,
      newcomer: existing === null,
      note: " (legacy room)",
    });
  }

  // -- Meet path: resolve the short code → roomId via the relay. -------------
  const code = joinCodeSchema.safeParse(rawArg);
  if (!code.success) {
    process.stderr.write(`pingpal: ${code.error.issues[0]?.message ?? "invalid join code"}\n`);
    return 1;
  }

  process.stdout.write(`pingpal: looking up room ${rawArg} on ${relayUrl}…\n`);
  let roomId: string | null;
  try {
    roomId = await resolveCode(relayUrl, code.data);
  } catch (err) {
    const why = err instanceof RoomControlError ? err.message : String(err);
    process.stderr.write(
      `pingpal: couldn't reach the relay to look up that code — ${why}\n` +
        `  (check your connection, or pass --relay <url> from the invite)\n`,
    );
    return 1;
  }

  if (roomId === null) {
    process.stderr.write(
      `pingpal: no room found for code “${rawArg}”.\n` +
        "  • Codes are case-insensitive but must be exact.\n" +
        "  • A room's code retires once everyone has left — ask for a fresh one.\n" +
        "  • Joining a pre-Meet/self-hosted room? re-run with --legacy.\n",
    );
    return 1;
  }

  return enter(paths, {
    roomId,
    displayCode: rawArg,
    identity,
    relay: relay ?? existing?.relayUrl,
    newcomer: existing === null,
  });
}

/** Shared tail: persist the room, (re)start the daemon, print confirmation. */
async function enter(
  paths: PingPalPaths,
  args: {
    roomId: string;
    displayCode: string;
    identity: { handle: string; faceId?: string };
    relay?: string;
    newcomer: boolean;
    note?: string;
  },
): Promise<number> {
  try {
    const config = await updateConfig(paths, {
      roomId: args.roomId,
      roomCode: args.displayCode,
      handle: args.identity.handle,
      faceId: args.identity.faceId,
      relayUrl: args.relay,
    });
    if (args.newcomer) {
      process.stdout.write(
        `\n${facePreview(config.faceId, config.handle)}  you're set as @${config.handle}\n`,
      );
    }
    process.stdout.write(
      `pingpal: @${config.handle} joining ${args.displayCode}${args.note ?? ""}\n`,
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

  await stopDaemon(paths);
  const code = await startDaemon(paths);
  if (code === 0) {
    process.stdout.write("  connected. `pingpal status` to see who's around, `pingpal chat` to talk.\n");
  }
  return code;
}
