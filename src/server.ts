import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppStoreConnectClient } from "./asc/client.js";
import { registerFeedbackTools } from "./tools/feedback.js";
import { registerAppTools } from "./tools/apps.js";
import { registerTesterTools } from "./tools/testers.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerProvisioningTools } from "./tools/provisioning.js";
import { registerMetadataTools } from "./tools/metadata.js";
import { registerTestFlightTools } from "./tools/testflight.js";
import { registerDiagnosticsTools } from "./tools/diagnostics.js";
import { registerCiTools } from "./tools/ci.js";

export function createServer(client: AppStoreConnectClient, vendorNumber?: string): McpServer {
  const server = new McpServer({ name: "testflight-mcp", version: "0.1.0" });
  registerFeedbackTools(server, client);
  registerAppTools(server, client);
  registerTestFlightTools(server, client);
  registerTesterTools(server, client);
  registerAnalyticsTools(server, client, vendorNumber);
  registerProvisioningTools(server, client);
  registerMetadataTools(server, client);
  registerDiagnosticsTools(server, client);
  registerCiTools(server, client);
  return server;
}
