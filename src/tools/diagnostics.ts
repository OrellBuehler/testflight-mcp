import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, QueryParams } from "../asc/client.js";
import { ok, err, flattenResource } from "../asc/format.js";

const XCODE_METRICS_HEADERS = {
  Accept: "application/vnd.apple.xcode-metrics+json, application/json",
};
const METRIC_TYPE = z.enum([
  "DISK",
  "HANG",
  "BATTERY",
  "LAUNCH",
  "MEMORY",
  "ANIMATION",
  "TERMINATION",
  "STORAGE",
]);
const DIAGNOSTIC_TYPE = z.enum(["DISK_WRITES", "HANGS", "LAUNCHES"]);
const SIGNATURE_FIELDS = "diagnosticType,signature,weight,insight";

interface DiagnosticLogsBody {
  productData?: Array<{ diagnosticLogs?: Array<Record<string, unknown>> }>;
}

export function registerDiagnosticsTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    "get_perf_power_metrics",
    "Get aggregated power and performance metrics (MetricKit data from real devices) for an app's recent versions or for a single build: launch time, hang rate, memory, disk writes, battery, animation and termination metrics, plus Apple's regression insights comparing the latest version against previous ones. Pass either app_id or build_id.",
    {
      app_id: z.string().optional().describe("App Store Connect app ID (or pass build_id)"),
      build_id: z.string().optional().describe("Build ID, for metrics of a single build"),
      metric_type: METRIC_TYPE.optional().describe("Filter by metric type, e.g. 'LAUNCH'"),
      device_type: z
        .string()
        .optional()
        .describe("Filter by device type, e.g. 'all_iphones' or 'all_ipads'"),
      platform: z.string().optional().describe("Filter by platform (only iOS is supported)"),
    },
    async ({ app_id, build_id, metric_type, device_type, platform }) => {
      try {
        if (!app_id && !build_id) return err("Pass either app_id or build_id.");
        const path = build_id
          ? `/builds/${encodeURIComponent(build_id)}/perfPowerMetrics`
          : `/apps/${encodeURIComponent(app_id!)}/perfPowerMetrics`;
        const params: QueryParams = {};
        if (metric_type) params["filter[metricType]"] = metric_type;
        if (device_type) params["filter[deviceType]"] = device_type;
        if (platform) params["filter[platform]"] = platform;
        return ok(await client.getJson(path, params, XCODE_METRICS_HEADERS));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_diagnostic_signatures",
    "List the diagnostic signatures for a build — groups of similar disk-write, hang or launch problems collected from real devices, each with the symbolicated signature, a weight between 0 and 1 (how much of the problem it accounts for) and Apple's insight. Use get_diagnostic_logs with a signature ID for the detailed logs.",
    {
      build_id: z.string().describe("Build ID (from list_builds)"),
      diagnostic_type: DIAGNOSTIC_TYPE.optional().describe(
        "Filter by diagnostic type: DISK_WRITES, HANGS or LAUNCHES",
      ),
      limit: z.number().int().min(1).max(200).optional().describe("Max signatures (default: 25)"),
    },
    async ({ build_id, diagnostic_type, limit }) => {
      try {
        const params: QueryParams = {
          "fields[diagnosticSignatures]": SIGNATURE_FIELDS,
          limit: limit ?? 25,
        };
        if (diagnostic_type) params["filter[diagnosticType]"] = diagnostic_type;
        const { data } = await client.getAll(
          `/builds/${encodeURIComponent(build_id)}/diagnosticSignatures`,
          params,
        );
        return ok({ count: data.length, signatures: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_diagnostic_logs",
    "Get the diagnostic logs for a diagnostic signature: per-log metadata (event, app version, OS version, device type, event detail) and Apple's insights with links to the relevant documentation. Call stack trees are stripped by default because they are very large — set include_call_stacks to true to get the symbolicated call stacks with the blame frames.",
    {
      signature_id: z
        .string()
        .describe("Diagnostic signature ID (from list_diagnostic_signatures)"),
      include_call_stacks: z
        .boolean()
        .optional()
        .describe("Include the full call stack trees (default: false)"),
      limit: z.number().int().min(1).max(200).optional().describe("Max logs (default: 5)"),
    },
    async ({ signature_id, include_call_stacks, limit }) => {
      try {
        const body = (await client.getJson(
          `/diagnosticSignatures/${encodeURIComponent(signature_id)}/logs`,
          { limit: limit ?? 5 },
          XCODE_METRICS_HEADERS,
        )) as DiagnosticLogsBody;
        if (!include_call_stacks) {
          for (const product of body.productData ?? []) {
            for (const log of product.diagnosticLogs ?? []) delete log.callStackTree;
          }
        }
        return ok(body);
      } catch (e) {
        return err(e);
      }
    },
  );
}
