import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource, QueryParams } from "../asc/client.js";
import { ok, err, flattenResource } from "../asc/format.js";
import { CREATE, DESTRUCTIVE, OVERWRITE, READ_ONLY } from "./shared.js";

const GROUP_FIELDS =
  "name,isInternalGroup,publicLinkEnabled,publicLinkLimit,publicLink,feedbackEnabled,createdDate";
const TESTER_FIELDS = "firstName,lastName,email,inviteType,state";

const refs = (type: string, ids: string[]) => ({ data: ids.map((id) => ({ type, id })) });

export function registerTesterTools(
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites = false,
) {
  server.tool(
    "list_beta_groups",
    "List the TestFlight beta groups for an app (name, internal/external, public link, whether feedback is enabled).",
    {
      app_id: z.string().describe("App Store Connect app ID"),
      limit: z.number().int().min(1).max(200).optional().describe("Max groups (default: 100)"),
    },
    READ_ONLY,
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
    READ_ONLY,
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
    READ_ONLY,
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

  if (!allowWrites) return;

  server.tool(
    "create_beta_group",
    "Writes. Create a TestFlight beta group for an app. Internal groups (is_internal_group) are for App Store Connect users and can have access to all builds; external groups are for outside testers, can have a public link, and each build added to one must pass beta app review (submit_build_for_beta_review). Returns the group id used by the other beta group tools.",
    {
      app_id: z.string().describe("App Store Connect app ID (from list_apps)"),
      name: z.string().describe("Group name"),
      is_internal_group: z.boolean().optional().describe("Internal group (default: external)"),
      has_access_to_all_builds: z
        .boolean()
        .optional()
        .describe("Internal groups only: give the group every build automatically"),
      public_link_enabled: z.boolean().optional().describe("External groups: enable a public link"),
      public_link_limit_enabled: z.boolean().optional().describe("Limit public link sign-ups"),
      public_link_limit: z.number().int().min(1).max(10000).optional(),
      feedback_enabled: z.boolean().optional().describe("Let testers send TestFlight feedback"),
    },
    CREATE,
    async (args) => {
      try {
        const attributes = {
          name: args.name,
          ...Object.fromEntries(
            Object.entries({
              isInternalGroup: args.is_internal_group,
              hasAccessToAllBuilds: args.has_access_to_all_builds,
              publicLinkEnabled: args.public_link_enabled,
              publicLinkLimitEnabled: args.public_link_limit_enabled,
              publicLinkLimit: args.public_link_limit,
              feedbackEnabled: args.feedback_enabled,
            }).filter(([, v]) => v !== undefined),
          ),
        };
        const res = await client.post("/betaGroups", {
          data: {
            type: "betaGroups",
            attributes,
            relationships: { app: { data: { type: "apps", id: args.app_id } } },
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_beta_group",
    "Writes, destructive and permanent. Delete a TestFlight beta group. Its public link stops working and its testers lose access to the builds they only had through this group (the testers themselves are kept). Group ids come from list_beta_groups.",
    { group_id: z.string().describe("Beta group ID (from list_beta_groups)") },
    DESTRUCTIVE,
    async ({ group_id }) => {
      try {
        await client.delete(`/betaGroups/${encodeURIComponent(group_id)}`);
        return ok({ deleted: group_id });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "add_beta_tester",
    "Writes. Create a beta tester by email and add them to one or more beta groups. Apple sends the tester an invitation email, so only use addresses the user asked for. For testers that already exist (list_beta_testers) use add_testers_to_beta_group. Returns the tester with its id.",
    {
      email: z.string().describe("Tester email address"),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      group_ids: z
        .array(z.string())
        .min(1)
        .describe("Beta group IDs to add the tester to (from list_beta_groups)"),
    },
    CREATE,
    async ({ email, first_name, last_name, group_ids }) => {
      try {
        const res = await client.post("/betaTesters", {
          data: {
            type: "betaTesters",
            attributes: {
              email,
              ...(first_name === undefined ? {} : { firstName: first_name }),
              ...(last_name === undefined ? {} : { lastName: last_name }),
            },
            relationships: { betaGroups: refs("betaGroups", group_ids) },
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "add_testers_to_beta_group",
    "Writes. Add existing beta testers to a beta group. Tester ids come from list_beta_testers, group ids from list_beta_groups. Returns nothing on success.",
    {
      group_id: z.string().describe("Beta group ID (from list_beta_groups)"),
      tester_ids: z.array(z.string()).min(1).describe("Beta tester IDs (from list_beta_testers)"),
    },
    CREATE,
    async ({ group_id, tester_ids }) => {
      try {
        await client.postNoContent(
          `/betaGroups/${encodeURIComponent(group_id)}/relationships/betaTesters`,
          refs("betaTesters", tester_ids),
        );
        return ok({ groupId: group_id, added: tester_ids });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "remove_testers_from_beta_group",
    "Writes, destructive. Remove testers from a beta group; they lose access to builds they only had through this group. The testers themselves are kept and can be added again. Tester ids come from list_group_testers.",
    {
      group_id: z.string().describe("Beta group ID (from list_beta_groups)"),
      tester_ids: z.array(z.string()).min(1).describe("Beta tester IDs (from list_group_testers)"),
    },
    DESTRUCTIVE,
    async ({ group_id, tester_ids }) => {
      try {
        await client.delete(
          `/betaGroups/${encodeURIComponent(group_id)}/relationships/betaTesters`,
          refs("betaTesters", tester_ids),
        );
        return ok({ groupId: group_id, removed: tester_ids });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "add_builds_to_beta_group",
    "Writes. Make builds available to a beta group. Build ids come from list_builds, group ids from list_beta_groups. For an external group the build also has to pass beta app review (submit_build_for_beta_review) and, if it uses encryption, have its export compliance answered (set_build_export_compliance); check get_build_status.",
    {
      group_id: z.string().describe("Beta group ID (from list_beta_groups)"),
      build_ids: z.array(z.string()).min(1).describe("Build IDs (from list_builds)"),
    },
    CREATE,
    async ({ group_id, build_ids }) => {
      try {
        await client.postNoContent(
          `/betaGroups/${encodeURIComponent(group_id)}/relationships/builds`,
          refs("builds", build_ids),
        );
        return ok({ groupId: group_id, added: build_ids });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "remove_builds_from_beta_group",
    "Writes, destructive. Remove builds from a beta group so its testers can no longer install them through this group. Build ids come from list_builds.",
    {
      group_id: z.string().describe("Beta group ID (from list_beta_groups)"),
      build_ids: z.array(z.string()).min(1).describe("Build IDs (from list_builds)"),
    },
    DESTRUCTIVE,
    async ({ group_id, build_ids }) => {
      try {
        await client.delete(
          `/betaGroups/${encodeURIComponent(group_id)}/relationships/builds`,
          refs("builds", build_ids),
        );
        return ok({ groupId: group_id, removed: build_ids });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_beta_group",
    "Writes. Change a TestFlight beta group: rename it, turn its public invitation link on or off, limit how many testers can join through the link, or turn tester feedback on or off. Only the given fields change. Turning the public link off invalidates the link for people who have not joined yet. Group ids come from list_beta_groups.",
    {
      group_id: z.string().describe("Beta group ID (from list_beta_groups)"),
      name: z.string().optional().describe("New group name"),
      public_link_enabled: z.boolean().optional().describe("Turn the public link on or off"),
      public_link_limit_enabled: z
        .boolean()
        .optional()
        .describe("Whether the public link has a tester limit"),
      public_link_limit: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .describe("Max testers that can join through the public link"),
      feedback_enabled: z.boolean().optional().describe("Whether testers can send feedback"),
    },
    OVERWRITE,
    async (args) => {
      try {
        const attributes = Object.fromEntries(
          Object.entries({
            name: args.name,
            publicLinkEnabled: args.public_link_enabled,
            publicLinkLimitEnabled: args.public_link_limit_enabled,
            publicLinkLimit: args.public_link_limit,
            feedbackEnabled: args.feedback_enabled,
          }).filter(([, v]) => v !== undefined),
        );
        if (Object.keys(attributes).length === 0) throw new Error("Nothing to update");
        const res = await client.patch(`/betaGroups/${encodeURIComponent(args.group_id)}`, {
          data: { type: "betaGroups", id: args.group_id, attributes },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "remove_beta_tester",
    "Writes, destructive. Remove a tester from TestFlight. With app_id the tester loses access to that app only (all of its groups and builds); without it the tester is removed from every app of the team. To take a tester out of a single group use remove_testers_from_beta_group. Tester ids come from list_beta_testers.",
    {
      tester_id: z.string().describe("Beta tester ID (from list_beta_testers)"),
      app_id: z
        .string()
        .optional()
        .describe("Only remove the tester from this app (from list_apps)"),
    },
    DESTRUCTIVE,
    async ({ tester_id, app_id }) => {
      try {
        if (app_id) {
          await client.delete(
            `/apps/${encodeURIComponent(app_id)}/relationships/betaTesters`,
            refs("betaTesters", [tester_id]),
          );
        } else {
          await client.delete(`/betaTesters/${encodeURIComponent(tester_id)}`);
        }
        return ok({ removed: tester_id, ...(app_id ? { appId: app_id } : {}) });
      } catch (e) {
        return err(e);
      }
    },
  );
}
