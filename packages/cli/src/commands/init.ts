import { fileURLToPath } from "node:url";
import {
  faceIdSchema,
  handleSchema,
  roomCodeSchema,
} from "@pingpal/protocol";
import { FACE_IDS } from "@pingpal/faces";
import type { PingPalPaths } from "@pingpal/daemon";
import { resolveClaudePaths } from "../claude-home.js";
import { readJson, writeJson } from "../jsonfile.js";
import {
  HOOK_EVENT,
  MCP_SERVER_NAME,
  mergeHook,
  mergeMcpServer,
  type ClaudeConfig,
  type ClaudeSettings,
  type McpServerDef,
} from "../claude-settings.js";
import { mcpBin } from "../resolve-bins.js";
import { updateConfig } from "../config-store.js";
import { facePreview, isInteractive, promptFace, promptValidated } from "../prompt.js";
import { installStatusline } from "./statusline-install.js";
import {
  codexAvailable,
  installCodexHook,
  registerCodexMcp,
} from "../codex-settings.js";

export interface InitOptions {
  handle?: string;
  room?: string;
  face?: string;
  /** Skip the Claude Code hook install. */
  noHook?: boolean;
  /** Skip the Claude Code MCP registration. */
  noMcp?: boolean;
  /** Skip wiring the live-roster status line. */
  noStatusline?: boolean;
  /** Overwrite an occupied status-line / Kickbacks chain slot. */
  force?: boolean;
  /** Also install for Codex (MCP + hook). */
  codex?: boolean;
}

/** Quote a path for embedding in a shell `command` string (hook entries run via a shell). */
function shellQuote(s: string): string {
  return `"${s.replace(/(["\\])/g, "\\$1")}"`;
}

/** Absolute path to the shipped hook script (lives at `<pkg>/hook/pingpal-hook.mjs`). */
function hookScriptPath(): string {
  return fileURLToPath(new URL("../../hook/pingpal-hook.mjs", import.meta.url));
}

/**
 * Resolve handle/face (and an OPTIONAL legacy room) from flags, prompting
 * interactively for gaps. In the Meet-style model a room comes from
 * `start-room`/`join`, so `init` no longer demands one — it sets up your
 * identity + Claude Code wiring. `--room` is still honoured for scripted/legacy
 * setups (it seeds a raw room code).
 */
async function gatherIdentity(opts: InitOptions): Promise<{
  handle: string;
  roomCode?: string;
  faceId?: string;
}> {
  const interactive = isInteractive();

  let handle = opts.handle ? handleSchema.parse(opts.handle) : undefined;
  if (!handle) {
    if (!interactive) throw new Error("missing --handle (non-interactive)");
    handle = await promptValidated("Your handle", handleSchema);
  }

  // Room is optional now; only validate one if explicitly provided via flag.
  const roomCode = opts.room ? roomCodeSchema.parse(opts.room) : undefined;

  let faceId = opts.face ? faceIdSchema.parse(opts.face) : undefined;
  if (faceId && !FACE_IDS.includes(faceId)) {
    process.stdout.write(
      `note: '${faceId}' isn't a preset face — using it anyway (presets: ${FACE_IDS.join(", ")}).\n`,
    );
  }
  if (!faceId && interactive) {
    faceId = await promptFace(handle);
  }

  return { handle, roomCode, faceId };
}

/** Install the notification hook into `~/.claude/settings.json` (idempotent). */
async function installHook(): Promise<string> {
  const { settings } = resolveClaudePaths();
  // `NO_COLOR=1` so the rendered faces reach the assistant as clean ASCII rather
  // than raw ANSI escapes (the UserPromptSubmit hook's stdout becomes context the
  // model reads, so escape codes would just be noise there).
  const command = `NO_COLOR=1 ${shellQuote(process.execPath)} ${shellQuote(hookScriptPath())}`;
  const current = await readJson<ClaudeSettings>(settings, {});
  const merged = mergeHook(current, command, HOOK_EVENT);
  await writeJson(settings, merged);
  return settings;
}

/** Register the MCP server in `~/.claude.json` under `mcpServers` (idempotent). */
async function registerMcp(): Promise<string> {
  const { mcpConfig } = resolveClaudePaths();
  const env: Record<string, string> = {};
  // Carry over the bits of our environment the MCP server needs to find the
  // same daemon socket / relay the CLI is configured against.
  for (const key of ["PINGPAL_HOME", "PINGPAL_RELAY"] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  const server: McpServerDef = {
    command: process.execPath,
    args: [mcpBin()],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
  const current = await readJson<ClaudeConfig>(mcpConfig, {});
  const merged = mergeMcpServer(current, MCP_SERVER_NAME, server);
  await writeJson(mcpConfig, merged);
  return mcpConfig;
}

/**
 * `pingpal init` — collect identity, write `~/.pingpal/config.json`, and wire up
 * the two Claude Code integrations. Every step is idempotent: re-running it
 * updates values in place and never duplicates a hook or MCP entry.
 */
export async function initCommand(
  paths: PingPalPaths,
  opts: InitOptions,
): Promise<number> {
  const { handle, roomCode, faceId } = await gatherIdentity(opts);

  // Only persist a room when one was explicitly provided (legacy/scripted).
  // Otherwise leave the room unset — `start-room`/`join` set it later.
  await updateConfig(paths, { handle, faceId, ...(roomCode ? { roomCode } : {}) });

  process.stdout.write(
    `\n${facePreview(faceId, handle)}  saved config for @${handle} → ${paths.config}\n`,
  );

  if (!opts.noHook) {
    const where = await installHook();
    process.stdout.write(`✓ installed Claude Code ${HOOK_EVENT} hook → ${where}\n`);
  }
  if (!opts.noMcp) {
    const where = await registerMcp();
    process.stdout.write(`✓ registered MCP server '${MCP_SERVER_NAME}' → ${where}\n`);
  }
  if (!opts.noStatusline) {
    try {
      const r = await installStatusline({ force: opts.force });
      switch (r.kind) {
        case "chained-into-kickbacks":
          process.stdout.write(
            `✓ live roster chained into your Kickbacks.ai status line → ${r.chainFile}\n` +
              `  (sponsor line on top, your room roster below — both auto-refresh)\n`,
          );
          break;
        case "set-directly":
          process.stdout.write(`✓ live roster set as your status line → ${r.settings}\n`);
          break;
        case "already-ours":
          process.stdout.write(`✓ live roster already wired → ${r.where}\n`);
          break;
        case "kickbacks-chain-occupied":
          process.stdout.write(
            `• Kickbacks.ai status-line chain already points elsewhere — left it as-is.\n` +
              `  Run \`pingpal init --force\` to chain the roster in, or set it up manually.\n`,
          );
          break;
        case "left-existing":
          process.stdout.write(
            `• You already have a custom status line — left it untouched.\n` +
              `  Add \`pingpal statusline\` yourself, or \`pingpal init --force\` to replace it.\n`,
          );
          break;
      }
    } catch (err) {
      // Status line is a nice-to-have; never fail init over it.
      process.stdout.write(
        `• couldn't wire the status-line roster (${err instanceof Error ? err.message : String(err)}); ` +
          `set it up later with \`pingpal statusline\`.\n`,
      );
    }
  }

  // Codex integration
  if (opts.codex) {
    if (!codexAvailable()) {
      process.stdout.write(
        "• Codex not found on PATH — install it first: https://developers.openai.com/codex/quickstart\n" +
          "  Then re-run `pingpal init --codex`.\n",
      );
    } else {
      // MCP server
      const mcpResult = registerCodexMcp(mcpBin());
      if (mcpResult.ok) {
        process.stdout.write(`✓ registered MCP server 'pingpal' in ~/.codex/config.toml\n`);
      } else {
        process.stdout.write(`• Codex MCP registration: ${mcpResult.output}\n`);
      }

      // Hook
      const hookResult = await installCodexHook();
      if (hookResult.ok) {
        const verb = hookResult.detail === "already installed" ? "already wired" : "installed";
        process.stdout.write(`✓ ${verb} Codex UserPromptSubmit hook → ${hookResult.path}\n`);
      } else {
        process.stdout.write(
          `• couldn't install Codex hook: ${hookResult.detail}\n`,
        );
      }
    }
  }

  const next = roomCode
    ? [
        "  pingpal start     # launch the background daemon",
        "  pingpal status    # see who's online",
      ]
    : [
        "  pingpal start-room       # create a room and get a code to share",
        "  pingpal join <code>      # or join a teammate's room by their code",
      ];
  process.stdout.write(
    [
      "",
      "You're set. Next:",
      ...next,
      "  …then start coding — pings surface inside Claude Code.",
      "",
    ].join("\n"),
  );
  return 0;
}
