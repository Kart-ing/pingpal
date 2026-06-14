/**
 * A tiny visual demo — `pnpm --filter @pingpal/faces demo` (after build) prints
 * a few faces and a roster so you can eyeball the rendering. Pure output, no
 * arguments; honours NO_COLOR like everything else.
 */
import { FACE_IDS, renderPing, renderRoster } from "./index.js";

const FIXED_NOW = 1_717_000_120_000;

const samples: Array<Parameters<typeof renderPing>[0]> = [
  {
    handle: "sarah",
    faceId: "fox",
    text: "ship it when green, I'll review at 3",
    status: "online",
    lastSeenText: "2s ago",
  },
  {
    handle: "max-1",
    faceId: "robot",
    text: "deploy is stuck on the migration step again, taking a look now",
    status: "idle",
    lastSeenText: "5m ago",
  },
  {
    handle: "jo",
    faceId: "bunny",
    text: "lunch?",
    status: "online",
    lastSeenText: "just now",
  },
];

const line = "─".repeat(60);

console.log("\nPingPal faces — incoming pings\n");
for (const s of samples) {
  console.log(renderPing(s));
  console.log(line);
}

console.log("\nEvery preset face:\n");
for (const id of FACE_IDS) {
  console.log(renderPing({ handle: id, faceId: id, text: `hi, I'm the ${id} face`, status: "online" }));
  console.log(line);
}

console.log("\nRoster (whos_online):\n");
console.log(
  renderRoster(
    [
      { handle: "sarah", faceId: "fox", status: "online", lastSeen: FIXED_NOW - 2_000 },
      { handle: "max-1", faceId: "robot", status: "idle", lastSeen: FIXED_NOW - 300_000 },
      { handle: "jo", faceId: "bunny", status: "online", lastSeen: FIXED_NOW - 1_000 },
      { handle: "kai", faceId: "ghost", status: "offline", lastSeen: FIXED_NOW - 86_400_000 },
    ],
    { now: FIXED_NOW },
  ),
);
console.log("");
