import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Read a JSON file, returning `fallback` when the file is absent. Any other
 * error (permission, malformed JSON) is thrown — we never want to silently
 * clobber a settings file we merely failed to parse.
 */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
  if (raw.trim() === "") return fallback;
  return JSON.parse(raw) as T;
}

/**
 * Write `value` as pretty JSON, creating parent directories as needed. The
 * write is atomic-ish: we write a sibling temp file and rename over the target
 * so a crash mid-write can't leave a half-written settings file behind.
 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${path}.pingpal-tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}
