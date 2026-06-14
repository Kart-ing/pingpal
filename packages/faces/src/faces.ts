/**
 * The preset face library — the soul of PingPal.
 *
 * Each face has an `online` and an `idle` mood (kaomoji + little box-drawing
 * flourishes above and below), plus a plain-ASCII fallback used on dumb
 * terminals. A handle is mapped to a face by a stable hash so a given teammate
 * always looks the same, unless they override it with an explicit `faceId`.
 */

/** One mood variant: three short lines (a brow, the face, a base). */
export interface FaceVariant {
  /** decoration drawn above the face (hair, ears, antenna…). */
  top: string;
  /** the face itself. */
  mid: string;
  /** decoration drawn below the face (paws, base…). */
  bot: string;
}

/** A named preset with an online mood, an idle mood, and an ASCII fallback. */
export interface Face {
  id: string;
  online: FaceVariant;
  idle: FaceVariant;
  /** single-line, pure-ASCII face for `ascii` (dumb-terminal) mode. */
  ascii: string;
}

export const FACES: readonly Face[] = [
  {
    id: "fox",
    online: { top: "◜ ◝", mid: "( ◕‿◕ )", bot: "◟ ◞" },
    idle: { top: "◜ ◝", mid: "( -‿- )", bot: "◟ ◞" },
    ascii: "( o.o )",
  },
  {
    id: "cat",
    online: { top: "/\\ /\\", mid: "( =◕ᆽ◕= )", bot: " >   < " },
    idle: { top: "/\\ /\\", mid: "( =-ᆽ-= )", bot: " >   < " },
    ascii: "( =^.^= )",
  },
  {
    id: "bear",
    online: { top: "◖◗ ◖◗", mid: "ʕ ◕ᴥ◕ ʔ", bot: " ˙   ˙ " },
    idle: { top: "◖◗ ◖◗", mid: "ʕ ˘ᴥ˘ ʔ", bot: " ˙   ˙ " },
    ascii: "( b o.o )",
  },
  {
    id: "robot",
    online: { top: "┌───┐", mid: "[ ◉⌂◉ ]", bot: "└─┴─┘" },
    idle: { top: "┌───┐", mid: "[ -⌂- ]", bot: "└─┴─┘" },
    ascii: "[ o_o ]",
  },
  {
    id: "owl",
    online: { top: " ▟▙ ", mid: "{ ʘ‿ʘ }", bot: " ▘▝ " },
    idle: { top: " ▟▙ ", mid: "{ -‿- }", bot: " ▘▝ " },
    ascii: "{ o.o }",
  },
  {
    id: "bunny",
    online: { top: "(\\_/)", mid: "( •ᴗ• )", bot: 'c(")(")' },
    idle: { top: "(\\_/)", mid: "( -ᴗ- )", bot: 'c(")(")' },
    ascii: "( ^.^ )",
  },
  {
    id: "ghost",
    online: { top: ".-~-.", mid: "( ◠‿◠ )", bot: "\\~^~/" },
    idle: { top: ".-~-.", mid: "( ◡‿◡ )", bot: "\\~^~/" },
    ascii: "( ~.~ )",
  },
  {
    id: "star",
    online: { top: "✦ · ✦", mid: "( ✪‿✪ )", bot: "·✦ ✦·" },
    idle: { top: "✦ · ✦", mid: "( ✪.✪ )", bot: "·✦ ✦·" },
    ascii: "( *.* )",
  },
];

/** The default face used when a hash or lookup somehow finds nothing. */
const DEFAULT_FACE: Face = FACES[0] as Face;

/** Every preset id, in declaration order. */
export const FACE_IDS: readonly string[] = FACES.map((f) => f.id);

const FACE_BY_ID = new Map<string, Face>(FACES.map((f) => [f.id, f]));

/**
 * FNV-1a — a small, fast, deterministic string hash. We only need stable
 * distribution across the preset list, not cryptographic strength.
 */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // force to an unsigned 32-bit integer
  return h >>> 0;
}

/**
 * Deterministically map a handle to a stable preset face id. The same handle
 * always yields the same face across machines and runs.
 */
export function pickFace(handle: string): string {
  const idx = hashString(handle) % FACES.length;
  return (FACES[idx] ?? DEFAULT_FACE).id;
}

/**
 * Resolve a {@link Face} to render. An explicit, known `faceId` wins; otherwise
 * we fall back to {@link pickFace} on the handle so every teammate still gets a
 * stable, charming face even with no override.
 */
export function getFace(faceId: string | undefined, handle: string): Face {
  if (faceId) {
    const exact = FACE_BY_ID.get(faceId);
    if (exact) return exact;
  }
  return FACE_BY_ID.get(pickFace(handle)) ?? DEFAULT_FACE;
}
