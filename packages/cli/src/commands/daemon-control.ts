import { spawn } from "node:child_process";
import {
  IpcClientError,
  sendRequest,
  type PingPalPaths,
} from "@pingpal/daemon";
import { renderRoster, type RosterPeer } from "@pingpal/faces";
import { daemonBin } from "../resolve-bins.js";
import { readConfig } from "../config-store.js";

/**
 * Run `pingpald <sub>` (start/stop) as a child, inheriting stdio so the
 * daemon's own progress lines reach the user. We delegate process lifecycle to
 * `pingpald` rather than reimplementing pidfile handling here.
 */
function runDaemon(sub: "start" | "stop", paths: PingPalPaths): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [daemonBin(), sub], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (err) => {
      process.stderr.write(`pingpal: could not launch pingpald: ${err.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

/** `pingpal start` — ensure config exists, then start the daemon if not up. */
export async function startDaemon(paths: PingPalPaths): Promise<number> {
  if ((await readConfig(paths)) === null) {
    process.stderr.write("pingpal: no config yet — run `pingpal init` first.\n");
    return 1;
  }
  return runDaemon("start", paths);
}

/** `pingpal stop` — stop the running daemon. */
export async function stopDaemon(paths: PingPalPaths): Promise<number> {
  return runDaemon("stop", paths);
}

/**
 * `pingpal status` — query the daemon over IPC and print a branded summary plus
 * a who's-online roster. Exits non-zero (quietly) when the daemon isn't up.
 */
export async function statusDaemon(paths: PingPalPaths): Promise<number> {
  let status;
  try {
    status = await sendRequest(paths, "status");
  } catch (err) {
    if (err instanceof IpcClientError && err.code === "unreachable") {
      process.stdout.write("pingpal: daemon not running — start it with `pingpal start`.\n");
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pingpal: could not reach daemon: ${msg}\n`);
    return 1;
  }

  const relay = status.relayConnected ? "connected" : "offline";
  const lan = status.lanEnabled ? `on, ${status.lanPeerCount} peer(s)` : "off";
  const lines = [
    `pingpal: @${status.handle} is up`,
    `  relay:  ${status.relayUrl} (${relay})`,
    `  LAN:    ${lan}`,
    `  unread: ${status.unread}`,
  ];
  if (status.authError) {
    lines.push(
      `  🔒 room rejected: ${status.authError}`,
      `     re-join with: pingpal join ${status.roomCode} --password <pw>`,
    );
  }
  lines.push("");
  process.stdout.write(lines.join("\n"));
  if (status.authError) return 1; // rejected → no roster to show

  try {
    const { peers } = await sendRequest(paths, "getPresence");
    const roster: RosterPeer[] = peers
      .filter((p) => p.handle !== status.handle)
      .map((p) => ({
        handle: p.handle,
        faceId: p.faceId,
        status: p.status,
        lastSeen: p.lastSeen,
      }));
    process.stdout.write(`${renderRoster(roster)}\n`);
  } catch {
    /* roster is a nice-to-have; the status above is the point */
  }
  return 0;
}
