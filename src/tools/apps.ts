import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource, QueryParams } from "../asc/client.js";
import { ok, err, shapeResource, flattenResource } from "../asc/format.js";

const APP_FIELDS = "name,bundleId,sku,primaryLocale";
const BUILD_FIELDS = "version,uploadedDate,expirationDate,expired,minOsVersion,processingState";

export function registerAppTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    "list_apps",
    "List the apps in your App Store Connect account (id, name, bundleId, sku, primaryLocale). Use the returned id as app_id for the other tools.",
    {
      bundle_id: z.string().optional().describe("Filter by exact bundle ID, e.g. 'com.acme.app'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max apps to return (default: 100)"),
    },
    async ({ bundle_id, limit }) => {
      try {
        const params: QueryParams = { "fields[apps]": APP_FIELDS, limit: limit ?? 100 };
        if (bundle_id) params["filter[bundleId]"] = bundle_id;
        const { data } = await client.getAll("/apps", params);
        return ok({ count: data.length, apps: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_app",
    "Get a single app by ID (name, bundleId, sku, primaryLocale).",
    { app_id: z.string().describe("App Store Connect app ID") },
    async ({ app_id }) => {
      try {
        const res = await client.get(`/apps/${encodeURIComponent(app_id)}`, {
          "fields[apps]": APP_FIELDS,
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_builds",
    "List TestFlight builds for an app (build/upload number, app version, platform, processing state, expiry). Filter by pre-release version or processing state.",
    {
      app_id: z.string().describe("App Store Connect app ID"),
      version: z.string().optional().describe("Filter by pre-release version, e.g. '1.2.0'"),
      processing_state: z
        .enum(["PROCESSING", "FAILED", "INVALID", "VALID"])
        .optional()
        .describe("Filter by processing state"),
      limit: z.number().int().min(1).max(200).optional().describe("Max builds (default: 25)"),
    },
    async ({ app_id, version, processing_state, limit }) => {
      try {
        const params: QueryParams = {
          "filter[app]": app_id,
          include: "preReleaseVersion",
          "fields[builds]": BUILD_FIELDS,
          "fields[preReleaseVersions]": "version,platform",
          sort: "-uploadedDate",
          limit: limit ?? 25,
        };
        if (version) params["filter[preReleaseVersion.version]"] = version;
        if (processing_state) params["filter[processingState]"] = processing_state;
        const { data, included } = await client.getAll("/builds", params);
        const builds = data.map((d) =>
          shapeResource(d, included, { relationships: ["preReleaseVersion"] }),
        );
        return ok({ count: builds.length, builds });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_build",
    "Get a single TestFlight build by ID, including its pre-release version.",
    { build_id: z.string().describe("Build ID") },
    async ({ build_id }) => {
      try {
        const res = await client.get(`/builds/${encodeURIComponent(build_id)}`, {
          include: "preReleaseVersion",
          "fields[builds]": BUILD_FIELDS,
          "fields[preReleaseVersions]": "version,platform",
        });
        return ok(
          shapeResource(res.data as JsonApiResource, res.included ?? [], {
            relationships: ["preReleaseVersion"],
          }),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_customer_reviews",
    "List public App Store customer reviews for a released app (rating, title, body, reviewer, territory). Distinct from TestFlight beta feedback. Filter by rating or territory.",
    {
      app_id: z.string().describe("App Store Connect app ID"),
      rating: z.number().int().min(1).max(5).optional().describe("Filter by star rating (1-5)"),
      territory: z.string().optional().describe("Filter by territory code, e.g. 'USA'"),
      limit: z.number().int().min(1).max(200).optional().describe("Max reviews (default: 50)"),
    },
    async ({ app_id, rating, territory, limit }) => {
      try {
        const params: QueryParams = {
          "fields[customerReviews]": "rating,title,body,reviewerNickname,createdDate,territory",
          sort: "-createdDate",
          limit: limit ?? 50,
        };
        if (rating !== undefined) params["filter[rating]"] = rating;
        if (territory) params["filter[territory]"] = territory;
        const { data } = await client.getAll(
          `/apps/${encodeURIComponent(app_id)}/customerReviews`,
          params,
        );
        return ok({ count: data.length, reviews: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );
}
