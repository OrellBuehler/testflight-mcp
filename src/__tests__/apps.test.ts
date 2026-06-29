import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerAppTools } from "../tools/apps.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect() {
  const tools = new Map<string, Handler>();
  registerAppTools(
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

describe("app tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_apps flattens apps and supports a bundle filter", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [{ type: "apps", id: "1", attributes: { name: "Acme", bundleId: "com.acme.app" } }],
      }),
    );
    const res = await tools.get("list_apps")!({ bundle_id: "com.acme.app" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/apps");
    expect(parsed.searchParams.get("filter[bundleId]")).toBe("com.acme.app");
    const payload = JSON.parse(res.content[0].text!);
    expect(payload.apps[0]).toEqual({
      id: "1",
      type: "apps",
      name: "Acme",
      bundleId: "com.acme.app",
    });
  });

  it("get_app fetches a single app by id", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "apps", id: "9", attributes: { name: "X" } } }),
    );
    await tools.get("get_app")!({ app_id: "9" });
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe("/v1/apps/9");
  });

  it("list_builds filters by app and resolves the pre-release version", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "builds",
            id: "b1",
            attributes: { version: "42", processingState: "VALID" },
            relationships: {
              preReleaseVersion: { data: { type: "preReleaseVersions", id: "p1" } },
            },
          },
        ],
        included: [
          {
            type: "preReleaseVersions",
            id: "p1",
            attributes: { version: "1.2.0", platform: "IOS" },
          },
        ],
      }),
    );
    const res = await tools.get("list_builds")!({ app_id: "APP1", version: "1.2.0" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/builds");
    expect(parsed.searchParams.get("filter[app]")).toBe("APP1");
    expect(parsed.searchParams.get("filter[preReleaseVersion.version]")).toBe("1.2.0");
    const payload = JSON.parse(res.content[0].text!);
    expect(payload.builds[0].preReleaseVersion).toMatchObject({
      version: "1.2.0",
      platform: "IOS",
    });
  });

  it("list_customer_reviews hits the app customerReviews endpoint", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_customer_reviews")!({ app_id: "APP1", rating: 1 });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/apps/APP1/customerReviews");
    expect(parsed.searchParams.get("filter[rating]")).toBe("1");
  });
});
