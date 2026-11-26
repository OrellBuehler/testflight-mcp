import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource, QueryParams } from "../asc/client.js";
import { ok, err, flattenResource, singleRef, findIncluded } from "../asc/format.js";
import { IMAGE_EXTENSIONS, loadImages, type UploadOperation } from "./screenshots.js";
import { DESTRUCTIVE, READ_ONLY } from "./shared.js";

const PLACEMENT_FIELDS =
  "mediaType,placementType,placementGroup,createdDate,lastModifiedDate,state,stateDetails,image";
const IMAGE_FIELDS = "category,fileName,fileSize,referenceName,specId,state,stateDetails";
const PLACEMENT_TYPES = [
  "APP_SCREENSHOT",
  "IMESSAGE_APP_SCREENSHOT",
  "APP_PREVIEW",
  "PRODUCT_PAGE_HEADER_ASSET",
  "APP_STORE_SEARCH_RESULTS_ASSET",
  "SEARCH_RESULTS_ADS_ASSET",
  "TODAY_TAB_ADS_ASSET",
  "EVENT_CARD_ASSET",
  "EVENT_DETAILS_PAGE_ASSET",
  "RETENTION_MESSAGE_ASSET",
] as const;
const UPLOAD_PLACEMENT_TYPES = [
  "PRODUCT_PAGE_HEADER_ASSET",
  "APP_STORE_SEARCH_RESULTS_ASSET",
] as const;
const UPLOAD_RULE = {
  tool: "upload_app_store_asset",
  what: "images",
  kinds: "PNG/JPEG",
  extensions: IMAGE_EXTENSIONS,
  maxBytes: 50 * 1024 * 1024,
};

async function listPlacements(
  client: AppStoreConnectClient,
  localizationId: string,
  placementType?: string,
  placementGroup?: string,
): Promise<Record<string, unknown>[]> {
  const params: QueryParams = {
    include: "image",
    "fields[appAssetLibraryPlacements]": PLACEMENT_FIELDS,
    "fields[appAssetLibraryImages]": IMAGE_FIELDS,
    limit: 200,
  };
  if (placementType) params["filter[placementType]"] = placementType;
  if (placementGroup) params["filter[placementGroup]"] = placementGroup;
  const { data, included } = await client.getAll(
    `/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}/placements`,
    params,
  );
  return data.map((placement) => ({
    ...(flattenResource(placement) as Record<string, unknown>),
    image: flattenResource(findIncluded(included, singleRef(placement.relationships?.image))),
  }));
}

async function deletePlacements(client: AppStoreConnectClient, ids: string[]) {
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await client.delete(`/appAssetLibraryPlacements/${encodeURIComponent(id)}`);
      deleted.push(id);
    } catch {
      failed.push(id);
    }
  }
  return { deleted, failed };
}

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function registerAssetTools(
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites = false,
  uploadDir?: string,
) {
  server.tool(
    "list_app_store_asset_placements",
    "List the asset library placements of an App Store version localization: the images placed on the product page, such as the product page header (PRODUCT_PAGE_HEADER_ASSET) and the search results asset (APP_STORE_SEARCH_RESULTS_ASSET) from the 'Header and Search Results' tab, each with its state and the library image behind it. Optionally filter by placement type.",
    {
      localization_id: z
        .string()
        .describe("App Store version localization ID (from list_app_store_version_localizations)"),
      placement_type: z.enum(PLACEMENT_TYPES).optional().describe("Only this placement type"),
    },
    READ_ONLY,
    async ({ localization_id, placement_type }) => {
      try {
        const placements = await listPlacements(client, localization_id, placement_type);
        return ok({ count: placements.length, placements });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_app_asset_library_specs",
    "Get Apple's reference data for the App Store asset library: per placement type the accepted asset categories and placement groups, and the image specs (pixel dimensions, aspect ratio, file extensions, max file size, whether alpha is allowed). Use it to check what a header or search results image must look like, and which placement_group to pass, before upload_app_store_asset. Defaults to the product page header and search results asset.",
    {
      placement_types: z
        .array(z.enum(PLACEMENT_TYPES))
        .optional()
        .describe(
          "Placement types to look up (default: PRODUCT_PAGE_HEADER_ASSET and APP_STORE_SEARCH_RESULTS_ASSET)",
        ),
    },
    READ_ONLY,
    async ({ placement_types }) => {
      try {
        const types: readonly string[] = placement_types ?? UPLOAD_PLACEMENT_TYPES;
        const { data } = await client.getAll("/appAssetLibraryRefData", {
          "filter[placementTypes]": types.join(","),
          "fields[appAssetLibraryRefData]": "placementTypes,imageSpecs,placementProfileGroups",
        });
        return ok({ placementTypes: types, referenceData: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowWrites) return;

  server.tool(
    "upload_app_store_asset",
    "Writes. Upload a local PNG/JPEG file as the product page header (PRODUCT_PAGE_HEADER_ASSET) or the search results asset (APP_STORE_SEARCH_RESULTS_ASSET) of an App Store version localization, the two images of the 'Header and Search Results' tab. The file must be inside the directory set in ASC_UPLOAD_DIR. It is added to the app's asset library and then placed on the localization. If the localization already has an asset of that type the call fails without changing anything unless replace_existing is set; then the new image is uploaded and placed first and the previous placement is removed afterwards (when Apple only accepts one placement at a time, the previous one is removed right before the new one is placed). Removed placements keep their image in the asset library. Required dimensions and placement groups are in get_app_asset_library_specs. Apple processes uploads asynchronously, so check the state with list_app_store_asset_placements. Nothing is submitted for review.",
    {
      app_id: z.string().describe("App Store Connect app ID (owner of the asset library)"),
      localization_id: z
        .string()
        .describe("App Store version localization ID (from list_app_store_version_localizations)"),
      placement_type: z.enum(UPLOAD_PLACEMENT_TYPES).describe("Which asset to set"),
      file_path: z
        .string()
        .describe(
          "Path of the .png/.jpg/.jpeg file inside ASC_UPLOAD_DIR (absolute, or relative to it)",
        ),
      placement_group: z
        .string()
        .optional()
        .describe(
          "Placement group, if the placement type needs one (see get_app_asset_library_specs)",
        ),
      reference_name: z.string().optional().describe("Name of the image in the asset library"),
      replace_existing: z
        .boolean()
        .optional()
        .describe(
          "Remove the previous placement of this type once the new one is placed (default: false)",
        ),
    },
    DESTRUCTIVE,
    async (args) => {
      try {
        const [{ name, bytes }] = await loadImages(uploadDir, [args.file_path], UPLOAD_RULE);
        const existing = await listPlacements(
          client,
          args.localization_id,
          args.placement_type,
          args.placement_group,
        );
        const previous = existing.map((p) => String(p.id));
        if (previous.length > 0 && !args.replace_existing) {
          throw new Error(
            `The localization already has a ${args.placement_type} placement (${previous.join(", ")}). Nothing was changed. Pass replace_existing: true to replace it.`,
          );
        }
        const library = await client.get(`/apps/${encodeURIComponent(args.app_id)}/assetLibrary`);
        const libraryId = (library.data as JsonApiResource).id;

        const reservation = await client.post("/appAssetLibraryImages", {
          data: {
            type: "appAssetLibraryImages",
            attributes: {
              category: "CREATIVE_ASSETS",
              fileName: name,
              fileSize: bytes.length,
              ...(args.reference_name ? { referenceName: args.reference_name } : {}),
            },
            relationships: {
              assetLibrary: { data: { type: "appAssetLibraries", id: libraryId } },
            },
          },
        });
        const image = reservation.data as JsonApiResource;
        const imagePath = `/appAssetLibraryImages/${encodeURIComponent(image.id)}`;
        const place = () =>
          client.post("/appAssetLibraryPlacements", {
            data: {
              type: "appAssetLibraryPlacements",
              attributes: {
                placementType: args.placement_type,
                ...(args.placement_group ? { placementGroup: args.placement_group } : {}),
              },
              relationships: {
                image: { data: { type: "appAssetLibraryImages", id: image.id } },
                appStoreVersionLocalization: {
                  data: { type: "appStoreVersionLocalizations", id: args.localization_id },
                },
              },
            },
          });

        const deleted: string[] = [];
        let committed: Record<string, unknown> | null;
        let placement: JsonApiResource;
        try {
          const operations = (image.attributes?.uploadOperations ?? []) as UploadOperation[];
          for (const op of operations) {
            const headers = Object.fromEntries(
              (op.requestHeaders ?? []).map((h) => [h.name, h.value]),
            );
            await client.uploadPart(
              op.url,
              op.method,
              headers,
              bytes.subarray(op.offset, op.offset + op.length),
            );
          }
          const patched = await client.patch(imagePath, {
            data: { type: "appAssetLibraryImages", id: image.id, attributes: { uploaded: true } },
          });
          committed = flattenResource(patched.data as JsonApiResource);
          if (committed?.state === "FAILED") {
            throw new Error(
              `App Store Connect rejected ${name}: ${JSON.stringify(committed.stateDetails ?? [])}`,
            );
          }
          try {
            placement = (await place()).data as JsonApiResource;
          } catch (first) {
            if (previous.length === 0) throw first;
            const removed = await deletePlacements(client, previous);
            deleted.push(...removed.deleted);
            if (removed.failed.length > 0) {
              throw new Error(
                `${message(first)}. Could not remove previous placements ${removed.failed.join(", ")} to make room`,
                { cause: first },
              );
            }
            placement = (await place()).data as JsonApiResource;
          }
        } catch (e) {
          const cleaned = await client.delete(imagePath).then(
            () => true,
            () => false,
          );
          throw new Error(
            `Upload failed: ${message(e)}. ` +
              (cleaned
                ? "The new image was removed from the asset library"
                : `Could not remove the new image ${image.id} from the asset library`) +
              (deleted.length > 0
                ? `. Previous placements ${deleted.join(", ")} were already removed; their images are still in the asset library.`
                : ". The previous placement was left intact."),
            { cause: e },
          );
        }

        const rest = await deletePlacements(
          client,
          previous.filter((id) => !deleted.includes(id)),
        );
        deleted.push(...rest.deleted);
        if (rest.failed.length > 0) {
          throw new Error(
            `Placed ${placement.id} but could not remove previous placements ${rest.failed.join(", ")}; they are still on the localization.`,
          );
        }
        return ok({
          placement: flattenResource(placement),
          image: {
            id: image.id,
            fileName: committed?.fileName,
            specId: committed?.specId,
            state: committed?.state,
            stateDetails: committed?.stateDetails,
          },
          deleted,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_app_store_asset_placement",
    "Writes, destructive. Remove an asset library placement from its App Store version localization, for example the product page header or the search results asset. The image stays in the app's asset library. Placement ids come from list_app_store_asset_placements.",
    {
      placement_id: z.string().describe("Placement ID (from list_app_store_asset_placements)"),
    },
    DESTRUCTIVE,
    async ({ placement_id }) => {
      try {
        await client.delete(`/appAssetLibraryPlacements/${encodeURIComponent(placement_id)}`);
        return ok({ deleted: true, placementId: placement_id });
      } catch (e) {
        return err(e);
      }
    },
  );
}
