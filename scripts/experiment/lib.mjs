// Shared helpers for the PingPal multi-daemon experiment.
//
// Each "person" is a fully isolated daemon: its own PINGPAL_HOME means its own
// config.json, daemon.sock, daemon.pid, unread flag, and pings.ndjson. We point
// them all at one local relay and drive them over their IPC sockets exactly the
// way the MCP server / hook do.
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = resolve(process.argv[1], "../../.."); // scripts/experiment/lib.mjs -> repo root
export const RELAY_BIN = join(REPO, "packages/relay/dist/bin.js");
export const DAEMON_BIN = join(REPO, "packages/daemon/dist/bin.js");
export const LAB = join(REPO, ".lab"); // throwaway state root (gitignored via .pingpal? no — clean up ourselves)

export const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

/** Start the local relay on a fixed port. Returns the child + a stop(). */
export async function startRelay(port, { rateCapacity, rateRefillPerSec } = {}) {
  const env = { ...process.env, PORT: String(port) };
  if (rateCapacity != null) env.PINGPAL_RATE_CAPACITY = String(rateCapacity);
  const out = [];
  const child = spawn(process.execPath, [RELAY_BIN], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => out.push(d.toString()));
  child.stderr.on("data", (d) => out.push(d.toString()));
  // wait until it's listening
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await tcpOpen(port)) {
      log(`relay up on :${port}`);
      return { child, out, stop: () => stopChild(child) };
    }
  }
  throw new Error(`relay did not come up on :${port}\n${out.join("")}`);
}

function tcpOpen(port) {
  return new Promise((res) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => res(false));
  });
}

function stopChild(child) {
  return new Promise((res) => {
    if (child.exitCode !== null) return res();
    child.on("close", () => res());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2000).unref?.();
  });
}

/**
 * A single isolated PingPal "person": its own home dir + config, its own daemon.
 * lanDiscovery is OFF so the experiment is deterministic (relay-only) and so
 * these synthetic peers don't leak onto your real LAN room.
 */
export class Person {
  constructor(handle, roomCode, relayPort, { faceId } = {}) {
    this.handle = handle;
    this.roomCode = roomCode;
    this.home = join(LAB, handle);
    this.relayUrl = `ws://127.0.0.1:${relayPort}`;
    this.faceId = faceId ?? "ghost";
    this.sock = join(this.home, "daemon.sock");
    this.pings = join(this.home, "pings.ndjson");
    this.child = null;
  }

  env() {
    return { ...process.env, PINGPAL_HOME: this.home, PINGPAL_RELAY: this.relayUrl };
  }

  async writeConfig() {
    await mkdir(this.home, { recursive: true });
    const cfg = {
      handle: this.handle,
      roomCode: this.roomCode,
      faceId: this.faceId,
      relayUrl: this.relayUrl,
      lanDiscovery: false,
    };
    await writeFile(join(this.home, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }

  /** Launch the daemon in the foreground (we own the child) and wait for its socket. */
  async start() {
    await this.writeConfig();
    const logFd = join(this.home, "daemon.log");
    this.child = spawn(process.execPath, [DAEMON_BIN, "--foreground"], {
      env: this.env(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this._log = [];
    this.child.stdout.on("data", (d) => this._log.push(d.toString()));
    this.child.stderr.on("data", (d) => this._log.push(d.toString()));
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      if (existsSync(this.sock)) return this;
      if (this.child.exitCode !== null) {
        throw new Error(`${this.handle} daemon exited early:\n${this._log.join("")}`);
      }
    }
    throw new Error(`${this.handle} daemon never created its socket:\n${this._log.join("")}`);
  }

  async stop() {
    if (this.child) await stopChild(this.child);
    this.child = null;
  }

  /** One IPC round-trip over this person's Unix socket (NDJSON request/response). */
  ipc(method, params = {}) {
    const id = Math.random().toString(36).slice(2);
    const req = JSON.stringify({ id, method, params }) + "\n";
    return new Promise((res, rej) => {
      const s = createConnection(this.sock, () => s.write(req));
      let buf = "";
      const to = setTimeout(() => {
        s.destroy();
        rej(new Error(`${this.handle} ipc ${method} timed out`));
      }, 5000);
      s.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          clearTimeout(to);
          s.destroy();
          try {
            const resp = JSON.parse(buf.slice(0, nl));
            resp.ok ? res(resp.result) : rej(new Error(`${method}: ${resp.error?.message}`));
          } catch (e) {
            rej(e);
          }
        }
      });
      s.on("error", (e) => {
        clearTimeout(to);
        rej(e);
      });
    });
  }

  send(text, to) {
    return this.ipc("sendPing", to != null ? { to, text } : { text });
  }
  presence() {
    return this.ipc("getPresence");
  }
  status() {
    return this.ipc("status");
  }
  inbox() {
    return this.ipc("getPings", { markRead: false });
  }
  async storedLines() {
    if (!existsSync(this.pings)) return [];
    const raw = await readFile(this.pings, "utf8");
    return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
}

export async function cleanLab() {
  await rm(LAB, { recursive: true, force: true });
}
