import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  faceIdSchema,
  handleSchema,
  roomCodeSchema,
  roomIdSchema,
} from "@pingpal/protocol";
import type { PingPalPaths } from "./paths.js";

/**
 * The default relay URL. This is a documented placeholder — self-hosters set
 * `PINGPAL_RELAY` (or `relayUrl` in config.json) to their own instance, and the
 * project README points at the public instance the maintainer hosts.
 */
export const DEFAULT_RELAY_URL = "wss://pingpal-relay-production.up.railway.app" as const;

/**
 * On-disk config shape (`~/.pingpal/config.json`), written by `pingpal init`.
 *
 * `roomCode` is OPTIONAL on disk on purpose: `pingpal leave` clears it to record
 * the legitimate "I have an identity but I'm between rooms" state, and a user can
 * `pingpal init` a handle/face before ever joining. The *daemon* still requires a
 * room to run — {@link loadConfig} enforces that — but read-only commands
 * (`whoami`, `invite`) and the room-switcher (`join`) must be able to load a
 * roomless config without throwing. (Before this, leaving wedged the config so
 * even `join` couldn't read it to set the new room.)
 */
export const configFileSchema = z.object({
  handle: handleSchema,
  /**
   * The full-entropy room secret minted by `start-room` (Meet-style rooms). It
   * is the wire routing key AND the E2E key material. Optional on disk: absent
   * in the between-rooms state and in legacy configs (which only had `roomCode`).
   */
  roomId: roomIdSchema.optional(),
  /**
   * For Meet-style rooms this is the short, shareable DISPLAY code (e.g.
   * `vmw-qkzt-ph`) — shown by `whoami`/`invite`, never used as key material. For
   * legacy configs (pre-`roomId`) it's the old self-chosen room code, which then
   * doubles as the room secret for backward compatibility. Optional: `leave`
   * clears it to record the "between rooms" state.
   */
  roomCode: roomCodeSchema.optional(),
  faceId: faceIdSchema.optional(),
  /** Relay URL override; `PINGPAL_RELAY` still takes precedence over this. */
  relayUrl: z.string().url().optional(),
  /** Optional shell command run (best-effort, detached) when a ping arrives. */
  notifyCommand: z.string().min(1).optional(),
  /** Set false to run relay-only and skip mDNS LAN discovery entirely. */
  lanDiscovery: z.boolean().optional(),
});

export type ConfigFile = z.infer<typeof configFileSchema>;

/** Fully-resolved runtime config: defaults applied, env overrides folded in. */
export interface ResolvedConfig {
  readonly handle: string;
  /**
   * The room key sent on the wire and run through HKDF for E2E. For Meet-style
   * rooms this is the minted `roomId`; for legacy rooms it's the old `roomCode`
   * (promoted here), so both paths encrypt/route identically downstream.
   */
  readonly roomId: string;
  /** Short, human-shareable code for display (may equal roomId for legacy rooms). */
  readonly displayCode: string;
  readonly faceId: string;
  readonly relayUrl: string;
  readonly notifyCommand?: string;
  readonly lanDiscovery: boolean;
  readonly clientVersion: string;
}

/** Version reported to the relay in the `hello` frame. */
const CLIENT_VERSION = "0.1.0";

/**
 * Resolve a {@link ConfigFile} into a {@link ResolvedConfig}, applying defaults
 * and honouring the `PINGPAL_RELAY` environment override (which wins over the
 * file). A handle without a face gets one derived from the handle so it is at
 * least stable — the faces package hashes the handle the same way.
 */
export function resolveConfig(
  file: ConfigFile,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const relayUrl =
    (env.PINGPAL_RELAY && env.PINGPAL_RELAY.trim()) ||
    file.relayUrl ||
    DEFAULT_RELAY_URL;
  // Room identity, unifying Meet-style and legacy configs:
  //  • new config has `roomId` (secret) + `roomCode` (short display code);
  //  • legacy config has only `roomCode`, which we PROMOTE to be the roomId so
  //    its wire-routing and E2E key derivation are byte-for-byte unchanged.
  // Empty strings mark "no room" for callers that only need other fields (e.g.
  // `invite` resolving the relay). The daemon path asserts a real room in
  // `loadConfig` before reaching here, so it never sees the empty fallback.
  const roomId = file.roomId ?? file.roomCode ?? "";
  const displayCode = file.roomCode ?? file.roomId ?? "";
  return {
    handle: file.handle,
    roomId,
    displayCode,
    faceId: file.faceId ?? file.handle,
    relayUrl,
    notifyCommand: file.notifyCommand,
    lanDiscovery: file.lanDiscovery ?? true,
    clientVersion: CLIENT_VERSION,
  };
}

/** Thrown when config is missing or malformed, with a user-facing message. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Read and validate `~/.pingpal/config.json`, returning a {@link ResolvedConfig}.
 * Throws {@link ConfigError} with a friendly message if the file is absent or
 * fails validation — the CLI surfaces this as "run `pingpal init` first".
 */
export async function loadConfig(
  paths: PingPalPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConfig> {
  let raw: string;
  try {
    raw = await readFile(paths.config, "utf8");
  } catch {
    throw new ConfigError(
      `no config found at ${paths.config} — run \`pingpal init\` first`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`config at ${paths.config} is not valid JSON`, {
      cause,
    });
  }
  const parsed = configFileSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ConfigError(
      `config at ${paths.config} is invalid: ${first?.message ?? "schema error"}`,
    );
  }
  // The schema allows a roomless config (the "between rooms" state after
  // `leave`), but the daemon can't run without a room — surface a clear message
  // instead of failing deeper with a confusing error. A room is present if
  // either the Meet-style `roomId` or a legacy `roomCode` is set.
  if (!parsed.data.roomId && !parsed.data.roomCode) {
    throw new ConfigError(
      `not in a room — \`pingpal start-room\` or \`pingpal join <code>\` before starting the daemon`,
    );
  }
  return resolveConfig(parsed.data, env);
}
