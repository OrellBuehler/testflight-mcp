import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource, QueryParams } from "../asc/client.js";
import { ok, err, flattenResource } from "../asc/format.js";

export function registerAnalyticsTools(
  server: McpServer,
  client: AppStoreConnectClient,
  defaultVendorNumber?: string,
) {
  const knownSegmentUrls = new Set<string>();

  server.tool(
    "create_analytics_report_request",
    "Create an analytics report request for an app — the required first step to read App Store analytics. Returns a reportRequestId to pass to list_analytics_reports. ONE_TIME_SNAPSHOT requests the latest data once; ONGOING accrues daily data. This creates a request resource but does not modify the app.",
    {
      app_id: z.string().describe("App Store Connect app ID"),
      access_type: z
        .enum(["ONE_TIME_SNAPSHOT", "ONGOING"])
        .optional()
        .describe("Report access type (default: ONE_TIME_SNAPSHOT)"),
    },
    async ({ app_id, access_type }) => {
      try {
        const res = await client.post("/analyticsReportRequests", {
          data: {
            type: "analyticsReportRequests",
            attributes: { accessType: access_type ?? "ONE_TIME_SNAPSHOT" },
            relationships: { app: { data: { type: "apps", id: app_id } } },
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_analytics_reports",
    "List the analytics reports available for a report request (name, category, instances). Optionally filter by category.",
    {
      report_request_id: z
        .string()
        .describe("reportRequestId from create_analytics_report_request"),
      category: z
        .enum([
          "APP_STORE_ENGAGEMENT",
          "APP_STORE_COMMERCE",
          "APP_USAGE",
          "FRAMEWORKS_USAGE",
          "PERFORMANCE",
        ])
        .optional()
        .describe("Filter reports by category"),
      limit: z.number().int().min(1).max(200).optional().describe("Max reports (default: 100)"),
    },
    async ({ report_request_id, category, limit }) => {
      try {
        const params: QueryParams = { limit: limit ?? 100 };
        if (category) params["filter[category]"] = category;
        const { data } = await client.getAll(
          `/analyticsReportRequests/${encodeURIComponent(report_request_id)}/reports`,
          params,
        );
        return ok({ count: data.length, reports: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_analytics_report_segments",
    "List the downloadable segments of an analytics report (each has a presigned url, size and checksum). Pass a segment url to download_analytics_report_segment.",
    {
      report_id: z.string().describe("Analytics report ID from list_analytics_reports"),
      limit: z.number().int().min(1).max(200).optional().describe("Max segments (default: 100)"),
    },
    async ({ report_id, limit }) => {
      try {
        const { data } = await client.getAll(
          `/analyticsReports/${encodeURIComponent(report_id)}/segments`,
          { limit: limit ?? 100 },
        );
        const segments = data.map((d) => flattenResource(d));
        for (const segment of segments) {
          const url = (segment as { url?: unknown }).url;
          if (typeof url === "string") knownSegmentUrls.add(url);
        }
        return ok({ count: segments.length, segments });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "download_analytics_report_segment",
    "Download and decompress an analytics report segment from its presigned url. Returns the report data as CSV/TSV text. Call list_analytics_report_segments first — only urls returned by that tool can be downloaded.",
    { segment_url: z.string().describe("The 'url' field of an analytics report segment") },
    async ({ segment_url }) => {
      try {
        if (!knownSegmentUrls.has(segment_url)) {
          return err(
            "Unknown segment url. Call list_analytics_report_segments first and pass a url from its response verbatim.",
          );
        }
        return ok(await client.downloadGzipText(segment_url));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "download_sales_report",
    "Download a Sales and Trends report as CSV text (decompressed from gzip). Requires a vendor number (from ASC_VENDOR_NUMBER or passed explicitly).",
    {
      report_date: z
        .string()
        .describe(
          "Report date: 'YYYY-MM-DD' (DAILY), 'YYYY-MM-DD' week end (WEEKLY), 'YYYY-MM' (MONTHLY), 'YYYY' (YEARLY)",
        ),
      frequency: z
        .enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"])
        .optional()
        .describe("Report frequency (default: DAILY)"),
      report_type: z
        .enum([
          "SALES",
          "SUBSCRIPTION",
          "SUBSCRIPTION_EVENT",
          "SUBSCRIBER",
          "NEWSSTAND",
          "PRE_ORDER",
        ])
        .optional()
        .describe("Report type (default: SALES)"),
      report_sub_type: z
        .enum(["SUMMARY", "DETAILED", "OPT_IN"])
        .optional()
        .describe("Report sub type (default: SUMMARY)"),
      vendor_number: z.string().optional().describe("Overrides ASC_VENDOR_NUMBER"),
      version: z
        .string()
        .optional()
        .describe("Report version, e.g. '1_0' or '1_1' (some report types require it)"),
    },
    async ({ report_date, frequency, report_type, report_sub_type, vendor_number, version }) => {
      try {
        const vendor = vendor_number ?? defaultVendorNumber;
        if (!vendor) {
          return err(
            "No vendor number. Set ASC_VENDOR_NUMBER or pass vendor_number (App Store Connect > Payments and Financial Reports).",
          );
        }
        const params: QueryParams = {
          "filter[frequency]": frequency ?? "DAILY",
          "filter[reportType]": report_type ?? "SALES",
          "filter[reportSubType]": report_sub_type ?? "SUMMARY",
          "filter[vendorNumber]": vendor,
          "filter[reportDate]": report_date,
        };
        if (version) params["filter[version]"] = version;
        return ok(await client.getGzippedReport("/salesReports", params));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "download_finance_report",
    "Download a Financial report as CSV text (decompressed from gzip). Requires a vendor number and a region code.",
    {
      report_date: z.string().describe("Fiscal report date in 'YYYY-MM' format"),
      region_code: z.string().describe("Region code, e.g. 'ZZ' for all regions, 'US', 'EU'"),
      report_type: z
        .enum(["FINANCIAL", "FINANCE_DETAIL"])
        .optional()
        .describe("Report type (default: FINANCIAL)"),
      vendor_number: z.string().optional().describe("Overrides ASC_VENDOR_NUMBER"),
    },
    async ({ report_date, region_code, report_type, vendor_number }) => {
      try {
        const vendor = vendor_number ?? defaultVendorNumber;
        if (!vendor) {
          return err("No vendor number. Set ASC_VENDOR_NUMBER or pass vendor_number.");
        }
        const params: QueryParams = {
          "filter[regionCode]": region_code,
          "filter[reportDate]": report_date,
          "filter[reportType]": report_type ?? "FINANCIAL",
          "filter[vendorNumber]": vendor,
        };
        return ok(await client.getGzippedReport("/financeReports", params));
      } catch (e) {
        return err(e);
      }
    },
  );
}
