// End-to-end verification of the Meet-style room flow, driving the REAL built
// CLI + relay with isolated PINGPAL_HOMEs (each = a separate "person").
//
// Proves: start-room mints a code → a second person joins by that code → pings
// flow both ways → leave clears the room AND persists → rejoin works → an
// expired code stops resolving once the room empties.
import { spawn, execFile } from "node:child_process";
import { mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const execFileP = promisify(execFile);
const REPO = resolve(process.argv[1], "../../..");
const RELAY_BIN = join(REPO, "packages/relay/dist/bin.js");
const CLI = join(REPO, "packages/cli/dist/index.js");
const LAB = join(REPO, ".lab-e2e");
const PORT = 8811;
const RELAY = `ws://127.0.0.1:${PORT}`;

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; log(`  ✓ ${name}`); }
  else { fail++; log(`  ✗ ${name}  ${detail}`); }
}

/** Run the CLI as a given person (its own PINGPAL_HOME). Returns {stdout,stderr,code}. */
async function cli(home, args, { handle } = {}) {
  const env = { ...process.env, PINGPAL_HOME: home, PINGPAL_RELAY: RELAY };
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], { env });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

/** Drive a daemon's IPC socket directly (same as MCP/hook do) for sending/reading. */
function ipc(home, method, params = {}) {
  const sock = join(home, "daemon.sock");
  const id = Math.random().toString(36).slice(2);
  const req = JSON.stringify({ id, method, params }) + "\n";
  return new Promise((res, rej) => {
    const s = createConnection(sock, () => s.write(req));
    let buf = "";
    const to = setTimeout(() => { s.destroy(); rej(new Error(`ipc ${method} timeout`)); }, 5000);
    s.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(to); s.destroy();
        try { const r = JSON.parse(buf.slice(0, nl)); r.ok ? res(r.result) : rej(new Error(r.error?.message)); }
        catch (e) { rej(e); }
      }
    });
    s.on("error", (e) => { clearTimeout(to); rej(e); });
  });
}

async function readConfig(home) {
  const p = join(home, "config.json");
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, "utf8"));
}

async function startRelay() {
  const child = spawn(process.execPath, [RELAY_BIN], { env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  const out = [];
  child.stdout.on("data", (d) => out.push(d.toString()));
  child.stderr.on("data", (d) => out.push(d.toString()));
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const ok = await new Promise((r) => { const s = createConnection({ host: "127.0.0.1", port: PORT }, () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
    if (ok) return { child, out };
  }
  throw new Error("relay didn't start:\n" + out.join(""));
}

/** Pull the `pingpal join <code>` token out of start-room's stdout. */
function parseCode(stdout) {
  const m = stdout.match(/pingpal join ([a-z0-9-]+)/i);
  return m ? m[1] : null;
}

async function main() {
  await rm(LAB, { recursive: true, force: true });
  const hostHome = join(LAB, "host");
  const guestHome = join(LAB, "guest");
  await mkdir(hostHome, { recursive: true });
  await mkdir(guestHome, { recursive: true });

  log("=== E2E: Meet-style rooms (real CLI + relay) ===");
  const relay = await startRelay();
  log(`relay up on :${PORT}`);

  try {
    // --- 1. HOST creates a room ------------------------------------------------
    log("\n#### 1. host runs `start-room` ####");
    const sr = await cli(hostHome, ["start-room", "--handle", "host", "--face", "fox"]);
    const code = parseCode(sr.stdout);
    log(`  start-room exit=${sr.code}, printed code = ${code}`);
    if (sr.code !== 0) log("  stderr:", sr.stderr.trim());
    check("start-room succeeded", sr.code === 0, sr.stderr.trim());
    check("a join code was printed", !!code);
    check("code looks Meet-style (xxx-xxxx-xx)", !!code && /^[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{2}$/.test(code), code ?? "");

    const hostCfg = await readConfig(hostHome);
    check("host config has roomId (secret)", !!hostCfg?.roomId && hostCfg.roomId.startsWith("rm_"), JSON.stringify(hostCfg));
    check("host config stores the short code as roomCode", hostCfg?.roomCode === code);
    check("host daemon is running (socket exists)", existsSync(join(hostHome, "daemon.sock")));

    await sleep(500);

    // --- 2. GUEST joins by the code -------------------------------------------
    log("\n#### 2. guest runs `join <code>` ####");
    const jn = await cli(guestHome, ["join", code, "--handle", "guest", "--face", "owl"]);
    log(`  join exit=${jn.code}`);
    if (jn.code !== 0) log("  stderr:", jn.stderr.trim());
    check("join succeeded", jn.code === 0, jn.stderr.trim());
    const guestCfg = await readConfig(guestHome);
    check("guest resolved the SAME roomId as host", guestCfg?.roomId === hostCfg?.roomId,
      `guest=${guestCfg?.roomId} host=${hostCfg?.roomId}`);

    await sleep(800); // let both daemons connect + exchange presence

    // --- 3. Presence: each sees the other -------------------------------------
    log("\n#### 3. presence ####");
    const hostRoster = await ipc(hostHome, "getPresence");
    const guestRoster = await ipc(guestHome, "getPresence");
    const hostSeesGuest = hostRoster.peers.some((p) => p.handle === "guest");
    const guestSeesHost = guestRoster.peers.some((p) => p.handle === "host");
    check("host sees guest in roster", hostSeesGuest, JSON.stringify(hostRoster.peers.map(p=>p.handle)));
    check("guest sees host in roster", guestSeesHost, JSON.stringify(guestRoster.peers.map(p=>p.handle)));

    // --- 4. Messages flow both ways (and E2E round-trips) ----------------------
    log("\n#### 4. pings both ways ####");
    await ipc(hostHome, "sendPing", { text: "welcome to the room!" });
    await sleep(600);
    const guestInbox = await ipc(guestHome, "getPings", { markRead: false });
    const gotWelcome = guestInbox.pings.find((p) => p.text === "welcome to the room!");
    check("guest received host's broadcast (decrypted correctly)", !!gotWelcome,
      JSON.stringify(guestInbox.pings.map(p=>p.text)));

    await ipc(guestHome, "sendPing", { text: "glad to be here", to: "host" });
    await sleep(600);
    const hostInbox = await ipc(hostHome, "getPings", { markRead: false });
    const gotReply = hostInbox.pings.find((p) => p.text === "glad to be here");
    check("host received guest's DM (decrypted correctly)", !!gotReply,
      JSON.stringify(hostInbox.pings.map(p=>p.text)));

    // --- 5. LEAVE persists -----------------------------------------------------
    log("\n#### 5. guest runs `leave` (must persist) ####");
    const lv = await cli(guestHome, ["leave"]);
    log(`  leave exit=${lv.code}: ${lv.stdout.trim()}`);
    const guestCfgAfter = await readConfig(guestHome);
    check("leave cleared roomId from config", !guestCfgAfter?.roomId, JSON.stringify(guestCfgAfter));
    check("leave cleared roomCode from config", !guestCfgAfter?.roomCode);
    check("leave kept the handle (identity persists)", guestCfgAfter?.handle === "guest");
    check("guest daemon stopped (socket gone)", !existsSync(join(guestHome, "daemon.sock")));

    // whoami after leave must NOT crash (the old Zod bug)
    const who = await cli(guestHome, ["whoami"]);
    check("whoami after leave does not crash", who.code === 0 || who.code === 1, `code=${who.code}`);
    check("whoami after leave says not-in-a-room", /not in a room/i.test(who.stdout + who.stderr),
      (who.stdout + who.stderr).trim().slice(0, 120));

    // --- 6. REJOIN works after leave (the old wedged-config bug) ---------------
    log("\n#### 6. guest rejoins the same code ####");
    const rj = await cli(guestHome, ["join", code, "--handle", "guest"]);
    log(`  rejoin exit=${rj.code}`);
    if (rj.code !== 0) log("  stderr:", rj.stderr.trim());
    check("rejoin after leave succeeds (config not wedged)", rj.code === 0, rj.stderr.trim());
    const guestCfgRejoin = await readConfig(guestHome);
    check("rejoin restored the same roomId", guestCfgRejoin?.roomId === hostCfg?.roomId);

    await sleep(500);

    // --- 7. Ephemeral code retires once the room empties -----------------------
    log("\n#### 7. code retires after everyone leaves ####");
    await cli(guestHome, ["leave"]);
    await cli(hostHome, ["leave"]);
    await sleep(600); // relay processes the disconnects
    // A fresh person tries the now-dead code.
    const ghostHome = join(LAB, "ghost");
    await mkdir(ghostHome, { recursive: true });
    const dead = await cli(ghostHome, ["join", code, "--handle", "ghost"]);
    check("expired code no longer resolves (clean failure)", dead.code !== 0,
      `exit=${dead.code}`);
    check("failure explains the code retired / not found", /no room found|retire|fresh one/i.test(dead.stdout + dead.stderr),
      (dead.stdout + dead.stderr).trim().slice(0, 160));

    log(`\n#### RESULT: ${pass} passed, ${fail} failed ####`);
  } finally {
    // stop any leftover daemons
    for (const h of ["host", "guest", "ghost"]) {
      await cli(join(LAB, h), ["stop"]).catch(() => {});
    }
    relay.child.kill("SIGTERM");
    await sleep(300);
    await rm(LAB, { recursive: true, force: true });
    log("cleaned up.");
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("E2E FAILED:", e); process.exit(1); });
