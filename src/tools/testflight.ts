import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource, QueryParams } from "../asc/client.js";
import { ok, err, flattenResource } from "../asc/format.js";
import { CREATE, OVERWRITE, READ_ONLY } from "./shared.js";

const BUILD_BETA_DETAIL_FIELDS = "autoNotifyEnabled,internalBuildState,externalBuildState";
const BETA_REVIEW_SUBMISSION_FIELDS = "betaReviewState,submittedDate";
const BETA_BUILD_LOCALIZATION_FIELDS = "whatsNew,locale";
const BETA_APP_LOCALIZATION_FIELDS =
  "feedbackEmail,marketingUrl,privacyPolicyUrl,tvOsPrivacyPolicy,description,locale";
const BETA_APP_REVIEW_DETAIL_FIELDS =
  "contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountName,demoAccountRequired,notes";
const PERIOD = z.enum(["P7D", "P30D", "P90D", "P365D"]);

interface MetricBody {
  data?: unknown;
  meta?: unknown;
}

export function registerTestFlightTools(
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites = false,
) {
  server.tool(
    "get_build_status",
    "Get the TestFlight distribution status of a build: internal/external build state and auto-notify (buildBetaDetail), the beta app review submission with its betaReviewState (WAITING_FOR_REVIEW, IN_REVIEW, REJECTED, APPROVED) and submitted date, and the 'What to Test' notes per locale. Use this to find out why a build is not yet available to external testers.",
    { build_id: z.string().describe("Build ID (from list_builds)") },
    READ_ONLY,
    async ({ build_id }) => {
      try {
        const [details, submissions, localizations] = await Promise.all([
          client.getAll("/buildBetaDetails", {
            "filter[build]": build_id,
            "fields[buildBetaDetails]": BUILD_BETA_DETAIL_FIELDS,
          }),
          client.getAll("/betaAppReviewSubmissions", {
            "filter[build]": build_id,
            "fields[betaAppReviewSubmissions]": BETA_REVIEW_SUBMISSION_FIELDS,
          }),
          client.getAll("/betaBuildLocalizations", {
            "filter[build]": build_id,
            "fields[betaBuildLocalizations]": BETA_BUILD_LOCALIZATION_FIELDS,
            limit: 200,
          }),
        ]);
        return ok({
          buildId: build_id,
          buildBetaDetail: flattenResource(details.data[0] ?? null),
          betaAppReviewSubmission: flattenResource(submissions.data[0] ?? null),
          whatToTest: localizations.data.map((d) => flattenResource(d)),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_beta_app_localizations",
    "List the TestFlight app localizations for an app (per-locale beta description, feedback email, marketing and privacy policy URLs). This is the tester-facing TestFlight metadata, not the App Store listing.",
    {
      app_id: z.string().describe("App Store Connect app ID"),
      locale: z.string().optional().describe("Filter by locale, e.g. 'en-US'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max localizations (default: 100)"),
    },
    READ_ONLY,
    async ({ app_id, locale, limit }) => {
      try {
        const params: QueryParams = {
          "filter[app]": app_id,
          "fields[betaAppLocalizations]": BETA_APP_LOCALIZATION_FIELDS,
          limit: limit ?? 100,
        };
        if (locale) params["filter[locale]"] = locale;
        const { data } = await client.getAll("/betaAppLocalizations", params);
        return ok({ count: data.length, localizations: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_beta_app_review_detail",
    "Get the beta app review details an app submits with builds for external TestFlight review: review contact, whether a demo account is required, the demo account name and review notes. The demo account password is deliberately not requested.",
    { app_id: z.string().describe("App Store Connect app ID") },
    READ_ONLY,
    async ({ app_id }) => {
      try {
        const { data } = await client.getAll("/betaAppReviewDetails", {
          "filter[app]": app_id,
          "fields[betaAppReviewDetails]": BETA_APP_REVIEW_DETAIL_FIELDS,
        });
        return ok(flattenResource(data[0] ?? null));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_build_usage_metrics",
    "Get TestFlight usage metrics for a build: install count, session count, crash count, invite count and feedback count over the reported date range. Use it to turn raw feedback and crash counts into rates (e.g. crashes per install).",
    {
      build_id: z.string().describe("Build ID (from list_builds)"),
      limit: z.number().int().min(1).max(200).optional().describe("Max data points"),
    },
    READ_ONLY,
    async ({ build_id, limit }) => {
      try {
        const params: QueryParams = {};
        if (limit !== undefined) params.limit = limit;
        const body = (await client.getJson(
          `/builds/${encodeURIComponent(build_id)}/metrics/betaBuildUsages`,
          params,
        )) as MetricBody;
        return ok({ buildId: build_id, metrics: body.data ?? [] });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_beta_tester_metrics",
    "Get TestFlight tester engagement metrics (session count, crash count, feedback count) for an app or a beta group, grouped by beta tester. Pass either app_id or group_id; optionally restrict to a single tester and pick a reporting period.",
    {
      app_id: z.string().optional().describe("App Store Connect app ID (or pass group_id)"),
      group_id: z.string().optional().describe("Beta group ID (from list_beta_groups)"),
      tester_id: z.string().optional().describe("Restrict to a single beta tester ID"),
      period: PERIOD.optional().describe("Reporting period (default: P30D)"),
      limit: z.number().int().min(1).max(200).optional().describe("Max data points"),
    },
    READ_ONLY,
    async ({ app_id, group_id, tester_id, period, limit }) => {
      try {
        if (!app_id && !group_id) return err("Pass either app_id or group_id.");
        const path = group_id
          ? `/betaGroups/${encodeURIComponent(group_id)}/metrics/betaTesterUsages`
          : `/apps/${encodeURIComponent(app_id!)}/metrics/betaTesterUsages`;
        const params: QueryParams = { groupBy: "betaTesters", period: period ?? "P30D" };
        if (tester_id) params["filter[betaTesters]"] = tester_id;
        if (limit !== undefined) params.limit = limit;
        const body = (await client.getJson(path, params)) as MetricBody;
        return ok({ metrics: body.data ?? [] });
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowWrites) return;

  server.tool(
    "set_build_export_compliance",
    "Writes. Answer the export compliance question for a build: whether it uses non-exempt encryption (usesNonExemptEncryption). A build with an unanswered question stays in 'Missing Compliance' and cannot be distributed to testers. Answer true only if the app uses encryption beyond what is exempt (then Apple may require an encryption declaration in App Store Connect); false for apps that only use exempt encryption such as HTTPS. Setting ITSAppUsesNonExemptEncryption in Info.plist avoids the question for future builds. Build ids come from list_builds.",
    {
      build_id: z.string().describe("Build ID (from list_builds)"),
      uses_non_exempt_encryption: z
        .boolean()
        .describe("Whether the build uses non-exempt encryption"),
    },
    OVERWRITE,
    async ({ build_id, uses_non_exempt_encryption }) => {
      try {
        const res = await client.patch(`/builds/${encodeURIComponent(build_id)}`, {
          data: {
            type: "builds",
            id: build_id,
            attributes: { usesNonExemptEncryption: uses_non_exempt_encryption },
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "set_build_whats_new",
    "Writes. Set the TestFlight 'What to Test' text of a build for one locale (creates the locale if it does not exist yet, otherwise replaces its text). Existing texts are listed by get_build_status. Build ids come from list_builds.",
    {
      build_id: z.string().describe("Build ID (from list_builds)"),
      locale: z.string().describe("Locale, e.g. 'en-US'"),
      whats_new: z.string().max(4000).describe("What to Test text (max 4000 chars)"),
    },
    OVERWRITE,
    async ({ build_id, locale, whats_new }) => {
      try {
        const { data } = await client.getAll("/betaBuildLocalizations", {
          "filter[build]": build_id,
          "fields[betaBuildLocalizations]": BETA_BUILD_LOCALIZATION_FIELDS,
          limit: 200,
        });
        const existing = data.find((l) => l.attributes?.locale === locale);
        const res = existing
          ? await client.patch(`/betaBuildLocalizations/${encodeURIComponent(existing.id)}`, {
              data: {
                type: "betaBuildLocalizations",
                id: existing.id,
                attributes: { whatsNew: whats_new },
              },
            })
          : await client.post("/betaBuildLocalizations", {
              data: {
                type: "betaBuildLocalizations",
                attributes: { locale, whatsNew: whats_new },
                relationships: { build: { data: { type: "builds", id: build_id } } },
              },
            });
        return ok({ created: !existing, ...flattenResource(res.data as JsonApiResource) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "submit_build_for_beta_review",
    "Writes. Submit a build for beta app review, which is required before it can go to external TestFlight groups. The app's beta review contact details and TestFlight localizations must be filled in (get_beta_app_review_detail, list_beta_app_localizations), and the build's export compliance answered (set_build_export_compliance). Follow the result with get_build_status. Build ids come from list_builds.",
    { build_id: z.string().describe("Build ID (from list_builds)") },
    CREATE,
    async ({ build_id }) => {
      try {
        const res = await client.post("/betaAppReviewSubmissions", {
          data: {
            type: "betaAppReviewSubmissions",
            relationships: { build: { data: { type: "builds", id: build_id } } },
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );
}
