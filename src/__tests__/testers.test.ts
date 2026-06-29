import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerTesterTools } from "../tools/testers.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect() {
  const tools = new Map<string, Handler>();
  registerTesterTools(
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

describe("tester tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_beta_groups filters by app", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: [{ type: "betaGroups", id: "g1", attributes: { name: "QA" } }] }),
    );
    const res = await tools.get("list_beta_groups")!({ app_id: "APP1" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/betaGroups");
    expect(parsed.searchParams.get("filter[app]")).toBe("APP1");
    expect(JSON.parse(res.content[0].text!).groups[0]).toEqual({
      id: "g1",
      type: "betaGroups",
      name: "QA",
    });
  });

  it("list_beta_testers maps app/group/email filters to the right params", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_beta_testers")!({ app_id: "APP1", group_id: "G1", email: "a@b.c" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.searchParams.get("filter[apps]")).toBe("APP1");
    expect(parsed.searchParams.get("filter[betaGroups]")).toBe("G1");
    expect(parsed.searchParams.get("filter[email]")).toBe("a@b.c");
  });

  it("list_group_testers uses the group sub-resource path", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_group_testers")!({ group_id: "G7" });
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe("/v1/betaGroups/G7/betaTesters");
  });
});
