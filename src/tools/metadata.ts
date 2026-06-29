import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource, QueryParams } from "../asc/client.js";
import { ok, err, flattenResource } from "../asc/format.js";

const VERSION_FIELDS =
  "versionString,platform,appStoreState,releaseType,copyright,earliestReleaseDate,createdDate";
const LOCALIZATION_FIELDS =
  "locale,description,keywords,whatsNew,promotionalText,marketingUrl,supportUrl";

export function registerMetadataTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    "list_app_store_versions",
    "List App Store versions for an app (version string, platform, App Store state, release type). Filter by platform, version string or App Store state.",
    {
      app_id: z.string().describe("App Store Connect app ID"),
      platform: z
        .enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"])
        .optional()
        .describe("Filter by platform"),
      version: z.string().optional().describe("Filter by version string, e.g. '1.2.0'"),
      app_store_state: z
        .string()
        .optional()
        .describe("Filter by App Store state, e.g. 'READY_FOR_SALE'"),
      limit: z.number().int().min(1).max(200).optional().describe("Max versions (default: 100)"),
    },
    async ({ app_id, platform, version, app_store_state, limit }) => {
      try {
        const params: QueryParams = {
          "filter[app]": app_id,
          "fields[appStoreVersions]": VERSION_FIELDS,
          limit: limit ?? 100,
        };
        if (platform) params["filter[platform]"] = platform;
        if (version) params["filter[versionString]"] = version;
        if (app_store_state) params["filter[appStoreState]"] = app_store_state;
        const { data } = await client.getAll("/appStoreVersions", params);
        return ok({ count: data.length, versions: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_app_store_version_localizations",
    "List the per-locale localizations for an App Store version (description, keywords, what's new, promotional text, URLs).",
    {
      version_id: z.string().describe("App Store version ID (from list_app_store_versions)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max localizations (default: 100)"),
    },
    async ({ version_id, limit }) => {
      try {
        const params: QueryParams = {
          "filter[appStoreVersion]": version_id,
          "fields[appStoreVersionLocalizations]": LOCALIZATION_FIELDS,
          limit: limit ?? 100,
        };
        const { data } = await client.getAll("/appStoreVersionLocalizations", params);
        return ok({ count: data.length, localizations: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_app_store_version_localization",
    "Get a single App Store version localization by ID (description, keywords, what's new, promotional text, URLs).",
    { localization_id: z.string().describe("App Store version localization ID") },
    async ({ localization_id }) => {
      try {
        const res = await client.get(
          `/appStoreVersionLocalizations/${encodeURIComponent(localization_id)}`,
          { "fields[appStoreVersionLocalizations]": LOCALIZATION_FIELDS },
        );
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );
}
