// PingPal multi-daemon experiment.
//
// Boots a local relay and a cast of isolated daemons ("people"), then runs four
// scenarios and prints what PingPal does. Cleans up after itself.
import { setTimeout as sleep } from "node:timers/promises";
import { Person, startRelay, cleanLab, log } from "./lib.mjs";

const PORT = 8799; // a dedicated experiment port (your real config uses 8787)
const people = [];
let relay;

async function spawnPerson(handle, room, face) {
  const p = new Person(handle, room, PORT, { faceId: face });
  await p.start();
  people.push(p);
  return p;
}

async function settle(ms = 800) {
  await sleep(ms);
}

function rosterNames(roster) {
  return roster.peers
    .map((p) => `${p.handle}(${p.status})`)
    .sort()
    .join(", ");
}

async function main() {
  await cleanLab();
  log("=== PingPal multi-daemon experiment ===");
  relay = await startRelay(PORT);

  // ---------------------------------------------------------------------------
  // SCENARIO 1 — Multiple people in ONE room. How does presence look? Do
  // broadcast + directed pings reach the right people?
  // ---------------------------------------------------------------------------
  log("\n#### SCENARIO 1: 4 people in room 'alpha' ####");
  const alice = await spawnPerson("alice", "alpha", "fox");
  const bob = await spawnPerson("bob", "alpha", "robot");
  const carol = await spawnPerson("carol", "alpha", "cat");
  const dave = await spawnPerson("dave", "alpha", "ghost");
  await settle();

  log("alice sees room roster:", rosterNames(await alice.presence()));
  log("dave  sees room roster:", rosterNames(await dave.presence()));

  log("alice broadcasts 'gm everyone'");
  const b1 = await alice.send("gm everyone");
  log("  -> via:", b1.via, "delivered:", b1.delivered);
  await settle();
  for (const p of [bob, carol, dave]) {
    const inbox = await p.inbox();
    const last = inbox.pings.at(-1);
    log(`  ${p.handle} inbox last:`, last ? `"${last.text}" from ${last.from}` : "(empty)");
  }
  const aliceInbox = await alice.inbox();
  log(`  alice (sender) inbox has her own broadcast?`,
    aliceInbox.pings.some((x) => x.text === "gm everyone" && x.outbound) ? "yes (outbound, marked read)" : "no");

  log("bob DMs carol 'just you'");
  await bob.send("just you", "carol");
  await settle();
  const carolInbox = (await carol.inbox()).pings.at(-1);
  const daveInbox2 = (await dave.inbox()).pings.at(-1);
  log(`  carol last:`, carolInbox ? `"${carolInbox.text}" from ${carolInbox.from}` : "(none)");
  log(`  dave  last (should NOT be 'just you'):`, daveInbox2 ? `"${daveInbox2.text}"` : "(none)");

  // ---------------------------------------------------------------------------
  // SCENARIO 2 — SOME people in a room (partial overlap / room isolation).
  // alice+bob in 'alpha', eve+frank in 'beta'. Cross-room must NOT leak.
  // ---------------------------------------------------------------------------
  log("\n#### SCENARIO 2: room isolation (alpha vs beta) ####");
  const eve = await spawnPerson("eve", "beta", "fox");
  const frank = await spawnPerson("frank", "beta", "robot");
  await settle();
  log("eve (room beta) sees roster:", rosterNames(await eve.presence()));
  log("  ^ should be only eve+frank, NOT alice/bob/carol/dave");
  log("alice (room alpha) sees roster:", rosterNames(await alice.presence()));

  log("eve broadcasts 'beta-only secret'");
  await eve.send("beta-only secret");
  await settle();
  const frankGot = (await frank.inbox()).pings.some((x) => x.text === "beta-only secret");
  const aliceLeaked = (await alice.inbox()).pings.some((x) => x.text === "beta-only secret");
  log(`  frank (beta) received it? ${frankGot}  <- want true`);
  log(`  alice (alpha) leaked it?  ${aliceLeaked}  <- want false`);

  // ---------------------------------------------------------------------------
  // SCENARIO 3 — Directed ping to someone NOT in the room (offline target).
  // ---------------------------------------------------------------------------
  log("\n#### SCENARIO 3: ping a handle that isn't in the room ####");
  const r3 = await alice.send("you around?", "ghostuser");
  log(`  alice -> @ghostuser : via=${r3.via} delivered=${r3.delivered}`);
  log("  (relay acks the send even if no connection matches the target handle)");

  // ---------------------------------------------------------------------------
  // SCENARIO 4 — How are messages stored? Show the on-disk artifacts.
  // ---------------------------------------------------------------------------
  log("\n#### SCENARIO 4: where messages live ####");
  const bobStored = await bob.storedLines();
  log(`  bob's ~/.pingpal(home)/pings.ndjson has ${bobStored.length} line(s):`);
  for (const l of bobStored) {
    log(`    ${l.outbound ? "OUT" : "IN "} [${l.via}] ${l.read ? "read  " : "UNREAD"} ` +
      `${l.from}->${l.to ?? "room"}: "${l.text}"`);
  }
  log("  NOTE: text is stored as PLAINTEXT locally; only the wire/relay form is encrypted.");

  // Cast summary
  log("\n#### CAST (who's where) ####");
  for (const p of people) {
    const s = await p.status();
    log(`  @${p.handle}: room=${p.roomCode} relay=${s.relayConnected ? "connected" : "off"} ` +
      `peers=${s.relayPeerCount} unread=${s.unread}`);
  }

  log("\nexperiment scenarios done. (capacity probe runs separately)");
}

async function cleanup() {
  log("\ncleaning up daemons + relay…");
  await Promise.all(people.map((p) => p.stop().catch(() => {})));
  if (relay) await relay.stop().catch(() => {});
  await cleanLab();
  log("done.");
}

main()
  .then(cleanup)
  .catch(async (e) => {
    console.error("EXPERIMENT FAILED:", e);
    await cleanup();
    process.exit(1);
  });
