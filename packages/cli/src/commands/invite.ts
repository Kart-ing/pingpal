import {
  DEFAULT_RELAY_URL,
  resolveConfig,
  type PingPalPaths,
} from "@pingpal/daemon";
import { readConfig } from "../config-store.js";

/**
 * `pingpal invite` — print a shareable bundle so someone else can join your
 * room: the room code, the relay URL, and a copy-paste `npx pingpal join …`
 * one-liner. This is the ONE place the room code is shown in full (everywhere
 * else masks it) — sharing the secret is an explicit, intentional act.
 *
 * It is honest about reachability: a localhost relay can't be reached by anyone
 * off your machine, so we warn and explain what to do (deploy a relay / use LAN).
 */

const LOCAL_RE = /^wss?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

export interface InviteOptions {
  /** Emit just the join command (handy for piping / scripting). */
  short?: boolean;
}

export async function inviteCommand(
  paths: PingPalPaths,
  opts: InviteOptions = {},
): Promise<number> {
  const config = await readConfig(paths);
  if (config === null) {
    process.stderr.write("pingpal: not configured yet — run `pingpal init` first.\n");
    return 1;
  }
  // Resolve the relay exactly as the daemon would (env override > config > default).
  const resolved = resolveConfig(config);
  const relay = resolved.relayUrl;
  const room = config.roomCode;
  const hasPassword = !!resolved.password;
  const isLocal = LOCAL_RE.test(relay);
  const isPlaceholder = relay === DEFAULT_RELAY_URL;

  const pwFlag = hasPassword ? " --password <password>" : "";
  const joinCmd = `npx pingpal join ${room} --relay ${relay} --handle <your-handle>${pwFlag}`;

  if (opts.short) {
    process.stdout.write(joinCmd + "\n");
    return 0;
  }

  const out: string[] = [
    "",
    "  📨  PingPal invite",
    "  ────────────────────────────────────────",
    `  room code:  ${room}`,
    `  relay:      ${relay}`,
    `  password:   ${hasPassword ? "yes — share it SEPARATELY (not in this line)" : "none (open room)"}`,
    "",
    "  Send a teammate this — they run it, pick a handle + face, and they're in:",
    "",
    `    ${joinCmd}`,
    "",
    "  (or, if they already ran `pingpal init`:)",
    `    pingpal join ${room} --relay ${relay}${pwFlag}`,
    "",
  ];
  if (hasPassword) {
    out.push(
      "  🔒 This room is password-protected: the relay rejects wrong/missing",
      "     passwords (so the code can't be guessed into), and the password also",
      "     strengthens the end-to-end encryption. Share it over a SEPARATE",
      "     channel — never paste it in the same message as the room code.",
      "",
    );
  }

  if (isLocal) {
    out.push(
      "  ⚠  Your relay is LOCAL (this machine only). Someone on another network",
      "     can't reach it. Options:",
      "       • same Wi-Fi/LAN? they'll auto-discover you over mDNS — the room",
      "         code + a `pingpal join` is enough, no reachable relay needed.",
      "       • remote teammates? deploy the relay and re-invite. See the README",
      "         'Self-hosting the relay' (Docker / Fly.io) and set PINGPAL_RELAY.",
      "",
    );
  } else if (isPlaceholder) {
    out.push(
      "  ⚠  This is the default placeholder relay URL and may not be running.",
      "     Point PINGPAL_RELAY (or config relayUrl) at a real instance first.",
      "",
    );
  }

  process.stdout.write(out.join("\n"));
  return 0;
}
