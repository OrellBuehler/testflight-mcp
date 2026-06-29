import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource, QueryParams } from "../asc/client.js";
import { ok, err, imageResult, shapeResource } from "../asc/format.js";

const PLATFORM = z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]);
const TESTER_FIELDS = "firstName,lastName,email";
const BUILD_FIELDS = "version,uploadedDate";

const listShape = {
  app_id: z.string().describe("App Store Connect app ID (from list_apps)"),
  build_id: z.string().optional().describe("Filter to a single build ID"),
  device_platform: PLATFORM.optional().describe("Filter by device platform"),
  app_platform: PLATFORM.optional().describe("Filter by app platform"),
  device_model: z.string().optional().describe("Filter by device model, e.g. 'iPhone15,2'"),
  os_version: z.string().optional().describe("Filter by OS version string"),
  tester_id: z.string().optional().describe("Filter by beta tester ID"),
  sort: z
    .enum(["createdDate", "-createdDate"])
    .optional()
    .describe("Sort order (default: -createdDate, newest first)"),
  limit: z.number().int().min(1).max(200).optional().describe("Max items to return (default: 50)"),
};

function buildListParams(
  args: {
    build_id?: string;
    device_platform?: string;
    app_platform?: string;
    device_model?: string;
    os_version?: string;
    tester_id?: string;
    sort?: string;
    limit?: number;
  },
  fieldsKey: string,
  fields: string,
): QueryParams {
  const params: QueryParams = {
    include: "build,tester",
    "fields[builds]": BUILD_FIELDS,
    "fields[betaTesters]": TESTER_FIELDS,
    [fieldsKey]: fields,
    sort: args.sort ?? "-createdDate",
    limit: args.limit ?? 50,
  };
  if (args.build_id) params["filter[build]"] = args.build_id;
  if (args.device_platform) params["filter[devicePlatform]"] = args.device_platform;
  if (args.app_platform) params["filter[appPlatform]"] = args.app_platform;
  if (args.device_model) params["filter[deviceModel]"] = args.device_model;
  if (args.os_version) params["filter[osVersion]"] = args.os_version;
  if (args.tester_id) params["filter[tester]"] = args.tester_id;
  return params;
}

const SCREENSHOT_FIELDS =
  "createdDate,comment,email,deviceModel,osVersion,locale,timeZone,architecture,connectionType,pairedAppleWatch,appUptimeInMilliseconds,diskBytesAvailable,diskBytesTotal,batteryPercentage,screenWidthInPoints,screenHeightInPoints,appPlatform,devicePlatform,deviceFamily,buildBundleId,screenshots";
const CRASH_FIELDS =
  "createdDate,comment,email,deviceModel,osVersion,locale,timeZone,architecture,connectionType,pairedAppleWatch,appUptimeInMilliseconds,diskBytesAvailable,diskBytesTotal,batteryPercentage,screenWidthInPoints,screenHeightInPoints,appPlatform,devicePlatform,deviceFamily,buildBundleId,crashLog";

function findCrashLogUrl(attrs: Record<string, unknown> | undefined): string | null {
  const cl = attrs?.crashLog;
  if (typeof cl === "string") return cl;
  if (cl && typeof cl === "object" && typeof (cl as { url?: unknown }).url === "string") {
    return (cl as { url: string }).url;
  }
  return null;
}

export function registerFeedbackTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    "list_screenshot_feedback",
    "List TestFlight screenshot feedback submissions for an app. Each submission includes the tester's comment (the actual feedback text), the screenshot asset URL(s), device/OS details, and the resolved tester and build. Filter by build, platform, device, OS or tester.",
    listShape,
    async (args) => {
      try {
        const params = buildListParams(
          args,
          "fields[betaFeedbackScreenshotSubmissions]",
          SCREENSHOT_FIELDS,
        );
        const { data, included } = await client.getAll(
          `/apps/${encodeURIComponent(args.app_id)}/betaFeedbackScreenshotSubmissions`,
          params,
        );
        const items = data.map((d) =>
          shapeResource(d, included, { relationships: ["build", "tester"] }),
        );
        return ok({ count: items.length, feedback: items });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_crash_feedback",
    "List TestFlight crash feedback submissions for an app. Each submission includes any tester comment, device/OS details, the resolved tester and build, and a reference to the downloadable crash log (use get_crash_log). Filter by build, platform, device, OS or tester.",
    listShape,
    async (args) => {
      try {
        const params = buildListParams(args, "fields[betaFeedbackCrashSubmissions]", CRASH_FIELDS);
        const { data, included } = await client.getAll(
          `/apps/${encodeURIComponent(args.app_id)}/betaFeedbackCrashSubmissions`,
          params,
        );
        const items = data.map((d) =>
          shapeResource(d, included, { relationships: ["build", "tester"] }),
        );
        return ok({ count: items.length, feedback: items });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_screenshot_feedback",
    "Get a single screenshot feedback submission by ID, including the tester comment, full device metadata, resolved tester and build, and screenshot asset URLs. Set download_screenshot to also return the first screenshot inline as an image.",
    {
      feedback_id: z.string().describe("Screenshot feedback submission ID"),
      download_screenshot: z
        .boolean()
        .optional()
        .describe("Download and return the first screenshot inline as an image (default: false)"),
    },
    async ({ feedback_id, download_screenshot }) => {
      try {
        const res = await client.get(
          `/betaFeedbackScreenshotSubmissions/${encodeURIComponent(feedback_id)}`,
          {
            include: "build,tester",
            "fields[builds]": BUILD_FIELDS,
            "fields[betaTesters]": TESTER_FIELDS,
            "fields[betaFeedbackScreenshotSubmissions]": SCREENSHOT_FIELDS,
          },
        );
        const resource = res.data as JsonApiResource;
        const shaped = shapeResource(resource, res.included ?? [], {
          relationships: ["build", "tester"],
        });
        if (download_screenshot) {
          const shots = resource.attributes?.screenshots as Array<{ url?: string }> | undefined;
          const url = shots?.[0]?.url;
          if (url) {
            const { base64, mimeType } = await client.downloadBinary(url);
            const comment = (resource.attributes?.comment as string) || "(no comment)";
            return imageResult(base64, mimeType, `Screenshot feedback ${feedback_id}: ${comment}`);
          }
        }
        return ok(shaped);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_crash_feedback",
    "Get a single crash feedback submission by ID, including any tester comment, full device metadata, resolved tester and build, and the crash log reference. Use get_crash_log to download the crash log text.",
    { feedback_id: z.string().describe("Crash feedback submission ID") },
    async ({ feedback_id }) => {
      try {
        const res = await client.get(
          `/betaFeedbackCrashSubmissions/${encodeURIComponent(feedback_id)}`,
          {
            include: "build,tester",
            "fields[builds]": BUILD_FIELDS,
            "fields[betaTesters]": TESTER_FIELDS,
            "fields[betaFeedbackCrashSubmissions]": CRASH_FIELDS,
          },
        );
        return ok(
          shapeResource(res.data as JsonApiResource, res.included ?? [], {
            relationships: ["build", "tester"],
          }),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_crash_log",
    "Download the crash log text for a crash feedback submission. Resolves the temporary crash-log URL from the submission and fetches its contents.",
    { feedback_id: z.string().describe("Crash feedback submission ID") },
    async ({ feedback_id }) => {
      try {
        const res = await client.get(
          `/betaFeedbackCrashSubmissions/${encodeURIComponent(feedback_id)}`,
          { "fields[betaFeedbackCrashSubmissions]": "crashLog" },
        );
        const attrs = (res.data as JsonApiResource).attributes;
        const url = findCrashLogUrl(attrs);
        if (!url) {
          return ok({
            message: "No downloadable crash log URL is present on this submission.",
            attributes: attrs ?? {},
          });
        }
        return ok(await client.downloadText(url));
      } catch (e) {
        return err(e);
      }
    },
  );
}
