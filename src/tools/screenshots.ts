import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource } from "../asc/client.js";
import { ok, err, flattenResource, manyRefs, findIncluded } from "../asc/format.js";

const SCREENSHOT_FIELDS = "fileName,fileSize,assetDeliveryState,sourceFileChecksum";

type ScreenshotSet = Record<string, unknown> & { screenshots: (Record<string, unknown> | null)[] };

type UploadOperation = {
  method: string;
  url: string;
  length: number;
  offset: number;
  requestHeaders?: { name: string; value: string }[];
};

async function listSets(
  client: AppStoreConnectClient,
  localizationId: string,
): Promise<ScreenshotSet[]> {
  const { data, included } = await client.getAll(
    `/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}/appScreenshotSets`,
    {
      include: "appScreenshots",
      "fields[appScreenshots]": SCREENSHOT_FIELDS,
      limit: 50,
    },
  );
  return data.map((set) => ({
    ...(flattenResource(set) as Record<string, unknown>),
    screenshots: manyRefs(set.relationships?.appScreenshots)
      .map((ref) => findIncluded(included, ref))
      .filter((s): s is JsonApiResource => s !== null)
      .map((s) => flattenResource(s)),
  }));
}

export function registerScreenshotTools(server: McpServer, client: AppStoreConnectClient) {
  server.tool(
    "list_app_screenshot_sets",
    "List the App Store screenshot sets of an App Store version localization: one set per display type (e.g. APP_IPHONE_65, APP_IPAD_PRO_3GEN_129, APP_WATCH_ULTRA) with its screenshots in display order, including each screenshot's file name and assetDeliveryState (processing state).",
    {
      localization_id: z
        .string()
        .describe("App Store version localization ID (from list_app_store_version_localizations)"),
    },
    async ({ localization_id }) => {
      try {
        const sets = await listSets(client, localization_id);
        return ok({ count: sets.length, sets });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "upload_app_screenshots",
    "Upload local PNG/JPEG files as App Store screenshots to one display type of an App Store version localization, in the given order. Creates the screenshot set if it does not exist. With replace_existing, the set's current screenshots are deleted first; otherwise the files are appended (a set holds at most 10). Returns each uploaded screenshot with its assetDeliveryState; Apple processes them asynchronously, so check again with list_app_screenshot_sets.",
    {
      localization_id: z
        .string()
        .describe("App Store version localization ID (from list_app_store_version_localizations)"),
      display_type: z
        .string()
        .describe(
          "Screenshot display type, e.g. APP_IPHONE_67, APP_IPHONE_65, APP_IPAD_PRO_3GEN_129, APP_WATCH_ULTRA",
        ),
      file_paths: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe("Absolute paths of the image files, in display order"),
      replace_existing: z
        .boolean()
        .optional()
        .describe("Delete the set's existing screenshots before uploading (default: false)"),
    },
    async ({ localization_id, display_type, file_paths, replace_existing }) => {
      try {
        const files = await Promise.all(
          file_paths.map(async (path) => ({ path, bytes: await readFile(path) })),
        );
        const sets = await listSets(client, localization_id);
        let set: ScreenshotSet | undefined = sets.find(
          (s) => s?.screenshotDisplayType === display_type,
        );
        if (!set) {
          const created = await client.post("/appScreenshotSets", {
            data: {
              type: "appScreenshotSets",
              attributes: { screenshotDisplayType: display_type },
              relationships: {
                appStoreVersionLocalization: {
                  data: { type: "appStoreVersionLocalizations", id: localization_id },
                },
              },
            },
          });
          set = {
            ...(flattenResource(created.data as JsonApiResource) as Record<string, unknown>),
            screenshots: [],
          };
        }
        const setId = String(set.id);

        let existing = set.screenshots.length;
        if (replace_existing) {
          for (const shot of set.screenshots) {
            await client.delete(`/appScreenshots/${encodeURIComponent(String(shot?.id))}`);
          }
          existing = 0;
        }
        if (existing + files.length > 10) {
          throw new Error(
            `The ${display_type} set already has ${existing} screenshots; adding ${files.length} would exceed 10. Use replace_existing.`,
          );
        }

        const uploaded = [];
        for (const { path, bytes } of files) {
          const reservation = await client.post("/appScreenshots", {
            data: {
              type: "appScreenshots",
              attributes: { fileName: basename(path), fileSize: bytes.length },
              relationships: {
                appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } },
              },
            },
          });
          const shot = reservation.data as JsonApiResource;
          const operations = (shot.attributes?.uploadOperations ?? []) as UploadOperation[];
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
          const committed = await client.patch(`/appScreenshots/${encodeURIComponent(shot.id)}`, {
            data: {
              type: "appScreenshots",
              id: shot.id,
              attributes: {
                uploaded: true,
                sourceFileChecksum: createHash("md5").update(bytes).digest("hex"),
              },
            },
          });
          const result = flattenResource(committed.data as JsonApiResource);
          uploaded.push({
            id: shot.id,
            fileName: result?.fileName,
            assetDeliveryState: result?.assetDeliveryState,
          });
        }
        return ok({ screenshotSetId: setId, displayType: display_type, uploaded });
      } catch (e) {
        return err(e);
      }
    },
  );
}
