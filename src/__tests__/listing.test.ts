import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerListingTools } from "../tools/listing.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect() {
  const tools = new Map<string, Handler>();
  registerListingTools(
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

describe("listing tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("get_app_info resolves localizations, categories and age rating", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (new URL(url).pathname === "/v1/apps/APP1") {
        return resp({ data: { type: "apps", id: "APP1", attributes: { primaryLocale: "en-US" } } });
      }
      return resp({
        data: [
          {
            type: "appInfos",
            id: "INFO1",
            attributes: { state: "PREPARE_FOR_SUBMISSION" },
            relationships: {
              appInfoLocalizations: { data: [{ type: "appInfoLocalizations", id: "L1" }] },
              primaryCategory: { data: { type: "appCategories", id: "HEALTH_AND_FITNESS" } },
              ageRatingDeclaration: { data: { type: "ageRatingDeclarations", id: "AGE1" } },
            },
          },
        ],
        included: [
          { type: "appInfoLocalizations", id: "L1", attributes: { locale: "en-US", name: "X" } },
          { type: "appCategories", id: "HEALTH_AND_FITNESS", attributes: {} },
          { type: "ageRatingDeclarations", id: "AGE1", attributes: { gambling: false } },
        ],
      });
    });
    const res = await tools.get("get_app_info")!({ app_id: "APP1" });
    const out = JSON.parse(res.content[0].text!);
    expect(out.app.primaryLocale).toBe("en-US");
    expect(out.appInfos[0].localizations[0].name).toBe("X");
    expect(out.appInfos[0].primaryCategory.id).toBe("HEALTH_AND_FITNESS");
    expect(out.appInfos[0].ageRatingDeclaration.gambling).toBe(false);
  });

  it("update_app_info_localization patches an existing locale", async () => {
    mockFetch
      .mockResolvedValueOnce(
        resp({
          data: [{ type: "appInfoLocalizations", id: "L1", attributes: { locale: "en-US" } }],
        }),
      )
      .mockResolvedValueOnce(
        resp({ data: { type: "appInfoLocalizations", id: "L1", attributes: { subtitle: "S" } } }),
      );
    const res = await tools.get("update_app_info_localization")!({
      app_info_id: "INFO1",
      locale: "en-US",
      subtitle: "S",
    });
    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe("https://api.appstoreconnect.apple.com/v1/appInfoLocalizations/L1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body).data.attributes).toEqual({ subtitle: "S" });
    expect(JSON.parse(res.content[0].text!).created).toBe(false);
  });

  it("update_app_store_version_localization creates a missing locale", async () => {
    mockFetch
      .mockResolvedValueOnce(resp({ data: [] }))
      .mockResolvedValueOnce(
        resp({ data: { type: "appStoreVersionLocalizations", id: "N", attributes: {} } }),
      );
    await tools.get("update_app_store_version_localization")!({
      version_id: "V1",
      locale: "de-DE",
      keywords: "a,b",
    });
    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe("https://api.appstoreconnect.apple.com/v1/appStoreVersionLocalizations");
    const body = JSON.parse(init.body);
    expect(body.data.attributes).toEqual({ locale: "de-DE", keywords: "a,b" });
    expect(body.data.relationships.appStoreVersion.data.id).toBe("V1");
  });

  it("update_app_info sets and clears categories", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: { type: "appInfos", id: "INFO1" } }));
    await tools.get("update_app_info")!({
      app_info_id: "INFO1",
      primary_category: "HEALTH_AND_FITNESS",
      secondary_category: null,
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.relationships).toEqual({
      primaryCategory: { data: { type: "appCategories", id: "HEALTH_AND_FITNESS" } },
      secondaryCategory: { data: null },
    });
  });

  it("update_app_store_version sends only given attributes", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: { type: "appStoreVersions", id: "V1" } }));
    await tools.get("update_app_store_version")!({
      version_id: "V1",
      version_string: "1.50.0",
      release_type: "MANUAL",
    });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).data.attributes).toEqual({
      versionString: "1.50.0",
      releaseType: "MANUAL",
    });
  });
});
