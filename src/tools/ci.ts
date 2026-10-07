import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, QueryParams } from "../asc/client.js";
import { ok, err, shapeResource, flattenResource } from "../asc/format.js";
import { retrieveCiLog } from "../ci/log_bundle.js";

const PRODUCT_FIELDS = "name,createdDate,productType";
const BUILD_RUN_FIELDS =
  "number,createdDate,startedDate,finishedDate,sourceCommit,destinationCommit,isPullRequestBuild,issueCounts,executionProgress,completionStatus,startReason,cancelReason";
const BUILD_RUN_RELATIONSHIPS = "workflow,sourceBranchOrTag,pullRequest";
const ACTION_FIELDS =
  "name,actionType,startedDate,finishedDate,issueCounts,executionProgress,completionStatus,isRequiredToPass";
const ISSUE_FIELDS = "issueType,message,fileSource,category";
const ARTIFACT_FIELDS = "fileType,fileName,fileSize";

export function registerCiTools(
  server: McpServer,
  client: AppStoreConnectClient,
  options: { artifactRoot?: string; timeoutMs?: number; fetcher?: typeof fetch } = {},
) {
  server.tool(
    "list_ci_products",
    "List the Xcode Cloud products in the account (name, product type, created date, related app). Use the returned id as product_id for list_ci_build_runs.",
    {
      app_id: z.string().optional().describe("Filter by App Store Connect app ID"),
      product_type: z.enum(["APP", "FRAMEWORK"]).optional().describe("Filter by product type"),
      limit: z.number().int().min(1).max(200).optional().describe("Max products (default: 100)"),
    },
    async ({ app_id, product_type, limit }) => {
      try {
        const params: QueryParams = {
          include: "app",
          "fields[ciProducts]": `${PRODUCT_FIELDS},app`,
          "fields[apps]": "name,bundleId",
          limit: limit ?? 100,
        };
        if (app_id) params["filter[app]"] = app_id;
        if (product_type) params["filter[productType]"] = product_type;
        const { data, included } = await client.getAll("/ciProducts", params);
        const products = data.map((d) => shapeResource(d, included, { relationships: ["app"] }));
        return ok({ count: products.length, products });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_ci_build_runs",
    "List Xcode Cloud build runs for a product or a workflow (build number, start reason, execution progress, completion status, issue counts, source commit and branch/tag). Newest first.",
    {
      product_id: z.string().optional().describe("Xcode Cloud product ID (or pass workflow_id)"),
      workflow_id: z.string().optional().describe("Xcode Cloud workflow ID"),
      limit: z.number().int().min(1).max(200).optional().describe("Max build runs (default: 25)"),
    },
    async ({ product_id, workflow_id, limit }) => {
      try {
        if (!product_id && !workflow_id) return err("Pass either product_id or workflow_id.");
        const path = workflow_id
          ? `/ciWorkflows/${encodeURIComponent(workflow_id)}/buildRuns`
          : `/ciProducts/${encodeURIComponent(product_id!)}/buildRuns`;
        const { data, included } = await client.getAll(path, {
          include: BUILD_RUN_RELATIONSHIPS,
          "fields[ciBuildRuns]": `${BUILD_RUN_FIELDS},${BUILD_RUN_RELATIONSHIPS}`,
          "fields[ciWorkflows]": "name,description,isEnabled",
          "fields[scmGitReferences]": "name,canonicalName,kind",
          "fields[scmPullRequests]": "title,number,webUrl,sourceBranchName,destinationBranchName",
          sort: "-number",
          limit: limit ?? 25,
        });
        const buildRuns = data.map((d) =>
          shapeResource(d, included, {
            relationships: ["workflow", "sourceBranchOrTag", "pullRequest"],
          }),
        );
        return ok({ count: buildRuns.length, buildRuns });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_ci_build_actions",
    "List the actions of an Xcode Cloud build run (build, test, analyze, archive) with their execution progress, completion status and issue counts. Use the returned action id with list_ci_issues and list_ci_artifacts.",
    {
      build_run_id: z.string().describe("Xcode Cloud build run ID (from list_ci_build_runs)"),
      limit: z.number().int().min(1).max(200).optional().describe("Max actions (default: 50)"),
    },
    async ({ build_run_id, limit }) => {
      try {
        const { data } = await client.getAll(
          `/ciBuildRuns/${encodeURIComponent(build_run_id)}/actions`,
          { "fields[ciBuildActions]": ACTION_FIELDS, limit: limit ?? 50 },
        );
        return ok({ count: data.length, actions: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_ci_issues",
    "List the issues Xcode Cloud reported for a build action (errors, warnings, analyzer and test failures) with the message and the source file location. This is what to read when a build run failed.",
    {
      build_action_id: z
        .string()
        .describe("Xcode Cloud build action ID (from list_ci_build_actions)"),
      limit: z.number().int().min(1).max(200).optional().describe("Max issues (default: 50)"),
    },
    async ({ build_action_id, limit }) => {
      try {
        const { data } = await client.getAll(
          `/ciBuildActions/${encodeURIComponent(build_action_id)}/issues`,
          { "fields[ciIssues]": ISSUE_FIELDS, limit: limit ?? 50 },
        );
        return ok({ count: data.length, issues: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_ci_artifacts",
    "List build artifact metadata. Download URLs are intentionally not exposed. Use get_ci_log to inspect a LOG_BUNDLE.",
    {
      build_action_id: z
        .string()
        .describe("Xcode Cloud build action ID (from list_ci_build_actions)"),
      limit: z.number().int().min(1).max(200).optional().describe("Max artifacts (default: 50)"),
    },
    async ({ build_action_id, limit }) => {
      try {
        const { data } = await client.getAll(
          `/ciBuildActions/${encodeURIComponent(build_action_id)}/artifacts`,
          { "fields[ciArtifacts]": ARTIFACT_FIELDS, limit: limit ?? 50 },
        );
        const artifacts = data.map((d) => {
          const resource = flattenResource(d);
          if (!resource) return resource;
          delete resource.downloadUrl;
          return resource;
        });
        return ok({ count: artifacts.length, artifacts });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_ci_log",
    "Safely download and inspect the LOG_BUNDLE for an Xcode Cloud build action. Signed URLs are never returned. Text output is redacted and bounded to the requested tail lines.",
    {
      build_action_id: z
        .string()
        .describe("Xcode Cloud build action ID (from list_ci_build_actions)"),
      max_lines: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe("Maximum tail lines per log file (default: 2000; maximum: 5000)"),
    },
    async ({ build_action_id, max_lines }) => {
      try {
        const actionResponse = await client.get(
          `/ciBuildActions/${encodeURIComponent(build_action_id)}`,
          {
            "fields[ciBuildActions]": "name,completionStatus,actionType",
          },
        );
        const action = Array.isArray(actionResponse.data)
          ? actionResponse.data[0]
          : actionResponse.data;
        const actionName = String(action?.attributes?.name ?? "");
        const { data } = await client.getAll(
          `/ciBuildActions/${encodeURIComponent(build_action_id)}/artifacts`,
          { "fields[ciArtifacts]": "fileType,fileName,fileSize", limit: 200 },
        );
        const logBundle = data.find((resource) => resource.attributes?.fileType === "LOG_BUNDLE");
        if (!logBundle) return err("No LOG_BUNDLE artifact was found for this build action.");

        const detailResponse = await client.get(
          `/ciArtifacts/${encodeURIComponent(logBundle.id)}`,
          {
            "fields[ciArtifacts]": "fileType,fileName,fileSize,downloadUrl",
          },
        );
        const detail = Array.isArray(detailResponse.data)
          ? detailResponse.data[0]
          : detailResponse.data;
        const attributes = detail?.attributes;
        const downloadUrl =
          typeof attributes?.downloadUrl === "string" ? attributes.downloadUrl : "";
        if (!downloadUrl || attributes?.fileType !== "LOG_BUNDLE") {
          return err("The LOG_BUNDLE artifact metadata is unavailable.");
        }
        const fileSizeValue = attributes.fileSize;
        const fileSize =
          typeof fileSizeValue === "number"
            ? fileSizeValue
            : typeof fileSizeValue === "string" && /^\d+$/u.test(fileSizeValue)
              ? Number(fileSizeValue)
              : undefined;
        const artifact = await retrieveCiLog(
          {
            id: detail.id,
            fileName: typeof attributes.fileName === "string" ? attributes.fileName : undefined,
            fileSize,
            downloadUrl,
          },
          max_lines ?? 2000,
          actionName,
          options,
        );
        return ok({
          buildActionId: build_action_id,
          artifact: artifact.artifact,
          logs: artifact.logs,
        });
      } catch {
        return err(
          "Could not safely retrieve the Xcode Cloud LOG_BUNDLE. Check artifact availability and retry.",
        );
      }
    },
  );
}
