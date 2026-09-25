import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource, QueryParams } from "../asc/client.js";
import { ok, err, flattenResource, shapeResource, manyRefs, findIncluded } from "../asc/format.js";

const APP_FIELDS = "name,bundleId,sku,primaryLocale,contentRightsDeclaration";
const APP_INFO_RELATIONSHIPS =
  "appInfoLocalizations,primaryCategory,primarySubcategoryOne,primarySubcategoryTwo,secondaryCategory,secondarySubcategoryOne,secondarySubcategoryTwo,ageRatingDeclaration";
const APP_INFO_LOCALIZATION_FIELDS =
  "locale,name,subtitle,privacyPolicyUrl,privacyChoicesUrl,privacyPolicyText";
const VERSION_LOCALIZATION_FIELDS =
  "locale,description,keywords,whatsNew,promotionalText,marketingUrl,supportUrl";

function defined(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
}

function categoryRef(id: string | null | undefined) {
  if (id === undefined) return undefined;
  return { data: id === null ? null : { type: "appCategories", id } };
}

export function registerListingTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    "get_app_info",
    "Get an app's App Information page: the app itself (primary locale, content rights declaration) and each appInfo (one per live/editable state) with its per-locale name, subtitle and privacy policy URL, primary/secondary categories and the age rating declaration. Use the returned IDs with the update_* tools.",
    { app_id: z.string().describe("App Store Connect app ID") },
    async ({ app_id }) => {
      try {
        const id = encodeURIComponent(app_id);
        const [app, infos] = await Promise.all([
          client.get(`/apps/${id}`, { "fields[apps]": APP_FIELDS }),
          client.get(`/apps/${id}/appInfos`, {
            include: APP_INFO_RELATIONSHIPS,
            "fields[appInfoLocalizations]": APP_INFO_LOCALIZATION_FIELDS,
            limit: 10,
          }),
        ]);
        const included = infos.included ?? [];
        const appInfos = (Array.isArray(infos.data) ? infos.data : [infos.data]).map((info) => {
          const shaped = shapeResource(info, included, {
            relationships: [
              "primaryCategory",
              "primarySubcategoryOne",
              "primarySubcategoryTwo",
              "secondaryCategory",
              "secondarySubcategoryOne",
              "secondarySubcategoryTwo",
              "ageRatingDeclaration",
            ],
          });
          shaped.localizations = manyRefs(info.relationships?.appInfoLocalizations)
            .map((ref) => findIncluded(included, ref))
            .filter((l): l is JsonApiResource => l !== null)
            .map((l) => flattenResource(l));
          return shaped;
        });
        return ok({ app: flattenResource(app.data as JsonApiResource), appInfos });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_app_categories",
    "List App Store categories (with subcategories) and their IDs, for update_app_info.",
    {
      platform: z
        .enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"])
        .optional()
        .describe("Filter by platform (default: IOS)"),
    },
    async ({ platform }) => {
      try {
        const { data } = await client.getAll("/appCategories", {
          "filter[platforms]": platform ?? "IOS",
          "exists[parent]": false,
          include: "subcategories",
          "fields[appCategories]": "platforms,subcategories",
          limit: 200,
        });
        const categories = data.map((c) => ({
          id: c.id,
          subcategories: manyRefs(c.relationships?.subcategories).map((ref) => ref.id),
        }));
        return ok({ count: categories.length, categories });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_app",
    "Writes. Update app-level App Information: the content rights declaration and/or the primary locale.",
    {
      app_id: z.string().describe("App Store Connect app ID"),
      content_rights_declaration: z
        .enum(["DOES_NOT_USE_THIRD_PARTY_CONTENT", "USES_THIRD_PARTY_CONTENT"])
        .optional()
        .describe("Whether the app contains, shows or accesses third-party content"),
      primary_locale: z.string().optional().describe("Primary locale, e.g. 'en-US'"),
    },
    async ({ app_id, content_rights_declaration, primary_locale }) => {
      try {
        const res = await client.patch(`/apps/${encodeURIComponent(app_id)}`, {
          data: {
            type: "apps",
            id: app_id,
            attributes: defined({
              contentRightsDeclaration: content_rights_declaration,
              primaryLocale: primary_locale,
            }),
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_app_info",
    "Writes. Set an appInfo's categories (IDs from list_app_categories, e.g. HEALTH_AND_FITNESS). Pass null to clear a secondary category.",
    {
      app_info_id: z.string().describe("appInfo ID (from get_app_info)"),
      primary_category: z.string().optional().describe("Primary category ID"),
      primary_subcategory_one: z.string().nullable().optional(),
      primary_subcategory_two: z.string().nullable().optional(),
      secondary_category: z.string().nullable().optional().describe("Secondary category ID"),
      secondary_subcategory_one: z.string().nullable().optional(),
      secondary_subcategory_two: z.string().nullable().optional(),
    },
    async (args) => {
      try {
        const res = await client.patch(`/appInfos/${encodeURIComponent(args.app_info_id)}`, {
          data: {
            type: "appInfos",
            id: args.app_info_id,
            relationships: defined({
              primaryCategory: categoryRef(args.primary_category),
              primarySubcategoryOne: categoryRef(args.primary_subcategory_one),
              primarySubcategoryTwo: categoryRef(args.primary_subcategory_two),
              secondaryCategory: categoryRef(args.secondary_category),
              secondarySubcategoryOne: categoryRef(args.secondary_subcategory_one),
              secondarySubcategoryTwo: categoryRef(args.secondary_subcategory_two),
            }),
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_app_info_localization",
    "Writes. Set the per-locale App Information fields (name, subtitle, privacy policy / privacy choices URL) of an appInfo. Creates the locale if it does not exist yet.",
    {
      app_info_id: z.string().describe("appInfo ID (from get_app_info)"),
      locale: z.string().describe("Locale, e.g. 'en-US' or 'de-DE'"),
      name: z.string().max(30).optional().describe("App name (max 30 chars)"),
      subtitle: z.string().max(30).optional().describe("Subtitle (max 30 chars)"),
      privacy_policy_url: z.string().optional(),
      privacy_choices_url: z.string().optional(),
    },
    async ({ app_info_id, locale, name, subtitle, privacy_policy_url, privacy_choices_url }) => {
      try {
        const attributes = defined({
          name,
          subtitle,
          privacyPolicyUrl: privacy_policy_url,
          privacyChoicesUrl: privacy_choices_url,
        });
        const { data } = await client.getAll(
          `/appInfos/${encodeURIComponent(app_info_id)}/appInfoLocalizations`,
          { "fields[appInfoLocalizations]": "locale", limit: 200 },
        );
        const existing = data.find((l) => l.attributes?.locale === locale);
        const res = existing
          ? await client.patch(`/appInfoLocalizations/${encodeURIComponent(existing.id)}`, {
              data: { type: "appInfoLocalizations", id: existing.id, attributes },
            })
          : await client.post("/appInfoLocalizations", {
              data: {
                type: "appInfoLocalizations",
                attributes: { locale, ...attributes },
                relationships: { appInfo: { data: { type: "appInfos", id: app_info_id } } },
              },
            });
        return ok({ created: !existing, ...flattenResource(res.data as JsonApiResource) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_age_rating_declaration",
    "Writes. Answer the age rating questionnaire. Attributes are passed through to Apple as-is, e.g. { violenceCartoonOrFantasy: 'NONE', gambling: false, unrestrictedWebAccess: false, ... } — read the current declaration with get_app_info to see the attribute names Apple expects.",
    {
      declaration_id: z.string().describe("ageRatingDeclaration ID (from get_app_info)"),
      attributes: z.record(z.string(), z.unknown()).describe("Questionnaire answers to set"),
    },
    async ({ declaration_id, attributes }) => {
      try {
        const res = await client.patch(
          `/ageRatingDeclarations/${encodeURIComponent(declaration_id)}`,
          { data: { type: "ageRatingDeclarations", id: declaration_id, attributes } },
        );
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_app_store_version",
    "Writes. Update an App Store version that is still editable: version string, copyright, and release type (MANUAL, AFTER_APPROVAL, SCHEDULED with earliest_release_date).",
    {
      version_id: z.string().describe("App Store version ID (from list_app_store_versions)"),
      version_string: z.string().optional().describe("Version, e.g. '1.50.0'"),
      copyright: z.string().optional().describe("e.g. '2026 Jane Doe'"),
      release_type: z.enum(["MANUAL", "AFTER_APPROVAL", "SCHEDULED"]).optional(),
      earliest_release_date: z
        .string()
        .optional()
        .describe("ISO 8601 date-time, required for SCHEDULED"),
    },
    async ({ version_id, version_string, copyright, release_type, earliest_release_date }) => {
      try {
        const res = await client.patch(`/appStoreVersions/${encodeURIComponent(version_id)}`, {
          data: {
            type: "appStoreVersions",
            id: version_id,
            attributes: defined({
              versionString: version_string,
              copyright,
              releaseType: release_type,
              earliestReleaseDate: earliest_release_date,
            }),
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_app_store_version_localization",
    "Writes. Set the per-locale product page text of an App Store version: description, keywords, promotional text, what's new, support and marketing URL. Creates the locale if it does not exist yet.",
    {
      version_id: z.string().describe("App Store version ID (from list_app_store_versions)"),
      locale: z.string().describe("Locale, e.g. 'en-US' or 'de-DE'"),
      description: z.string().max(4000).optional(),
      keywords: z.string().max(100).optional().describe("Comma-separated, max 100 chars"),
      promotional_text: z.string().max(170).optional(),
      whats_new: z.string().max(4000).optional().describe("Not allowed on an app's first version"),
      support_url: z.string().optional(),
      marketing_url: z.string().optional(),
    },
    async (args) => {
      try {
        const attributes = defined({
          description: args.description,
          keywords: args.keywords,
          promotionalText: args.promotional_text,
          whatsNew: args.whats_new,
          supportUrl: args.support_url,
          marketingUrl: args.marketing_url,
        });
        const params: QueryParams = {
          "filter[appStoreVersion]": args.version_id,
          "fields[appStoreVersionLocalizations]": "locale",
          limit: 200,
        };
        const { data } = await client.getAll("/appStoreVersionLocalizations", params);
        const existing = data.find((l) => l.attributes?.locale === args.locale);
        const res = existing
          ? await client.patch(`/appStoreVersionLocalizations/${encodeURIComponent(existing.id)}`, {
              data: { type: "appStoreVersionLocalizations", id: existing.id, attributes },
            })
          : await client.post("/appStoreVersionLocalizations", {
              data: {
                type: "appStoreVersionLocalizations",
                attributes: { locale: args.locale, ...attributes },
                relationships: {
                  appStoreVersion: { data: { type: "appStoreVersions", id: args.version_id } },
                },
              },
            });
        const out = flattenResource(res.data as JsonApiResource) as Record<string, unknown>;
        return ok({
          created: !existing,
          ...Object.fromEntries(
            Object.entries(out).filter(([k]) =>
              ["id", "type", ...VERSION_LOCALIZATION_FIELDS.split(",")].includes(k),
            ),
          ),
        });
      } catch (e) {
        return err(e);
      }
    },
  );
}
