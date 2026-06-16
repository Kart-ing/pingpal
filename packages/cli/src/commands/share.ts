/**
 * `pingpal share` — send a file to a teammate or the whole room.
 *
 * Files ≤5 MB are uploaded to the relay blob store (30 min TTL) and shared
 * instantly via a file_share ping. Larger files are routed through a configured
 * git remote for persistent, versioned sharing.
 */
import { statSync } from "node:fs";
import { basename } from "node:path";
import { sendRequest, IpcClientError } from "@pingpal/daemon";
import type { PingPalPaths } from "@pingpal/daemon";
import { readJson } from "../jsonfile.js";

const MAX_RELAY_BYTES = 5_242_880; // 5 MB

export async function shareCommand(
  paths: PingPalPaths,
  filePath: string,
  opts: { to?: string; git?: boolean },
): Promise<number> {
  // Validate the file exists and get its size.
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    process.stderr.write(`pingpal: file not found: ${filePath}\n`);
    return 1;
  }
  if (!stat.isFile()) {
    process.stderr.write(`pingpal: not a regular file: ${filePath}\n`);
    return 1;
  }

  const size = stat.size;
  const name = basename(filePath);

  // --git flag or >5 MB → git-backed sharing
  if (opts.git || size > MAX_RELAY_BYTES) {
    return shareViaGit(paths, filePath, name, size, opts.to);
  }

  // ≤5 MB → relay blob store
  return shareViaRelay(paths, filePath, name, size, opts.to);
}

async function shareViaRelay(
  paths: PingPalPaths,
  filePath: string,
  name: string,
  size: number,
  to?: string,
): Promise<number> {
  try {
    const result = await sendRequest(paths, "sendFile", {
      path: filePath,
      to: to ?? null,
    });
    const dest = to ? `@${to}` : "the room";
    process.stdout.write(
      `📎 shared ${name} (${formatSize(size)}) to ${dest}\n` +
        `   blob ${result.blobId.slice(0, 8)}… — available for 30 minutes\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof IpcClientError && err.code === "unreachable") {
      process.stderr.write(
        "pingpal: daemon not running — start it with `pingpal start`.\n",
      );
      return 1;
    }
    if (
      err instanceof IpcClientError &&
      err.code === "file_too_large"
    ) {
      process.stderr.write(
        `pingpal: ${name} is ${formatSize(size)} — the relay limit is ${formatSize(MAX_RELAY_BYTES)}.\n` +
          `  Try \`pingpal share --git ${filePath}\` for larger files.\n`,
      );
      return 1;
    }
    if (err instanceof IpcClientError && err.code === "no_relay") {
      process.stderr.write(
        "pingpal: relay is not connected. Wait for the daemon to connect and try again.\n",
      );
      return 1;
    }
    process.stderr.write(
      `pingpal: share failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function shareViaGit(
  paths: PingPalPaths,
  filePath: string,
  name: string,
  size: number,
  to?: string,
): Promise<number> {
  // Check for git repo config
  let cfg: { fileRepo?: string } = {};
  try {
    cfg = await readJson<{ fileRepo?: string }>(paths.config, {});
  } catch {
    // no config yet
  }

  if (!cfg.fileRepo) {
    process.stderr.write(
      `pingpal: no git file repo configured.\n` +
        `  Set one in ~/.pingpal/config.json:\n` +
        `    "fileRepo": "git@github.com:you/team-files.git"\n` +
        `  Or share via relay (≤${formatSize(MAX_RELAY_BYTES)}) with:\n` +
        `    pingpal share ${filePath}\n`,
    );
    return 1;
  }

  // Copy the file to .pingpal-files/, commit, and push.
  const { execSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { copyFile } = await import("node:fs/promises");

  const stagingDir = join(paths.files, "_shared");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(stagingDir, { recursive: true });

  const dest = join(stagingDir, name);

  try {
    await copyFile(filePath, dest);

    const git = (args: string) =>
      execSync(`git -C "${stagingDir}" ${args}`, {
        encoding: "utf8",
        timeout: 30000,
      });

    // Init if needed
    try {
      git("rev-parse --is-inside-work-tree");
    } catch {
      execSync(`git -C "${stagingDir}" init`, { timeout: 5000 });
      git(`remote add origin ${cfg.fileRepo}`);
    }

    git("add .");
    git(`commit -m "share: ${name} (${formatSize(size)})" --allow-empty`);
    git("push -u origin main 2>&1 || git push -u origin master 2>&1");

    // Clean up the copy
    const { rm } = await import("node:fs/promises");
    await rm(dest, { force: true });

    const dest2 = to ? `@${to}` : "the room";
    process.stdout.write(
      `📎 shared ${name} (${formatSize(size)}) to ${dest2} via git\n` +
        `   repo: ${cfg.fileRepo}\n` +
        `   Tell teammates: \`pingpal pull\` to sync.\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `pingpal: git share failed: ${err instanceof Error ? err.message : String(err)}\n` +
        `  Make sure you have push access to ${cfg.fileRepo}.\n`,
    );
    return 1;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
