import { sendRequest, IpcClientError } from "@pingpal/daemon";
import type { PingPalPaths } from "@pingpal/daemon";

export async function filesCommand(paths: PingPalPaths): Promise<number> {
  try {
    const files = await sendRequest(paths, "listFiles");
    if (files.length === 0) {
      process.stdout.write("No received files.\n");
      return 0;
    }

    process.stdout.write(`Received files (${files.length}):\n`);
    for (const f of files) {
      const when = relativeTime(f.savedAt, Date.now());
      process.stdout.write(
        `  ${f.name}  (${formatSize(f.size)})  from @${f.from}  ${when}\n` +
        `    → ${f.path}\n`,
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof IpcClientError && err.code === "unreachable") {
      process.stderr.write(
        "pingpal: daemon not running — start it with `pingpal start`.\n",
      );
      return 1;
    }
    process.stderr.write(
      `pingpal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
