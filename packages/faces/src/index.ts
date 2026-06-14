/**
 * @pingpal/faces — the charming ASCII face + message-bubble renderer.
 *
 * Pure, dependency-light (only `@pingpal/protocol` for the 90-char rule), and
 * fully unit-testable without a terminal. The hook uses {@link renderPing} to
 * surface an incoming ping inside a Claude Code session; the MCP `whos_online`
 * tool uses {@link renderRoster}.
 */
export { ansi, colorEnabled, displayWidth, stripAnsi } from "./ansi.js";

export { FACES, FACE_IDS, getFace, pickFace } from "./faces.js";
export type { Face, FaceVariant } from "./faces.js";

export { wrapText } from "./layout.js";
export { formatRelative } from "./time.js";

export { renderPing, renderRoster } from "./render.js";
export type {
  RenderPingOptions,
  RenderRosterOptions,
  RosterPeer,
} from "./render.js";
