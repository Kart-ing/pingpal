import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The set of files PingPal keeps under its home directory (default
 * `~/.pingpal`). Every path is derived from a single base so tests can point
 * the whole daemon at a throwaway directory via `PINGPAL_HOME`.
 */
export interface PingPalPaths {
  /** The base directory (e.g. `~/.pingpal`). */
  readonly home: string;
  /** Persisted handle/room/face/relay config, written by the CLI's `init`. */
  readonly config: string;
  /** Unix domain socket the daemon listens on for local IPC. */
  readonly sock: string;
  /** Windows/TCP fallback: the IPC port is written here as plain text. */
  readonly portFile: string;
  /** Pidfile for `pingpald start/stop/status`. */
  readonly pid: string;
  /** Flag file the Claude Code hook polls; contains the unread ping count. */
  readonly unread: string;
  /** Append-only NDJSON log of received pings (so the hook can read directly). */
  readonly pings: string;
  /** Directory where received files are saved. */
  readonly files: string;
  /** JSON file tracking received file metadata. */
  readonly filesLog: string;
}

/**
 * Resolve all PingPal paths from `PINGPAL_HOME` (if set) or `~/.pingpal`.
 *
 * @param home Explicit base directory; overrides the environment. Handy in
 *   tests to isolate state in an OS temp directory.
 */
export function resolvePaths(home?: string): PingPalPaths {
  const base = home ?? process.env.PINGPAL_HOME ?? join(homedir(), ".pingpal");
  return {
    home: base,
    config: join(base, "config.json"),
    sock: join(base, "daemon.sock"),
    portFile: join(base, "daemon.port"),
    pid: join(base, "daemon.pid"),
    unread: join(base, "unread"),
    pings: join(base, "pings.ndjson"),
    files: join(base, "files"),
    filesLog: join(base, "files.json"),
  };
}
