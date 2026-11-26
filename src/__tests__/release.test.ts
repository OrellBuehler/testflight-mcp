import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerReleaseTools } from "../tools/release.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(allowWrites = true) {
  const tools = new Map<string, Handler>();
  registerReleaseTools(
    {
      tool: (n: string, _d: string, _s: unknown, _a: unknown, h: Handler) => tools.set(n, h),
    } as any,
    new AppStoreConnectClient(async () => "tok"),
    allowWrites,
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

function sent(mockFetch: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = mockFetch.mock.calls[index];
  return {
    method: init?.method ?? "GET",
    path: new URL(url).pathname,
    body: init?.body ? JSON.parse(init.body) : undefined,
  };
}

const tools = collect();

describe("release tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("registers nothing unless writes are allowed", () => {
    expect([...collect(false).keys()]).toEqual([]);
    expect([...collect(true).keys()]).toEqual([
      "create_app_store_version",
      "set_app_store_version_build",
      "update_app_store_review_detail",
      "create_review_submission",
      "add_review_submission_item",
      "submit_review_submission",
      "cancel_review_submission",
      "create_phased_release",
      "update_phased_release",
      "delete_phased_release",
      "release_app_store_version",
    ]);
  });

  it("update_app_store_review_detail patches an existing detail and hides the password", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "appStoreReviewDetails", id: "d1", attributes: {} } }),
    );
    mockFetch.mockResolvedValueOnce(
      resp({
        data: {
          type: "appStoreReviewDetails",
          id: "d1",
          attributes: { notes: "Hi", demoAccountPassword: "hunter2" },
        },
      }),
    );
    const res = await tools.get("update_app_store_review_detail")!({
      version_id: "v1",
      notes: "Hi",
      demo_account_password: "hunter2",
      contact_phone: null,
    });
    const [lookupUrl] = mockFetch.mock.calls[0];
    expect(new URL(lookupUrl).pathname).toBe("/v1/appStoreVersions/v1/appStoreReviewDetail");
    expect(new URL(lookupUrl).searchParams.get("fields[appStoreReviewDetails]")).not.toContain(
      "demoAccountPassword",
    );
    const patch = sent(mockFetch, 1);
    expect(patch.method).toBe("PATCH");
    expect(patch.path).toBe("/v1/appStoreReviewDetails/d1");
    expect(patch.body).toEqual({
      data: {
        type: "appStoreReviewDetails",
        id: "d1",
        attributes: { notes: "Hi", demoAccountPassword: "hunter2", contactPhone: null },
      },
    });
    expect(res.content[0].text).not.toContain("hunter2");
    expect(JSON.parse(res.content[0].text!)).toEqual({
      created: false,
      type: "appStoreReviewDetails",
      id: "d1",
      notes: "Hi",
    });
  });

  it("update_app_store_review_detail creates the detail when the version has none", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: () => Promise.resolve("{}"),
    });
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "appStoreReviewDetails", id: "d2", attributes: { notes: "Hi" } } }),
    );
    const res = await tools.get("update_app_store_review_detail")!({
      version_id: "v1",
      notes: "Hi",
    });
    const post = sent(mockFetch, 1);
    expect(post.method).toBe("POST");
    expect(post.path).toBe("/v1/appStoreReviewDetails");
    expect(post.body).toEqual({
      data: {
        type: "appStoreReviewDetails",
        attributes: { notes: "Hi" },
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "v1" } } },
      },
    });
    expect(JSON.parse(res.content[0].text!).created).toBe(true);
  });

  it("update_app_store_review_detail needs a field and passes other errors on", async () => {
    const empty = await tools.get("update_app_store_review_detail")!({ version_id: "v1" });
    expect(empty.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: () => Promise.resolve("{}"),
    });
    const res = await tools.get("update_app_store_review_detail")!({
      version_id: "v1",
      notes: "x",
    });
    expect(res.isError).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("create_app_store_version posts the version with its app and optional build", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "appStoreVersions", id: "v1", attributes: {} } }),
    );
    await tools.get("create_app_store_version")!({
      app_id: "A1",
      platform: "IOS",
      version_string: "1.0.0",
      release_type: "AFTER_APPROVAL",
      build_id: "b1",
    });
    expect(sent(mockFetch)).toMatchObject({
      method: "POST",
      path: "/v1/appStoreVersions",
      body: {
        data: {
          type: "appStoreVersions",
          attributes: { platform: "IOS", versionString: "1.0.0", releaseType: "AFTER_APPROVAL" },
          relationships: {
            app: { data: { type: "apps", id: "A1" } },
            build: { data: { type: "builds", id: "b1" } },
          },
        },
      },
    });
  });

  it("create_app_store_version omits unset attributes and the build", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "appStoreVersions", id: "v1", attributes: {} } }),
    );
    await tools.get("create_app_store_version")!({
      app_id: "A1",
      platform: "IOS",
      version_string: "1.0.0",
    });
    const { body } = sent(mockFetch);
    expect(body.data.attributes).toEqual({ platform: "IOS", versionString: "1.0.0" });
    expect(body.data.relationships.build).toBeUndefined();
  });

  it("set_app_store_version_build patches the build relationship", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "appStoreVersions", id: "v1", attributes: {} } }),
    );
    await tools.get("set_app_store_version_build")!({ version_id: "v1", build_id: "b2" });
    expect(sent(mockFetch)).toMatchObject({
      method: "PATCH",
      path: "/v1/appStoreVersions/v1",
      body: {
        data: {
          type: "appStoreVersions",
          id: "v1",
          relationships: { build: { data: { type: "builds", id: "b2" } } },
        },
      },
    });
  });

  it("create_review_submission and add_review_submission_item build the submission", async () => {
    mockFetch.mockResolvedValue(
      resp({ data: { type: "reviewSubmissions", id: "s1", attributes: {} } }),
    );
    await tools.get("create_review_submission")!({ app_id: "A1", platform: "IOS" });
    await tools.get("add_review_submission_item")!({ submission_id: "s1", version_id: "v1" });
    expect(sent(mockFetch)).toMatchObject({
      method: "POST",
      path: "/v1/reviewSubmissions",
      body: {
        data: {
          type: "reviewSubmissions",
          attributes: { platform: "IOS" },
          relationships: { app: { data: { type: "apps", id: "A1" } } },
        },
      },
    });
    expect(sent(mockFetch, 1)).toMatchObject({
      method: "POST",
      path: "/v1/reviewSubmissionItems",
      body: {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: "s1" } },
            appStoreVersion: { data: { type: "appStoreVersions", id: "v1" } },
          },
        },
      },
    });
  });

  it("submit and cancel patch the submission flags", async () => {
    mockFetch.mockResolvedValue(
      resp({ data: { type: "reviewSubmissions", id: "s1", attributes: {} } }),
    );
    await tools.get("submit_review_submission")!({ submission_id: "s1" });
    await tools.get("cancel_review_submission")!({ submission_id: "s1" });
    expect(sent(mockFetch)).toMatchObject({
      method: "PATCH",
      path: "/v1/reviewSubmissions/s1",
      body: { data: { type: "reviewSubmissions", id: "s1", attributes: { submitted: true } } },
    });
    expect(sent(mockFetch, 1)).toMatchObject({
      method: "PATCH",
      path: "/v1/reviewSubmissions/s1",
      body: { data: { type: "reviewSubmissions", id: "s1", attributes: { canceled: true } } },
    });
  });

  it("create_phased_release posts an inactive phased release for the version", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "appStoreVersionPhasedReleases", id: "p1", attributes: {} } }),
    );
    const res = await tools.get("create_phased_release")!({ version_id: "v1" });
    expect(sent(mockFetch)).toEqual({
      method: "POST",
      path: "/v1/appStoreVersionPhasedReleases",
      body: {
        data: {
          type: "appStoreVersionPhasedReleases",
          attributes: { phasedReleaseState: "INACTIVE" },
          relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "v1" } } },
        },
      },
    });
    expect(JSON.parse(res.content[0].text!)).toMatchObject({ id: "p1" });
  });

  it("update_phased_release patches the state", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: {
          type: "appStoreVersionPhasedReleases",
          id: "p1",
          attributes: { phasedReleaseState: "PAUSED", currentDayNumber: 3 },
        },
      }),
    );
    const res = await tools.get("update_phased_release")!({
      phased_release_id: "p1",
      state: "PAUSED",
    });
    expect(sent(mockFetch)).toEqual({
      method: "PATCH",
      path: "/v1/appStoreVersionPhasedReleases/p1",
      body: {
        data: {
          type: "appStoreVersionPhasedReleases",
          id: "p1",
          attributes: { phasedReleaseState: "PAUSED" },
        },
      },
    });
    expect(JSON.parse(res.content[0].text!)).toMatchObject({ currentDayNumber: 3 });
  });

  it("delete_phased_release deletes it", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });
    const res = await tools.get("delete_phased_release")!({ phased_release_id: "p1" });
    expect(sent(mockFetch)).toMatchObject({
      method: "DELETE",
      path: "/v1/appStoreVersionPhasedReleases/p1",
    });
    expect(JSON.parse(res.content[0].text!)).toEqual({ deleted: "p1" });
  });

  it("release_app_store_version posts a release request for the version", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "appStoreVersionReleaseRequests", id: "r1" } }),
    );
    await tools.get("release_app_store_version")!({ version_id: "v1" });
    expect(sent(mockFetch)).toEqual({
      method: "POST",
      path: "/v1/appStoreVersionReleaseRequests",
      body: {
        data: {
          type: "appStoreVersionReleaseRequests",
          relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "v1" } } },
        },
      },
    });
  });

  it("reports Apple errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: "Conflict",
      text: () => Promise.resolve("STATE_ERROR"),
    });
    const res = await tools.get("submit_review_submission")!({ submission_id: "s1" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("STATE_ERROR");
  });
});
