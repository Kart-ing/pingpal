import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOursCommand, installStatusline } from "./statusline-install.js";

describe("isOursCommand", () => {
  it("matches a global-install path containing 'pingpal'", () => {
    expect(isOursCommand('"/usr/bin/node" "/x/pingpal/dist/index.js" statusline')).toBe(true);
  });
  it("matches a dev checkout whose dir is NOT named pingpal", () => {
    // the bug we hit: repo dir is 'Claude_Code_texting', no literal 'pingpal'
    expect(
      isOursCommand(
        'NO_COLOR=1 "/opt/node" "/Users/k/Claude_Code_texting/packages/cli/dist/index.js" statusline',
      ),
    ).toBe(true);
  });
  it("does NOT match an unrelated status line", () => {
    expect(isOursCommand('node "/x/.vibe-ads/vibe-ads-statusline.mjs"')).toBe(false);
    expect(isOursCommand("starship prompt")).toBe(false);
  });
  it("requires the statusline subcommand, not just our path", () => {
    expect(isOursCommand('node "/x/pingpal/dist/index.js" status')).toBe(false);
  });
});

describe("installStatusline", () => {
  let home: string;
  let vibe: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pp-home-"));
    vibe = mkdtempSync(join(tmpdir(), "pp-vibe-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    process.env.PINGPAL_VIBE_DIR = vibe;
  });
  afterEach(() => {
    delete process.env.PINGPAL_VIBE_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(vibe, { recursive: true, force: true });
  });

  const settingsFile = () => join(home, ".claude", "settings.json");
  const readSettings = () => JSON.parse(readFileSync(settingsFile(), "utf8"));

  it("sets the status line directly when none exists", async () => {
    const r = await installStatusline({ home });
    expect(r.kind).toBe("set-directly");
    const s = readSettings();
    expect(isOursCommand(s.statusLine.command)).toBe(true);
    expect(s.statusLine.refreshInterval).toBe(2);
  });

  it("is idempotent: a second run reports already-ours and keeps one entry", async () => {
    await installStatusline({ home });
    const r2 = await installStatusline({ home });
    expect(r2.kind).toBe("already-ours");
  });

  it("chains into Kickbacks instead of clobbering its status line", async () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        statusLine: { type: "command", command: 'node "/x/.vibe-ads/vibe-ads-statusline.mjs"' },
      }),
    );
    const r = await installStatusline({ home });
    expect(r.kind).toBe("chained-into-kickbacks");
    // statusLine entry is untouched (still Kickbacks) but gains refreshInterval
    const s = readSettings();
    expect(s.statusLine.command).toContain("vibe-ads-statusline.mjs");
    expect(s.statusLine.refreshInterval).toBe(2);
    // and the chain file now points at our roster
    const chain = JSON.parse(readFileSync(join(vibe, "cli-prev-statusline.json"), "utf8"));
    expect(isOursCommand(chain.statusLine.command)).toBe(true);
  });

  it("leaves a foreign status line untouched unless forced", async () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({ statusLine: { type: "command", command: "starship prompt" } }),
    );
    const r = await installStatusline({ home });
    expect(r.kind).toBe("left-existing");
    expect(readSettings().statusLine.command).toBe("starship prompt");
    // with --force it takes over
    const r2 = await installStatusline({ home, force: true });
    expect(r2.kind).toBe("set-directly");
    expect(isOursCommand(readSettings().statusLine.command)).toBe(true);
  });
});
