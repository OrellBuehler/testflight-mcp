import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerCiTools } from "../tools/ci.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect() {
  const tools = new Map<string, Handler>();
  registerCiTools(
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

  it("list_ci_artifacts lists the artifacts of a build action", async () => {
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
    expect(JSON.parse(res.content[0].text!).artifacts[0].fileName).toBe("Logs.zip");
  });
});
