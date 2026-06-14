import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJson } from "../jsonfile.js";

/**
 * Wire `pingpal statusline` into Claude Code so the live room roster shows up,
 * auto-refreshing, with no per-session setup.
 *
 * The tricky bit is coexisting with Kickbacks.ai (a.k.a. the `vibe-ads` status
 * line — "get paid for AI wait states", https://kickbacks.ai). Kickbacks owns
 * the `statusLine` entry and renders a sponsor line, then CHAINS to whatever
 * status line was there before via `~/.vibe-ads/cli-prev-statusline.json`. So:
 *
 *  - If Kickbacks is the active status line, we DON'T touch `statusLine`. We
 *    register our roster as Kickbacks' downstream chained command (writing that
 *    cli-prev file only if it isn't already pointing somewhere). Result: the bar
 *    stacks the sponsor line on top and our roster below — both live.
 *  - Otherwise we set `statusLine` to our roster directly. If the user already
 *    had some OTHER status line, we don't clobber it silently — we leave it and
 *    report that, so they can compose it themselves.
 *
 * Either way we set `refreshInterval` so the roster updates on its own.
 */

const VIBE_DIR = ".vibe-ads";
const VIBE_SCRIPT_MARKER = "vibe-ads-statusline.mjs";
const VIBE_CHAIN_FILE = "cli-prev-statusline.json";
const DEFAULT_REFRESH = 2;

/**
 * Does a status-line command string belong to PingPal? We can't rely on the word
 * "pingpal" appearing in the path (a dev checkout lives in an arbitrary dir, and
 * even a global install's path varies). The stable signature is "our CLI invoked
 * with the `statusline` subcommand": the command ends in (or contains) a
 * `… statusline` token and references either the pingpal entry or the package.
 */
export function isOursCommand(command: string): boolean {
  // Must invoke the `statusline` subcommand…
  if (!/(^|\s)statusline(\s|$)/.test(command)) return false;
  // …via something recognisable as our CLI: the word "pingpal" anywhere (global
  // installs, the `pingpal` bin), or an `index.js` entry under a cli package dir
  // (a dev checkout or symlinked entry — src/ or dist/). The subcommand gate
  // above keeps this from matching unrelated `index.js … status` commands.
  return (
    command.includes("pingpal") ||
    /(packages[/\\]cli[/\\])?(src|dist)[/\\]index\.js/.test(command) ||
    /[/\\]index\.js"?\s+statusline/.test(command)
  );
}

export type StatuslineOutcome =
  | { kind: "chained-into-kickbacks"; chainFile: string }
  | { kind: "kickbacks-chain-occupied"; chainFile: string; existing: string }
  | { kind: "set-directly"; settings: string }
  | { kind: "left-existing"; settings: string; existing: string }
  | { kind: "already-ours"; where: string };

interface StatusLineDef {
  type?: string;
  command?: string;
  refreshInterval?: number;
  [k: string]: unknown;
}
interface SettingsShape {
  statusLine?: StatusLineDef;
  [k: string]: unknown;
}
interface ChainShape {
  statusLine?: StatusLineDef;
  [k: string]: unknown;
}

/** Absolute path to this `pingpal` CLI's entry (dist/index.js). */
function cliEntry(): string {
  // Resolve relative to THIS module (…/dist/commands/statusline-install.js →
  // …/dist/index.js). This is stable regardless of how the process was launched
  // (a test runner, a symlinked bin, etc.) — unlike process.argv[1].
  try {
    return fileURLToPath(new URL("../index.js", import.meta.url));
  } catch {
    return process.argv[1] ?? "pingpal";
  }
}

/** The shell command Claude Code (or Kickbacks) should run for our roster. */
function rosterCommand(): string {
  // NO_COLOR keeps the chained output clean and predictable regardless of the
  // parent environment.
  return `NO_COLOR=1 "${process.execPath}" "${cliEntry()}" statusline`;
}

function settingsPath(home?: string): string {
  const base = home ?? process.env.CLAUDE_HOME ?? homedir();
  return join(base, ".claude", "settings.json");
}

function vibeChainPath(): string {
  // PINGPAL_VIBE_DIR overrides the Kickbacks/vibe-ads directory (tests; unusual
  // installs). Defaults to ~/.vibe-ads where the Kickbacks client lives.
  const dir = process.env.PINGPAL_VIBE_DIR ?? join(homedir(), VIBE_DIR);
  return join(dir, VIBE_CHAIN_FILE);
}

/**
 * Install the status-line roster. Idempotent and non-destructive.
 * @param force when true, overwrite an occupied Kickbacks chain / foreign status line.
 */
export async function installStatusline(
  opts: { force?: boolean; home?: string } = {},
): Promise<StatuslineOutcome> {
  const sPath = settingsPath(opts.home);
  const settings = await readJson<SettingsShape>(sPath, {});
  const current = settings.statusLine;
  const cmd = rosterCommand();

  const kickbacksActive =
    !!current?.command && current.command.includes(VIBE_SCRIPT_MARKER);

  if (kickbacksActive) {
    // Coexist: register ourselves as Kickbacks' downstream chained status line.
    // Ensure the roster still auto-refreshes by setting refreshInterval on the
    // (Kickbacks-owned) top entry — that's what CC actually ticks.
    if (current && current.refreshInterval == null) {
      current.refreshInterval = DEFAULT_REFRESH;
      await writeJson(sPath, settings);
    }
    const chainFile = vibeChainPath();
    const chain = await readJson<ChainShape>(chainFile, {});
    const existing = chain.statusLine?.command;
    if (existing && isOursCommand(existing)) {
      return { kind: "already-ours", where: chainFile };
    }
    if (existing && !opts.force) {
      // Someone else already chained here — don't stomp it.
      return { kind: "kickbacks-chain-occupied", chainFile, existing };
    }
    chain.statusLine = { type: "command", command: cmd };
    await writeJson(chainFile, chain);
    return { kind: "chained-into-kickbacks", chainFile };
  }

  // No Kickbacks. If it's already us, just ensure refreshInterval.
  if (current?.command && isOursCommand(current.command)) {
    if (current.refreshInterval == null) {
      current.refreshInterval = DEFAULT_REFRESH;
      await writeJson(sPath, settings);
    }
    return { kind: "already-ours", where: sPath };
  }

  // Some other status line present and not ours → don't clobber unless forced.
  if (current?.command && !opts.force) {
    return { kind: "left-existing", settings: sPath, existing: current.command };
  }

  // Free to set ours directly.
  settings.statusLine = {
    type: "command",
    command: cmd,
    refreshInterval: DEFAULT_REFRESH,
  };
  await writeJson(sPath, settings);
  return { kind: "set-directly", settings: sPath };
}
