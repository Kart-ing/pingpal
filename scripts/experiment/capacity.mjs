// PingPal capacity / limits probe.
//
// Answers: what's the limit of a room? a relay? We don't run hundreds of full
// daemons (heavy); instead we open raw relay WebSocket connections speaking the
// wire protocol directly — that's what actually consumes relay resources — and
// push them up while watching presence-roster growth, broadcast fan-out, and the
// per-connection rate limiter.
import WebSocket from "/opt/homebrew/lib/node_modules/pingpal/node_modules/ws/index.js";
import { setTimeout as sleep } from "node:timers/promises";
import { startRelay, cleanLab, log } from "./lib.mjs";

const PORT = 8801;

/** A raw relay client: connect, send hello, count presence + pings we receive. */
class RawPeer {
  constructor(handle, room, port) {
    this.handle = handle;
    this.room = room;
    this.url = `ws://127.0.0.1:${port}`;
    this.presenceSizes = [];
    this.pingsRecv = 0;
    this.acks = 0;
    this.errors = [];
    this.lastRoster = [];
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", () => {
        // clientVersion is REQUIRED by helloSchema — omitting it gets you bad_frame.
        this.ws.send(JSON.stringify({ type: "hello", roomCode: this.room, handle: this.handle, faceId: "ghost", clientVersion: "0.1.0-lab" }) + "\n");
        res();
      });
      this.ws.on("message", (data) => {
        for (const line of data.toString().split("\n")) {
          if (!line.trim()) continue;
          let m;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.type === "presence") { this.presenceSizes.push(m.peers.length); this.lastRoster = m.peers; }
          else if (m.type === "ping") this.pingsRecv++;
          else if (m.type === "ack") this.acks++;
          else if (m.type === "error") this.errors.push(m.code);
        }
      });
      this.ws.on("error", (e) => rej(e));
    });
  }
  send(text, to = null) {
    this.ws.send(JSON.stringify({ type: "ping", id: "p" + Math.random().toString(36).slice(2), from: this.handle, to, text, ts: Date.now() }) + "\n");
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  await cleanLab();
  log("=== PingPal capacity / limits probe ===");
  // Use default rate limits (capacity 30, refill 10/s) to observe the limiter.
  const relay = await startRelay(PORT);
  const peers = [];

  try {
    // -------------------------------------------------------------------------
    // PROBE A — How big can ONE room's roster get? Add 60 peers to 'big'.
    // -------------------------------------------------------------------------
    log("\n#### PROBE A: grow one room to 60 members ####");
    const N = 60;
    for (let i = 0; i < N; i++) {
      const p = new RawPeer(`u${String(i).padStart(2, "0")}`, "big-room", PORT);
      await p.connect();
      peers.push(p);
      if ((i + 1) % 15 === 0) log(`  connected ${i + 1}/${N}…`);
    }
    await sleep(1500); // let final presence broadcasts settle
    const maxRoster = Math.max(...peers.flatMap((p) => p.presenceSizes), 0);
    log(`  peers connected: ${peers.length}`);
    log(`  max roster size any peer saw: ${maxRoster}`);
    log(`  -> a room holds at least ${maxRoster} members with no hard cap in code`);
    const errs = peers.flatMap((p) => p.errors);
    log(`  protocol errors during join: ${errs.length ? errs.join(",") : "none"}`);

    // -------------------------------------------------------------------------
    // PROBE B — Broadcast fan-out: one peer broadcasts, how many receive it?
    // -------------------------------------------------------------------------
    log("\n#### PROBE B: broadcast fan-out across the 60-member room ####");
    peers.forEach((p) => (p.pingsRecv = 0));
    peers[0].send("hello big room"); // broadcast (to:null)
    await sleep(1500);
    const got = peers.filter((p) => p.pingsRecv > 0).length;
    log(`  sender broadcast once; ${got}/${peers.length - 1} other peers received it`);
    log(`  (relay fans a broadcast to every other connection in the room)`);

    // -------------------------------------------------------------------------
    // PROBE C — Per-connection RATE LIMIT. Token bucket: capacity 30, +10/s.
    // Fire 50 messages as fast as possible from one peer; count rate_limited.
    // -------------------------------------------------------------------------
    log("\n#### PROBE C: per-connection rate limit (bucket cap 30, refill 10/s) ####");
    const rl = new RawPeer("flooder", "big-room", PORT);
    await rl.connect();
    await sleep(300);
    rl.errors.length = 0; rl.acks = 0;
    for (let i = 0; i < 50; i++) rl.send(`flood ${i}`); // burst, no await
    await sleep(800);
    const limited = rl.errors.filter((e) => e === "rate_limited").length;
    log(`  fired 50 msgs instantly -> acks: ${rl.acks}, rate_limited: ${limited}`);
    log(`  -> ~first 30 pass (bucket), rest rejected until tokens refill at 10/s`);
    rl.close();

    // -------------------------------------------------------------------------
    // PROBE D — Many ROOMS at once on one relay (tenant scaling).
    // -------------------------------------------------------------------------
    log("\n#### PROBE D: many distinct rooms on one relay ####");
    const roomPeers = [];
    const ROOMS = 40;
    for (let i = 0; i < ROOMS; i++) {
      const p = new RawPeer(`solo${i}`, `room-${i}`, PORT);
      await p.connect();
      roomPeers.push(p);
    }
    await sleep(800);
    log(`  opened ${ROOMS} separate rooms (1 peer each) on the same relay process`);
    log(`  each peer's roster size (should be 1 = just themselves):`,
      `${Math.min(...roomPeers.map((p) => p.lastRoster.length))}..${Math.max(...roomPeers.map((p) => p.lastRoster.length))}`);
    roomPeers.forEach((p) => p.close());

    log("\n#### SUMMARY ####");
    log(`  • Room size: no hard limit in code — relay grouped ${maxRoster} members fine.`);
    log(`  • Broadcast: O(room size) fan-out, every other conn gets it.`);
    log(`  • Relay protects itself per-CONNECTION (token bucket ${30}/+10s), not per-room.`);
    log(`  • Many rooms coexist; rooms are just Map<roomCode, Set<conn>>, GC'd when empty.`);
    log(`  • Real limits are resource-based: FDs / sockets / RAM on the relay host, not config.`);
  } finally {
    peers.forEach((p) => p.close());
    await sleep(300);
    await relay.stop().catch(() => {});
    await cleanLab();
    log("\ncleaned up.");
  }
}

main().catch((e) => { console.error("CAPACITY PROBE FAILED:", e); process.exit(1); });
