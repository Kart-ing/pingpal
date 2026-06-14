#!/usr/bin/env node
/**
 * `pingpald` — the PingPal daemon CLI.
 *
 *   pingpald start         start the daemon in the background (detached)
 *   pingpald stop          stop a running daemon
 *   pingpald status        report whether it's running + a presence summary
 *   pingpald --foreground  run in the foreground (what `start` spawns)
 *
 * The foreground process owns the pidfile at `~/.pingpal/daemon.pid`: it writes
 * it once the IPC server is listening and removes it on a clean shutdown, so the
 * pidfile's presence means "ready to serve", not merely "spawned".
 */
import {
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig, ConfigError } from "./config.js";
import { resolvePaths, type PingPalPaths } from "./paths.js";
import { Daemon } from "./daemon.js";
import { sendRequest, IpcClientError } from "./ipc-client.js";

function logPath(paths: PingPalPaths): string {
  return join(paths.home, "daemon.log");
}

/** Read the pid from the pidfile, or null if absent/unparsable. */
function readPid(paths: PingPalPaths): number | null {
  try {
    const pid = Number(readFileSync(paths.pid, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Is a process with this pid alive? (EPERM ⇒ exists but owned by another user.) */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The running pid if the daemon is up, else null (cleaning a stale pidfile). */
function runningPid(paths: PingPalPaths): number | null {
  const pid = readPid(paths);
  if (pid === null) return null;
  if (isAlive(pid)) return pid;
  // Stale pidfile from a crash — clean it up.
  try {
    rmSync(paths.pid, { force: true });
  } catch {
    /* ignore */
  }
  return null;
}

/** Run the daemon in this process until a signal stops it. */
async function runForeground(paths: PingPalPaths): Promise<void> {
  let config;
  try {
    config = await loadConfig(paths);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`pingpald: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const existing = runningPid(paths);
  if (existing !== null && existing !== process.pid) {
    console.error(`pingpald: already running (pid ${existing})`);
    process.exit(1);
  }

  const daemon = new Daemon(config, paths);
  const addr = await daemon.start();
  writeFileSync(paths.pid, String(process.pid), "utf8");

  const where = addr.socketPath ?? `127.0.0.1:${addr.port}`;
  console.log(
    `pingpald: up as @${config.handle} in room (${config.roomCode.slice(0, 4)}…), ` +
      `relay ${config.relayUrl}, IPC ${where}`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`pingpald: ${signal} received, shutting down…`);
    void daemon
      .stop()
      .catch(() => {})
      .finally(() => {
        try {
          rmSync(paths.pid, { force: true });
        } catch {
          /* ignore */
        }
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** Spawn a detached foreground daemon and wait for its pidfile to appear. */
async function startBackground(paths: PingPalPaths): Promise<void> {
  const existing = runningPid(paths);
  if (existing !== null) {
    console.log(`pingpald: already running (pid ${existing})`);
    return;
  }
  // Fail fast on missing config rather than spawning a child that exits.
  try {
    await loadConfig(paths);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`pingpald: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const self = fileURLToPath(import.meta.url);
  const out = openSync(logPath(paths), "a");
  const child = spawn(process.execPath, [self, "--foreground"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();

  // Wait (up to ~5s) for the child to write its pidfile = IPC is listening.
  for (let i = 0; i < 50; i += 1) {
    await sleep(100);
    const pid = runningPid(paths);
    if (pid !== null) {
      console.log(`pingpald: started (pid ${pid}) — logs at ${logPath(paths)}`);
      return;
    }
    if (child.exitCode !== null && child.exitCode !== 0) {
      console.error(
        `pingpald: failed to start (see ${logPath(paths)})`,
      );
      process.exitCode = 1;
      return;
    }
  }
  console.error(`pingpald: timed out waiting for daemon (see ${logPath(paths)})`);
  process.exitCode = 1;
}

/** Stop a running daemon and wait for it to exit. */
async function stop(paths: PingPalPaths): Promise<void> {
  const pid = runningPid(paths);
  if (pid === null) {
    console.log("pingpald: not running");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    console.log("pingpald: not running");
    return;
  }
  for (let i = 0; i < 50; i += 1) {
    await sleep(100);
    if (!isAlive(pid)) {
      try {
        rmSync(paths.pid, { force: true });
      } catch {
        /* ignore */
      }
      console.log(`pingpald: stopped (pid ${pid})`);
      return;
    }
  }
  console.error(`pingpald: pid ${pid} did not exit; sending SIGKILL`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Print whether the daemon is running and, if so, a presence summary. */
async function status(paths: PingPalPaths): Promise<void> {
  const pid = runningPid(paths);
  if (pid === null) {
    console.log("pingpald: not running");
    process.exitCode = 1;
    return;
  }
  try {
    const s = await sendRequest(paths, "status");
    console.log(`pingpald: running (pid ${pid})`);
    console.log(`  handle:  @${s.handle}`);
    console.log(`  relay:   ${s.relayUrl} ${s.relayConnected ? "✓ connected" : "✗ offline"}`);
    console.log(`  LAN:     ${s.lanEnabled ? "on" : "off"} (${s.lanPeerCount} peer${s.lanPeerCount === 1 ? "" : "s"})`);
    console.log(`  peers:   ${s.relayPeerCount} via relay`);
    console.log(`  unread:  ${s.unread}`);
  } catch (err) {
    const msg = err instanceof IpcClientError ? err.message : String(err);
    console.log(`pingpald: running (pid ${pid}) but IPC not responding: ${msg}`);
    process.exitCode = 1;
  }
}

function usage(): void {
  console.log(
    [
      "pingpald — the PingPal daemon",
      "",
      "Usage:",
      "  pingpald start         start the daemon in the background",
      "  pingpald stop          stop the running daemon",
      "  pingpald status        show daemon + presence status",
      "  pingpald --foreground  run in the foreground (used by `start`)",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const paths = resolvePaths();
  const cmd = process.argv[2];
  switch (cmd) {
    case "--foreground":
    case "foreground":
      await runForeground(paths);
      return;
    case "start":
      await startBackground(paths);
      return;
    case "stop":
      await stop(paths);
      return;
    case "status":
      await status(paths);
      return;
    case "-h":
    case "--help":
    case "help":
    case undefined:
      usage();
      return;
    default:
      console.error(`pingpald: unknown command '${cmd}'`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error("pingpald: fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
