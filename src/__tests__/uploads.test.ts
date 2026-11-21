import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerBuildUploadTools } from "../tools/uploads.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

const root = mkdtempSync(join(tmpdir(), "builds-"));
const dir = join(root, "uploads");
mkdirSync(dir);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const IPA = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.from("0123456789")]);
writeFileSync(join(dir, "App.ipa"), IPA);
writeFileSync(join(dir, "App.pkg"), Buffer.concat([Buffer.from("xar!"), Buffer.from("pkgdata")]));
writeFileSync(join(dir, "fake.ipa"), "not a zip");
writeFileSync(join(dir, "notes.txt"), "PK\x03\x04 text");
writeFileSync(join(root, "outside.ipa"), IPA);

function collect(allowWrites = true, uploadDir: string | undefined = dir) {
  const tools = new Map<string, Handler>();
  registerBuildUploadTools(
    {
      tool: (n: string, _d: string, _s: unknown, _a: unknown, h: Handler) => tools.set(n, h),
    } as any,
    new AppStoreConnectClient(async () => "tok"),
    allowWrites,
    uploadDir,
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

function sent(mockFetch: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = mockFetch.mock.calls[index];
  return {
    url: String(url),
    method: init?.method ?? "GET",
    path: new URL(url).pathname,
    params: new URL(url).searchParams,
    headers: init?.headers as Record<string, string>,
    rawBody: init?.body,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  };
}

const args = {
  app_id: "A1",
  file_path: "App.ipa",
  version: "1.2.0",
  build_number: "42",
  platform: "IOS",
};
const tools = collect();

describe("build upload tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("registers only read tools unless writes are allowed", () => {
    expect([...collect(false).keys()]).toEqual(["list_build_uploads", "get_build_upload"]);
    expect([...collect(true).keys()]).toEqual([
      "list_build_uploads",
      "get_build_upload",
      "upload_build",
    ]);
  });

  it("list_build_uploads filters, sorts and resolves the build", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "buildUploads",
            id: "u1",
            attributes: { cfBundleVersion: "42", state: { state: "COMPLETE" } },
            relationships: { build: { data: { type: "builds", id: "b1" } } },
          },
        ],
        included: [{ type: "builds", id: "b1", attributes: { processingState: "VALID" } }],
      }),
    );
    const res = await tools.get("list_build_uploads")!({
      app_id: "A1",
      state: "COMPLETE",
      version: "1.2.0",
    });
    const req = sent(mockFetch);
    expect(req.path).toBe("/v1/apps/A1/buildUploads");
    expect(req.params.get("filter[state]")).toBe("COMPLETE");
    expect(req.params.get("filter[cfBundleShortVersionString]")).toBe("1.2.0");
    expect(req.params.get("sort")).toBe("-uploadedDate");
    expect(req.params.get("include")).toBe("build");
    expect(req.params.get("limit")).toBe("20");
    expect(JSON.parse(res.content[0].text!)).toEqual({
      count: 1,
      uploads: [
        {
          id: "u1",
          type: "buildUploads",
          cfBundleVersion: "42",
          state: { state: "COMPLETE" },
          build: { id: "b1", type: "builds", processingState: "VALID" },
        },
      ],
    });
  });

  it("get_build_upload returns the upload with its files and never the upload URLs", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        new URL(url).pathname.endsWith("/buildUploadFiles")
          ? resp({
              data: [
                {
                  type: "buildUploadFiles",
                  id: "f1",
                  attributes: {
                    fileName: "App.ipa",
                    uploadOperations: [{ url: "https://s/secret" }],
                  },
                },
              ],
            })
          : resp({
              data: {
                type: "buildUploads",
                id: "u1",
                attributes: { state: { state: "FAILED", errors: [{ code: "90062" }] } },
              },
            }),
      ),
    );
    const res = await tools.get("get_build_upload")!({ upload_id: "u1" });
    const paths = mockFetch.mock.calls.map(([url]) => new URL(url).pathname).sort();
    expect(paths).toEqual(["/v1/buildUploads/u1", "/v1/buildUploads/u1/buildUploadFiles"]);
    const files = mockFetch.mock.calls.find(([url]) => String(url).includes("buildUploadFiles"))!;
    expect(new URL(files[0]).searchParams.get("fields[buildUploadFiles]")).not.toContain(
      "uploadOperations",
    );
    expect(res.content[0].text).not.toContain("secret");
    expect(JSON.parse(res.content[0].text!)).toMatchObject({
      id: "u1",
      state: { state: "FAILED", errors: [{ code: "90062" }] },
      build: null,
      files: [{ id: "f1", fileName: "App.ipa" }],
    });
  });

  describe("upload_build", () => {
    function happyPath() {
      mockFetch
        .mockResolvedValueOnce(resp({ data: { type: "buildUploads", id: "u1", attributes: {} } }))
        .mockResolvedValueOnce(
          resp({
            data: {
              type: "buildUploadFiles",
              id: "f1",
              attributes: {
                uploadOperations: [
                  {
                    method: "PUT",
                    url: "https://store.example/part1",
                    offset: 0,
                    length: 8,
                    requestHeaders: [{ name: "Content-Type", value: "application/octet-stream" }],
                  },
                  { method: "PUT", url: "https://store.example/part2", offset: 8, length: 6 },
                ],
              },
            },
          }),
        )
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce(
          resp({
            data: {
              type: "buildUploadFiles",
              id: "f1",
              attributes: {
                fileName: "App.ipa",
                assetDeliveryState: { state: "UPLOAD_COMPLETE" },
                uploadOperations: [{ url: "https://store.example/secret" }],
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          resp({
            data: {
              type: "buildUploads",
              id: "u1",
              attributes: { state: { state: "PROCESSING" } },
            },
          }),
        );
    }

    it("reserves, uploads every part without auth, commits with a checksum and reports the state", async () => {
      happyPath();
      const res = await tools.get("upload_build")!(args);
      expect(res.isError).toBeUndefined();
      expect(sent(mockFetch, 0)).toMatchObject({
        method: "POST",
        path: "/v1/buildUploads",
        body: {
          data: {
            type: "buildUploads",
            attributes: {
              cfBundleShortVersionString: "1.2.0",
              cfBundleVersion: "42",
              platform: "IOS",
            },
            relationships: { app: { data: { type: "apps", id: "A1" } } },
          },
        },
      });
      expect(sent(mockFetch, 1)).toMatchObject({
        method: "POST",
        path: "/v1/buildUploadFiles",
        body: {
          data: {
            type: "buildUploadFiles",
            attributes: {
              assetType: "ASSET",
              fileName: "App.ipa",
              fileSize: IPA.length,
              uti: "com.apple.ipa",
            },
            relationships: { buildUpload: { data: { type: "buildUploads", id: "u1" } } },
          },
        },
      });
      const part1 = sent(mockFetch, 2);
      const part2 = sent(mockFetch, 3);
      expect(part1.url).toBe("https://store.example/part1");
      expect(part1.headers).toEqual({ "Content-Type": "application/octet-stream" });
      expect(Buffer.from(part1.rawBody)).toEqual(IPA.subarray(0, 8));
      expect(part2.headers).toEqual({});
      expect(Buffer.from(part2.rawBody)).toEqual(IPA.subarray(8, 14));
      expect(sent(mockFetch, 4)).toMatchObject({
        method: "PATCH",
        path: "/v1/buildUploadFiles/f1",
        body: {
          data: {
            type: "buildUploadFiles",
            id: "f1",
            attributes: {
              uploaded: true,
              sourceFileChecksums: {
                file: {
                  hash: createHash("md5").update(IPA).digest("hex"),
                  algorithm: "MD5",
                },
              },
            },
          },
        },
      });
      expect(sent(mockFetch, 5).path).toBe("/v1/buildUploads/u1");
      expect(res.content[0].text).not.toContain("secret");
      expect(JSON.parse(res.content[0].text!)).toMatchObject({
        id: "u1",
        state: { state: "PROCESSING" },
        file: { id: "f1", assetDeliveryState: { state: "UPLOAD_COMPLETE" } },
      });
    });

    it("uses the pkg type for macOS installers", async () => {
      happyPath();
      await tools.get("upload_build")!({ ...args, file_path: "App.pkg", platform: "MAC_OS" });
      expect(sent(mockFetch, 1).body.data.attributes).toMatchObject({
        fileName: "App.pkg",
        uti: "com.apple.pkg",
      });
    });

    it("deletes the upload record when a part fails", async () => {
      mockFetch
        .mockResolvedValueOnce(resp({ data: { type: "buildUploads", id: "u1", attributes: {} } }))
        .mockResolvedValueOnce(
          resp({
            data: {
              type: "buildUploadFiles",
              id: "f1",
              attributes: {
                uploadOperations: [
                  { method: "PUT", url: "https://store.example/p", offset: 0, length: 14 },
                ],
              },
            },
          }),
        )
        .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" })
        .mockResolvedValueOnce({ ok: true, status: 204 });
      const res = await tools.get("upload_build")!(args);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/Upload failed: 403 Forbidden.*u1 was deleted/);
      expect(sent(mockFetch, 3)).toMatchObject({ method: "DELETE", path: "/v1/buildUploads/u1" });
    });

    it("deletes the upload record when Apple rejects the delivered file", async () => {
      mockFetch
        .mockResolvedValueOnce(resp({ data: { type: "buildUploads", id: "u1", attributes: {} } }))
        .mockResolvedValueOnce(
          resp({
            data: {
              type: "buildUploadFiles",
              id: "f1",
              attributes: {
                uploadOperations: [
                  { method: "PUT", url: "https://store.example/p", offset: 0, length: 14 },
                ],
              },
            },
          }),
        )
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce(
          resp({
            data: {
              type: "buildUploadFiles",
              id: "f1",
              attributes: { assetDeliveryState: { state: "FAILED", errors: [{ code: "BAD" }] } },
            },
          }),
        )
        .mockResolvedValueOnce({ ok: true, status: 204 });
      const res = await tools.get("upload_build")!(args);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("BAD");
      expect(sent(mockFetch, 4)).toMatchObject({ method: "DELETE", path: "/v1/buildUploads/u1" });
    });

    it("validates the file before the first API call", async () => {
      symlinkSync(join(root, "outside.ipa"), join(dir, "link.ipa"));
      symlinkSync(join(dir, "notes.txt"), join(dir, "notes.ipa"));
      const cases: [string, RegExp][] = [
        ["../outside.ipa", /outside ASC_UPLOAD_DIR/],
        [join(root, "outside.ipa"), /outside ASC_UPLOAD_DIR/],
        ["link.ipa", /outside ASC_UPLOAD_DIR/],
        ["notes.txt", /only \.ipa and \.pkg files/],
        ["notes.ipa", /only \.ipa and \.pkg files/],
        ["fake.ipa", /not an \.ipa \(zip\) archive/],
        ["missing.ipa", /ENOENT/],
      ];
      for (const [file_path, message] of cases) {
        const res = await tools.get("upload_build")!({ ...args, file_path });
        expect(res.isError, file_path).toBe(true);
        expect(res.content[0].text, file_path).toMatch(message);
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("is disabled without ASC_UPLOAD_DIR", async () => {
      const res = await collect(true, "").get("upload_build")!(args);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(
        /upload_build is disabled because ASC_UPLOAD_DIR is not set/,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
