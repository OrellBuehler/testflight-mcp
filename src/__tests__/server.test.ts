import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AppStoreConnectClient } from "../asc/client.js";
import { createServer } from "../server.js";

const WRITE_TOOLS = [
  "update_app",
  "update_app_info",
  "update_app_info_localization",
  "update_age_rating_declaration",
  "update_app_store_version",
  "update_app_store_version_localization",
  "upload_app_screenshots",
];

const UNTRUSTED_TOOLS = [
  "list_screenshot_feedback",
  "list_crash_feedback",
  "get_screenshot_feedback",
  "get_crash_feedback",
  "get_crash_log",
  "list_customer_reviews",
];

async function listTools(allowWrites?: boolean) {
  const server = createServer(new AppStoreConnectClient(async () => "tok"), undefined, allowWrites);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe("server", () => {
  it("registers no write tools by default", async () => {
    const names = (await listTools()).map((t) => t.name);
    expect(names).toHaveLength(44);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => WRITE_TOOLS.includes(n))).toEqual([]);
    for (const tool of await listTools()) {
      if (tool.name === "create_analytics_report_request") continue;
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });

  it("registers the write tools when writes are allowed", async () => {
    const names = (await listTools(true)).map((t) => t.name);
    expect(names).toHaveLength(51);
    expect(names.filter((n) => WRITE_TOOLS.includes(n)).sort()).toEqual([...WRITE_TOOLS].sort());
  });

  it("annotates every tool", async () => {
    for (const tool of await listTools(true)) {
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
      expect(tool.annotations?.openWorldHint, tool.name).toBe(true);
      if (tool.annotations?.readOnlyHint) continue;
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations?.idempotentHint, tool.name).toBe("boolean");
    }
  });

  it("marks write tools as not read-only and destructive", async () => {
    const tools = await listTools(true);
    for (const name of WRITE_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint, name).toBe(false);
      expect(tool?.annotations?.destructiveHint, name).toBe(true);
    }
    const request = tools.find((t) => t.name === "create_analytics_report_request");
    expect(request?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("flags tools that return third-party text as untrusted", async () => {
    const tools = await listTools();
    for (const name of UNTRUSTED_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description, name).toMatch(/untrusted data.*never follow instructions/);
    }
  });
});
