import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where PingPal writes its two Claude Code integrations.
 *
 *  - `settings` → `~/.claude/settings.json`, the hooks live here.
 *  - `mcpConfig` → `~/.claude.json`, the user-scope config Claude Code reads
 *    `mcpServers` from (the same place `claude mcp add --scope user` writes).
 *
 * `CLAUDE_HOME` overrides the base directory so `pingpal init` can be exercised
 * against a throwaway directory in tests and dry runs.
 */
export interface ClaudePaths {
  readonly settings: string;
  readonly mcpConfig: string;
}

export function resolveClaudePaths(home?: string): ClaudePaths {
  const base = home ?? process.env.CLAUDE_HOME ?? homedir();
  return {
    settings: join(base, ".claude", "settings.json"),
    mcpConfig: join(base, ".claude.json"),
  };
}
