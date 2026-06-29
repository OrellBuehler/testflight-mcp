#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { client, config } from "./config.js";
import { createServer } from "./server.js";

const server = createServer(client, config.vendorNumber);
const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (e) {
  console.error(`Failed to start testflight-mcp: ${String(e)}`);
  process.exit(1);
}
