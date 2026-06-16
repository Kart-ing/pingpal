/**
 * Codex integration helpers.
 *
 * Codex stores config in TOML (`~/.codex/config.toml`) and hooks in a separate
 * `~/.codex/hooks.json`. Since TOML is harder to merge programmatically without
 * a parser, we delegate the MCP registration to `codex mcp add` (Codex's own
 * CLI handles TOML idempotency) and write `hooks.json` ourselves (JSON merge
 * is straightforward).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

/** Paths to Codex's config files. */
export function resolveCodexPaths() {
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return {
    home,
    configToml: join(home, "config.toml"),
    hooksJson: join(home, "hooks.json"),
  };
}

/** Check if `codex` is on PATH. */
export function codexAvailable(): boolean {
  try {
    execSync("codex --version", { stdio: "pipe", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Register the PingPal MCP server by shelling out to `codex mcp add`.
 * Codex handles TOML merging and idempotency natively.
 */
export function registerCodexMcp(mcpBinPath: string): { ok: boolean; output: string } {
  try {
    const node = process.execPath;
    const out = execSync(
      `codex mcp add pingpal -- ${node} "${mcpBinPath}"`,
      { encoding: "utf8", timeout: 15000 },
    );
    return { ok: true, output: out.trim() };
  } catch (err: any) {
    const msg = err?.stderr ?? err?.stdout ?? err?.message ?? String(err);
    // "already exists" is not an error — it's already wired.
    if (/already exists/i.test(msg)) {
      return { ok: true, output: "pingpal MCP server already registered" };
    }
    return { ok: false, output: msg };
  }
}

/**
 * Install a UserPromptSubmit hook that runs `pingpal pings --announce`
 * so unread pings surface inside Codex sessions.
 *
 * Codex hooks live in `~/.codex/hooks.json`. We merge idempotently: if a
 * hook entry with our command already exists, we skip it.
 */
export async function installCodexHook(): Promise<{ ok: boolean; path: string; detail: string }> {
  const paths = resolveCodexPaths();
  const command = "pingpal pings --announce --quiet-when-empty";

  // Load existing hooks
  let hooks: any = {};
  if (existsSync(paths.hooksJson)) {
    try {
      const raw = await readFile(paths.hooksJson, "utf8");
      hooks = JSON.parse(raw);
    } catch {
      hooks = {};
    }
  }

  if (!hooks.hooks) hooks.hooks = {};
  if (!hooks.hooks.UserPromptSubmit) hooks.hooks.UserPromptSubmit = [];

  // Check if our hook already exists (avoid duplicates)
  const userPromptHooks: any[] = hooks.hooks.UserPromptSubmit;
  const alreadyThere = userPromptHooks.some((group: any) =>
    group.hooks?.some(
      (h: any) => h.type === "command" && h.command === command,
    ),
  );

  if (alreadyThere) {
    return { ok: true, path: paths.hooksJson, detail: "already installed" };
  }

  userPromptHooks.push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command,
        timeout: 10,
        statusMessage: "Checking PingPal…",
      },
    ],
  });

  await writeFile(paths.hooksJson, JSON.stringify(hooks, null, 2) + "\n", "utf8");
  return { ok: true, path: paths.hooksJson, detail: "installed" };
}
