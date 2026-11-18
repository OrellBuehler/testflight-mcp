import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerScreenshotTools } from "../tools/screenshots.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const root = mkdtempSync(join(tmpdir(), "shots-"));
const dir = join(root, "allowed");
mkdirSync(dir);

function collect(allowWrites = true, uploadDir: string | undefined = dir) {
  const tools = new Map<string, Handler>();
  registerScreenshotTools(
    {
      tool: (n: string, _d: string, _s: unknown, _a: unknown, h: Handler) => tools.set(n, h),
    } as any,
    new AppStoreConnectClient(async () => "tok"),
    allowWrites,
    uploadDir,
  );
  return tools;
}

function png(name: string, body = "x") {
  const file = join(dir, name);
  writeFileSync(file, Buffer.concat([PNG, Buffer.from(body)]));
  return file;
}

function reservation(id: string) {
  return resp({ data: { type: "appScreenshots", id, attributes: { uploadOperations: [] } } });
}

function commit(id: string, state = "UPLOAD_COMPLETE") {
  return resp({
    data: { type: "appScreenshots", id, attributes: { assetDeliveryState: { state } } },
  });
}

function fail(status = 500) {
  return { ok: false, status, statusText: "Server Error", text: () => Promise.resolve("boom") };
}

function setWith(count: number) {
  const ids = Array.from({ length: count }, (_, i) => `OLD${i + 1}`);
  return {
    data: [
      {
        type: "appScreenshotSets",
        id: "SET1",
        attributes: { screenshotDisplayType: "APP_IPHONE_65" },
        relationships: {
          appScreenshots: { data: ids.map((id) => ({ type: "appScreenshots", id })) },
        },
      },
    ],
    included: ids.map((id) => ({ type: "appScreenshots", id, attributes: {} })),
  };
}

function calls(mockFetch: ReturnType<typeof vi.fn>) {
  return mockFetch.mock.calls.map(
    ([url, init]) => `${init?.method ?? "GET"} ${new URL(url).pathname}`,
  );
}

function resp(body: unknown, status = 200) {
  return {
    ok: true,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  };
}

const tools = collect();

const existingSets = {
  data: [
    {
      type: "appScreenshotSets",
      id: "SET1",
      attributes: { screenshotDisplayType: "APP_IPHONE_65" },
      relationships: { appScreenshots: { data: [{ type: "appScreenshots", id: "OLD1" }] } },
    },
  ],
  included: [
    {
      type: "appScreenshots",
      id: "OLD1",
      attributes: { fileName: "old.png", assetDeliveryState: { state: "COMPLETE" } },
    },
  ],
};

describe("screenshot tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_app_screenshot_sets resolves screenshots per set", async () => {
    mockFetch.mockResolvedValueOnce(resp(existingSets));
    const res = await tools.get("list_app_screenshot_sets")!({ localization_id: "LOC1" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/appStoreVersionLocalizations/LOC1/appScreenshotSets");
    expect(parsed.searchParams.get("include")).toBe("appScreenshots");
    const out = JSON.parse(res.content[0].text!);
    expect(out.sets[0].screenshotDisplayType).toBe("APP_IPHONE_65");
    expect(out.sets[0].screenshots[0].fileName).toBe("old.png");
  });

  it("registers only the read tool unless writes are allowed", () => {
    expect([...collect(false).keys()]).toEqual(["list_app_screenshot_sets"]);
    expect([...collect(true).keys()]).toEqual([
      "list_app_screenshot_sets",
      "upload_app_screenshots",
    ]);
  });

  it("upload_app_screenshots uploads and commits before deleting the previous screenshots", async () => {
    const bytes = Buffer.concat([PNG, Buffer.from("0123456789")]);
    const file = join(dir, "01.png");
    writeFileSync(file, bytes);

    mockFetch
      .mockResolvedValueOnce(resp(existingSets))
      .mockResolvedValueOnce(
        resp({
          data: {
            type: "appScreenshots",
            id: "NEW1",
            attributes: {
              uploadOperations: [
                {
                  method: "PUT",
                  url: "https://upload.example/a",
                  offset: 0,
                  length: 8,
                  requestHeaders: [{ name: "Content-Type", value: "image/png" }],
                },
                { method: "PUT", url: "https://upload.example/b", offset: 8, length: 10 },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(resp(null))
      .mockResolvedValueOnce(resp(null))
      .mockResolvedValueOnce(
        resp({
          data: {
            type: "appScreenshots",
            id: "NEW1",
            attributes: { fileName: "01.png", assetDeliveryState: { state: "UPLOAD_COMPLETE" } },
          },
        }),
      )
      .mockResolvedValueOnce(resp(null, 204));

    const res = await tools.get("upload_app_screenshots")!({
      localization_id: "LOC1",
      display_type: "APP_IPHONE_65",
      file_paths: [file],
      replace_existing: true,
    });
    expect(res.isError).toBeFalsy();
    expect(mockFetch).toHaveBeenCalledTimes(6);

    const [, reserve, partA, partB, commitCall, del] = mockFetch.mock.calls;
    const reserveBody = JSON.parse(reserve[1].body);
    expect(reserveBody.data.attributes).toEqual({ fileName: "01.png", fileSize: 18 });
    expect(reserveBody.data.relationships.appScreenshotSet.data.id).toBe("SET1");

    expect(partA[0]).toBe("https://upload.example/a");
    expect(partA[1].headers).toEqual({ "Content-Type": "image/png" });
    expect(partA[1].headers.Authorization).toBeUndefined();
    expect(Buffer.from(partA[1].body).equals(PNG)).toBe(true);
    expect(Buffer.from(partB[1].body).toString()).toBe("0123456789");

    expect(commitCall[1].method).toBe("PATCH");
    expect(JSON.parse(commitCall[1].body).data.attributes).toEqual({
      uploaded: true,
      sourceFileChecksum: createHash("md5").update(bytes).digest("hex"),
    });

    expect(del[0]).toBe("https://api.appstoreconnect.apple.com/v1/appScreenshots/OLD1");
    expect(del[1].method).toBe("DELETE");

    const out = JSON.parse(res.content[0].text!);
    expect(out.screenshotSetId).toBe("SET1");
    expect(out.uploaded[0].assetDeliveryState.state).toBe("UPLOAD_COMPLETE");
    expect(out.deleted).toEqual(["OLD1"]);
  });

  it("upload_app_screenshots keeps the previous screenshots and removes partial uploads when an upload fails", async () => {
    mockFetch
      .mockResolvedValueOnce(resp(existingSets))
      .mockResolvedValueOnce(reservation("NEW1"))
      .mockResolvedValueOnce(commit("NEW1"))
      .mockResolvedValueOnce(reservation("NEW2"))
      .mockResolvedValueOnce(fail())
      .mockResolvedValue(resp(null, 204));

    const res = await tools.get("upload_app_screenshots")!({
      localization_id: "LOC1",
      display_type: "APP_IPHONE_65",
      file_paths: [png("a.png"), png("b.png")],
      replace_existing: true,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/previous screenshots were left intact/);
    expect(calls(mockFetch)).toEqual([
      "GET /v1/appStoreVersionLocalizations/LOC1/appScreenshotSets",
      "POST /v1/appScreenshots",
      "PATCH /v1/appScreenshots/NEW1",
      "POST /v1/appScreenshots",
      "PATCH /v1/appScreenshots/NEW2",
      "DELETE /v1/appScreenshots/NEW1",
      "DELETE /v1/appScreenshots/NEW2",
    ]);
  });

  it("upload_app_screenshots treats a FAILED delivery state as a failed upload", async () => {
    mockFetch
      .mockResolvedValueOnce(resp(existingSets))
      .mockResolvedValueOnce(reservation("NEW1"))
      .mockResolvedValueOnce(commit("NEW1", "FAILED"))
      .mockResolvedValue(resp(null, 204));

    const res = await tools.get("upload_app_screenshots")!({
      localization_id: "LOC1",
      display_type: "APP_IPHONE_65",
      file_paths: [png("a.png")],
      replace_existing: true,
    });
    expect(res.isError).toBe(true);
    expect(calls(mockFetch).filter((c) => c.startsWith("DELETE"))).toEqual([
      "DELETE /v1/appScreenshots/NEW1",
    ]);
  });

  it("upload_app_screenshots refuses to replace when old and new exceed 10, without deleting", async () => {
    mockFetch.mockResolvedValueOnce(resp(setWith(8)));
    const res = await tools.get("upload_app_screenshots")!({
      localization_id: "LOC1",
      display_type: "APP_IPHONE_65",
      file_paths: [png("a.png"), png("b.png"), png("c.png")],
      replace_existing: true,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Nothing was changed.*delete_first/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("upload_app_screenshots with delete_first deletes only the overflow before uploading", async () => {
    mockFetch
      .mockResolvedValueOnce(resp(setWith(8)))
      .mockResolvedValueOnce(resp(null, 204))
      .mockResolvedValueOnce(reservation("N1"))
      .mockResolvedValueOnce(commit("N1"))
      .mockResolvedValueOnce(reservation("N2"))
      .mockResolvedValueOnce(commit("N2"))
      .mockResolvedValueOnce(reservation("N3"))
      .mockResolvedValueOnce(commit("N3"))
      .mockResolvedValue(resp(null, 204));

    const res = await tools.get("upload_app_screenshots")!({
      localization_id: "LOC1",
      display_type: "APP_IPHONE_65",
      file_paths: [png("a.png"), png("b.png"), png("c.png")],
      replace_existing: true,
      delete_first: true,
    });
    expect(res.isError).toBeFalsy();
    const made = calls(mockFetch);
    expect(made[1]).toBe("DELETE /v1/appScreenshots/OLD8");
    expect(made.slice(2, 8).some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(made.slice(8)).toEqual(
      Array.from({ length: 7 }, (_, i) => `DELETE /v1/appScreenshots/OLD${i + 1}`),
    );
    expect(JSON.parse(res.content[0].text!).deleted).toHaveLength(8);
  });

  it("upload_app_screenshots creates a missing set", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ data: [] }))
      .mockResolvedValueOnce(
        resp({
          data: {
            type: "appScreenshotSets",
            id: "SET2",
            attributes: { screenshotDisplayType: "APP_IPAD_PRO_3GEN_129" },
          },
        }),
      )
      .mockResolvedValueOnce(reservation("N"))
      .mockResolvedValueOnce(commit("N"));

    await tools.get("upload_app_screenshots")!({
      localization_id: "LOC1",
      display_type: "APP_IPAD_PRO_3GEN_129",
      file_paths: [png("01.png")],
    });
    const create = mockFetch.mock.calls[1];
    expect(create[0]).toBe("https://api.appstoreconnect.apple.com/v1/appScreenshotSets");
    const body = JSON.parse(create[1].body);
    expect(body.data.attributes.screenshotDisplayType).toBe("APP_IPAD_PRO_3GEN_129");
    expect(body.data.relationships.appStoreVersionLocalization.data.id).toBe("LOC1");
    expect(
      JSON.parse(mockFetch.mock.calls[2][1].body).data.relationships.appScreenshotSet.data.id,
    ).toBe("SET2");
  });

  it("upload_app_screenshots refuses to exceed 10 without replacing", async () => {
    const files = Array.from({ length: 10 }, (_, i) => png(`${i}.png`));
    mockFetch.mockResolvedValueOnce(resp(existingSets));
    const res = await tools.get("upload_app_screenshots")!({
      localization_id: "LOC1",
      display_type: "APP_IPHONE_65",
      file_paths: files,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/exceed 10/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  describe("upload path restrictions", () => {
    const upload = (file_paths: string[], t = tools) =>
      t.get("upload_app_screenshots")!({
        localization_id: "LOC1",
        display_type: "APP_IPHONE_65",
        file_paths,
        replace_existing: true,
      });

    it("errors when ASC_UPLOAD_DIR is not set", async () => {
      const res = await upload([png("a.png")], collect(true, ""));
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/ASC_UPLOAD_DIR is not set/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects paths outside the upload directory", async () => {
      const outside = join(root, "outside.png");
      writeFileSync(outside, PNG);
      for (const path of [outside, "../outside.png", join(dir, "..", "outside.png")]) {
        const res = await upload([path]);
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toMatch(/outside ASC_UPLOAD_DIR/);
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects symlinks that escape the upload directory", async () => {
      const secret = join(root, "secret.png");
      writeFileSync(secret, PNG);
      symlinkSync(secret, join(dir, "link.png"));
      symlinkSync(root, join(dir, "up"));
      for (const path of ["link.png", "up/secret.png"]) {
        const res = await upload([path]);
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toMatch(/outside ASC_UPLOAD_DIR/);
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects non-image extensions, including through a symlink", async () => {
      writeFileSync(join(dir, "notes.txt"), PNG);
      symlinkSync(join(dir, "notes.txt"), join(dir, "notes.png"));
      for (const path of ["notes.txt", "notes.png"]) {
        const res = await upload([path]);
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toMatch(/only \.png, \.jpg and \.jpeg/);
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects files that are not PNG or JPEG data", async () => {
      writeFileSync(join(dir, "fake.png"), "secret");
      const res = await upload(["fake.png"]);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/not a PNG or JPEG image/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects oversized files and directories", async () => {
      png("big.png");
      truncateSync(join(dir, "big.png"), 30 * 1024 * 1024 + 1);
      mkdirSync(join(dir, "folder.png"));
      expect((await upload(["big.png"])).content[0].text).toMatch(/larger than 30 MB/);
      expect((await upload(["folder.png"])).content[0].text).toMatch(/not a regular file/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("validates every file before touching App Store Connect", async () => {
      const res = await upload([png("ok.png"), "missing.png"]);
      expect(res.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("accepts JPEG files given relative to the upload directory", async () => {
      writeFileSync(join(dir, "photo.JPG"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      mockFetch
        .mockResolvedValueOnce(resp({ data: [] }))
        .mockResolvedValueOnce(resp({ data: { type: "appScreenshotSets", id: "S" } }))
        .mockResolvedValueOnce(reservation("N"))
        .mockResolvedValueOnce(commit("N"));
      const res = await upload(["photo.JPG"]);
      expect(res.isError).toBeFalsy();
    });
  });
});
