import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource } from "../asc/client.js";
import { ok, err, flattenResource, defined } from "../asc/format.js";
import { CREATE, DESTRUCTIVE, OVERWRITE } from "./shared.js";

const REVIEW_DETAIL_FIELDS =
  "contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountName,demoAccountRequired,notes";
const PLATFORM = z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]);

export function registerReleaseTools(
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites = false,
) {
  if (!allowWrites) return;

  server.tool(
    "create_app_store_version",
    "Writes. Create a new App Store version (the version that gets submitted to App Review) for an app. The app record must already exist in App Store Connect; the API cannot create apps. Fails while another version of the same platform is still editable. Optionally attach a build and set the release type right away; the release type and build can also be changed later with update_app_store_version and set_app_store_version_build. Fill in the localized text with update_app_store_version_localization. App ids come from list_apps.",
    {
      app_id: z.string().describe("App Store Connect app ID (from list_apps)"),
      platform: PLATFORM.describe("Platform of the version"),
      version_string: z.string().describe("Version, e.g. '1.0.0'"),
      release_type: z
        .enum(["MANUAL", "AFTER_APPROVAL", "SCHEDULED"])
        .optional()
        .describe("How the approved version is released"),
      earliest_release_date: z
        .string()
        .optional()
        .describe("ISO 8601 date-time, for SCHEDULED release"),
      copyright: z.string().optional().describe("e.g. '2026 Jane Doe'"),
      build_id: z.string().optional().describe("Build to attach (from list_builds)"),
    },
    CREATE,
    async (args) => {
      try {
        const attributes = Object.fromEntries(
          Object.entries({
            platform: args.platform,
            versionString: args.version_string,
            releaseType: args.release_type,
            earliestReleaseDate: args.earliest_release_date,
            copyright: args.copyright,
          }).filter(([, v]) => v !== undefined),
        );
        const res = await client.post("/appStoreVersions", {
          data: {
            type: "appStoreVersions",
            attributes,
            relationships: {
              app: { data: { type: "apps", id: args.app_id } },
              ...(args.build_id ? { build: { data: { type: "builds", id: args.build_id } } } : {}),
            },
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "set_app_store_version_build",
    "Writes. Attach a build to an editable App Store version, replacing any build attached before. The build must be processed (VALID) and have its export compliance answered. Version ids come from list_app_store_versions, build ids from list_builds.",
    {
      version_id: z.string().describe("App Store version ID (from list_app_store_versions)"),
      build_id: z.string().describe("Build ID (from list_builds)"),
    },
    OVERWRITE,
    async ({ version_id, build_id }) => {
      try {
        const res = await client.patch(`/appStoreVersions/${encodeURIComponent(version_id)}`, {
          data: {
            type: "appStoreVersions",
            id: version_id,
            relationships: { build: { data: { type: "builds", id: build_id } } },
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_app_store_review_detail",
    "Writes. Set the App Review information of an App Store version: the review notes, the review contact and the demo account that App Review uses. Creates the review detail if the version has none yet, otherwise changes only the fields you pass; pass null to clear one. The demo account password is write-only: it is sent to Apple but never returned by this or any other tool. Nothing is submitted for review. Read the current values with get_app_store_version_status. Version ids come from list_app_store_versions.",
    {
      version_id: z.string().describe("App Store version ID (from list_app_store_versions)"),
      notes: z.string().max(4000).nullable().optional().describe("Notes for App Review"),
      contact_first_name: z.string().nullable().optional().describe("Review contact first name"),
      contact_last_name: z.string().nullable().optional().describe("Review contact last name"),
      contact_phone: z
        .string()
        .nullable()
        .optional()
        .describe("Review contact phone number with country code, e.g. '+41 44 123 45 67'"),
      contact_email: z.string().nullable().optional().describe("Review contact email"),
      demo_account_required: z
        .boolean()
        .optional()
        .describe("Whether reviewers need a demo account to sign in"),
      demo_account_name: z.string().nullable().optional().describe("Demo account user name"),
      demo_account_password: z
        .string()
        .nullable()
        .optional()
        .describe("Demo account password (write-only, never returned)"),
    },
    OVERWRITE,
    async (args) => {
      try {
        const attributes = defined({
          notes: args.notes,
          contactFirstName: args.contact_first_name,
          contactLastName: args.contact_last_name,
          contactPhone: args.contact_phone,
          contactEmail: args.contact_email,
          demoAccountRequired: args.demo_account_required,
          demoAccountName: args.demo_account_name,
          demoAccountPassword: args.demo_account_password,
        });
        if (Object.keys(attributes).length === 0) return err("Pass at least one field to update.");
        let existing: JsonApiResource | null = null;
        try {
          const found = await client.get(
            `/appStoreVersions/${encodeURIComponent(args.version_id)}/appStoreReviewDetail`,
            { "fields[appStoreReviewDetails]": REVIEW_DETAIL_FIELDS },
          );
          existing = (found.data as JsonApiResource | null) ?? null;
        } catch (e) {
          if (!/^Error: 404\b/.test(String(e))) throw e;
        }
        const res = existing
          ? await client.patch(`/appStoreReviewDetails/${encodeURIComponent(existing.id)}`, {
              data: { type: "appStoreReviewDetails", id: existing.id, attributes },
            })
          : await client.post("/appStoreReviewDetails", {
              data: {
                type: "appStoreReviewDetails",
                attributes,
                relationships: {
                  appStoreVersion: { data: { type: "appStoreVersions", id: args.version_id } },
                },
              },
            });
        const flat = { ...flattenResource(res.data as JsonApiResource) };
        delete flat.demoAccountPassword;
        return ok({ created: !existing, ...flat });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "create_review_submission",
    "Writes. Start an App Review submission for an app and platform: the container that is filled with add_review_submission_item and then sent with submit_review_submission. Nothing is sent to Apple yet. Reuse an existing READY_FOR_REVIEW submission (list_review_submissions) instead of creating another. App ids come from list_apps.",
    {
      app_id: z.string().describe("App Store Connect app ID (from list_apps)"),
      platform: PLATFORM.describe("Platform being submitted"),
    },
    CREATE,
    async ({ app_id, platform }) => {
      try {
        const res = await client.post("/reviewSubmissions", {
          data: {
            type: "reviewSubmissions",
            attributes: { platform },
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
    "add_review_submission_item",
    "Writes. Add an App Store version to a review submission that has not been submitted yet. The version needs a build, its localized text, age rating and review details filled in. Submission ids come from create_review_submission / list_review_submissions, version ids from list_app_store_versions.",
    {
      submission_id: z.string().describe("Review submission ID"),
      version_id: z.string().describe("App Store version ID (from list_app_store_versions)"),
    },
    CREATE,
    async ({ submission_id, version_id }) => {
      try {
        const res = await client.post("/reviewSubmissionItems", {
          data: {
            type: "reviewSubmissionItems",
            relationships: {
              reviewSubmission: { data: { type: "reviewSubmissions", id: submission_id } },
              appStoreVersion: { data: { type: "appStoreVersions", id: version_id } },
            },
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "submit_review_submission",
    "Writes, consequential. Send a review submission to App Review. Once submitted the version is locked and Apple starts reviewing it; undo it with cancel_review_submission. The submission must contain at least one item (add_review_submission_item). Follow the progress with list_review_submissions.",
    { submission_id: z.string().describe("Review submission ID") },
    DESTRUCTIVE,
    async ({ submission_id }) => {
      try {
        const res = await client.patch(`/reviewSubmissions/${encodeURIComponent(submission_id)}`, {
          data: { type: "reviewSubmissions", id: submission_id, attributes: { submitted: true } },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "cancel_review_submission",
    "Writes, destructive. Cancel a review submission that is waiting for or in review. The version leaves App Review and its place in the review queue is lost; it can be submitted again afterwards. Submission ids come from list_review_submissions.",
    { submission_id: z.string().describe("Review submission ID (from list_review_submissions)") },
    DESTRUCTIVE,
    async ({ submission_id }) => {
      try {
        const res = await client.patch(`/reviewSubmissions/${encodeURIComponent(submission_id)}`, {
          data: { type: "reviewSubmissions", id: submission_id, attributes: { canceled: true } },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "create_phased_release",
    "Writes. Turn on phased release for an App Store version that is not released yet: once the version goes live the automatic update reaches 1%, 2%, 5%, 10%, 20%, 50% and then 100% of users over 7 days, while anyone can still get it manually from the App Store. Created INACTIVE; it becomes ACTIVE when the version is released. Steer it afterwards with update_phased_release. Version ids come from list_app_store_versions.",
    { version_id: z.string().describe("App Store version ID (from list_app_store_versions)") },
    CREATE,
    async ({ version_id }) => {
      try {
        const res = await client.post("/appStoreVersionPhasedReleases", {
          data: {
            type: "appStoreVersionPhasedReleases",
            attributes: { phasedReleaseState: "INACTIVE" },
            relationships: {
              appStoreVersion: { data: { type: "appStoreVersions", id: version_id } },
            },
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_phased_release",
    "Writes, consequential. Steer a running phased release: PAUSED stops the rollout at its current percentage (for at most 30 days in total), ACTIVE resumes it, COMPLETE releases the update to all users at once and cannot be undone. The phased release id and its current state and day number come from get_app_store_version_status.",
    {
      phased_release_id: z
        .string()
        .describe("Phased release ID (phasedRelease.id in get_app_store_version_status)"),
      state: z.enum(["ACTIVE", "PAUSED", "COMPLETE"]).describe("New phased release state"),
    },
    DESTRUCTIVE,
    async ({ phased_release_id, state }) => {
      try {
        const res = await client.patch(
          `/appStoreVersionPhasedReleases/${encodeURIComponent(phased_release_id)}`,
          {
            data: {
              type: "appStoreVersionPhasedReleases",
              id: phased_release_id,
              attributes: { phasedReleaseState: state },
            },
          },
        );
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_phased_release",
    "Writes, destructive. Turn phased release off again for an App Store version that has not started rolling out, so that the version reaches all users at once when it is released. The phased release id comes from get_app_store_version_status.",
    {
      phased_release_id: z
        .string()
        .describe("Phased release ID (phasedRelease.id in get_app_store_version_status)"),
    },
    DESTRUCTIVE,
    async ({ phased_release_id }) => {
      try {
        await client.delete(
          `/appStoreVersionPhasedReleases/${encodeURIComponent(phased_release_id)}`,
        );
        return ok({ deleted: phased_release_id });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "release_app_store_version",
    "Writes, consequential. Release an approved App Store version that is waiting in PENDING_DEVELOPER_RELEASE (manual release) to the App Store now. This publishes the version to customers and cannot be undone. Check the state with get_app_store_version_status first. Version ids come from list_app_store_versions.",
    { version_id: z.string().describe("App Store version ID (from list_app_store_versions)") },
    DESTRUCTIVE,
    async ({ version_id }) => {
      try {
        const res = await client.post("/appStoreVersionReleaseRequests", {
          data: {
            type: "appStoreVersionReleaseRequests",
            relationships: {
              appStoreVersion: { data: { type: "appStoreVersions", id: version_id } },
            },
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );
}
