import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerProvisioningTools } from "../tools/provisioning.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect() {
  const tools = new Map<string, Handler>();
  registerProvisioningTools(
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

describe("provisioning tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_devices filters by platform and status", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_devices")!({ platform: "IOS", status: "ENABLED" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/devices");
    expect(parsed.searchParams.get("filter[platform]")).toBe("IOS");
    expect(parsed.searchParams.get("filter[status]")).toBe("ENABLED");
  });

  it("list_certificates filters by certificate type", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_certificates")!({ certificate_type: "IOS_DISTRIBUTION" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/certificates");
    expect(parsed.searchParams.get("filter[certificateType]")).toBe("IOS_DISTRIBUTION");
  });

  it("list_profiles includes and resolves the bundle id", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "profiles",
            id: "pr1",
            attributes: { name: "Acme Dist" },
            relationships: { bundleId: { data: { type: "bundleIds", id: "bid1" } } },
          },
        ],
        included: [{ type: "bundleIds", id: "bid1", attributes: { identifier: "com.acme.app" } }],
      }),
    );
    const res = await tools.get("list_profiles")!({});
    expect(new URL(mockFetch.mock.calls[0][0]).searchParams.get("include")).toBe("bundleId");
    expect(JSON.parse(res.content[0].text!).profiles[0].bundleId).toMatchObject({
      identifier: "com.acme.app",
    });
  });

  it("list_bundle_ids filters by identifier", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_bundle_ids")!({ identifier: "com.acme.app" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/bundleIds");
    expect(parsed.searchParams.get("filter[identifier]")).toBe("com.acme.app");
  });
});
