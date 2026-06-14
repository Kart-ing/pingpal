#!/usr/bin/env node
/**
 * `pingpal-mcp` — the PingPal MCP server entry point.
 *
 * Claude Code launches this over stdio (it's registered by `pingpal init`). It
 * speaks the Model Context Protocol on stdin/stdout, so **nothing else may be
 * written to stdout** — all diagnostics go to stderr. The three tools it
 * exposes proxy to the local pingpald daemon over its IPC socket.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The process now stays alive on the stdio transport until Claude Code
  // closes it. Diagnostics to stderr only — stdout is the protocol channel.
  process.stderr.write("pingpal-mcp: ready on stdio\n");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pingpal-mcp: fatal: ${message}\n`);
  process.exit(1);
});
