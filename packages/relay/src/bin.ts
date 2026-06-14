#!/usr/bin/env node
/**
 * Standalone entry point for the PingPal relay (`pingpal-relay`).
 *
 * Reads PORT and HOST from the environment (PORT defaults to 8787, the same
 * value the bundled Dockerfile and fly.toml expose) and starts the relay,
 * logging the bound address and shutting down cleanly on SIGINT/SIGTERM.
 */
import { startRelay } from "./relay.js";
import { DEFAULT_PORT } from "./constants.js";

const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
const host = process.env.HOST || undefined;

if (Number.isNaN(port) || port < 0 || port > 65535) {
  console.error(`pingpal-relay: invalid PORT '${process.env.PORT}'`);
  process.exit(1);
}

async function main(): Promise<void> {
  const relay = await startRelay({ port, host });
  console.log(`pingpal-relay listening on ${host ?? "0.0.0.0"}:${relay.port}`);

  const shutdown = (signal: string): void => {
    console.log(`\npingpal-relay: received ${signal}, shutting down…`);
    void relay.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("pingpal-relay: failed to start:", err);
  process.exit(1);
});
