import { genCode, newRoomId, normalizeCode } from "@pingpal/protocol";

/**
 * The relay's tiny control plane: a registry mapping short human **join codes**
 * to full-entropy **roomIds**. This is what makes Google-Meet-style codes work —
 * `pingpal start-room` asks the relay to {@link create} a room, gets back a
 * fresh `code` + `roomId`, and shares the code; a joiner {@link resolve}s the
 * code back to the roomId, then connects by roomId like everyone else.
 *
 * Lifetime mirrors the rest of the relay: in-memory, nothing persisted. A code
 * is forgotten once its room goes empty (the relay calls {@link forget} when the
 * last member of a room disconnects), so a code is single-meeting — exactly the
 * "the link dies with the meeting" intuition. Codes are normalised (lowercased,
 * dashes/space stripped) before lookup so `VMW-QKZT-PH` and `vmwqkztph` match.
 */
export class RoomDirectory {
  /** normalised code → roomId */
  private readonly byCode = new Map<string, string>();
  /** roomId → normalised code, so we can drop the mapping when a room empties */
  private readonly byRoom = new Map<string, string>();

  /**
   * Mint a brand-new room: a fresh roomId and a fresh, unused join code. Retries
   * code generation on the (astronomically rare) collision so a returned code is
   * always currently unique.
   */
  create(): { code: string; roomId: string } {
    const roomId = newRoomId();
    let code = genCode();
    let key = normalizeCode(code);
    // Avoid handing out a code that's already live.
    for (let i = 0; i < 5 && this.byCode.has(key); i++) {
      code = genCode();
      key = normalizeCode(code);
    }
    this.byCode.set(key, roomId);
    this.byRoom.set(roomId, key);
    return { code, roomId };
  }

  /** Resolve a (possibly messily-typed) join code to its roomId, or null. */
  resolve(code: string): string | null {
    return this.byCode.get(normalizeCode(code)) ?? null;
  }

  /**
   * Drop the code mapping for a room once it empties. Idempotent and safe to
   * call for rooms that were never minted here (legacy roomCode rooms aren't in
   * the directory — this is just a no-op for them).
   */
  forget(roomId: string): void {
    const key = this.byRoom.get(roomId);
    if (key === undefined) return;
    this.byCode.delete(key);
    this.byRoom.delete(roomId);
  }

  /** Number of live code mappings (for tests / introspection). */
  get size(): number {
    return this.byCode.size;
  }
}
