/**
 * Plain-text layout helpers. Everything here measures with {@link displayWidth}
 * so it is safe even if a string already carries ANSI codes — though the
 * renderer deliberately lays out in plain text and colours last.
 */
import { displayWidth } from "./ansi.js";

/** `n` spaces (never negative). */
export function spaces(n: number): string {
  return " ".repeat(Math.max(0, n));
}

/** Pad `s` on the right with spaces to a visible width of `w`. */
export function padEnd(s: string, w: number): string {
  return s + spaces(w - displayWidth(s));
}

/** Centre `s` within a visible width of `w`, biasing extra space to the right. */
export function padCenter(s: string, w: number): string {
  const len = displayWidth(s);
  if (len >= w) return s;
  const total = w - len;
  const left = Math.floor(total / 2);
  return spaces(left) + s + spaces(total - left);
}

/**
 * Word-wrap `text` to a maximum visible width of `width`. Words longer than the
 * width are hard-broken so a single long token can never blow past the column
 * budget. Returns at least one line.
 */
export function wrapText(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = "";

  const pushCurrent = (): void => {
    if (current.length > 0) {
      lines.push(current);
      current = "";
    }
  };

  for (let word of words) {
    // Hard-break any word that cannot fit on a line by itself.
    while (displayWidth(word) > max) {
      pushCurrent();
      const head = [...word].slice(0, max).join("");
      lines.push(head);
      word = [...word].slice(max).join("");
    }
    if (word.length === 0) continue;
    if (current.length === 0) {
      current = word;
    } else if (displayWidth(current) + 1 + displayWidth(word) <= max) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  pushCurrent();

  return lines.length > 0 ? lines : [""];
}
