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

  it("list_screenshot_feedback hits the app-scoped endpoint and resolves tester/build", async () => {
    mockFetch.mockResolvedValueOnce(
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
          { type: "builds", id: "b1", attributes: { version: "1.2.0" } },
        ],
      }),
    );
    const res = await tools.get("list_screenshot_feedback")!({ app_id: "APP1" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/apps/APP1/betaFeedbackScreenshotSubmissions");
    expect(parsed.searchParams.get("include")).toBe("build,tester");
    expect(parsed.searchParams.get("sort")).toBe("-createdDate");
    const payload = JSON.parse(res.content[0].text!);
    expect(payload.count).toBe(1);
    expect(payload.feedback[0]).toMatchObject({
      id: "f1",
      comment: "button is cut off",
      tester: { id: "t1", email: "a@b.c" },
      build: { id: "b1", version: "1.2.0" },
    });
  });

  it("list_screenshot_feedback applies the build filter", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_screenshot_feedback")!({ app_id: "APP1", build_id: "B9", limit: 5 });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.searchParams.get("filter[build]")).toBe("B9");
    expect(parsed.searchParams.get("limit")).toBe("5");
  });

  it("list_crash_feedback hits the crash submissions endpoint", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_crash_feedback")!({ app_id: "APP1" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/apps/APP1/betaFeedbackCrashSubmissions");
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

  it("get_crash_log resolves the crash log URL and downloads its text", async () => {
    mockFetch
      .mockResolvedValueOnce(
        resp({
          data: {
            type: "betaFeedbackCrashSubmissions",
            id: "c1",
            attributes: { crashLog: { url: "https://logs/c1.crash" } },
          },
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => Promise.resolve("Thread 0 crashed"),
      });
    const res = await tools.get("get_crash_log")!({ feedback_id: "c1" });
    expect(mockFetch.mock.calls[1][0]).toBe("https://logs/c1.crash");
    expect(res.content[0].text).toBe("Thread 0 crashed");
  });

  it("get_crash_log reports when no crash log URL is present", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "betaFeedbackCrashSubmissions", id: "c2", attributes: {} } }),
    );
    const res = await tools.get("get_crash_log")!({ feedback_id: "c2" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(res.content[0].text).toContain("No downloadable crash log");
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
