import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerFeedbackTools } from "../tools/feedback.js";

type Handler = (
  args: any,
) => Promise<{ content: { type: string; text?: string; data?: string }[]; isError?: boolean }>;

function collect() {
  const tools = new Map<string, Handler>();
  registerFeedbackTools(
    { tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any,
    new AppStoreConnectClient(async () => "tok"),
  );
  return tools;
}

function resp(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
  };
}

const tools = collect();

describe("feedback tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("list_screenshot_feedback defaults to the latest version and resolves tester/build", async () => {
    mockFetch
      .mockResolvedValueOnce(
        resp({
          data: [
            {
              type: "builds",
              id: "b1",
              attributes: { version: "42" },
              relationships: {
                preReleaseVersion: { data: { type: "preReleaseVersions", id: "pv1" } },
              },
            },
          ],
          included: [{ type: "preReleaseVersions", id: "pv1", attributes: { version: "1.2.0" } }],
        }),
      )
      .mockResolvedValueOnce(
        resp({
          data: [
            {
              type: "betaFeedbackScreenshotSubmissions",
              id: "f1",
              attributes: { comment: "button is cut off", createdDate: "2026-06-01T00:00:00Z" },
              relationships: {
                tester: { data: { type: "betaTesters", id: "t1" } },
                build: { data: { type: "builds", id: "b1" } },
              },
            },
          ],
          included: [
            { type: "betaTesters", id: "t1", attributes: { email: "a@b.c" } },
            { type: "builds", id: "b1", attributes: { version: "42" } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        resp({
          data: [
            {
              type: "builds",
              id: "b1",
              relationships: {
                preReleaseVersion: { data: { type: "preReleaseVersions", id: "pv1" } },
              },
            },
          ],
          included: [{ type: "preReleaseVersions", id: "pv1", attributes: { version: "1.2.0" } }],
        }),
      );
    const res = await tools.get("list_screenshot_feedback")!({ app_id: "APP1" });

    const buildsCall = new URL(mockFetch.mock.calls[0][0]);
    expect(buildsCall.pathname).toBe("/v1/builds");
    expect(buildsCall.searchParams.get("filter[app]")).toBe("APP1");
    expect(buildsCall.searchParams.get("sort")).toBe("-uploadedDate");

    const feedbackCall = new URL(mockFetch.mock.calls[1][0]);
    expect(feedbackCall.pathname).toBe("/v1/apps/APP1/betaFeedbackScreenshotSubmissions");
    expect(feedbackCall.searchParams.get("include")).toBe("build,tester");
    expect(feedbackCall.searchParams.get("sort")).toBe("-createdDate");
    expect(feedbackCall.searchParams.get("filter[build]")).toBe("b1");
    expect(feedbackCall.searchParams.get("fields[betaFeedbackScreenshotSubmissions]")).toContain(
      "build,tester",
    );

    const enrichCall = new URL(mockFetch.mock.calls[2][0]);
    expect(enrichCall.pathname).toBe("/v1/builds");
    expect(enrichCall.searchParams.get("filter[app]")).toBe("APP1");
    expect(enrichCall.searchParams.get("include")).toBe("preReleaseVersion");

    const payload = JSON.parse(res.content[0].text!);
    expect(payload.count).toBe(1);
    expect(payload.appVersion).toBe("1.2.0");
    expect(payload.feedback[0]).toMatchObject({
      id: "f1",
      comment: "button is cut off",
      tester: { id: "t1", email: "a@b.c" },
      build: { id: "b1", version: "42", preReleaseVersion: { id: "pv1", version: "1.2.0" } },
    });
  });

  it("list_screenshot_feedback filters by an explicit app_version via its builds", async () => {
    mockFetch
      .mockResolvedValueOnce(
        resp({
          data: [
            { type: "builds", id: "b2", attributes: { version: "5" } },
            { type: "builds", id: "b3", attributes: { version: "6" } },
          ],
        }),
      )
      .mockResolvedValueOnce(resp({ data: [] }));
    const res = await tools.get("list_screenshot_feedback")!({
      app_id: "APP1",
      app_version: "1.0.0",
    });

    const buildsCall = new URL(mockFetch.mock.calls[0][0]);
    expect(buildsCall.pathname).toBe("/v1/builds");
    expect(buildsCall.searchParams.get("filter[preReleaseVersion.version]")).toBe("1.0.0");

    const feedbackCall = new URL(mockFetch.mock.calls[1][0]);
    expect(feedbackCall.searchParams.get("filter[build]")).toBe("b2,b3");
    expect(JSON.parse(res.content[0].text!).appVersion).toBe("1.0.0");
  });

  it("list_screenshot_feedback returns empty when the app_version has no builds", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    const res = await tools.get("list_screenshot_feedback")!({
      app_id: "APP1",
      app_version: "9.9.9",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(res.content[0].text!);
    expect(payload.count).toBe(0);
    expect(payload.appVersion).toBe("9.9.9");
    expect(payload.feedback).toEqual([]);
  });

  it("list_screenshot_feedback applies the build filter and skips version resolution", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_screenshot_feedback")!({ app_id: "APP1", build_id: "B9", limit: 5 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/apps/APP1/betaFeedbackScreenshotSubmissions");
    expect(parsed.searchParams.get("filter[build]")).toBe("B9");
    expect(parsed.searchParams.get("limit")).toBe("5");
  });

  it("list_crash_feedback with app_version 'all' skips version filtering", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_crash_feedback")!({ app_id: "APP1", app_version: "all" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/apps/APP1/betaFeedbackCrashSubmissions");
    expect(parsed.searchParams.has("filter[build]")).toBe(false);
  });

  it("get_screenshot_feedback can download the first screenshot inline", async () => {
    mockFetch
      .mockResolvedValueOnce(
        resp({
          data: {
            type: "betaFeedbackScreenshotSubmissions",
            id: "f1",
            attributes: { comment: "see attached", screenshots: [{ url: "https://shots/1.png" }] },
            relationships: {},
          },
          included: [],
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: () => Promise.resolve(Uint8Array.from([1, 2, 3]).buffer),
      });
    const res = await tools.get("get_screenshot_feedback")!({
      feedback_id: "f1",
      download_screenshot: true,
    });
    expect(mockFetch.mock.calls[1][0]).toBe("https://shots/1.png");
    const image = res.content.find((c) => c.type === "image");
    expect(image?.data).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  it("get_screenshot_feedback resolves the build and its TestFlight version", async () => {
    mockFetch
      .mockResolvedValueOnce(
        resp({
          data: {
            type: "betaFeedbackScreenshotSubmissions",
            id: "f1",
            attributes: { comment: "layout bug" },
            relationships: {
              tester: { data: { type: "betaTesters", id: "t1" } },
              build: { data: { type: "builds", id: "b1" } },
            },
          },
          included: [
            { type: "betaTesters", id: "t1", attributes: { email: "a@b.c" } },
            { type: "builds", id: "b1", attributes: { version: "42" } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        resp({
          data: {
            type: "builds",
            id: "b1",
            relationships: {
              preReleaseVersion: { data: { type: "preReleaseVersions", id: "pv1" } },
            },
          },
          included: [{ type: "preReleaseVersions", id: "pv1", attributes: { version: "1.2.0" } }],
        }),
      );
    const res = await tools.get("get_screenshot_feedback")!({ feedback_id: "f1" });

    const feedbackCall = new URL(mockFetch.mock.calls[0][0]);
    expect(feedbackCall.searchParams.get("include")).toBe("build,tester");
    expect(feedbackCall.searchParams.get("fields[betaFeedbackScreenshotSubmissions]")).toContain(
      "build,tester",
    );
    const enrichCall = new URL(mockFetch.mock.calls[1][0]);
    expect(enrichCall.pathname).toBe("/v1/builds/b1");
    expect(enrichCall.searchParams.get("include")).toBe("preReleaseVersion");

    const payload = JSON.parse(res.content[0].text!);
    expect(payload).toMatchObject({
      id: "f1",
      tester: { id: "t1", email: "a@b.c" },
      build: { id: "b1", version: "42", preReleaseVersion: { id: "pv1", version: "1.2.0" } },
    });
  });

  it("get_crash_log reads the linked betaCrashLogs resource's logText", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: {
          type: "betaCrashLogs",
          id: "log1",
          attributes: { logText: "Incident Identifier: X\nThread 0 crashed" },
        },
      }),
    );
    const res = await tools.get("get_crash_log")!({ feedback_id: "c1" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      "https://api.appstoreconnect.apple.com/v1/betaFeedbackCrashSubmissions/c1/crashLog",
    );
    expect(res.content[0].text).toBe("Incident Identifier: X\nThread 0 crashed");
  });

  it("get_crash_log reports when no crash log is attached", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: null }));
    const res = await tools.get("get_crash_log")!({ feedback_id: "c2" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(res.content[0].text).toContain("No crash log is attached");
  });

  it("returns an MCP error when the API call fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: () => Promise.resolve("FORBIDDEN_ERROR"),
    });
    const res = await tools.get("list_crash_feedback")!({ app_id: "APP1" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("403");
  });
});
