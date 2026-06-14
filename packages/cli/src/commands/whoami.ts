import { getFace } from "@pingpal/faces";
import type { PingPalPaths } from "@pingpal/daemon";
import { readConfig } from "../config-store.js";

/** `pingpal whoami` — print the current handle, room (masked), and face. */
export async function whoamiCommand(paths: PingPalPaths): Promise<number> {
  const config = await readConfig(paths);
  if (config === null) {
    process.stdout.write("pingpal: not configured yet — run `pingpal init`.\n");
    return 1;
  }

  const face = getFace(config.faceId, config.handle);
  const masked = `${config.roomCode.slice(0, 4)}…`;
  process.stdout.write(
    [
      `  ${face.online.mid}  @${config.handle}`,
      `  room:  ${masked}`,
      `  face:  ${face.id}`,
      "",
    ].join("\n"),
  );
  return 0;
}
