import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  faceIdSchema,
  handleSchema,
  roomCodeSchema,
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
 * Only `handle` and `roomCode` are required to run; everything else has a
 * sensible default.
 */
export const configFileSchema = z.object({
  handle: handleSchema,
  roomCode: roomCodeSchema,
  faceId: faceIdSchema.optional(),
  /** Relay URL override; `PINGPAL_RELAY` still takes precedence over this. */
  relayUrl: z.string().url().optional(),
  /** Optional shell command run (best-effort, detached) when a ping arrives. */
  notifyCommand: z.string().min(1).optional(),
  /** Set false to run relay-only and skip mDNS LAN discovery entirely. */
  lanDiscovery: z.boolean().optional(),
  /**
   * Optional room password. Folds into the E2E key (so it protects message
   * content) AND produces the relay auth proof (so wrong/missing passwords are
   * rejected at join — stopping room-code brute-forcing). `PINGPAL_PASSWORD`
   * env overrides this if you'd rather not store it on disk.
   */
  password: z.string().min(1).optional(),
});

export type ConfigFile = z.infer<typeof configFileSchema>;

/** Fully-resolved runtime config: defaults applied, env overrides folded in. */
export interface ResolvedConfig {
  readonly handle: string;
  readonly roomCode: string;
  readonly faceId: string;
  readonly relayUrl: string;
  readonly notifyCommand?: string;
  readonly lanDiscovery: boolean;
  readonly clientVersion: string;
  /** Room password (raw), or undefined for an open room. */
  readonly password?: string;
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
  const password =
    (env.PINGPAL_PASSWORD && env.PINGPAL_PASSWORD.trim()) || file.password || undefined;
  return {
    handle: file.handle,
    roomCode: file.roomCode,
    faceId: file.faceId ?? file.handle,
    relayUrl,
    notifyCommand: file.notifyCommand,
    lanDiscovery: file.lanDiscovery ?? true,
    clientVersion: CLIENT_VERSION,
    password,
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
  return resolveConfig(parsed.data, env);
}
