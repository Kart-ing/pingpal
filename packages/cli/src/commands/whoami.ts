import { getFace } from "@pingpal/faces";
import type { PingPalPaths } from "@pingpal/daemon";
import { readConfig } from "../config-store.js";

/** `pingpal whoami` — print the current handle, room (shareable join code), and face. */
export async function whoamiCommand(paths: PingPalPaths): Promise<number> {
  const config = await readConfig(paths);
  if (config === null) {
    process.stdout.write("pingpal: not configured yet — run `pingpal init`.\n");
    return 1;
  }

  const face = getFace(config.faceId, config.handle);
  const lines = [`  ${face.online.mid}  @${config.handle}`];
  if (config.roomCode) {
    // roomCode holds the short, shareable join code — show it in full so this is
    // the quick "what do I tell people to join?" answer.
    lines.push(`  room:  ${config.roomCode}   (others: \`pingpal join ${config.roomCode}\`)`);
  } else {
    lines.push("  room:  — not in a room (`pingpal start-room` or `pingpal join <code>`)");
  }
  lines.push(`  face:  ${face.id}`, "");
  process.stdout.write(lines.join("\n"));
  return 0;
}
