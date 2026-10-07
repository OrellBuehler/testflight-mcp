import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerCiTools } from "../tools/ci.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function storedZip(name: string, text: string): Uint8Array {
  const fileName = Buffer.from(name, "utf8");
  const contents = Buffer.from(text, "utf8");
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(fileName.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(fileName.length, 28);

  const centralOffset = local.length + fileName.length + contents.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, contents, central, fileName, end]);
}

function collect(
  options: { artifactRoot?: string; timeoutMs?: number; fetcher?: typeof fetch } = {},
) {
  const tools = new Map<string, Handler>();
  registerCiTools(
    { tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any,
    new AppStoreConnectClient(async () => "tok"),
    options,
  );
  return tools;
}

function resp(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
  };
}

const tools = collect();

describe("xcode cloud tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_ci_products filters by app and resolves the app", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "ciProducts",
            id: "p1",
            attributes: { name: "Acme", productType: "APP" },
            relationships: { app: { data: { type: "apps", id: "APP1" } } },
          },
        ],
        included: [
          { type: "apps", id: "APP1", attributes: { name: "Acme", bundleId: "com.acme" } },
        ],
      }),
    );
    const res = await tools.get("list_ci_products")!({ app_id: "APP1" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/ciProducts");
    expect(parsed.searchParams.get("filter[app]")).toBe("APP1");
    expect(JSON.parse(res.content[0].text!).products[0].app).toMatchObject({
      bundleId: "com.acme",
    });
  });

  it("list_ci_build_runs reads a product newest first", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "ciBuildRuns",
            id: "r1",
            attributes: { number: 42, completionStatus: "FAILED" },
            relationships: { workflow: { data: { type: "ciWorkflows", id: "w1" } } },
          },
        ],
        included: [{ type: "ciWorkflows", id: "w1", attributes: { name: "Release" } }],
      }),
    );
    const res = await tools.get("list_ci_build_runs")!({ product_id: "p1" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/ciProducts/p1/buildRuns");
    expect(parsed.searchParams.get("sort")).toBe("-number");
    const payload = JSON.parse(res.content[0].text!);
    expect(payload.buildRuns[0]).toMatchObject({ number: 42, completionStatus: "FAILED" });
    expect(payload.buildRuns[0].workflow).toMatchObject({ name: "Release" });
  });

  it("list_ci_build_runs reads a workflow when given workflow_id", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_ci_build_runs")!({ workflow_id: "w1" });
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe("/v1/ciWorkflows/w1/buildRuns");
  });

  it("list_ci_build_runs errors without a product or workflow", async () => {
    const res = await tools.get("list_ci_build_runs")!({});
    expect(res.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("list_ci_build_actions lists the actions of a build run", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "ciBuildActions",
            id: "a1",
            attributes: { name: "Test", completionStatus: "FAILED" },
          },
        ],
      }),
    );
    const res = await tools.get("list_ci_build_actions")!({ build_run_id: "r1" });
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe("/v1/ciBuildRuns/r1/actions");
    expect(JSON.parse(res.content[0].text!).actions[0].name).toBe("Test");
  });

  it("list_ci_issues lists the issues of a build action", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "ciIssues",
            id: "i1",
            attributes: { issueType: "ERROR", message: "no such module 'Foo'" },
          },
        ],
      }),
    );
    const res = await tools.get("list_ci_issues")!({ build_action_id: "a1" });
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe("/v1/ciBuildActions/a1/issues");
    expect(JSON.parse(res.content[0].text!).issues[0].message).toBe("no such module 'Foo'");
  });

  it("list_ci_artifacts omits signed download URLs", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "ciArtifacts",
            id: "art1",
            attributes: { fileName: "Logs.zip", downloadUrl: "https://example.test/logs.zip" },
          },
        ],
      }),
    );
    const res = await tools.get("list_ci_artifacts")!({ build_action_id: "a1" });
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe("/v1/ciBuildActions/a1/artifacts");
    expect(new URL(mockFetch.mock.calls[0][0]).searchParams.get("fields[ciArtifacts]")).toBe(
      "fileType,fileName,fileSize",
    );
    expect(JSON.parse(res.content[0].text!).artifacts[0]).toMatchObject({ fileName: "Logs.zip" });
    expect(JSON.stringify(res)).not.toContain("downloadUrl");
    expect(JSON.stringify(res)).not.toContain("https://example.test/logs.zip");
  });

  it("get_ci_log reports a missing LOG_BUNDLE without exposing API errors", async () => {
    mockFetch
      .mockResolvedValueOnce(
        resp({ data: { type: "ciBuildActions", id: "a1", attributes: { name: "Archive" } } }),
      )
      .mockResolvedValueOnce(
        resp({
          data: [{ type: "ciArtifacts", id: "art1", attributes: { fileType: "TEST_RESULTS" } }],
        }),
      );
    const res = await tools.get("get_ci_log")!({ build_action_id: "a1" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No LOG_BUNDLE artifact");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("get_ci_log keeps the signed URL and download failure details private", async () => {
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "testflight-ci-tool-"));
    const signedUrl = "https://example.test/logs.zip?X-Amz-Credential=private-value";
    const download = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        expect(init?.headers).toEqual({ Accept: "application/zip, application/octet-stream" });
        expect(init?.redirect).toBe("error");
        throw new Error(`failed ${signedUrl}`);
      },
    );
    const localTools = collect({
      artifactRoot: path.join(artifactRoot, "artifacts"),
      fetcher: download,
    });
    mockFetch
      .mockResolvedValueOnce(
        resp({ data: { type: "ciBuildActions", id: "a1", attributes: { name: "Archive" } } }),
      )
      .mockResolvedValueOnce(
        resp({
          data: [{ type: "ciArtifacts", id: "art1", attributes: { fileType: "LOG_BUNDLE" } }],
        }),
      )
      .mockResolvedValueOnce(
        resp({
          data: {
            type: "ciArtifacts",
            id: "art1",
            attributes: {
              fileType: "LOG_BUNDLE",
              fileName: "Logs.zip",
              fileSize: 100,
              downloadUrl: signedUrl,
            },
          },
        }),
      );
    try {
      const res = await localTools.get("get_ci_log")!({ build_action_id: "a1", max_lines: 20 });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).not.toContain("X-Amz-Credential");
      expect(JSON.stringify(res)).not.toContain("private-value");
      expect(download).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(new URL(mockFetch.mock.calls[2][0]).searchParams.get("fields[ciArtifacts]")).toBe(
        "fileType,fileName,fileSize,downloadUrl",
      );
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("get_ci_log returns redacted bounded text from a LOG_BUNDLE", async () => {
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "testflight-ci-success-"));
    const signedUrl = "https://example.test/logs.zip?signature=private-download-secret";
    const archive = storedZip(
      "ci_post_clone.log",
      [
        "Archive started",
        "error: xcodebuild failed",
        "CONTROL_PLANE_API_KEY=private-runtime-secret",
        "https://example.test/log?signature=private-log-secret",
      ].join("\n"),
    );
    const download = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        expect(init?.headers).toEqual({ Accept: "application/zip, application/octet-stream" });
        expect(init?.redirect).toBe("error");
        return new Response(new Uint8Array(archive), {
          headers: { "content-type": "application/zip" },
        });
      },
    );
    const localTools = collect({
      artifactRoot: path.join(artifactRoot, "artifacts"),
      fetcher: download,
    });
    mockFetch
      .mockResolvedValueOnce(
        resp({ data: { type: "ciBuildActions", id: "a1", attributes: { name: "Archive" } } }),
      )
      .mockResolvedValueOnce(
        resp({
          data: [
            {
              type: "ciArtifacts",
              id: "art1",
              attributes: {
                fileType: "LOG_BUNDLE",
                fileName: "Logs.zip",
                fileSize: archive.length,
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        resp({
          data: {
            type: "ciArtifacts",
            id: "art1",
            attributes: {
              fileType: "LOG_BUNDLE",
              fileName: "Logs.zip",
              fileSize: archive.length,
              downloadUrl: signedUrl,
            },
          },
        }),
      );
    try {
      const result = await localTools.get("get_ci_log")!({ build_action_id: "a1", max_lines: 2 });
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse(result.content[0].text!);
      expect(payload.artifact).toEqual({
        id: "art1",
        fileName: "Logs.zip",
        fileSize: archive.length,
      });
      expect(payload.logs).toEqual([
        expect.objectContaining({
          path: "ci_post_clone.log",
          text: "CONTROL_PLANE_API_KEY=[REDACTED]\nhttps://example.test/log?REDACTED",
          truncated: true,
        }),
      ]);
      expect(download).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain("private-download-secret");
      expect(JSON.stringify(result)).not.toContain("private-runtime-secret");
      expect(JSON.stringify(result)).not.toContain("private-log-secret");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
});
