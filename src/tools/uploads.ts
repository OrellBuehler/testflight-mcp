import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource, QueryParams } from "../asc/client.js";
import { ok, err, flattenResource, shapeResource } from "../asc/format.js";
import { hashFile, readBytes, resolveUploadFile } from "../asc/files.js";
import { CREATE, READ_ONLY } from "./shared.js";

const PLATFORM = z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]);
const UPLOAD_FIELDS =
  "cfBundleShortVersionString,cfBundleVersion,createdDate,state,platform,uploadedDate,build";
const BUILD_FIELDS = "version,uploadedDate,processingState,expired";
const FILE_FIELDS = "assetDeliveryState,assetType,fileName,fileSize,sourceFileChecksums,uti";
const PART_TIMEOUT_MS = 10 * 60 * 1000;
const UPLOAD_RULE = {
  tool: "upload_build",
  what: "builds",
  kinds: ".ipa/.pkg",
  extensions: [".ipa", ".pkg"],
  maxBytes: 4 * 1024 * 1024 * 1024,
};
const FORMATS: Record<string, { uti: string; magic: Buffer; label: string }> = {
  ".ipa": {
    uti: "com.apple.ipa",
    magic: Buffer.from("PK\x03\x04", "latin1"),
    label: "an .ipa (zip) archive",
  },
  ".pkg": { uti: "com.apple.pkg", magic: Buffer.from("xar!", "latin1"), label: "a .pkg installer" },
};

type UploadOperation = {
  method: string;
  url: string;
  length: number;
  offset: number;
  requestHeaders?: { name: string; value: string }[];
};

function shapeFile(file: JsonApiResource) {
  const { uploadOperations: _operations, ...rest } = flattenResource(file) as Record<
    string,
    unknown
  >;
  return rest;
}

export function registerBuildUploadTools(
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites = false,
  uploadDir?: string,
) {
  server.tool(
    "list_build_uploads",
    "List the build uploads of an app, newest first: every binary that was sent to App Store Connect (through this server, Xcode or Transporter) with its version, build number, platform and upload state (AWAITING_UPLOAD, PROCESSING, FAILED, COMPLETE) including Apple's errors and warnings, plus the resulting build once processing finished. Use it to find out why an upload never showed up in list_builds.",
    {
      app_id: z.string().describe("App Store Connect app ID (from list_apps)"),
      platform: PLATFORM.optional().describe("Filter by platform"),
      state: z
        .enum(["AWAITING_UPLOAD", "PROCESSING", "FAILED", "COMPLETE"])
        .optional()
        .describe("Filter by upload state"),
      version: z.string().optional().describe("Filter by version (CFBundleShortVersionString)"),
      build_number: z.string().optional().describe("Filter by build number (CFBundleVersion)"),
      limit: z.number().int().min(1).max(200).optional().describe("Max uploads (default: 20)"),
    },
    READ_ONLY,
    async ({ app_id, platform, state, version, build_number, limit }) => {
      try {
        const params: QueryParams = {
          include: "build",
          "fields[buildUploads]": UPLOAD_FIELDS,
          "fields[builds]": BUILD_FIELDS,
          sort: "-uploadedDate",
          limit: limit ?? 20,
        };
        if (platform) params["filter[platform]"] = platform;
        if (state) params["filter[state]"] = state;
        if (version) params["filter[cfBundleShortVersionString]"] = version;
        if (build_number) params["filter[cfBundleVersion]"] = build_number;
        const res = await client.get(`/apps/${encodeURIComponent(app_id)}/buildUploads`, params);
        const uploads = (res.data as JsonApiResource[]).map((d) =>
          shapeResource(d, res.included ?? [], { relationships: ["build"] }),
        );
        return ok({ count: uploads.length, uploads });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_build_upload",
    "Get one build upload by ID: its state with Apple's errors, warnings and infos, the uploaded files with their delivery state, and the resulting build once processing finished. Poll this after upload_build until the state is COMPLETE or FAILED.",
    { upload_id: z.string().describe("Build upload ID (from upload_build or list_build_uploads)") },
    READ_ONLY,
    async ({ upload_id }) => {
      try {
        const id = encodeURIComponent(upload_id);
        const [upload, files] = await Promise.all([
          client.get(`/buildUploads/${id}`, {
            include: "build",
            "fields[buildUploads]": UPLOAD_FIELDS,
            "fields[builds]": BUILD_FIELDS,
          }),
          client.getAll(`/buildUploads/${id}/buildUploadFiles`, {
            "fields[buildUploadFiles]": FILE_FIELDS,
          }),
        ]);
        return ok({
          ...shapeResource(upload.data as JsonApiResource, upload.included ?? [], {
            relationships: ["build"],
          }),
          files: files.data.map(shapeFile),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowWrites) return;

  server.tool(
    "upload_build",
    "Writes. Upload a signed .ipa (iOS, tvOS, visionOS) or .pkg (macOS) to App Store Connect without Xcode or Transporter. The file must be inside the directory set in ASC_UPLOAD_DIR (max 4 GB) and be exported for App Store distribution. version and build_number must match CFBundleShortVersionString and CFBundleVersion in the binary's Info.plist, and the build number must be new for that version. If the transfer fails the upload record is deleted again. The call returns once the file is delivered; Apple then processes it asynchronously, so poll get_build_upload until the state is COMPLETE or FAILED and then find the build with list_builds. App ids come from list_apps.",
    {
      app_id: z.string().describe("App Store Connect app ID (from list_apps)"),
      file_path: z
        .string()
        .describe("Path of the .ipa/.pkg inside ASC_UPLOAD_DIR (absolute, or relative to it)"),
      version: z.string().describe("CFBundleShortVersionString of the binary, e.g. '1.2.0'"),
      build_number: z.string().describe("CFBundleVersion of the binary, e.g. '42'"),
      platform: PLATFORM.describe("Platform of the binary"),
    },
    CREATE,
    async ({ app_id, file_path, version, build_number, platform }) => {
      try {
        const file = await resolveUploadFile(uploadDir, file_path, UPLOAD_RULE);
        const format = FORMATS[file.extension];
        const head = await readBytes(file.real, 0, format.magic.length);
        if (!head.equals(format.magic)) throw new Error(`${file_path} is not ${format.label}`);
        const checksum = await hashFile(file.real, "md5");

        const created = await client.post("/buildUploads", {
          data: {
            type: "buildUploads",
            attributes: {
              cfBundleShortVersionString: version,
              cfBundleVersion: build_number,
              platform,
            },
            relationships: { app: { data: { type: "apps", id: app_id } } },
          },
        });
        const uploadId = (created.data as JsonApiResource).id;
        const uploadPath = `/buildUploads/${encodeURIComponent(uploadId)}`;
        try {
          const reservation = await client.post("/buildUploadFiles", {
            data: {
              type: "buildUploadFiles",
              attributes: {
                assetType: "ASSET",
                fileName: file.name,
                fileSize: file.size,
                uti: format.uti,
              },
              relationships: { buildUpload: { data: { type: "buildUploads", id: uploadId } } },
            },
          });
          const reserved = reservation.data as JsonApiResource;
          const operations = (reserved.attributes?.uploadOperations ?? []) as UploadOperation[];
          if (operations.length === 0) {
            throw new Error("App Store Connect returned no upload operations for the file");
          }
          for (const op of operations) {
            const part = await readBytes(file.real, op.offset, op.length);
            if (part.length !== op.length) {
              throw new Error(`${file_path} changed while it was being uploaded`);
            }
            await client.uploadPart(
              op.url,
              op.method,
              Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value])),
              part,
              PART_TIMEOUT_MS,
            );
          }
          const committed = await client.patch(
            `/buildUploadFiles/${encodeURIComponent(reserved.id)}`,
            {
              data: {
                type: "buildUploadFiles",
                id: reserved.id,
                attributes: {
                  uploaded: true,
                  sourceFileChecksums: { file: { hash: checksum, algorithm: "MD5" } },
                },
              },
            },
          );
          const delivered = shapeFile(committed.data as JsonApiResource);
          const delivery = delivered.assetDeliveryState as { state?: string } | undefined;
          if (delivery?.state === "FAILED") {
            throw new Error(`App Store Connect rejected the file: ${JSON.stringify(delivery)}`);
          }
          const upload = await client.get(uploadPath, { "fields[buildUploads]": UPLOAD_FIELDS });
          return ok({ ...flattenResource(upload.data as JsonApiResource), file: delivered });
        } catch (e) {
          const removed = await client.delete(uploadPath).then(
            () => true,
            () => false,
          );
          throw new Error(
            `Upload failed: ${e instanceof Error ? e.message : String(e)}. ` +
              (removed
                ? `The upload record ${uploadId} was deleted.`
                : `The upload record ${uploadId} could not be deleted.`),
            { cause: e },
          );
        }
      } catch (e) {
        return err(e);
      }
    },
  );
}
