import { createRequire } from "node:module";
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
import { registerScreenshotTools } from "./tools/screenshots.js";
import { registerListingTools } from "./tools/listing.js";
import { registerReleaseTools } from "./tools/release.js";
import { registerReviewTools } from "./tools/reviews.js";
import { registerBuildUploadTools } from "./tools/uploads.js";
import { registerNotaryTools } from "./tools/notary.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export function createServer(
  client: AppStoreConnectClient,
  vendorNumber?: string,
  allowWrites = false,
  uploadDir?: string,
  downloadDir?: string,
): McpServer {
  const server = new McpServer({ name: "testflight-mcp", version });
  registerFeedbackTools(server, client);
  registerAppTools(server, client);
  registerTestFlightTools(server, client, allowWrites);
  registerTesterTools(server, client, allowWrites);
  registerAnalyticsTools(server, client, vendorNumber);
  registerProvisioningTools(server, client, allowWrites, downloadDir);
  registerMetadataTools(server, client);
  registerDiagnosticsTools(server, client);
  registerCiTools(server, client);
  registerScreenshotTools(server, client, allowWrites, uploadDir);
  registerListingTools(server, client, allowWrites);
  registerReleaseTools(server, client, allowWrites);
  registerReviewTools(server, client, allowWrites);
  registerBuildUploadTools(server, client, allowWrites, uploadDir);
  registerNotaryTools(server, client, allowWrites, uploadDir);
  return server;
}
