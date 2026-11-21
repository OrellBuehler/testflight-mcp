import { openAsBlob } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource } from "../asc/client.js";
import { ok, err, flattenResource } from "../asc/format.js";
import { hashFile, readBytes, resolveUploadFile } from "../asc/files.js";
import { encodeS3Key, signRequest } from "../asc/sigv4.js";
import { CREATE, READ_ONLY } from "./shared.js";

export const NOTARY_URL = "https://appstoreconnect.apple.com/notary/v2/submissions";
const DEFAULT_REGION = "us-west-2";
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const UPLOAD_RULE = {
  tool: "submit_for_notarization",
  what: "software to notarize",
  kinds: ".zip/.dmg/.pkg",
  extensions: [".zip", ".dmg", ".pkg"],
  maxBytes: 5 * 1024 * 1024 * 1024,
};
const SUBMISSION_ID = z
  .string()
  .uuid()
  .describe("Notarization submission ID (from submit_for_notarization)");

async function checkFormat(path: string, real: string, extension: string, size: number) {
  if (extension === ".dmg") {
    const trailer = size >= 512 ? await readBytes(real, size - 512, 4) : Buffer.alloc(0);
    if (trailer.toString("latin1") !== "koly") throw new Error(`${path} is not a disk image`);
    return;
  }
  const magic = extension === ".zip" ? "PK\x03\x04" : "xar!";
  const head = await readBytes(real, 0, 4);
  if (head.toString("latin1") !== magic) {
    throw new Error(
      `${path} is not ${extension === ".zip" ? "a zip archive" : "a .pkg installer"}`,
    );
  }
}

async function bucketRegion(bucket: string, timeoutMs: number) {
  try {
    const res = await fetch(`https://${bucket}.s3.amazonaws.com/`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.headers.get("x-amz-bucket-region") || DEFAULT_REGION;
  } catch {
    return DEFAULT_REGION;
  }
}

export function registerNotaryTools(
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites = false,
  uploadDir?: string,
) {
  server.tool(
    "list_notarization_submissions",
    "List the team's most recent macOS notarization submissions (up to 100) with their name, creation date and status (Accepted, In Progress, Invalid, Rejected). Notarization is for Mac software distributed outside the App Store with a Developer ID certificate.",
    {},
    READ_ONLY,
    async () => {
      try {
        const res = (await client.getJson(NOTARY_URL)) as { data?: JsonApiResource[] };
        const submissions = (res.data ?? []).map((d) => flattenResource(d));
        return ok({ count: submissions.length, submissions });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_notarization_submission",
    "Get the status of one macOS notarization submission: Accepted, In Progress, Invalid or Rejected. Poll it after submit_for_notarization; once it is no longer In Progress read get_notarization_log, also when it was accepted.",
    { submission_id: SUBMISSION_ID },
    READ_ONLY,
    async ({ submission_id }) => {
      try {
        const res = (await client.getJson(
          `${NOTARY_URL}/${encodeURIComponent(submission_id)}`,
        )) as {
          data: JsonApiResource;
        };
        return ok(flattenResource(res.data));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_notarization_log",
    "Get the notary service's log for a finished macOS notarization submission: the overall status and every issue it found (unsigned or wrongly signed binaries, missing hardened runtime, missing secure timestamp, ...) with the path inside the upload and the architecture. Read it even when notarization succeeded, because it can contain warnings. Not available while the submission is still In Progress.",
    { submission_id: SUBMISSION_ID },
    READ_ONLY,
    async ({ submission_id }) => {
      try {
        const res = (await client.getJson(
          `${NOTARY_URL}/${encodeURIComponent(submission_id)}/logs`,
        )) as { data: { attributes?: { developerLogUrl?: string } } };
        const url = res.data.attributes?.developerLogUrl;
        if (!url) throw new Error("The notary service returned no log URL for this submission");
        const text = await client.downloadText(url);
        try {
          return ok(JSON.parse(text));
        } catch {
          return ok(text);
        }
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowWrites) return;

  server.tool(
    "submit_for_notarization",
    "Writes. Submit Mac software to Apple's notary service without notarytool: a .zip, .dmg or flat .pkg that is already signed with a Developer ID certificate, hardened runtime and a secure timestamp. The file must be inside the directory set in ASC_UPLOAD_DIR (max 5 GB). It is uploaded to the storage location Apple hands out for this submission. The call returns once the upload is done; notarization itself usually takes a few minutes, so poll get_notarization_submission and then read get_notarization_log. A submission cannot be withdrawn. Stapling the ticket to the software still needs `xcrun stapler staple` on a Mac; without it Gatekeeper checks the ticket online.",
    {
      file_path: z
        .string()
        .describe("Path of the .zip/.dmg/.pkg inside ASC_UPLOAD_DIR (absolute, or relative to it)"),
    },
    CREATE,
    async ({ file_path }) => {
      try {
        const file = await resolveUploadFile(uploadDir, file_path, UPLOAD_RULE);
        await checkFormat(file_path, file.real, file.extension, file.size);
        const sha256 = await hashFile(file.real);
        const created = await client.post(NOTARY_URL, { submissionName: file.name, sha256 });
        const submission = created.data as JsonApiResource;
        const target = (submission.attributes ?? {}) as Record<string, string | undefined>;
        if (
          !target.bucket ||
          !target.object ||
          !target.awsAccessKeyId ||
          !target.awsSecretAccessKey
        ) {
          throw new Error("The notary service returned no upload location");
        }
        try {
          const region = await bucketRegion(target.bucket, client.timeoutMs);
          const url = `https://${target.bucket}.s3.${region}.amazonaws.com/${encodeS3Key(target.object)}`;
          const headers = signRequest({
            method: "PUT",
            url,
            payloadHash: sha256,
            credentials: {
              accessKeyId: target.awsAccessKeyId,
              secretAccessKey: target.awsSecretAccessKey,
              sessionToken: target.awsSessionToken,
            },
            region,
          });
          await client.uploadPart(
            url,
            "PUT",
            headers,
            await openAsBlob(file.real),
            UPLOAD_TIMEOUT_MS,
          );
        } catch (e) {
          throw new Error(
            `Submission ${submission.id} was created but the upload failed: ${e instanceof Error ? e.message : String(e)}. It stays In Progress without a file; submit again.`,
            { cause: e },
          );
        }
        return ok({
          id: submission.id,
          name: file.name,
          sha256,
          fileSize: file.size,
          status: "In Progress",
        });
      } catch (e) {
        return err(e);
      }
    },
  );
}
