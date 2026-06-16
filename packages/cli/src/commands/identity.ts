import { handleSchema, faceIdSchema } from "@pingpal/protocol";
import type { ConfigFile } from "@pingpal/daemon";
import {
  isInteractive,
  promptFace,
  promptValidated,
} from "../prompt.js";

/**
 * Resolve the user's handle + face, shared by `start-room` and `join`. Both
 * commands need an identity before they can enter a room; a first-timer is
 * walked through a short prompt, a returning user keeps what they had. Flags
 * win over existing config, which wins over a prompt.
 *
 * Returns null (after printing a reason) when no handle can be obtained without
 * a TTY — the caller should treat that as a usage error and exit non-zero.
 */
export async function resolveIdentity(
  existing: ConfigFile | null,
  opts: { handle?: string; face?: string; greetNewcomer?: boolean },
): Promise<{ handle: string; faceId?: string } | null> {
  const interactive = isInteractive();
  const newcomer = existing === null;

  let handle = opts.handle ? handleSchema.parse(opts.handle) : existing?.handle;
  if (!handle) {
    if (!interactive) {
      process.stderr.write(
        "pingpal: no handle — pass --handle, or run the command interactively.\n",
      );
      return null;
    }
    if (newcomer && opts.greetNewcomer) {
      process.stdout.write("\n  👋  Welcome to PingPal — let's get you set up.\n\n");
    }
    handle = await promptValidated("Your handle", handleSchema);
  }

  let faceId = opts.face ? faceIdSchema.parse(opts.face) : existing?.faceId;
  if (!faceId && interactive) {
    faceId = await promptFace(handle);
  }

  return { handle, faceId };
}
