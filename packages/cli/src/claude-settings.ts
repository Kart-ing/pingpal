/**
 * Idempotent merging of PingPal's entries into the user's Claude Code config.
 *
 * Two integrations live here, kept as pure functions so they can be unit-tested
 * without touching the filesystem:
 *
 *  - {@link mergeHook} adds the notification hook into `~/.claude/settings.json`;
 *  - {@link mergeMcpServer} registers the MCP server in `~/.claude.json`.
 *
 * Both deep-clone their input and return a new object, so existing keys are
 * never mutated or dropped. Re-running `pingpal init` must converge to exactly
 * one PingPal entry — never a duplicate — even if the install path changed.
 */

/**
 * The Claude Code event PingPal's hook listens on.
 *
 * We use `UserPromptSubmit`: it fires on every prompt you send, and — crucially —
 * it is one of the few events whose stdout Claude Code injects into the session
 * as context the assistant sees and acts on. (`Notification` fires rarely and
 * only surfaces *stderr*; `Stop` fires often but its stdout is *ignored* — both
 * useless for actually showing an incoming ping.) So buffered pings reliably
 * surface on your next interaction. The hook prepends a short directive telling
 * the assistant to display them, and exits silently when there's nothing to
 * show, so this never adds noise to a quiet session. Documented in the README.
 */
export const HOOK_EVENT = "UserPromptSubmit" as const;

/**
 * Substring marker identifying a hook command as ours. The command embeds an
 * absolute path to `pingpal-hook.mjs`, so matching on the filename lets us find
 * (and replace) a prior install even if its path differs from this one.
 */
export const HOOK_MARKER = "pingpal-hook";

/** Logical name of the MCP server entry under `mcpServers`. */
export const MCP_SERVER_NAME = "pingpal";

interface CommandHook {
  type: "command";
  command: string;
  [k: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks?: CommandHook[];
  [k: string]: unknown;
}

export interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

export interface McpServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ClaudeConfig {
  mcpServers?: Record<string, McpServerDef>;
  [k: string]: unknown;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Merge PingPal's notification hook into a Claude Code settings object.
 *
 * Strips any existing PingPal hook (matched by {@link HOOK_MARKER}) from every
 * group first — removing now-empty groups — then appends a single fresh group.
 * Unrelated events, groups, matchers and sibling hooks are preserved verbatim.
 *
 * @returns a new settings object; the input is not modified.
 */
export function mergeHook(
  settings: ClaudeSettings,
  command: string,
  event: string = HOOK_EVENT,
): ClaudeSettings {
  const next = clone(settings);
  const hooks = (next.hooks ??= {});
  const groups = Array.isArray(hooks[event]) ? hooks[event] : [];

  const pruned: HookGroup[] = [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) {
      // Shape we don't recognise — leave it untouched.
      pruned.push(group);
      continue;
    }
    const kept = group.hooks.filter(
      (h) => !(typeof h?.command === "string" && h.command.includes(HOOK_MARKER)),
    );
    if (kept.length === group.hooks.length) {
      pruned.push(group); // nothing of ours here
    } else if (kept.length > 0) {
      pruned.push({ ...group, hooks: kept }); // keep their other hooks
    }
    // else: group was PingPal-only and is now empty — drop it.
  }

  pruned.push({ hooks: [{ type: "command", command }] });
  hooks[event] = pruned;
  return next;
}

/** True if `settings` already has exactly the given PingPal hook command. */
export function hasHook(
  settings: ClaudeSettings,
  command: string,
  event: string = HOOK_EVENT,
): boolean {
  const groups = settings.hooks?.[event];
  if (!Array.isArray(groups)) return false;
  return groups.some((g) =>
    g?.hooks?.some((h) => h?.command === command),
  );
}

/**
 * Merge a stdio MCP server entry into a Claude Code config object (`~/.claude.json`).
 * Idempotent by key: re-registering the same server overwrites its definition
 * and leaves every other server — and every unrelated top-level key — intact.
 *
 * @returns a new config object; the input is not modified.
 */
export function mergeMcpServer(
  config: ClaudeConfig,
  name: string,
  server: McpServerDef,
): ClaudeConfig {
  const next = clone(config);
  const servers = (next.mcpServers ??= {});
  servers[name] = server;
  return next;
}
