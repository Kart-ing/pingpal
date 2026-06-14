#!/usr/bin/env node
/**
 * `pingpal` — the user-facing CLI (published as the `pingpal` package, run via
 * `npx pingpal`). It owns onboarding (`init`), room switching (`join`), daemon
 * lifecycle (`start`/`stop`/`status`), and `whoami`. The heavy lifting lives in
 * `@pingpal/daemon` (presence, relay, IPC) — this is a thin, friendly front.
 */
import { Command } from "commander";
import { resolvePaths } from "@pingpal/daemon";
import { initCommand, type InitOptions } from "./commands/init.js";
import { joinCommand } from "./commands/join.js";
import { startDaemon, statusDaemon, stopDaemon } from "./commands/daemon-control.js";
import { whoamiCommand } from "./commands/whoami.js";
import { pingsCommand } from "./commands/pings.js";
import { statuslineCommand } from "./commands/statusline.js";

const paths = resolvePaths();

/** Run a command, mapping its exit code onto the process and surfacing errors cleanly. */
async function run(action: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await action();
  } catch (err) {
    process.exitCode = 1;
    process.stderr.write(`pingpal: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

const program = new Command();

program
  .name("pingpal")
  .description("Ambient messaging for CLI coders — ASCII faces + 90-char pings inside Claude Code.")
  .version("0.1.0");

program
  .command("init")
  .description("set your handle/room/face and wire up Claude Code (hook + MCP + status line)")
  .option("--handle <handle>", "your handle (unique within the room)")
  .option("--room <code>", "the shared room code (acts as the secret)")
  .option("--face <id>", "a preset face id (or a custom one)")
  .option("--no-hook", "skip installing the Claude Code notification hook")
  .option("--no-mcp", "skip registering the MCP server")
  .option("--no-statusline", "skip wiring the live who's-online status line")
  .option("--force", "overwrite an existing status line / Kickbacks chain slot")
  .action(
    (opts: {
      handle?: string;
      room?: string;
      face?: string;
      hook: boolean;
      mcp: boolean;
      statusline: boolean;
      force?: boolean;
    }) => {
      const init: InitOptions = {
        handle: opts.handle,
        room: opts.room,
        face: opts.face,
        noHook: opts.hook === false,
        noMcp: opts.mcp === false,
        noStatusline: opts.statusline === false,
        force: opts.force,
      };
      return run(() => initCommand(paths, init));
    },
  );

program
  .command("join")
  .description("switch to a room (and restart the daemon)")
  .argument("<room>", "the room code to join")
  .option("--handle <handle>", "set/override your handle while joining")
  .action((room: string, opts: { handle?: string }) =>
    run(() => joinCommand(paths, room, opts)),
  );

program
  .command("start")
  .description("start the background daemon (pingpald)")
  .action(() => run(() => startDaemon(paths)));

program
  .command("stop")
  .description("stop the background daemon")
  .action(() => run(() => stopDaemon(paths)));

program
  .command("status")
  .description("show the daemon status and who's online")
  .action(() => run(() => statusDaemon(paths)));

program
  .command("whoami")
  .description("print your current handle, room, and face")
  .action(() => run(() => whoamiCommand(paths)));

program
  .command("pings")
  .description("show unread pings as ASCII faces and mark them read")
  .option("--no-read", "peek without marking pings as read")
  .option("--announce", "prepend an instruction so an assistant surfaces them (for /loop)")
  .option("--quiet-when-empty", "print nothing when there are no new pings (for /loop)")
  .action((opts: { read: boolean; announce?: boolean; quietWhenEmpty?: boolean }) =>
    run(() =>
      pingsCommand(paths, {
        markRead: opts.read,
        announce: opts.announce,
        quietWhenEmpty: opts.quietWhenEmpty,
      }),
    ),
  );

program
  .command("statusline")
  .description("print a one-line live who's-online roster (for a Claude Code statusLine)")
  .action(() => run(() => statuslineCommand(paths)));

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`pingpal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
