import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerMetadataTools } from "../tools/metadata.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect() {
  const tools = new Map<string, Handler>();
  registerMetadataTools(
    { tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any,
    new AppStoreConnectClient(async () => "tok"),
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

describe("metadata tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_app_store_versions filters by app and state", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [{ type: "appStoreVersions", id: "v1", attributes: { versionString: "1.0" } }],
      }),
    );
    const res = await tools.get("list_app_store_versions")!({
      app_id: "APP1",
      app_store_state: "READY_FOR_SALE",
    });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/apps/APP1/appStoreVersions");
    expect(parsed.searchParams.get("filter[appStoreState]")).toBe("READY_FOR_SALE");
    expect(JSON.parse(res.content[0].text!).versions[0].versionString).toBe("1.0");
  });

  it("list_app_store_version_localizations filters by version", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_app_store_version_localizations")!({ version_id: "V1" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/appStoreVersionLocalizations");
    expect(parsed.searchParams.get("filter[appStoreVersion]")).toBe("V1");
  });

  it("get_app_store_version_localization fetches by id", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: { type: "appStoreVersionLocalizations", id: "L1", attributes: { locale: "en-US" } },
      }),
    );
    await tools.get("get_app_store_version_localization")!({ localization_id: "L1" });
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe(
      "/v1/appStoreVersionLocalizations/L1",
    );
  });

  it("list_review_submissions resolves the version under review and its items", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "reviewSubmissions",
            id: "rs1",
            attributes: { state: "IN_REVIEW", submittedDate: "2026-08-10T09:00:00Z" },
            relationships: {
              appStoreVersionForReview: { data: { type: "appStoreVersions", id: "V1" } },
              items: { data: [{ type: "reviewSubmissionItems", id: "it1" }] },
            },
          },
        ],
        included: [
          { type: "appStoreVersions", id: "V1", attributes: { versionString: "1.4.0" } },
          {
            type: "reviewSubmissionItems",
            id: "it1",
            attributes: { state: "READY_FOR_REVIEW" },
            relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "V1" } } },
          },
        ],
      }),
    );
    const res = await tools.get("list_review_submissions")!({ app_id: "APP1", state: "IN_REVIEW" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/reviewSubmissions");
    expect(parsed.searchParams.get("filter[app]")).toBe("APP1");
    expect(parsed.searchParams.get("filter[state]")).toBe("IN_REVIEW");
    const submission = JSON.parse(res.content[0].text!).submissions[0];
    expect(submission.appStoreVersionForReview).toMatchObject({ versionString: "1.4.0" });
    expect(submission.items[0]).toMatchObject({
      state: "READY_FOR_REVIEW",
      targets: { appStoreVersion: { type: "appStoreVersions", id: "V1" } },
    });
  });

  it("get_app_store_version_status returns null for sub-resources that do not exist", async () => {
    mockFetch.mockImplementation((url: string) => {
      const { pathname } = new URL(url);
      if (pathname === "/v1/appStoreVersions/V1") {
        return Promise.resolve(
          resp({
            data: {
              type: "appStoreVersions",
              id: "V1",
              attributes: { versionString: "1.4.0", appVersionState: "WAITING_FOR_REVIEW" },
            },
          }),
        );
      }
      if (pathname === "/v1/appStoreVersions/V1/build") {
        return Promise.resolve(
          resp({ data: { type: "builds", id: "B1", attributes: { version: "42" } } }),
        );
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: () => Promise.resolve("{}"),
      });
    });
    const res = await tools.get("get_app_store_version_status")!({ version_id: "V1" });
    const payload = JSON.parse(res.content[0].text!);
    expect(payload.version).toMatchObject({ appVersionState: "WAITING_FOR_REVIEW" });
    expect(payload.build).toMatchObject({ version: "42" });
    expect(payload.submission).toBeNull();
    expect(payload.phasedRelease).toBeNull();
    expect(payload.reviewDetail).toBeNull();
  });

  it("get_app_store_version_status surfaces non-404 failures", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve("bad key"),
    });
    const res = await tools.get("get_app_store_version_status")!({ version_id: "V1" });
    expect(res.isError).toBe(true);
  });
});
