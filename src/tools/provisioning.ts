import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, QueryParams } from "../asc/client.js";
import { ok, err, flattenResource, shapeResource } from "../asc/format.js";

export function registerProvisioningTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    "list_devices",
    "List registered devices (name, platform, UDID, class, model, status). Filter by platform or status.",
    {
      platform: z.enum(["IOS", "MAC_OS"]).optional().describe("Filter by device platform"),
      status: z.enum(["ENABLED", "DISABLED"]).optional().describe("Filter by device status"),
      limit: z.number().int().min(1).max(200).optional().describe("Max devices (default: 100)"),
    },
    async ({ platform, status, limit }) => {
      try {
        const params: QueryParams = {
          "fields[devices]": "name,platform,udid,deviceClass,status,model,addedDate",
          limit: limit ?? 100,
        };
        if (platform) params["filter[platform]"] = platform;
        if (status) params["filter[status]"] = status;
        const { data } = await client.getAll("/devices", params);
        return ok({ count: data.length, devices: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_certificates",
    "List signing certificates (type, name, platform, serial number, expiry). Filter by certificate type.",
    {
      certificate_type: z
        .string()
        .optional()
        .describe("Filter by type, e.g. 'IOS_DISTRIBUTION', 'IOS_DEVELOPMENT', 'DISTRIBUTION'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max certificates (default: 100)"),
    },
    async ({ certificate_type, limit }) => {
      try {
        const params: QueryParams = {
          "fields[certificates]":
            "certificateType,displayName,name,platform,serialNumber,expirationDate",
          limit: limit ?? 100,
        };
        if (certificate_type) params["filter[certificateType]"] = certificate_type;
        const { data } = await client.getAll("/certificates", params);
        return ok({ count: data.length, certificates: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_profiles",
    "List provisioning profiles (name, platform, type, state, UUID, expiry) with their bundle ID. Filter by profile state.",
    {
      profile_state: z.enum(["ACTIVE", "INVALID"]).optional().describe("Filter by profile state"),
      limit: z.number().int().min(1).max(200).optional().describe("Max profiles (default: 100)"),
    },
    async ({ profile_state, limit }) => {
      try {
        const params: QueryParams = {
          "fields[profiles]":
            "name,platform,profileType,profileState,uuid,createdDate,expirationDate",
          "fields[bundleIds]": "identifier,name,platform",
          include: "bundleId",
          limit: limit ?? 100,
        };
        if (profile_state) params["filter[profileState]"] = profile_state;
        const { data, included } = await client.getAll("/profiles", params);
        const profiles = data.map((d) =>
          shapeResource(d, included, { relationships: ["bundleId"] }),
        );
        return ok({ count: profiles.length, profiles });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_bundle_ids",
    "List registered bundle IDs (identifier, name, platform, seed ID). Filter by identifier or platform.",
    {
      identifier: z
        .string()
        .optional()
        .describe("Filter by bundle identifier, e.g. 'com.acme.app'"),
      platform: z
        .enum(["IOS", "MAC_OS", "UNIVERSAL"])
        .optional()
        .describe("Filter by bundle platform"),
      limit: z.number().int().min(1).max(200).optional().describe("Max bundle IDs (default: 100)"),
    },
    async ({ identifier, platform, limit }) => {
      try {
        const params: QueryParams = {
          "fields[bundleIds]": "identifier,name,platform,seedId",
          limit: limit ?? 100,
        };
        if (identifier) params["filter[identifier]"] = identifier;
        if (platform) params["filter[platform]"] = platform;
        const { data } = await client.getAll("/bundleIds", params);
        return ok({ count: data.length, bundleIds: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );
}
