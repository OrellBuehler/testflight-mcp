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
    expect(parsed.pathname).toBe("/v1/appStoreVersions");
    expect(parsed.searchParams.get("filter[app]")).toBe("APP1");
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
});
