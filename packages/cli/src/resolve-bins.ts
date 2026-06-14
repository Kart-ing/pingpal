import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * Resolve a package's main entry. The PingPal packages are ESM-only — their
 * `exports` map declares an `import` condition but no `require` — so we resolve
 * through `import.meta.resolve` (which honours the `import` condition) and only
 * fall back to `require.resolve` on older runtimes that lack it.
 */
function resolveEntry(pkg: string): string {
  const meta = import.meta as ImportMeta & { resolve?: (specifier: string) => string };
  if (typeof meta.resolve === "function") {
    return fileURLToPath(meta.resolve(pkg));
  }
  return require.resolve(pkg);
}

/**
 * Resolve the absolute path to a workspace package's compiled `bin.js`.
 *
 * We resolve the package's main entry (its `exports["."]`) and take `bin.js`
 * from the same `dist/` directory. Going through the absolute path — rather than
 * relying on a `pingpald` / `pingpal-mcp` command being on `PATH` — is what
 * makes this work after `npm i -g pingpal`, where dependency bins are linked
 * into pingpal's own `node_modules/.bin`, not the global `PATH`.
 */
function resolveBin(pkg: string): string {
  return join(dirname(resolveEntry(pkg)), "bin.js");
}

/** Absolute path to the `pingpald` daemon entry point. */
export function daemonBin(): string {
  return resolveBin("@pingpal/daemon");
}

/** Absolute path to the `pingpal-mcp` MCP server entry point. */
export function mcpBin(): string {
  return resolveBin("@pingpal/mcp");
}
