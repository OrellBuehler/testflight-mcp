import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource } from "../asc/client.js";
import { ok, err, flattenResource, manyRefs, findIncluded } from "../asc/format.js";
import { DESTRUCTIVE, READ_ONLY } from "./shared.js";

const SCREENSHOT_FIELDS = "fileName,fileSize,assetDeliveryState,sourceFileChecksum";
const MAX_SET_SIZE = 10;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg"];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

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

function isImageExtension(path: string) {
  return IMAGE_EXTENSIONS.includes(extname(path).toLowerCase());
}

async function loadFiles(uploadDir: string | undefined, paths: string[]) {
  if (!uploadDir) {
    throw new Error(
      "upload_app_screenshots is disabled because ASC_UPLOAD_DIR is not set. Set ASC_UPLOAD_DIR to the directory that holds the screenshots; only PNG/JPEG files inside it can be uploaded.",
    );
  }
  const base = await realpath(uploadDir);
  const files = [];
  for (const path of paths) {
    if (!isImageExtension(path)) {
      throw new Error(`${path}: only .png, .jpg and .jpeg files can be uploaded`);
    }
    const real = await realpath(resolve(base, path));
    const rel = relative(base, real);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`${path} is outside ASC_UPLOAD_DIR`);
    }
    if (!isImageExtension(real)) {
      throw new Error(`${path}: only .png, .jpg and .jpeg files can be uploaded`);
    }
    const info = await stat(real);
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`${path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    }
    const bytes = await readFile(real);
    if (bytes.length > MAX_FILE_BYTES) {
      throw new Error(`${path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    }
    const isImage =
      bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ||
      bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC);
    if (!isImage) throw new Error(`${path} is not a PNG or JPEG image`);
    files.push({ name: basename(path), bytes });
  }
  return files;
}

async function deleteScreenshots(client: AppStoreConnectClient, ids: string[]) {
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await client.delete(`/appScreenshots/${encodeURIComponent(id)}`);
      deleted.push(id);
    } catch {
      failed.push(id);
    }
  }
  return { deleted, failed };
}

export function registerScreenshotTools(
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites = false,
  uploadDir?: string,
) {
  server.tool(
    "list_app_screenshot_sets",
    "List the App Store screenshot sets of an App Store version localization: one set per display type (e.g. APP_IPHONE_65, APP_IPAD_PRO_3GEN_129, APP_WATCH_ULTRA) with its screenshots in display order, including each screenshot's file name and assetDeliveryState (processing state).",
    {
      localization_id: z
        .string()
        .describe("App Store version localization ID (from list_app_store_version_localizations)"),
    },
    READ_ONLY,
    async ({ localization_id }) => {
      try {
        const sets = await listSets(client, localization_id);
        return ok({ count: sets.length, sets });
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowWrites) return;

  server.tool(
    "upload_app_screenshots",
    "Writes. Upload local PNG/JPEG files as App Store screenshots to one display type of an App Store version localization, in the given order. Files must be inside the directory set in ASC_UPLOAD_DIR (max 30 MB each). Creates the screenshot set if it does not exist. Without replace_existing the files are appended (a set holds at most 10). With replace_existing the new files are uploaded first and the set's previous screenshots are deleted only after every upload succeeded; if an upload fails, the partial uploads are removed and the previous screenshots stay. When old and new together exceed 10 the call fails without changing anything unless delete_first is set. Returns each uploaded screenshot with its assetDeliveryState and the IDs of deleted screenshots; Apple processes uploads asynchronously, so check again with list_app_screenshot_sets.",
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
        .max(MAX_SET_SIZE)
        .describe(
          "Paths of the .png/.jpg/.jpeg files inside ASC_UPLOAD_DIR (absolute, or relative to it), in display order",
        ),
      replace_existing: z
        .boolean()
        .optional()
        .describe(
          "Delete the set's previous screenshots once the new ones are uploaded (default: false)",
        ),
      delete_first: z
        .boolean()
        .optional()
        .describe(
          "Only with replace_existing, when old and new screenshots together exceed 10: delete just enough of the previous screenshots before uploading to make room. Those are lost if an upload then fails (default: false)",
        ),
    },
    DESTRUCTIVE,
    async ({ localization_id, display_type, file_paths, replace_existing, delete_first }) => {
      try {
        const files = await loadFiles(uploadDir, file_paths);
        const sets = await listSets(client, localization_id);
        let set: ScreenshotSet | undefined = sets.find(
          (s) => s?.screenshotDisplayType === display_type,
        );
        const previous = (set?.screenshots ?? []).map((shot) => String(shot?.id));
        const overflow = previous.length + files.length - MAX_SET_SIZE;
        if (overflow > 0 && !replace_existing) {
          throw new Error(
            `The ${display_type} set already has ${previous.length} screenshots; adding ${files.length} would exceed ${MAX_SET_SIZE}. Use replace_existing.`,
          );
        }
        if (overflow > 0 && !delete_first) {
          throw new Error(
            `The ${display_type} set has ${previous.length} screenshots and holds at most ${MAX_SET_SIZE}, so ${files.length} new ones cannot be uploaded before the previous ones are deleted. Nothing was changed. Pass delete_first: true to delete ${overflow} of the previous screenshots before uploading; those are lost if an upload then fails.`,
          );
        }
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

        const deleted: string[] = [];
        if (overflow > 0) {
          const first = await deleteScreenshots(client, previous.slice(-overflow));
          deleted.push(...first.deleted);
          if (first.failed.length > 0) {
            throw new Error(
              `Could not delete previous screenshots ${first.failed.join(", ")} to make room; nothing was uploaded. Deleted: ${deleted.join(", ") || "none"}.`,
            );
          }
        }

        const uploaded = [];
        const reserved: string[] = [];
        try {
          for (const { name, bytes } of files) {
            const reservation = await client.post("/appScreenshots", {
              data: {
                type: "appScreenshots",
                attributes: { fileName: name, fileSize: bytes.length },
                relationships: {
                  appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } },
                },
              },
            });
            const shot = reservation.data as JsonApiResource;
            reserved.push(shot.id);
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
            const state = result?.assetDeliveryState as { state?: string } | undefined;
            if (state?.state === "FAILED") {
              throw new Error(`App Store Connect rejected ${name}: ${JSON.stringify(state)}`);
            }
            uploaded.push({
              id: shot.id,
              fileName: result?.fileName,
              assetDeliveryState: result?.assetDeliveryState,
            });
          }
        } catch (e) {
          const cleanup = await deleteScreenshots(client, reserved);
          throw new Error(
            `Upload failed: ${e instanceof Error ? e.message : String(e)}. Removed ${cleanup.deleted.length} partial upload(s)` +
              (cleanup.failed.length > 0 ? `; could not remove ${cleanup.failed.join(", ")}` : "") +
              (deleted.length > 0
                ? `. Previous screenshots ${deleted.join(", ")} were already deleted (delete_first); the others were left intact.`
                : ". The previous screenshots were left intact."),
            { cause: e },
          );
        }

        if (replace_existing) {
          const rest = await deleteScreenshots(
            client,
            previous.filter((id) => !deleted.includes(id)),
          );
          deleted.push(...rest.deleted);
          if (rest.failed.length > 0) {
            throw new Error(
              `Uploaded ${uploaded.map((u) => u.id).join(", ")} but could not delete previous screenshots ${rest.failed.join(", ")}; they are still in the set.`,
            );
          }
        }
        return ok({ screenshotSetId: setId, displayType: display_type, uploaded, deleted });
      } catch (e) {
        return err(e);
      }
    },
  );
}
