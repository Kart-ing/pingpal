import { stdin, stdout } from "node:process";
import {
  IpcClientError,
  sendRequest,
  type PingPalPaths,
} from "@pingpal/daemon";
import { getFace } from "@pingpal/faces";

/**
 * `pingpal chat` — a full-screen, inline group-chat TUI for the current room.
 *
 * Takes over the terminal (alternate screen + raw input), polls the local daemon
 * for messages + presence on a short interval, renders a scrollback of the
 * conversation (both sides), and sends on Enter. `q`/Esc/Ctrl-C quits cleanly and
 * restores the terminal. Dependency-light on purpose: raw ANSI, no TUI library.
 *
 * The daemon's IPC is request/response only, so we poll (~1s) rather than stream.
 */

const ESC = "\x1b[";
const ALT_ON = "\x1b[?1049h"; // enter alternate screen
const ALT_OFF = "\x1b[?1049l"; // leave alternate screen
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const POLL_MS = 1000;

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  grey: "\x1b[90m",
  magenta: "\x1b[35m",
};
const DOT = { online: "●", idle: "◐", offline: "○" } as const;

interface BufPing {
  id: string;
  from: string;
  to: string | null;
  text: string;
  ts: number;
  read?: boolean;
  outbound?: boolean;
}
interface Peer {
  handle: string;
  faceId: string;
  status: "online" | "idle" | "offline";
  lastSeen: number;
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export async function chatCommand(paths: PingPalPaths): Promise<number> {
  // Verify the daemon is up before taking over the screen.
  let me: string;
  let room = "";
  try {
    const st = await sendRequest(paths, "status");
    me = st.handle;
    room = st.roomCode ?? "";
  } catch (err) {
    if (err instanceof IpcClientError && err.code === "unreachable") {
      stdout.write("pingpal: daemon not running — start it with `pingpal start`.\n");
      return 1;
    }
    stdout.write(`pingpal: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (!stdin.isTTY) {
    stdout.write("pingpal chat: needs an interactive terminal (TTY).\n");
    return 1;
  }

  const faceByHandle = new Map<string, string>();
  let peers: Peer[] = [];
  let msgs: BufPing[] = [];
  let input = "";
  let status = "";
  let dirty = true;
  let alive = true;
  const now = () => Date.now();

  const faceMid = (handle: string): string => {
    // getFace(faceId, handle) falls back to a stable hash of the handle itself.
    const f = getFace(faceByHandle.get(handle), handle);
    return f.online.mid.trim();
  };

  async function refresh(): Promise<void> {
    try {
      const pres = await sendRequest(paths, "getPresence");
      peers = pres.peers as Peer[];
      for (const p of peers) if (p.faceId) faceByHandle.set(p.handle, p.faceId);
    } catch {
      /* keep last roster */
    }
    try {
      // markRead:true — opening chat means you're reading. Keep outbound for history.
      const res = await sendRequest(paths, "getPings", { markRead: true });
      msgs = res.pings as BufPing[];
      dirty = true;
    } catch {
      /* keep last messages */
    }
  }

  function render(): void {
    const cols = stdout.columns ?? 80;
    const rows = stdout.rows ?? 24;
    const t = now();
    const lines: string[] = [];

    // Header
    const others = peers.filter((p) => p.handle !== me);
    const roster =
      others.length === 0
        ? `${C.dim}room empty${C.reset}`
        : others
            .map((p) => {
              const col =
                p.status === "online" ? C.green : p.status === "idle" ? C.yellow : C.grey;
              return `${col}${DOT[p.status]}${C.reset} ${p.handle}`;
            })
            .join("  ");
    const title = `${C.magenta}${C.bold}PingPal${C.reset}${room ? ` ${C.dim}#${room}${C.reset}` : ""}  ${C.dim}you: ${me}${C.reset}`;
    lines.push(title);
    lines.push(roster);
    lines.push(`${C.grey}${"─".repeat(Math.max(1, cols))}${C.reset}`);

    // Message area height = rows - header(3) - input(2)
    const areaH = Math.max(3, rows - 3 - 2);
    const rendered: string[] = [];
    for (const m of msgs.slice(-areaH * 2)) {
      const mine = m.outbound || m.from === me;
      const when = `${C.grey}${relTime(m.ts, t)}${C.reset}`;
      if (mine) {
        // your own line — labelled, no face
        const body = clamp(m.text, Math.max(10, cols - 18));
        rendered.push(`      ${C.cyan}you${C.reset} ${C.dim}▶${C.reset} ${body}  ${when}`);
      } else {
        const face = `${C.cyan}${faceMid(m.from)}${C.reset}`;
        const who = `${C.bold}${C.cyan}${m.from}${C.reset}`;
        const body = clamp(m.text, Math.max(10, cols - 24));
        rendered.push(`${face} ${who} ${C.dim}·${C.reset} ${body}  ${when}`);
      }
    }
    const shown = rendered.slice(-areaH);
    while (shown.length < areaH) shown.unshift("");
    lines.push(...shown);

    // Input
    lines.push(`${C.grey}${"─".repeat(Math.max(1, cols))}${C.reset}`);
    const hint = status ? `  ${C.dim}${status}${C.reset}` : `  ${C.dim}@name to DM · Enter send · q quit${C.reset}`;
    lines.push(`${C.green}❯${C.reset} ${input}${hint}`);

    stdout.write(`${ESC}H${ESC}2J`);
    stdout.write(lines.join("\n"));
    dirty = false;
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text) return;
    if (text.length > 90) {
      status = `too long (${text.length}/90)`;
      input = input.slice(0, 90);
      return;
    }
    // @handle prefix → directed; otherwise room broadcast
    let to: string | null = null;
    let body = text;
    const m = /^@(\S+)\s+([\s\S]+)$/.exec(text);
    if (m) {
      to = m[1] ?? null;
      body = m[2] ?? "";
    }
    input = "";
    status = "sending…";
    dirty = true;
    try {
      const r = await sendRequest(paths, "sendPing", { to, text: body });
      status = r.delivered ? `sent (${r.via})` : `queued (${r.via})`;
    } catch (err) {
      status = `send failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await refresh();
  }

  // --- terminal setup ---
  const wasRaw = stdin.isRaw;
  let timer: ReturnType<typeof setInterval>;
  function teardown(): void {
    alive = false;
    clearInterval(timer);
    stdin.setRawMode(wasRaw);
    stdin.pause();
    stdout.write(SHOW_CURSOR + ALT_OFF);
  }

  stdout.write(ALT_ON + HIDE_CURSOR);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  await refresh();
  render();

  timer = setInterval(() => {
    if (!alive) return;
    void refresh().then(() => {
      if (alive && dirty) render();
    });
  }, POLL_MS);

  return await new Promise<number>((resolve) => {
    stdin.on("data", (key: string) => {
      if (!alive) return;
      const code = key.charCodeAt(0);
      // Ctrl-C (3) or Esc (27) → quit; bare 'q' quits only when input is empty.
      if (code === 3 || code === 27 || (key === "q" && input === "")) {
        teardown();
        resolve(0);
        return;
      }
      // Enter (CR 13 / LF 10) → send
      if (code === 13 || code === 10) {
        void send().then(() => alive && render());
        return;
      }
      // Backspace: DEL (127) or BS (8)
      if (code === 127 || code === 8) {
        input = input.slice(0, -1);
        status = "";
        dirty = true;
        render();
        return;
      }
      // Printable single chars only (ignore other control / escape sequences)
      if (code >= 32 && code !== 127 && key.length === 1) {
        input += key;
        if (input.length > 90) {
          status = "max 90 chars";
          input = input.slice(0, 90);
        } else {
          status = "";
        }
        dirty = true;
        render();
      }
    });
    stdin.on("error", () => {
      teardown();
      resolve(1);
    });
  });
}
