import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ping } from "@pingpal/protocol";
import { PingBuffer } from "./ping-buffer.js";
import { resolvePaths } from "./paths.js";

function ping(id: string, from: string, text = "hi"): Ping {
  return { type: "ping", id, from, to: null, text, ts: 1 };
}

describe("PingBuffer outbound (sent) messages", () => {
  let dir: string;
  let buf: PingBuffer;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pp-buf-"));
    buf = new PingBuffer(resolvePaths(dir));
  });
  afterEach(() => {
    // recordSent/add persist to disk asynchronously (fire-and-forget); a write
    // can land mid-delete and yield ENOTEMPTY. Retry the cleanup a few times.
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        /* retry */
      }
    }
  });

  it("records a sent ping as read + outbound", () => {
    buf.recordSent(ping("a", "me"), "relay");
    const [entry] = buf.list();
    expect(entry?.outbound).toBe(true);
    expect(entry?.read).toBe(true);
  });

  it("does not count outbound pings as unread", () => {
    buf.recordSent(ping("a", "me"), "lan");
    expect(buf.unreadCount()).toBe(0);
  });

  it("keeps received pings unread while outbound stay read (chat shows both)", () => {
    buf.recordSent(ping("a", "me", "yo"), "relay");
    buf.add(ping("b", "sarah", "hey"), "lan");
    const list = buf.list();
    expect(list).toHaveLength(2);
    expect(buf.unreadCount()).toBe(1); // only the received one
    const sarah = list.find((p) => p.from === "sarah");
    expect(sarah?.outbound).toBeUndefined();
    expect(sarah?.read).toBe(false);
  });

  it("is idempotent by id (no double-record across send paths)", () => {
    expect(buf.recordSent(ping("dup", "me"), "lan")).toBe(true);
    expect(buf.recordSent(ping("dup", "me"), "relay")).toBe(false);
    expect(buf.list()).toHaveLength(1);
  });
});
