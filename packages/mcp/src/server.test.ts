import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer, TOOL_NAMES } from "./server.js";
import type { DaemonClient } from "./daemon-ipc.js";

/** A daemon client with canned data, for driving the server end-to-end. */
const fakeClient: DaemonClient = {
  getPresence: async () => ({
    peers: [{ handle: "sarah", faceId: "fox", status: "online", lastSeen: 0, via: "relay" }],
  }),
  getPings: async () => ({ pings: [] }),
  sendPing: async () => ({ id: "sent-1", via: "relay", delivered: true }),
};

async function connectedClient(): Promise<Client> {
  const server = buildServer({ client: fakeClient });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("PingPal MCP server", () => {
  it("lists exactly its three tools over the protocol", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    await client.close();
  });

  it("each tool advertises an input schema", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
    await client.close();
  });

  it("calls whos_online through the transport and gets the roster", async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: "whos_online", arguments: {} });
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("sarah");
    await client.close();
  });

  it("send_ping validates the 90-char rule through the transport", async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: "send_ping",
      arguments: { text: "x".repeat(91) },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("over the 90-char limit");
    await client.close();
  });
});
