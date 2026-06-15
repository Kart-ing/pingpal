#!/usr/bin/env node
/**
 * Bake a deployed relay URL into the source as the default, so a cold
 * `npx pingpal` connects with no PINGPAL_RELAY / config needed.
 *
 * Usage:  node scripts/set-default-relay.mjs wss://pingpal-relay-you.fly.dev
 *
 * It rewrites DEFAULT_RELAY_URL in packages/daemon/src/config.ts. Re-run any
 * time the relay URL changes; commit + rebuild + republish after.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const url = process.argv[2];
if (!url || !/^wss?:\/\/[^\s"]+$/.test(url)) {
  console.error("Usage: node scripts/set-default-relay.mjs <wss://your-relay-host>");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "packages/daemon/src/config.ts");
const src = readFileSync(file, "utf8");

const re = /export const DEFAULT_RELAY_URL = "[^"]*" as const;/;
if (!re.test(src)) {
  console.error("Could not find DEFAULT_RELAY_URL in config.ts — aborting.");
  process.exit(1);
}
const next = src.replace(re, `export const DEFAULT_RELAY_URL = "${url}" as const;`);
writeFileSync(file, next);
console.log(`Set DEFAULT_RELAY_URL = ${url}`);
console.log("Now:  pnpm -r build  &&  bash scripts/publish.sh   (then npx pingpal uses it)");
