import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerTesterTools } from "../tools/testers.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(allowWrites = true) {
  const tools = new Map<string, Handler>();
  registerTesterTools(
    {
      tool: (n: string, _d: string, _s: unknown, _a: unknown, h: Handler) => tools.set(n, h),
    } as any,
    new AppStoreConnectClient(async () => "tok"),
    allowWrites,
  );
  return tools;
}

function sent(mockFetch: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = mockFetch.mock.calls[index];
  return {
    method: init?.method ?? "GET",
    path: new URL(url).pathname,
    params: new URL(url).searchParams,
    body: init?.body ? JSON.parse(init.body) : undefined,
  };
}

const noContent = { ok: true, status: 204, statusText: "No Content" };

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

  it("registers only read tools unless writes are allowed", () => {
    expect([...collect(false).keys()]).toEqual([
      "list_beta_groups",
      "list_beta_testers",
      "list_group_testers",
    ]);
    expect([...collect(true).keys()].slice(3)).toEqual([
      "create_beta_group",
      "delete_beta_group",
      "add_beta_tester",
      "add_testers_to_beta_group",
      "remove_testers_from_beta_group",
      "add_builds_to_beta_group",
      "remove_builds_from_beta_group",
      "update_beta_group",
      "remove_beta_tester",
    ]);
  });

  it("update_beta_group patches only the given attributes", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "betaGroups", id: "g1", attributes: { publicLinkEnabled: true } } }),
    );
    await tools.get("update_beta_group")!({
      group_id: "g1",
      public_link_enabled: true,
      public_link_limit_enabled: true,
      public_link_limit: 50,
    });
    expect(sent(mockFetch)).toMatchObject({
      method: "PATCH",
      path: "/v1/betaGroups/g1",
    });
    expect(sent(mockFetch).body).toEqual({
      data: {
        type: "betaGroups",
        id: "g1",
        attributes: { publicLinkEnabled: true, publicLinkLimitEnabled: true, publicLinkLimit: 50 },
      },
    });
  });

  it("update_beta_group refuses an empty update", async () => {
    const res = await tools.get("update_beta_group")!({ group_id: "g1" });
    expect(res.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("remove_beta_tester removes the tester from one app or from the team", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204 });
    await tools.get("remove_beta_tester")!({ tester_id: "t1", app_id: "A1" });
    await tools.get("remove_beta_tester")!({ tester_id: "t1" });
    expect(sent(mockFetch)).toMatchObject({
      method: "DELETE",
      path: "/v1/apps/A1/relationships/betaTesters",
      body: { data: [{ type: "betaTesters", id: "t1" }] },
    });
    expect(sent(mockFetch, 1)).toMatchObject({ method: "DELETE", path: "/v1/betaTesters/t1" });
    expect(sent(mockFetch, 1).body).toBeUndefined();
  });

  it("create_beta_group posts the group with its app and only the given attributes", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "betaGroups", id: "g1", attributes: {} } }),
    );
    await tools.get("create_beta_group")!({
      app_id: "A1",
      name: "External QA",
      public_link_enabled: true,
      public_link_limit_enabled: true,
      public_link_limit: 50,
      feedback_enabled: true,
    });
    expect(sent(mockFetch)).toMatchObject({
      method: "POST",
      path: "/v1/betaGroups",
      body: {
        data: {
          type: "betaGroups",
          attributes: {
            name: "External QA",
            publicLinkEnabled: true,
            publicLinkLimitEnabled: true,
            publicLinkLimit: 50,
            feedbackEnabled: true,
          },
          relationships: { app: { data: { type: "apps", id: "A1" } } },
        },
      },
    });
    expect(sent(mockFetch).body.data.attributes.isInternalGroup).toBeUndefined();
  });

  it("create_beta_group can create an internal group", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "betaGroups", id: "g1", attributes: {} } }),
    );
    await tools.get("create_beta_group")!({
      app_id: "A1",
      name: "Team",
      is_internal_group: true,
      has_access_to_all_builds: true,
    });
    expect(sent(mockFetch).body.data.attributes).toEqual({
      name: "Team",
      isInternalGroup: true,
      hasAccessToAllBuilds: true,
    });
  });

  it("delete_beta_group deletes the group", async () => {
    mockFetch.mockResolvedValueOnce(noContent);
    await tools.get("delete_beta_group")!({ group_id: "g1" });
    expect(sent(mockFetch)).toMatchObject({ method: "DELETE", path: "/v1/betaGroups/g1" });
  });

  it("add_beta_tester creates the tester in the given groups", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "betaTesters", id: "t1", attributes: {} } }),
    );
    await tools.get("add_beta_tester")!({
      email: "tester@example.com",
      first_name: "Test",
      group_ids: ["g1", "g2"],
    });
    expect(sent(mockFetch)).toMatchObject({
      method: "POST",
      path: "/v1/betaTesters",
      body: {
        data: {
          type: "betaTesters",
          attributes: { email: "tester@example.com", firstName: "Test" },
          relationships: {
            betaGroups: {
              data: [
                { type: "betaGroups", id: "g1" },
                { type: "betaGroups", id: "g2" },
              ],
            },
          },
        },
      },
    });
    expect(sent(mockFetch).body.data.attributes.lastName).toBeUndefined();
  });

  it("adds and removes testers via the group relationship", async () => {
    mockFetch.mockResolvedValue(noContent);
    await tools.get("add_testers_to_beta_group")!({ group_id: "g1", tester_ids: ["t1", "t2"] });
    await tools.get("remove_testers_from_beta_group")!({ group_id: "g1", tester_ids: ["t1"] });
    expect(sent(mockFetch)).toMatchObject({
      method: "POST",
      path: "/v1/betaGroups/g1/relationships/betaTesters",
      body: {
        data: [
          { type: "betaTesters", id: "t1" },
          { type: "betaTesters", id: "t2" },
        ],
      },
    });
    expect(sent(mockFetch, 1)).toMatchObject({
      method: "DELETE",
      path: "/v1/betaGroups/g1/relationships/betaTesters",
      body: { data: [{ type: "betaTesters", id: "t1" }] },
    });
  });

  it("adds and removes builds via the group relationship", async () => {
    mockFetch.mockResolvedValue(noContent);
    const added = await tools.get("add_builds_to_beta_group")!({
      group_id: "g1",
      build_ids: ["b1"],
    });
    await tools.get("remove_builds_from_beta_group")!({ group_id: "g1", build_ids: ["b1"] });
    expect(sent(mockFetch)).toMatchObject({
      method: "POST",
      path: "/v1/betaGroups/g1/relationships/builds",
      body: { data: [{ type: "builds", id: "b1" }] },
    });
    expect(sent(mockFetch, 1)).toMatchObject({
      method: "DELETE",
      path: "/v1/betaGroups/g1/relationships/builds",
      body: { data: [{ type: "builds", id: "b1" }] },
    });
    expect(JSON.parse(added.content[0].text!)).toEqual({ groupId: "g1", added: ["b1"] });
  });

  it("reports Apple errors from write tools", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: "Conflict",
      text: () => Promise.resolve("ENTITY_ERROR"),
    });
    const res = await tools.get("delete_beta_group")!({ group_id: "g1" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("409 Conflict");
  });
});
