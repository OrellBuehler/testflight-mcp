import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, QueryParams } from "../asc/client.js";
import { ok, err, flattenResource } from "../asc/format.js";

const GROUP_FIELDS =
  "name,isInternalGroup,publicLinkEnabled,publicLinkLimit,publicLink,feedbackEnabled,createdDate";
const TESTER_FIELDS = "firstName,lastName,email,inviteType,state";

export function registerTesterTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    "list_beta_groups",
    "List the TestFlight beta groups for an app (name, internal/external, public link, whether feedback is enabled).",
    {
      app_id: z.string().describe("App Store Connect app ID"),
      limit: z.number().int().min(1).max(200).optional().describe("Max groups (default: 100)"),
    },
    async ({ app_id, limit }) => {
      try {
        const params: QueryParams = {
          "filter[app]": app_id,
          "fields[betaGroups]": GROUP_FIELDS,
          limit: limit ?? 100,
        };
        const { data } = await client.getAll("/betaGroups", params);
        return ok({ count: data.length, groups: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_beta_testers",
    "List TestFlight beta testers (name, email, invite type, state). Filter by app, beta group and/or email.",
    {
      app_id: z.string().optional().describe("Filter testers by app ID"),
      group_id: z.string().optional().describe("Filter testers by beta group ID"),
      email: z.string().optional().describe("Filter by exact tester email"),
      limit: z.number().int().min(1).max(200).optional().describe("Max testers (default: 100)"),
    },
    async ({ app_id, group_id, email, limit }) => {
      try {
        const params: QueryParams = {
          "fields[betaTesters]": TESTER_FIELDS,
          sort: "lastName",
          limit: limit ?? 100,
        };
        if (app_id) params["filter[apps]"] = app_id;
        if (group_id) params["filter[betaGroups]"] = group_id;
        if (email) params["filter[email]"] = email;
        const { data } = await client.getAll("/betaTesters", params);
        return ok({ count: data.length, testers: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_group_testers",
    "List the beta testers that belong to a specific beta group.",
    {
      group_id: z.string().describe("Beta group ID"),
      limit: z.number().int().min(1).max(200).optional().describe("Max testers (default: 100)"),
    },
    async ({ group_id, limit }) => {
      try {
        const params: QueryParams = {
          "fields[betaTesters]": TESTER_FIELDS,
          limit: limit ?? 100,
        };
        const { data } = await client.getAll(
          `/betaGroups/${encodeURIComponent(group_id)}/betaTesters`,
          params,
        );
        return ok({ count: data.length, testers: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );
}
