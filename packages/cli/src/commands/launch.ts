import { spawn } from "node:child_process";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * `pingpal launch` — open the chat TUI in a NEW terminal window, auto-detecting
 * the platform's terminal. This is what a `/pingpal` Claude Code slash command
 * runs, so chatting doesn't take over the CC session's own terminal.
 *
 * macOS: opens Terminal.app via `osascript` (most universally present; iTerm
 * users can still run `pingpal chat` themselves). Linux: tries common emulators.
 * If we can't open a window, we print the exact command to run and return 0 —
 * never leave the user stuck.
 */

function cliEntry(): string {
  try {
    return fileURLToPath(new URL("../index.js", import.meta.url));
  } catch {
    return process.argv[1] ?? "pingpal";
  }
}

/** The shell command that launches the chat TUI. */
function chatCmd(): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(cliEntry())} chat`;
}

function trySpawn(cmd: string, args: string[]): boolean {
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Identify the terminal host so we open the chat in the RIGHT place. Inside an
 * editor's integrated terminal (VS Code, Cursor, …) the user wants the chat in
 * *that* terminal, not a detached OS window — and since a launcher run by an
 * agent isn't itself an interactive TTY, the correct move there is to tell the
 * user to run `pingpal chat` in their integrated terminal. Standalone terminals
 * (Terminal.app, iTerm, gnome-terminal, …) can have a fresh window spawned.
 */
function editorHost(): string | null {
  const tp = (process.env.TERM_PROGRAM ?? "").toLowerCase();
  if (process.env.VSCODE_INJECTION || process.env.VSCODE_GIT_IPC_HANDLE || tp === "vscode") {
    // Cursor is a VS Code fork; distinguish by bundle id when present.
    return (process.env.__CFBundleIdentifier ?? "").toLowerCase().includes("cursor")
      ? "Cursor"
      : "VS Code";
  }
  if (tp.includes("cursor")) return "Cursor";
  return null;
}

export async function launchCommand(): Promise<number> {
  const run = chatCmd();
  const os = platform();

  // Inside an editor's integrated terminal: don't spawn an external window.
  // Point the user at their own terminal, which is where they want it.
  const host = editorHost();
  if (host) {
    process.stdout.write(
      `pingpal: you're in the ${host} integrated terminal — open the chat right here.\n` +
        `In a terminal pane (a new one keeps this session free), run:\n\n` +
        `  pingpal chat\n\n` +
        `Tip: split the terminal (${os === "darwin" ? "⌘\\" : "Ctrl+Shift+5"}) so chat sits beside your work.\n`,
    );
    return 0;
  }

  if (os === "darwin") {
    // `osascript` tells Terminal.app to open a new window running our command.
    const script = `tell application "Terminal" to do script ${JSON.stringify(run)}\ntell application "Terminal" to activate`;
    if (trySpawn("osascript", ["-e", script])) {
      process.stdout.write("pingpal: opened the chat window (Terminal.app). 💬\n");
      return 0;
    }
  } else if (os === "linux") {
    // Try the common terminal emulators, in rough order of ubiquity.
    const sh = `${run}; exec $SHELL`;
    const candidates: Array<[string, string[]]> = [
      ["x-terminal-emulator", ["-e", `bash -lc ${JSON.stringify(sh)}`]],
      ["gnome-terminal", ["--", "bash", "-lc", sh]],
      ["konsole", ["-e", `bash -lc ${JSON.stringify(sh)}`]],
      ["xterm", ["-e", `bash -lc ${JSON.stringify(sh)}`]],
    ];
    for (const [cmd, args] of candidates) {
      if (trySpawn(cmd, args)) {
        process.stdout.write(`pingpal: opened the chat window (${cmd}). 💬\n`);
        return 0;
      }
    }
  }

  // Fallback: couldn't open a window — tell them exactly what to run.
  process.stdout.write(
    "pingpal: couldn't open a new terminal window automatically.\n" +
      "Open a terminal and run:\n\n" +
      `  pingpal chat\n\n` +
      "(or, from this checkout)\n\n" +
      `  ${run}\n`,
  );
  return 0;
}
