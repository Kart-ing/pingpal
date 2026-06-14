import { describe, expect, it } from "vitest";
import {
  HOOK_EVENT,
  hasHook,
  mergeHook,
  mergeMcpServer,
  type ClaudeConfig,
  type ClaudeSettings,
} from "./claude-settings.js";

const HOOK = `"/usr/bin/node" "/home/me/.pnpm/pingpal/hook/pingpal-hook.mjs"`;

describe("mergeHook", () => {
  it("adds the hook into an empty settings object", () => {
    const out = mergeHook({}, HOOK);
    const groups = out.hooks?.[HOOK_EVENT];
    expect(groups).toHaveLength(1);
    expect(groups?.[0]?.hooks?.[0]).toEqual({ type: "command", command: HOOK });
    expect(hasHook(out, HOOK)).toBe(true);
  });

  it("is idempotent: merging twice yields exactly one PingPal hook", () => {
    const once = mergeHook({}, HOOK);
    const twice = mergeHook(once, HOOK);
    const groups = twice.hooks?.[HOOK_EVENT] ?? [];
    const pingpalHooks = groups.flatMap((g) =>
      (g.hooks ?? []).filter((h) => h.command.includes("pingpal-hook")),
    );
    expect(pingpalHooks).toHaveLength(1);
  });

  it("updates the command when the install path changes (no duplicate)", () => {
    const old = mergeHook({}, `"node" "/old/path/pingpal-hook.mjs"`);
    const updated = mergeHook(old, HOOK);
    const groups = updated.hooks?.[HOOK_EVENT] ?? [];
    const commands = groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    expect(commands).toEqual([HOOK]);
  });

  it("preserves unrelated top-level keys, events, and sibling hooks", () => {
    const existing: ClaudeSettings = {
      model: "opus",
      permissions: { allow: ["Bash"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        [HOOK_EVENT]: [
          {
            matcher: "x",
            hooks: [{ type: "command", command: "/other/tool.sh" }],
          },
        ],
      },
    };
    const out = mergeHook(existing, HOOK);

    // Unrelated keys untouched.
    expect(out.model).toBe("opus");
    expect(out.permissions).toEqual({ allow: ["Bash"] });
    expect(out.hooks?.PreToolUse).toEqual(existing.hooks?.PreToolUse);

    // The other tool's hook in our event survives, plus our new group.
    const groups = out.hooks?.[HOOK_EVENT] ?? [];
    const commands = groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    expect(commands).toContain("/other/tool.sh");
    expect(commands).toContain(HOOK);
    expect(hasHook(out, HOOK)).toBe(true);

    // Input was not mutated.
    expect(existing.hooks?.[HOOK_EVENT]).toHaveLength(1);
  });

  it("keeps a sibling hook but drops the now-empty group when re-merging", () => {
    const start: ClaudeSettings = {
      hooks: {
        [HOOK_EVENT]: [
          {
            hooks: [
              { type: "command", command: "/keep/me.sh" },
              { type: "command", command: `"node" "/x/pingpal-hook.mjs"` },
            ],
          },
        ],
      },
    };
    const out = mergeHook(start, HOOK);
    const groups = out.hooks?.[HOOK_EVENT] ?? [];
    const commands = groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    // sibling kept, old pingpal removed, one fresh pingpal added
    expect(commands.filter((c) => c.includes("pingpal-hook"))).toEqual([HOOK]);
    expect(commands).toContain("/keep/me.sh");
  });
});

describe("mergeMcpServer", () => {
  const server = { command: "/usr/bin/node", args: ["/p/mcp/dist/bin.js"] };

  it("adds the server and preserves other servers + top-level keys", () => {
    const existing: ClaudeConfig = {
      numStartups: 7,
      mcpServers: { other: { command: "othercmd" } },
    };
    const out = mergeMcpServer(existing, "pingpal", server);
    expect(out.numStartups).toBe(7);
    expect(out.mcpServers?.other).toEqual({ command: "othercmd" });
    expect(out.mcpServers?.pingpal).toEqual(server);
    // input untouched
    expect(existing.mcpServers?.pingpal).toBeUndefined();
  });

  it("is idempotent by key", () => {
    const once = mergeMcpServer({}, "pingpal", server);
    const twice = mergeMcpServer(once, "pingpal", server);
    expect(Object.keys(twice.mcpServers ?? {})).toEqual(["pingpal"]);
    expect(twice.mcpServers?.pingpal).toEqual(server);
  });
});
