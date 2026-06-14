/**
 * The three PingPal MCP tools, as plain async functions over a
 * {@link DaemonClient}. They return MCP `CallToolResult`-shaped objects so they
 * can be unit-tested directly (no transport, no SDK) and registered onto an
 * `McpServer` by {@link ./server.ts}.
 *
 * Design notes:
 *  - Every tool degrades gracefully: if the daemon socket is unreachable, it
 *    returns a friendly "run `pingpal start`" message instead of throwing, so a
 *    stopped daemon never spews errors into a Claude Code session.
 *  - The two read tools (`whos_online`, `list_pings`) return both a
 *    human-readable text rendering *and* `structuredContent` so Claude can both
 *    show it to the user and reason over the raw data.
 */
import { z } from "zod";
import { validatePingText } from "@pingpal/protocol";
import { formatRelative, renderRoster, type RosterPeer } from "@pingpal/faces";

import {
  isUnreachable,
  type BufferedPing,
  type DaemonClient,
  type MergedPeer,
} from "./daemon-ipc.js";

/**
 * Minimal MCP tool-result shape (a structural subset of the SDK's
 * `CallToolResult`). The index signature keeps it assignable to the SDK's
 * result type, which carries optional `_meta` and other open fields.
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

const DAEMON_DOWN =
  "PingPal daemon not running — run `pingpal start` to connect.";

function text(body: string, extra?: Partial<ToolResult>): ToolResult {
  return { content: [{ type: "text", text: body }], ...extra };
}

/**
 * Wrap a tool body so that an unreachable daemon yields the friendly message
 * and any other failure is surfaced as a non-fatal error result (never a throw
 * that would crash the stdio transport).
 */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (isUnreachable(err)) return text(DAEMON_DOWN);
    const message = err instanceof Error ? err.message : String(err);
    return text(`PingPal: ${message}`, { isError: true });
  }
}

// ---------------------------------------------------------------------------
// whos_online
// ---------------------------------------------------------------------------

export const whosOnlineOutputSchema = {
  peers: z.array(
    z.object({
      handle: z.string(),
      status: z.enum(["online", "idle", "offline"]),
      faceId: z.string(),
      via: z.enum(["lan", "relay", "both"]),
      lastSeen: z.number(),
    }),
  ),
  count: z.number(),
} as const;

export function whosOnline(client: DaemonClient): Promise<ToolResult> {
  return guard(async () => {
    const { peers } = await client.getPresence();
    const roster: RosterPeer[] = peers.map((p: MergedPeer) => ({
      handle: p.handle,
      faceId: p.faceId,
      status: p.status,
      lastSeen: p.lastSeen,
    }));
    const rendered = renderRoster(roster);
    const structured = {
      count: peers.length,
      peers: peers.map((p) => ({
        handle: p.handle,
        status: p.status,
        faceId: p.faceId,
        via: p.via,
        lastSeen: p.lastSeen,
      })),
    };
    return text(rendered, { structuredContent: structured });
  });
}

// ---------------------------------------------------------------------------
// list_pings
// ---------------------------------------------------------------------------

export const listPingsInputSchema = {
  markRead: z
    .boolean()
    .optional()
    .describe("Mark the returned pings as read (default true)."),
} as const;

export const listPingsOutputSchema = {
  pings: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string().nullable(),
      text: z.string(),
      ts: z.number(),
      read: z.boolean(),
      via: z.enum(["lan", "relay"]),
    }),
  ),
  count: z.number(),
} as const;

function renderPingLine(p: BufferedPing, now: number): string {
  const when = formatRelative(p.ts, now);
  const target = p.to ? ` → @${p.to}` : " → room";
  const flag = p.read ? "" : " ·new";
  return `@${p.from}${target} (${when})${flag}: ${p.text}`;
}

export function listPings(
  client: DaemonClient,
  args: { markRead?: boolean } = {},
  now: number = Date.now(),
): Promise<ToolResult> {
  return guard(async () => {
    const markRead = args.markRead ?? true;
    const { pings } = await client.getPings(markRead);
    if (pings.length === 0) {
      return text("No pings — your inbox is quiet.", {
        structuredContent: { count: 0, pings: [] },
      });
    }
    const lines = pings.map((p) => renderPingLine(p, now));
    const header = `${pings.length} ping${pings.length === 1 ? "" : "s"}${
      markRead ? " (marked read)" : ""
    }:`;
    const structured = {
      count: pings.length,
      pings: pings.map((p) => ({
        id: p.id,
        from: p.from,
        to: p.to,
        text: p.text,
        ts: p.ts,
        read: p.read,
        via: p.via,
      })),
    };
    return text([header, ...lines].join("\n"), {
      structuredContent: structured,
    });
  });
}

// ---------------------------------------------------------------------------
// send_ping
// ---------------------------------------------------------------------------

export const sendPingInputSchema = {
  to: z
    .string()
    .optional()
    .describe(
      "Target handle (with or without a leading @). Omit to broadcast to the whole room.",
    ),
  text: z.string().describe("The message body — 90 characters max."),
} as const;

/** Normalize a target: strip a leading `@`, trim; empty/absent => broadcast. */
export function normalizeTarget(to: string | undefined): string | undefined {
  if (to == null) return undefined;
  const cleaned = to.trim().replace(/^@+/, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export function sendPing(
  client: DaemonClient,
  args: { to?: string; text: string },
): Promise<ToolResult> {
  return guard(async () => {
    const check = validatePingText(args.text);
    if (!check.ok) {
      return text(`Can't send: ${check.reason}`, { isError: true });
    }
    const to = normalizeTarget(args.to);
    const result = await client.sendPing(to, args.text);

    const dest = to ? `@${to}` : "the room";
    if (result.via === "none" || !result.delivered) {
      return text(
        `Queued for ${dest}, but no one is reachable right now (id ${result.id}).`,
      );
    }
    return text(`Sent to ${dest} via ${result.via} (id ${result.id}).`);
  });
}
