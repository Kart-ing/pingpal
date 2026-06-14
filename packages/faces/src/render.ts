/**
 * The headline renderer. Draws a message bubble *above* a kaomoji face, with a
 * little connector dropping onto the face's head, a label box carrying the
 * handle, and a status dot. Plus {@link renderRoster} for a compact
 * who's-online list (used by the MCP `whos_online` tool).
 *
 * Everything is laid out in plain text and measured by code-point width, then
 * coloured last so ANSI never disturbs alignment. Respects `NO_COLOR` and
 * offers a pure-ASCII fallback for dumb terminals.
 */
import { MAX_PING_CHARS } from "@pingpal/protocol";
import type { Status } from "@pingpal/protocol";

import { ansi, colorEnabled, displayWidth } from "./ansi.js";
import { getFace } from "./faces.js";
import type { Face } from "./faces.js";
import { padCenter, padEnd, spaces, wrapText } from "./layout.js";
import { formatRelative } from "./time.js";

/** Visible width budget for the wrapped message text inside the bubble. */
const WRAP_WIDTH = 38;
/** Left margin for the whole rendered block. */
const INDENT = 3;
/** Left margin of the face block (a touch inset from the bubble). */
const FACE_INDENT = INDENT + 4;
/** Inner horizontal padding on each side of the bubble text. */
const PAD = 2;
/** Gap between the face block and the handle label box. */
const GAP = "  ";
/** Gap between the label box and the status segment. */
const STATUS_GAP = "   ";

const BOX = {
  unicode: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", tdown: "┬" },
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", tdown: "+" },
} as const;

/** Box-drawing glyphs we colour as "borders" (unicode mode only). */
const BORDER_RE = /[╭╮╰╯─│┬┴├┤┼┌┐└┘]+/g;

/** The little status indicator: ● online · ◐ idle · ○ offline. */
function statusDot(status: Status, ascii = false): string {
  if (ascii) return status === "online" ? "*" : status === "idle" ? "o" : ".";
  return status === "online" ? "●" : status === "idle" ? "◐" : "○";
}

interface Palette {
  border: (s: string) => string;
  handle: (s: string) => string;
  dim: (s: string) => string;
  dot: (status: Status, s: string) => string;
}

function makePalette(color: boolean): Palette {
  const id = (s: string): string => s;
  if (!color) return { border: id, handle: id, dim: id, dot: (_s, x) => x };
  return {
    border: (s) => ansi.cyanDim(s),
    handle: (s) => ansi.bold(ansi.cyan(s)),
    dim: (s) => ansi.dim(s),
    dot: (status, s) =>
      status === "online"
        ? ansi.green(s)
        : status === "idle"
          ? ansi.yellow(s)
          : ansi.dim(s),
  };
}

/** Colour any runs of box-drawing characters in a finished line. */
function paintBorders(line: string, p: Palette): string {
  return line.replace(BORDER_RE, (m) => p.border(m));
}

/** Centre `text` in width `w`, painting only the text (spaces stay plain). */
function centerPainted(text: string, w: number, paint: (s: string) => string): string {
  const len = displayWidth(text);
  if (len >= w) return paint(text);
  const total = w - len;
  const left = Math.floor(total / 2);
  return spaces(left) + paint(text) + spaces(total - left);
}

export interface RenderPingOptions {
  handle: string;
  /** the message body; defensively truncated to the 90-char rule. */
  text: string;
  /** presence status; drives the mood + dot. Defaults to `online`. */
  status?: Status;
  /** pre-formatted "2s ago"; omit to show no timestamp. */
  lastSeenText?: string;
  /** an explicit face object (wins over `faceId`). */
  face?: Face;
  /** a preset id; falls back to a stable hash of the handle if unknown. */
  faceId?: string;
  /** force colour on/off. Defaults to auto (honours `NO_COLOR`). */
  color?: boolean;
  /** pure-ASCII output for dumb terminals (no box-drawing, ASCII face). */
  ascii?: boolean;
}

/**
 * Render the full "incoming ping" art: bubble + connector + face + label +
 * status. Pure — give it the same inputs and it returns the same string.
 */
export function renderPing(opts: RenderPingOptions): string {
  const status: Status = opts.status ?? "online";
  const ascii = opts.ascii ?? false;
  const color = colorEnabled(opts.color);
  const p = makePalette(color);
  const chars = ascii ? BOX.ascii : BOX.unicode;
  const face = opts.face ?? getFace(opts.faceId, opts.handle);

  // 1. Message text — clamp to the hard cap, then wrap.
  const safeText = [...opts.text].slice(0, MAX_PING_CHARS).join("");
  const lines = wrapText(safeText, WRAP_WIDTH);
  const contentW = Math.max(1, ...lines.map(displayWidth));

  // 2. Face block (three lines), centred to its own width.
  let ftop: string;
  let fmid: string;
  let fbot: string;
  if (ascii) {
    ftop = "";
    fmid = face.ascii;
    fbot = "";
  } else {
    const v = status === "online" ? face.online : face.idle;
    ftop = v.top;
    fmid = v.mid;
    fbot = v.bot;
  }
  const fw = Math.max(1, displayWidth(ftop), displayWidth(fmid), displayWidth(fbot));

  // 3. Connector geometry — the ┬ sits directly above the face's head.
  const connectorCol = FACE_INDENT + Math.floor(fw / 2);
  const bx = connectorCol - (INDENT + 1);
  // Widen the bubble if needed so the connector always lands inside it.
  const innerW = Math.max(contentW + PAD * 2, bx + 2, 3);

  // 4. Bubble.
  const bubbleTop = spaces(INDENT) + chars.tl + chars.h.repeat(innerW) + chars.tr;
  const bubbleBody = lines.map((line) => {
    const cell = spaces(PAD) + padEnd(line, innerW - PAD * 2) + spaces(PAD);
    return spaces(INDENT) + chars.v + cell + chars.v;
  });
  const bubbleBottom =
    spaces(INDENT) +
    chars.bl +
    chars.h.repeat(bx) +
    chars.tdown +
    chars.h.repeat(innerW - 1 - bx) +
    chars.br;
  const connectorRow = spaces(connectorCol) + chars.v;

  // 5. Handle label box.
  const labInner = Math.max(displayWidth(opts.handle) + 6, 9);
  const labTop = chars.tl + chars.h.repeat(labInner) + chars.tr;
  const labBot = chars.bl + chars.h.repeat(labInner) + chars.br;
  const labMid =
    p.border(chars.v) + centerPainted(opts.handle, labInner, p.handle) + p.border(chars.v);

  // 6. Status segment, e.g. "● online · 2s ago".
  const tail = opts.lastSeenText ? `${" · "}${opts.lastSeenText}` : "";
  const statusSeg =
    p.dot(status, statusDot(status, ascii)) + ` ${status}` + (tail ? p.dim(tail) : "");

  // 7. Assemble the face + label rows.
  const faceCellTop = spaces(FACE_INDENT) + padCenter(ftop, fw);
  const faceCellMid = spaces(FACE_INDENT) + padCenter(fmid, fw);
  const faceCellBot = spaces(FACE_INDENT) + padCenter(fbot, fw);

  const rowTop = `${faceCellTop}${GAP}${labTop}`;
  const rowMid = `${faceCellMid}${GAP}${labMid}${STATUS_GAP}${statusSeg}`;
  const rowBot = `${faceCellBot}${GAP}${labBot}`;

  const out = [
    paintBorders(bubbleTop, p),
    ...bubbleBody.map((l) => paintBorders(l, p)),
    paintBorders(bubbleBottom, p),
    paintBorders(connectorRow, p),
    paintBorders(rowTop, p),
    // rowMid already carries colour on its label/status; only the face
    // decoration's box glyphs (if any) remain — but the face has none here.
    rowMid,
    paintBorders(rowBot, p),
  ];

  return out.join("\n");
}

/** One peer in the roster. Mirrors {@link Peer} from the protocol. */
export interface RosterPeer {
  handle: string;
  faceId?: string;
  status: Status;
  lastSeen?: number;
}

export interface RenderRosterOptions {
  color?: boolean;
  ascii?: boolean;
  /** "now" for relative timestamps; defaults to the wall clock. */
  now?: number;
  /** drop the little "who's online" header. */
  noHeader?: boolean;
}

/**
 * Render a compact who's-online list — one line per peer with a status dot,
 * handle, the peer's face, and a relative last-seen. Used by the MCP
 * `whos_online` tool, so it stays terse and aligns into neat columns.
 */
export function renderRoster(
  peers: readonly RosterPeer[],
  opts: RenderRosterOptions = {},
): string {
  const ascii = opts.ascii ?? false;
  const color = colorEnabled(opts.color);
  const p = makePalette(color);

  if (peers.length === 0) {
    const empty = "no one else is here yet — you have the room to yourself.";
    return opts.noHeader ? empty : `${p.dim(empty)}`;
  }

  const faceOf = (peer: RosterPeer): string => {
    const face = getFace(peer.faceId, peer.handle);
    if (ascii) return face.ascii;
    return peer.status === "online" ? face.online.mid : face.idle.mid;
  };

  const handleW = Math.max(...peers.map((peer) => displayWidth(peer.handle)));
  const faceW = Math.max(...peers.map((peer) => displayWidth(faceOf(peer))));

  const rows = peers.map((peer) => {
    const dot = p.dot(peer.status, statusDot(peer.status, ascii));
    const handle = p.handle(padEnd(peer.handle, handleW));
    const face = padCenter(faceOf(peer), faceW);
    const seen =
      typeof peer.lastSeen === "number"
        ? p.dim(` · ${formatRelative(peer.lastSeen, opts.now)}`)
        : "";
    return `  ${dot} ${handle}  ${face}  ${peer.status}${seen}`;
  });

  if (opts.noHeader) return rows.join("\n");
  const header = p.dim(`who's online (${peers.length})`);
  return [header, ...rows].join("\n");
}
