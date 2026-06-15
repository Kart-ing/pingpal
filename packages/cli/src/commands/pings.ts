import {
  IpcClientError,
  sendRequest,
  type PingPalPaths,
} from "@pingpal/daemon";
import { renderPing, formatRelative } from "@pingpal/faces";

export interface PingsOptions {
  /** Mark the shown pings as read (default true). Pass false to peek. */
  markRead?: boolean;
  /** Print a directive header telling the assistant to surface them (for /loop). */
  announce?: boolean;
  /** When there's nothing new, stay completely silent (exit 0, no output). */
  quietWhenEmpty?: boolean;
}

/**
 * `pingpal pings` — show unread pings as rendered ASCII faces and (by default)
 * mark them read. Designed to be the unit a `/loop` runs on a timer: with
 * `--announce` it prepends an instruction so the assistant surfaces the pings,
 * and with `--quiet-when-empty` it prints nothing when the inbox is clear so a
 * once-a-minute loop doesn't spam the session.
 */
export async function pingsCommand(
  paths: PingPalPaths,
  opts: PingsOptions = {},
): Promise<number> {
  const markRead = opts.markRead ?? true;

  // Build a handle -> faceId map from presence so a ping shows the SENDER's
  // chosen face, not one hashed from their handle. Best-effort.
  const faceByHandle = new Map<string, string>();
  try {
    const { peers } = await sendRequest(paths, "getPresence");
    for (const p of peers) if (p.faceId) faceByHandle.set(p.handle, p.faceId);
  } catch {
    /* presence is optional; fall back to handle-hash faces */
  }

  let pings;
  try {
    const res = await sendRequest(paths, "getPings", { markRead });
    pings = res.pings;
  } catch (err) {
    if (err instanceof IpcClientError && err.code === "unreachable") {
      if (opts.quietWhenEmpty) return 0; // a loop tick with no daemon: stay silent
      process.stdout.write("pingpal: daemon not running — start it with `pingpal start`.\n");
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pingpal: could not reach daemon: ${msg}\n`);
    return 1;
  }

  // Only incoming unread pings — our own sent (outbound) ones never "arrive".
  const unread = (pings ?? []).filter((p) => p && p.read === false && !p.outbound);
  if (unread.length === 0) {
    if (!opts.quietWhenEmpty) process.stdout.write("pingpal: no new pings.\n");
    return 0;
  }

  const blocks = unread.map((p) => {
    const faceId = faceByHandle.get(p.from);
    return renderPing({
      handle: p.from,
      ...(faceId ? { faceId } : {}),
      // Buffered pings are decrypted to plaintext by the daemon; default guards
      // the (shouldn't-happen) case of a stored ping without text.
      text: p.text ?? "🔒 [encrypted]",
      status: "online",
      lastSeenText: formatRelative(p.ts),
    });
  });

  let out = "";
  if (opts.announce) {
    const n = unread.length;
    const senders = [...new Set(unread.map((p) => p.from))].join(", ");
    out +=
      `[PingPal] ${n} new ping${n === 1 ? "" : "s"} just arrived (from ${senders}). ` +
      `Show the user ${n === 1 ? "this message" : "these messages"} right now, ` +
      `rendering the block(s) below verbatim, before anything else:\n\n`;
  }
  out += blocks.join("\n\n");
  process.stdout.write(`\n${out}\n`);
  return 0;
}
