import { sendRequest, type PingPalPaths } from "@pingpal/daemon";

/**
 * `pingpal statusline` — print a single-line, live who's-online roster for use
 * as a Claude Code statusline `command` (ideally with `refreshInterval` so it
 * updates on its own). Output is one line: colored presence dots + handles, and
 * an unread badge when pings are waiting. Designed to be FAST and to NEVER throw
 * — a statusline that errors or hangs is worse than one that says nothing — so
 * every failure path degrades to empty output and exit 0.
 *
 * Claude Code pipes a JSON blob on stdin; we ignore it (the roster comes from
 * the local daemon, not the session), but we read+discard so the pipe closes.
 *
 * Credit: the notion of an ambient, living status line — the most-watched strip
 * of the terminal — is owed to Kickbacks.ai (https://kickbacks.ai). PingPal is
 * built to COEXIST with it: when Kickbacks (the `vibe-ads` status line) is
 * present, PingPal registers this command as Kickbacks' downstream chained
 * status line so the sponsor line and the room roster stack instead of
 * clobbering each other. Earn while you wait; see your team while you code.
 */

const DOT = { online: "●", idle: "◐", offline: "○" } as const;
// 24-bit-safe basic ANSI; respects NO_COLOR. green / yellow / dim-grey.
const COLOR = { online: "\x1b[32m", idle: "\x1b[33m", offline: "\x1b[90m" } as const;
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function paint(s: string, code: string, useColor: boolean): string {
  return useColor ? `${code}${s}${RESET}` : s;
}

/** Drain stdin (the statusline JSON) without blocking; we don't need its contents. */
function drainStdin(): void {
  try {
    process.stdin.resume();
    process.stdin.on("data", () => {});
    process.stdin.on("error", () => {});
  } catch {
    /* no stdin is fine */
  }
}

export async function statuslineCommand(paths: PingPalPaths): Promise<number> {
  drainStdin();
  const useColor = !process.env.NO_COLOR;

  let handle = "";
  let unread = 0;
  let peers: Array<{ handle: string; status: "online" | "idle" | "offline" }> = [];

  try {
    const status = await sendRequest(paths, "status");
    handle = status.handle;
    unread = status.unread ?? 0;
  } catch {
    // daemon down → render nothing (don't clutter the bar with errors)
    return 0;
  }
  try {
    const res = await sendRequest(paths, "getPresence");
    peers = res.peers
      .filter((p) => p.handle !== handle)
      .sort((a, b) => {
        const rank = { online: 0, idle: 1, offline: 2 } as const;
        return rank[a.status] - rank[b.status] || a.handle.localeCompare(b.handle);
      });
  } catch {
    /* roster optional */
  }

  const label = paint("PingPal", DIM, useColor);
  let line: string;
  if (peers.length === 0) {
    line = `${label} ${paint("· room empty", DIM, useColor)}`;
  } else {
    const cells = peers.map((p) => {
      const dot = paint(DOT[p.status], COLOR[p.status], useColor);
      const name =
        p.status === "offline"
          ? paint(p.handle, DIM, useColor)
          : paint(p.handle, CYAN, useColor);
      return `${dot} ${name}`;
    });
    line = `${label}  ${cells.join("  ")}`;
  }
  if (unread > 0) {
    line += `  ${paint(`📨${unread}`, CYAN, useColor)}`;
  }

  process.stdout.write(line);
  return 0;
}
