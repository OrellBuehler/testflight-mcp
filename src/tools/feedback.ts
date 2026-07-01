import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource, QueryParams } from "../asc/client.js";
import {
  ok,
  err,
  imageResult,
  shapeResource,
  singleRef,
  findIncluded,
  flattenResource,
} from "../asc/format.js";

const PLATFORM = z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]);
const TESTER_FIELDS = "firstName,lastName,email";
const BUILD_FIELDS = "version,uploadedDate";
const FEEDBACK_RELATIONSHIPS = "build,tester";

const listShape = {
  app_id: z.string().describe("App Store Connect app ID (from list_apps)"),
  app_version: z
    .string()
    .optional()
    .describe(
      "Pre-release (marketing) version to filter by, e.g. '1.2.0'. Defaults to 'latest' — only the most recent version's feedback is returned; older versions are excluded. Pass 'all' to include every version. Ignored when build_id is set.",
    ),
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
    include: FEEDBACK_RELATIONSHIPS,
    "fields[builds]": BUILD_FIELDS,
    "fields[betaTesters]": TESTER_FIELDS,
    [fieldsKey]: `${fields},${FEEDBACK_RELATIONSHIPS}`,
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

async function resolveVersionBuildIds(
  client: AppStoreConnectClient,
  appId: string,
  version: string,
): Promise<{ resolvedVersion: string | null; buildIds: string[] }> {
  if (version === "latest") {
    const { data, included } = await client.getAll("/builds", {
      "filter[app]": appId,
      include: "preReleaseVersion",
      "fields[builds]": "version",
      "fields[preReleaseVersions]": "version",
      sort: "-uploadedDate",
      limit: 200,
    });
    const versionOf = (b: JsonApiResource): string | null => {
      const pre = findIncluded(included, singleRef(b.relationships?.preReleaseVersion));
      const v = pre?.attributes?.version;
      return typeof v === "string" ? v : null;
    };
    const target = data.map(versionOf).find((v) => v !== null) ?? null;
    const buildIds = target ? data.filter((b) => versionOf(b) === target).map((b) => b.id) : [];
    return { resolvedVersion: target, buildIds };
  }
  const { data } = await client.getAll("/builds", {
    "filter[app]": appId,
    "filter[preReleaseVersion.version]": version,
    "fields[builds]": "version",
    sort: "-uploadedDate",
    limit: 200,
  });
  return { resolvedVersion: version, buildIds: data.map((b) => b.id) };
}

async function preReleaseVersionByBuild(
  client: AppStoreConnectClient,
  appId: string,
): Promise<Map<string, Record<string, unknown> | null>> {
  const { data, included } = await client.getAll("/builds", {
    "filter[app]": appId,
    include: "preReleaseVersion",
    "fields[builds]": "preReleaseVersion",
    "fields[preReleaseVersions]": "version",
    limit: 200,
  });
  const map = new Map<string, Record<string, unknown> | null>();
  for (const b of data) {
    const pre = findIncluded(included, singleRef(b.relationships?.preReleaseVersion));
    map.set(b.id, flattenResource(pre));
  }
  return map;
}

async function preReleaseVersionForBuild(
  client: AppStoreConnectClient,
  buildId: string,
): Promise<Record<string, unknown> | null> {
  const res = await client.get(`/builds/${encodeURIComponent(buildId)}`, {
    include: "preReleaseVersion",
    "fields[builds]": "preReleaseVersion",
    "fields[preReleaseVersions]": "version",
  });
  const build = res.data as JsonApiResource;
  const pre = findIncluded(res.included ?? [], singleRef(build.relationships?.preReleaseVersion));
  return flattenResource(pre);
}

function buildIdOf(item: Record<string, unknown>): string | undefined {
  const build = item.build;
  if (build && typeof build === "object") return (build as { id?: string }).id;
  return undefined;
}

async function listFeedback(
  client: AppStoreConnectClient,
  args: { app_id: string; app_version?: string; build_id?: string },
  endpoint: string,
  fieldsKey: string,
  fields: string,
) {
  const params = buildListParams(args, fieldsKey, fields);
  let appVersion: string | null = null;
  if (!args.build_id) {
    const mode = args.app_version ?? "latest";
    if (mode !== "all") {
      const resolved = await resolveVersionBuildIds(client, args.app_id, mode);
      appVersion = resolved.resolvedVersion;
      if (resolved.buildIds.length > 0) {
        params["filter[build]"] = resolved.buildIds;
      } else if (mode !== "latest") {
        return ok({ count: 0, appVersion, feedback: [] });
      }
    }
  }
  const { data, included } = await client.getAll(
    `/apps/${encodeURIComponent(args.app_id)}/${endpoint}`,
    params,
  );
  const items = data.map((d) => shapeResource(d, included, { relationships: ["build", "tester"] }));
  if (items.some((i) => buildIdOf(i) !== undefined)) {
    const preByBuild = await preReleaseVersionByBuild(client, args.app_id);
    for (const item of items) {
      const id = buildIdOf(item);
      if (id)
        (item.build as Record<string, unknown>).preReleaseVersion = preByBuild.get(id) ?? null;
    }
  }
  return ok({ count: items.length, appVersion: appVersion ?? undefined, feedback: items });
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
    "List TestFlight screenshot feedback submissions for an app. Each submission includes the tester's comment (the actual feedback text), the screenshot asset URL(s), device/OS details, and the resolved tester and build. The build carries its build number (build.version) and the TestFlight/marketing version (build.preReleaseVersion.version, e.g. '1.2.0'). By default only the latest pre-release version's feedback is returned (set app_version to a specific version or 'all'). Filter by build, platform, device, OS or tester.",
    listShape,
    async (args) => {
      try {
        return await listFeedback(
          client,
          args,
          "betaFeedbackScreenshotSubmissions",
          "fields[betaFeedbackScreenshotSubmissions]",
          SCREENSHOT_FIELDS,
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_crash_feedback",
    "List TestFlight crash feedback submissions for an app. Each submission includes any tester comment, device/OS details, the resolved tester and build, and a reference to the downloadable crash log (use get_crash_log). The build carries its build number (build.version) and the TestFlight/marketing version (build.preReleaseVersion.version, e.g. '1.2.0'). By default only the latest pre-release version's feedback is returned (set app_version to a specific version or 'all'). Filter by build, platform, device, OS or tester.",
    listShape,
    async (args) => {
      try {
        return await listFeedback(
          client,
          args,
          "betaFeedbackCrashSubmissions",
          "fields[betaFeedbackCrashSubmissions]",
          CRASH_FIELDS,
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_screenshot_feedback",
    "Get a single screenshot feedback submission by ID, including the tester comment, full device metadata, resolved tester and build (with build.version and the TestFlight version build.preReleaseVersion.version), and screenshot asset URLs. Set download_screenshot to also return the first screenshot inline as an image.",
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
            include: FEEDBACK_RELATIONSHIPS,
            "fields[builds]": BUILD_FIELDS,
            "fields[betaTesters]": TESTER_FIELDS,
            "fields[betaFeedbackScreenshotSubmissions]": `${SCREENSHOT_FIELDS},${FEEDBACK_RELATIONSHIPS}`,
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
        const buildId = buildIdOf(shaped);
        if (buildId) {
          (shaped.build as Record<string, unknown>).preReleaseVersion =
            await preReleaseVersionForBuild(client, buildId);
        }
        return ok(shaped);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_crash_feedback",
    "Get a single crash feedback submission by ID, including any tester comment, full device metadata, resolved tester and build (with build.version and the TestFlight version build.preReleaseVersion.version), and the crash log reference. Use get_crash_log to download the crash log text.",
    { feedback_id: z.string().describe("Crash feedback submission ID") },
    async ({ feedback_id }) => {
      try {
        const res = await client.get(
          `/betaFeedbackCrashSubmissions/${encodeURIComponent(feedback_id)}`,
          {
            include: FEEDBACK_RELATIONSHIPS,
            "fields[builds]": BUILD_FIELDS,
            "fields[betaTesters]": TESTER_FIELDS,
            "fields[betaFeedbackCrashSubmissions]": `${CRASH_FIELDS},${FEEDBACK_RELATIONSHIPS}`,
          },
        );
        const shaped = shapeResource(res.data as JsonApiResource, res.included ?? [], {
          relationships: ["build", "tester"],
        });
        const buildId = buildIdOf(shaped);
        if (buildId) {
          (shaped.build as Record<string, unknown>).preReleaseVersion =
            await preReleaseVersionForBuild(client, buildId);
        }
        return ok(shaped);
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
