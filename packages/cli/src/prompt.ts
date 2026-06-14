import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { z } from "zod";
import { FACES, getFace, pickFace } from "@pingpal/faces";

/** Whether we can interactively prompt (a TTY on stdin). */
export function isInteractive(): boolean {
  return Boolean(stdin.isTTY);
}

/**
 * Ask a question, re-prompting until the answer passes `schema`. An empty answer
 * uses `defaultValue` when one is given. The schema's own message is shown on a
 * rejected answer, so validation rules live in one place (`@pingpal/protocol`).
 */
export async function promptValidated(
  question: string,
  schema: z.ZodType<string>,
  defaultValue?: string,
): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const hint = defaultValue ? ` (${defaultValue})` : "";
      const answer = (await rl.question(`${question}${hint}: `)).trim();
      const candidate = answer === "" && defaultValue ? defaultValue : answer;
      const result = schema.safeParse(candidate);
      if (result.success) return result.data;
      stdout.write(`  ↳ ${result.error.issues[0]?.message ?? "invalid"}\n`);
    }
  } finally {
    rl.close();
  }
}

/**
 * Show the preset faces and let the user pick one by number or id. Defaults to
 * the face PingPal would hash from `handle`, so just pressing Enter still gives
 * a stable, charming choice.
 */
export async function promptFace(handle: string): Promise<string> {
  const fallback = pickFace(handle);
  stdout.write("\nPick a face (Enter for the one we chose for you):\n");
  FACES.forEach((face, i) => {
    const mine = face.id === fallback ? "  ← yours" : "";
    stdout.write(`  ${String(i + 1).padStart(2)}. ${face.online.mid.padEnd(12)} ${face.id}${mine}\n`);
  });

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`face (${fallback}): `)).trim().toLowerCase();
      if (answer === "") return fallback;
      const byNumber = Number(answer);
      if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= FACES.length) {
        return FACES[byNumber - 1]!.id;
      }
      const byId = FACES.find((f) => f.id === answer);
      if (byId) return byId.id;
      stdout.write("  ↳ pick a number from the list, or a face name\n");
    }
  } finally {
    rl.close();
  }
}

/** A one-line preview of a face, for confirmation messages. */
export function facePreview(faceId: string | undefined, handle: string): string {
  return getFace(faceId, handle).online.mid;
}
