import { configFileSchema, type ConfigFile, type PingPalPaths } from "@pingpal/daemon";
import { readJson, writeJson } from "./jsonfile.js";

/**
 * The CLI owns *writing* `~/.pingpal/config.json`; the daemon owns reading it.
 * Both validate against the same {@link configFileSchema} so a config the CLI
 * writes is always one the daemon can load.
 */

/** Read and validate the config file, or `null` if it doesn't exist yet. */
export async function readConfig(paths: PingPalPaths): Promise<ConfigFile | null> {
  const raw = await readJson<unknown | null>(paths.config, null);
  if (raw === null) return null;
  return configFileSchema.parse(raw);
}

/** Validate and write the config file (pretty-printed, dirs created). */
export async function writeConfig(
  paths: PingPalPaths,
  config: ConfigFile,
): Promise<ConfigFile> {
  const valid = configFileSchema.parse(config);
  await writeJson(paths.config, valid);
  return valid;
}

/**
 * Read the existing config (if any), apply a partial patch, then validate and
 * write the result. Used by `join` to switch room while keeping the handle/face.
 * Keys set to `undefined` in the patch are ignored (existing values survive).
 */
export async function updateConfig(
  paths: PingPalPaths,
  patch: Partial<ConfigFile>,
): Promise<ConfigFile> {
  const current = (await readConfig(paths)) ?? {};
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  return writeConfig(paths, merged as ConfigFile);
}
