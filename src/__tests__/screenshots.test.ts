import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerScreenshotTools } from "../tools/screenshots.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect() {
  const tools = new Map<string, Handler>();
  registerScreenshotTools(
    { tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any,
    new AppStoreConnectClient(async () => "tok"),
  );
  return tools;
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

  it("upload_app_screenshots replaces, reserves, uploads parts and commits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shots-"));
    const file = join(dir, "01.png");
    const bytes = Buffer.from("0123456789");
    writeFileSync(file, bytes);

    mockFetch
      .mockResolvedValueOnce(resp(existingSets))
      .mockResolvedValueOnce(resp(null, 204))
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
                  length: 6,
                  requestHeaders: [{ name: "Content-Type", value: "image/png" }],
                },
                { method: "PUT", url: "https://upload.example/b", offset: 6, length: 4 },
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
      );

    const res = await tools.get("upload_app_screenshots")!({
      localization_id: "LOC1",
      display_type: "APP_IPHONE_65",
      file_paths: [file],
      replace_existing: true,
    });
    expect(res.isError).toBeFalsy();

    const [, del, reserve, partA, partB, commit] = mockFetch.mock.calls;
    expect(del[0]).toBe("https://api.appstoreconnect.apple.com/v1/appScreenshots/OLD1");
    expect(del[1].method).toBe("DELETE");

    const reserveBody = JSON.parse(reserve[1].body);
    expect(reserveBody.data.attributes).toEqual({ fileName: "01.png", fileSize: 10 });
    expect(reserveBody.data.relationships.appScreenshotSet.data.id).toBe("SET1");

    expect(partA[0]).toBe("https://upload.example/a");
    expect(partA[1].headers).toEqual({ "Content-Type": "image/png" });
    expect(partA[1].headers.Authorization).toBeUndefined();
    expect(Buffer.from(partA[1].body).toString()).toBe("012345");
    expect(Buffer.from(partB[1].body).toString()).toBe("6789");

    expect(commit[1].method).toBe("PATCH");
    expect(JSON.parse(commit[1].body).data.attributes).toEqual({
      uploaded: true,
      sourceFileChecksum: createHash("md5").update(bytes).digest("hex"),
    });

    const out = JSON.parse(res.content[0].text!);
    expect(out.screenshotSetId).toBe("SET1");
    expect(out.uploaded[0].assetDeliveryState.state).toBe("UPLOAD_COMPLETE");
  });

  it("upload_app_screenshots creates a missing set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shots-"));
    const file = join(dir, "01.png");
    writeFileSync(file, Buffer.from("x"));

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
      .mockResolvedValueOnce(
        resp({ data: { type: "appScreenshots", id: "N", attributes: { uploadOperations: [] } } }),
      )
      .mockResolvedValueOnce(resp({ data: { type: "appScreenshots", id: "N", attributes: {} } }));

    await tools.get("upload_app_screenshots")!({
      localization_id: "LOC1",
      display_type: "APP_IPAD_PRO_3GEN_129",
      file_paths: [file],
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
    const dir = mkdtempSync(join(tmpdir(), "shots-"));
    const files = Array.from({ length: 10 }, (_, i) => {
      const f = join(dir, `${i}.png`);
      writeFileSync(f, Buffer.from("x"));
      return f;
    });
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
});
