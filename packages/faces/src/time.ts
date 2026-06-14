/**
 * Format an epoch-ms timestamp as a short, human relative time like "2s ago"
 * or "5m ago". Kept pure by accepting an explicit `now` (defaulting to the
 * wall clock) so the renderer's output is testable.
 */
export function formatRelative(lastSeen: number, now: number = Date.now()): string {
  const diff = now - lastSeen;
  if (!Number.isFinite(diff) || diff < 5_000) return "just now";
  const s = Math.floor(diff / 1_000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
