/**
 * A tiny, dependency-free ANSI helper. We deliberately avoid pulling in chalk
 * or similar so `@pingpal/faces` stays portable and trivially testable.
 *
 * All layout math in the renderer is done on *plain* text and measured by
 * {@link displayWidth}, which strips escape codes first — so colour never
 * shifts a column.
 */

const ESC = "";
const ANSI_RE = /\[[0-9;]*m/g;

/** Remove every SGR colour/style escape from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Visible width of a string in terminal cells, approximated as the number of
 * Unicode code points after stripping ANSI. This is exact for ASCII and the
 * box-drawing / narrow kaomoji glyphs we use, and deterministic for tests.
 */
export function displayWidth(s: string): number {
  return [...stripAnsi(s)].length;
}

const wrap = (code: string, s: string): string => `${ESC}[${code}m${s}${ESC}[0m`;

/** Raw style functions. The renderer chooses whether to call these (see palette). */
export const ansi = {
  bold: (s: string): string => wrap("1", s),
  dim: (s: string): string => wrap("2", s),
  red: (s: string): string => wrap("31", s),
  green: (s: string): string => wrap("32", s),
  yellow: (s: string): string => wrap("33", s),
  cyan: (s: string): string => wrap("36", s),
  gray: (s: string): string => wrap("90", s),
  /** dim cyan — used for box borders so the face/text stay the focus. */
  cyanDim: (s: string): string => wrap("2;36", s),
};

/**
 * Decide whether colour should be emitted. An explicit `color` option always
 * wins; otherwise we honour the `NO_COLOR` convention (https://no-color.org).
 */
export function colorEnabled(explicit?: boolean): boolean {
  if (typeof explicit === "boolean") return explicit;
  return !("NO_COLOR" in process.env);
}
