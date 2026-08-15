import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource, QueryParams } from "../asc/client.js";
import { ok, err, flattenResource, shapeResource, manyRefs, findIncluded } from "../asc/format.js";

const VERSION_FIELDS =
  "versionString,platform,appStoreState,appVersionState,releaseType,copyright,earliestReleaseDate,downloadable,createdDate";
const LOCALIZATION_FIELDS =
  "locale,description,keywords,whatsNew,promotionalText,marketingUrl,supportUrl";
const REVIEW_SUBMISSION_FIELDS = "platform,submittedDate,state";
const REVIEW_SUBMISSION_RELATIONSHIPS = "items,appStoreVersionForReview";
const PHASED_RELEASE_FIELDS = "phasedReleaseState,startDate,totalPauseDuration,currentDayNumber";
const REVIEW_DETAIL_FIELDS =
  "contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountName,demoAccountRequired,notes";
const BUILD_FIELDS = "version,uploadedDate,processingState,expired";

async function optionalResource(
  client: AppStoreConnectClient,
  path: string,
  params?: QueryParams,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await client.get(path, params);
    return flattenResource(res.data as JsonApiResource);
  } catch (e) {
    if (/^Error: 404\b/.test(String(e))) return null;
    throw e;
  }
}

function relationshipRefs(resource: JsonApiResource): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, rel] of Object.entries(resource.relationships ?? {})) {
    const refs = manyRefs(rel);
    if (refs.length > 0) out[name] = refs.length === 1 ? refs[0] : refs;
  }
  return out;
}

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
    "list_review_submissions",
    "List App Store review submissions for an app: the state of each submission (READY_FOR_REVIEW, WAITING_FOR_REVIEW, IN_REVIEW, UNRESOLVED_ISSUES, CANCELING, COMPLETING, COMPLETE), when it was submitted, the App Store version under review and the items it contains (version, in-app purchases, product pages, experiments). Use this to see what is currently in App Review and what is blocking it.",
    {
      app_id: z.string().describe("App Store Connect app ID"),
      platform: z
        .enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"])
        .optional()
        .describe("Filter by platform"),
      state: z
        .enum([
          "READY_FOR_REVIEW",
          "WAITING_FOR_REVIEW",
          "IN_REVIEW",
          "UNRESOLVED_ISSUES",
          "CANCELING",
          "COMPLETING",
          "COMPLETE",
        ])
        .optional()
        .describe("Filter by submission state"),
      limit: z.number().int().min(1).max(200).optional().describe("Max submissions (default: 25)"),
    },
    async ({ app_id, platform, state, limit }) => {
      try {
        const params: QueryParams = {
          "filter[app]": app_id,
          include: REVIEW_SUBMISSION_RELATIONSHIPS,
          "fields[reviewSubmissions]": `${REVIEW_SUBMISSION_FIELDS},${REVIEW_SUBMISSION_RELATIONSHIPS}`,
          "fields[reviewSubmissionItems]": "state",
          "fields[appStoreVersions]": VERSION_FIELDS,
          limit: limit ?? 25,
        };
        if (platform) params["filter[platform]"] = platform;
        if (state) params["filter[state]"] = state;
        const { data, included } = await client.getAll("/reviewSubmissions", params);
        const submissions = data.map((d) => {
          const shaped = shapeResource(d, included, {
            relationships: ["appStoreVersionForReview"],
          });
          shaped.items = manyRefs(d.relationships?.items)
            .map((ref) => findIncluded(included, ref))
            .filter((item): item is JsonApiResource => item !== null)
            .map((item) => ({ ...flattenResource(item), targets: relationshipRefs(item) }));
          return shaped;
        });
        return ok({ count: submissions.length, submissions });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_app_store_version_status",
    "Get the full release status of an App Store version in one call: the version itself (appVersionState / appStoreState), the build attached to it, whether it has been submitted for review, the phased release state and day number, and the App Review contact and notes. Sub-resources that do not exist yet (no build attached, not submitted, no phased release) come back as null.",
    { version_id: z.string().describe("App Store version ID (from list_app_store_versions)") },
    async ({ version_id }) => {
      try {
        const id = encodeURIComponent(version_id);
        const [version, build, submission, phasedRelease, reviewDetail] = await Promise.all([
          optionalResource(client, `/appStoreVersions/${id}`, {
            "fields[appStoreVersions]": VERSION_FIELDS,
          }),
          optionalResource(client, `/appStoreVersions/${id}/build`, {
            "fields[builds]": BUILD_FIELDS,
          }),
          optionalResource(client, `/appStoreVersions/${id}/appStoreVersionSubmission`),
          optionalResource(client, `/appStoreVersions/${id}/appStoreVersionPhasedRelease`, {
            "fields[appStoreVersionPhasedReleases]": PHASED_RELEASE_FIELDS,
          }),
          optionalResource(client, `/appStoreVersions/${id}/appStoreReviewDetail`, {
            "fields[appStoreReviewDetails]": REVIEW_DETAIL_FIELDS,
          }),
        ]);
        return ok({ version, build, submission, phasedRelease, reviewDetail });
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
