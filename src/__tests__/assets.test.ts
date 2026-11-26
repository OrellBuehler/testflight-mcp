import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerAssetTools } from "../tools/assets.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const root = mkdtempSync(join(tmpdir(), "assets-"));
const dir = join(root, "allowed");
mkdirSync(dir);
writeFileSync(join(dir, "header.png"), Buffer.concat([PNG, Buffer.from("abcdef")]));
writeFileSync(join(root, "outside.png"), PNG);

function collect(allowWrites = true, uploadDir: string | undefined = dir) {
  const tools = new Map<string, Handler>();
  registerAssetTools(
    {
      tool: (n: string, _d: string, _s: unknown, _a: unknown, h: Handler) => tools.set(n, h),
    } as any,
    new AppStoreConnectClient(async () => "tok"),
    allowWrites,
    uploadDir,
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

function fail(status = 409) {
  return { ok: false, status, statusText: "Conflict", text: () => Promise.resolve("boom") };
}

function calls(mockFetch: ReturnType<typeof vi.fn>) {
  return mockFetch.mock.calls.map(([url, init]) => {
    const u = new URL(url);
    return `${init?.method ?? "GET"} ${u.host === "api.appstoreconnect.apple.com" ? u.pathname : u.host}`;
  });
}

function body(mockFetch: ReturnType<typeof vi.fn>, index: number) {
  return JSON.parse(mockFetch.mock.calls[index][1].body);
}

const noPlacements = resp({ data: [] });
const onePlacement = resp({
  data: [
    {
      type: "appAssetLibraryPlacements",
      id: "OLD",
      attributes: {
        placementType: "PRODUCT_PAGE_HEADER_ASSET",
        state: "PARENT_PREPARE_FOR_SUBMISSION",
      },
      relationships: { image: { data: { type: "appAssetLibraryImages", id: "IMG0" } } },
    },
  ],
  included: [{ type: "appAssetLibraryImages", id: "IMG0", attributes: { fileName: "old.png" } }],
});
const library = resp({ data: { type: "appAssetLibraries", id: "LIB" } });
const reservation = resp({
  data: {
    type: "appAssetLibraryImages",
    id: "IMG1",
    attributes: {
      state: "AWAITING_UPLOAD",
      uploadOperations: [
        {
          method: "PUT",
          url: "https://upload.example.com/part?sig=secret",
          offset: 0,
          length: 14,
          requestHeaders: [{ name: "Content-Type", value: "image/png" }],
        },
      ],
    },
  },
});
const committed = (state = "UPLOAD_COMPLETE") =>
  resp({
    data: {
      type: "appAssetLibraryImages",
      id: "IMG1",
      attributes: {
        state,
        fileName: "header.png",
        stateDetails: [],
        uploadOperations: [{ url: "https://upload.example.com/part?sig=secret" }],
      },
    },
  });
const placed = resp({
  data: {
    type: "appAssetLibraryPlacements",
    id: "NEW",
    attributes: { placementType: "PRODUCT_PAGE_HEADER_ASSET", state: "ASSET_PROCESSING" },
  },
});
const noContent = { ok: true, status: 204, headers: new Headers() };

const tools = collect();
const upload = (extra: Record<string, unknown> = {}) =>
  tools.get("upload_app_store_asset")!({
    app_id: "A1",
    localization_id: "L1",
    placement_type: "PRODUCT_PAGE_HEADER_ASSET",
    file_path: "header.png",
    ...extra,
  });

describe("asset tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("registers only the read tools unless writes are allowed", () => {
    expect([...collect(false).keys()]).toEqual([
      "list_app_store_asset_placements",
      "get_app_asset_library_specs",
    ]);
    expect([...collect(true).keys()].slice(2)).toEqual([
      "upload_app_store_asset",
      "delete_app_store_asset_placement",
    ]);
  });

  it("list_app_store_asset_placements resolves the image and never asks for upload operations", async () => {
    mockFetch.mockResolvedValueOnce(onePlacement);
    const res = await tools.get("list_app_store_asset_placements")!({
      localization_id: "L1",
      placement_type: "PRODUCT_PAGE_HEADER_ASSET",
    });
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/v1/appStoreVersionLocalizations/L1/placements");
    expect(url.searchParams.get("filter[placementType]")).toBe("PRODUCT_PAGE_HEADER_ASSET");
    expect(url.searchParams.get("include")).toBe("image");
    expect(url.searchParams.get("fields[appAssetLibraryImages]")).not.toContain("uploadOperations");
    const out = JSON.parse(res.content[0].text!);
    expect(out.count).toBe(1);
    expect(out.placements[0]).toMatchObject({
      id: "OLD",
      image: { id: "IMG0", fileName: "old.png" },
    });
  });

  it("get_app_asset_library_specs defaults to the header and search results types", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: [{ type: "appAssetLibraryRefData", id: "r", attributes: { imageSpecs: [] } }] }),
    );
    const res = await tools.get("get_app_asset_library_specs")!({});
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/v1/appAssetLibraryRefData");
    expect(url.searchParams.get("filter[placementTypes]")).toBe(
      "PRODUCT_PAGE_HEADER_ASSET,APP_STORE_SEARCH_RESULTS_ASSET",
    );
    expect(JSON.parse(res.content[0].text!).referenceData[0]).toMatchObject({ imageSpecs: [] });
  });

  it("upload_app_store_asset uploads, commits and places the image", async () => {
    mockFetch
      .mockResolvedValueOnce(noPlacements)
      .mockResolvedValueOnce(library)
      .mockResolvedValueOnce(reservation)
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(committed())
      .mockResolvedValueOnce(placed);
    const res = await upload({ reference_name: "Header" });
    expect(res.isError).toBeFalsy();
    expect(calls(mockFetch)).toEqual([
      "GET /v1/appStoreVersionLocalizations/L1/placements",
      "GET /v1/apps/A1/assetLibrary",
      "POST /v1/appAssetLibraryImages",
      "PUT upload.example.com",
      "PATCH /v1/appAssetLibraryImages/IMG1",
      "POST /v1/appAssetLibraryPlacements",
    ]);
    expect(body(mockFetch, 2)).toEqual({
      data: {
        type: "appAssetLibraryImages",
        attributes: {
          category: "CREATIVE_ASSETS",
          fileName: "header.png",
          fileSize: 14,
          referenceName: "Header",
        },
        relationships: { assetLibrary: { data: { type: "appAssetLibraries", id: "LIB" } } },
      },
    });
    const [, part] = mockFetch.mock.calls[3];
    expect(part.headers).toEqual({ "Content-Type": "image/png" });
    expect(part.body.length).toBe(14);
    expect(body(mockFetch, 4).data.attributes).toEqual({ uploaded: true });
    expect(body(mockFetch, 5)).toEqual({
      data: {
        type: "appAssetLibraryPlacements",
        attributes: { placementType: "PRODUCT_PAGE_HEADER_ASSET" },
        relationships: {
          image: { data: { type: "appAssetLibraryImages", id: "IMG1" } },
          appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: "L1" } },
        },
      },
    });
    expect(res.content[0].text).not.toContain("upload.example.com");
    expect(JSON.parse(res.content[0].text!)).toMatchObject({
      placement: { id: "NEW" },
      image: { id: "IMG1", state: "UPLOAD_COMPLETE" },
      deleted: [],
    });
  });

  it("upload_app_store_asset refuses to add a second asset without replace_existing", async () => {
    mockFetch.mockResolvedValueOnce(onePlacement);
    const res = await upload();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/replace_existing/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("upload_app_store_asset places the new asset before removing the previous one", async () => {
    mockFetch
      .mockResolvedValueOnce(onePlacement)
      .mockResolvedValueOnce(library)
      .mockResolvedValueOnce(reservation)
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(committed())
      .mockResolvedValueOnce(placed)
      .mockResolvedValueOnce(noContent);
    const res = await upload({ replace_existing: true, placement_group: "G1" });
    expect(calls(mockFetch).slice(5)).toEqual([
      "POST /v1/appAssetLibraryPlacements",
      "DELETE /v1/appAssetLibraryPlacements/OLD",
    ]);
    expect(new URL(mockFetch.mock.calls[0][0]).searchParams.get("filter[placementGroup]")).toBe(
      "G1",
    );
    expect(body(mockFetch, 5).data.attributes).toEqual({
      placementType: "PRODUCT_PAGE_HEADER_ASSET",
      placementGroup: "G1",
    });
    expect(JSON.parse(res.content[0].text!).deleted).toEqual(["OLD"]);
  });

  it("upload_app_store_asset removes the previous placement first when Apple rejects a second one", async () => {
    mockFetch
      .mockResolvedValueOnce(onePlacement)
      .mockResolvedValueOnce(library)
      .mockResolvedValueOnce(reservation)
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(committed())
      .mockResolvedValueOnce(fail())
      .mockResolvedValueOnce(noContent)
      .mockResolvedValueOnce(placed);
    const res = await upload({ replace_existing: true });
    expect(res.isError).toBeFalsy();
    expect(calls(mockFetch).slice(5)).toEqual([
      "POST /v1/appAssetLibraryPlacements",
      "DELETE /v1/appAssetLibraryPlacements/OLD",
      "POST /v1/appAssetLibraryPlacements",
    ]);
    expect(JSON.parse(res.content[0].text!).deleted).toEqual(["OLD"]);
  });

  it("upload_app_store_asset removes the new image and keeps the previous placement when the upload fails", async () => {
    mockFetch
      .mockResolvedValueOnce(onePlacement)
      .mockResolvedValueOnce(library)
      .mockResolvedValueOnce(reservation)
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Server Error" })
      .mockResolvedValueOnce(noContent);
    const res = await upload({ replace_existing: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/previous placement was left intact/);
    expect(calls(mockFetch).slice(4)).toEqual(["DELETE /v1/appAssetLibraryImages/IMG1"]);
  });

  it("upload_app_store_asset treats a FAILED image as a failed upload", async () => {
    mockFetch
      .mockResolvedValueOnce(noPlacements)
      .mockResolvedValueOnce(library)
      .mockResolvedValueOnce(reservation)
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(committed("FAILED"))
      .mockResolvedValueOnce(noContent);
    const res = await upload();
    expect(res.isError).toBe(true);
    expect(calls(mockFetch).at(-1)).toBe("DELETE /v1/appAssetLibraryImages/IMG1");
  });

  it("upload_app_store_asset only reads images inside ASC_UPLOAD_DIR", async () => {
    symlinkSync(join(root, "outside.png"), join(dir, "link.png"));
    writeFileSync(join(dir, "fake.png"), "secret");
    const unset = await collect(true, null as any).get("upload_app_store_asset")!({
      app_id: "A1",
      localization_id: "L1",
      placement_type: "PRODUCT_PAGE_HEADER_ASSET",
      file_path: "header.png",
    });
    expect(unset.content[0].text).toMatch(/ASC_UPLOAD_DIR is not set/);
    expect((await upload({ file_path: "../outside.png" })).content[0].text).toMatch(/outside/);
    expect((await upload({ file_path: "link.png" })).content[0].text).toMatch(/outside/);
    expect((await upload({ file_path: "notes.txt" })).content[0].text).toMatch(/only .* files/);
    expect((await upload({ file_path: "fake.png" })).content[0].text).toMatch(/not a PNG or JPEG/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("delete_app_store_asset_placement deletes the placement", async () => {
    mockFetch.mockResolvedValueOnce(noContent);
    const res = await tools.get("delete_app_store_asset_placement")!({ placement_id: "P1" });
    expect(calls(mockFetch)).toEqual(["DELETE /v1/appAssetLibraryPlacements/P1"]);
    expect(JSON.parse(res.content[0].text!)).toEqual({ deleted: true, placementId: "P1" });
  });
});
