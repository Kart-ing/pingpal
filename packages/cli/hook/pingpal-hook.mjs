#!/usr/bin/env node
/**
 * pingpal-hook — the Claude Code notification hook.
 *
 * Installed by `pingpal init` to run on the Notification event. Each time it
 * fires it asks the local daemon for unread pings, renders each as an ASCII
 * face + bubble, prints them into the session, and marks them read.
 *
 * It is deliberately standalone and dependency-light: it talks to the daemon
 * with a tiny inline IPC client (so it never loads the daemon's `ws`/`bonjour`
 * stack) and imports only `@pingpal/faces` for rendering. If anything is off —
 * no daemon, no socket, a timeout — it exits 0 in silence. A hook must never
 * spew errors into the user's session.
 */
import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderPing, formatRelative } from "@pingpal/faces";

/** Exit cleanly without printing anything. */
function quiet() {
  process.exit(0);
}

function resolvePaths() {
  const base = process.env.PINGPAL_HOME ?? join(homedir(), ".pingpal");
  return {
    sock: join(base, "daemon.sock"),
    portFile: join(base, "daemon.port"),
    unread: join(base, "unread"),
  };
}

/** Open the IPC socket (Unix socket, or the Windows TCP fallback via port file). */
function openSocket(paths) {
  return new Promise((resolve, reject) => {
    let target;
    if (process.platform === "win32") {
      let port = 0;
      try {
        port = Number(readFileSync(paths.portFile, "utf8").trim());
      } catch {
        return reject(new Error("no daemon"));
      }
      if (!Number.isInteger(port) || port <= 0) return reject(new Error("bad port"));
      target = { port, host: "127.0.0.1" };
    } else {
      if (!existsSync(paths.sock)) return reject(new Error("no socket"));
      target = { path: paths.sock };
    }
    const socket = connect(target);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve(socket);
    });
  });
}

/** One IPC round-trip: getPings(markRead) → the buffered pings. */
function fetchPings(paths, timeoutMs = 1500) {
  return new Promise(async (resolve, reject) => {
    let socket;
    try {
      socket = await openSocket(paths);
    } catch (err) {
      return reject(err);
    }
    const id = `hook-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    let buffer = "";
    const done = (fn, arg) => {
      clearTimeout(timer);
      socket.destroy();
      fn(arg);
    };
    const timer = setTimeout(() => done(reject, new Error("timeout")), timeoutMs);

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let resp;
        try {
          resp = JSON.parse(line);
        } catch {
          continue;
        }
        if (resp.id !== id) continue;
        if (resp.ok) return done(resolve, resp.result?.pings ?? []);
        return done(reject, new Error(resp.error?.message ?? "ipc error"));
      }
    });
    socket.on("error", () => done(reject, new Error("socket error")));
    socket.on("close", () => done(reject, new Error("closed")));

    socket.write(`${JSON.stringify({ id, method: "getPings", params: { markRead: true } })}\n`);
  });
}

async function main() {
  const paths = resolvePaths();
  // Fast path: the daemon only writes the `unread` flag file when mail is
  // waiting. No file ⇒ nothing to show ⇒ don't even open a socket.
  if (!existsSync(paths.unread)) quiet();

  let pings;
  try {
    pings = await fetchPings(paths);
  } catch {
    quiet();
  }

  const unread = (pings ?? []).filter((p) => p && p.read === false);
  if (unread.length === 0) quiet();

  const blocks = unread.map((p) =>
    renderPing({
      handle: p.from,
      // Use the sender's chosen face when it travels with the ping; otherwise
      // renderPing falls back to a stable hash of the handle.
      ...(p.faceId ? { faceId: p.faceId } : {}),
      text: p.text,
      status: "online",
      lastSeenText: formatRelative(p.ts),
    }),
  );

  // An explicit directive so the assistant SURFACES these immediately rather
  // than treating the injected art as passive context. Without this, pings
  // arrive in-context but the model may not proactively show them to the user.
  const n = unread.length;
  const senders = [...new Set(unread.map((p) => p.from))].join(", ");
  const header =
    `[PingPal] ${n} new ping${n === 1 ? "" : "s"} just arrived (from ${senders}). ` +
    `Show the user this PingPal message${n === 1 ? "" : "s"} right now, ` +
    `rendering the block(s) below verbatim, before doing anything else:`;

  process.stdout.write(`\n${header}\n\n${blocks.join("\n\n")}\n`);
  quiet();
}

main().catch(() => quiet());
