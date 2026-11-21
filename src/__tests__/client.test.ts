import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import { AppStoreConnectClient } from "../asc/client.js";

function mockJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function mockBytes(buf: Buffer, contentType = "application/octet-stream") {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": contentType }),
    arrayBuffer: () =>
      Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
  };
}

describe("AppStoreConnectClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const client = new AppStoreConnectClient(async () => "test-token");

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the v1 URL with query params and sends the bearer token", async () => {
    mockFetch.mockResolvedValueOnce(mockJson({ data: [] }));
    await client.get("/apps", { "filter[bundleId]": "com.acme.app", limit: 10 });
    const [url, options] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://api.appstoreconnect.apple.com/v1/apps");
    expect(parsed.searchParams.get("filter[bundleId]")).toBe("com.acme.app");
    expect(parsed.searchParams.get("limit")).toBe("10");
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect((options.headers as Record<string, string>).Accept).toBe("application/json");
  });

  it("joins array params with commas and skips empty/undefined values", async () => {
    mockFetch.mockResolvedValueOnce(mockJson({ data: [] }));
    await client.get("/builds", {
      include: ["preReleaseVersion", "app"],
      sort: undefined,
      empty: [],
    });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.searchParams.get("include")).toBe("preReleaseVersion,app");
    expect(parsed.searchParams.has("sort")).toBe(false);
    expect(parsed.searchParams.has("empty")).toBe(false);
  });

  it("getAll follows links.next and accumulates data and included", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockJson({
          data: [{ type: "apps", id: "1" }],
          included: [{ type: "builds", id: "b1" }],
          links: { next: "https://api.appstoreconnect.apple.com/v1/apps?cursor=2" },
        }),
      )
      .mockResolvedValueOnce(mockJson({ data: [{ type: "apps", id: "2" }] }));
    const { data, included } = await client.getAll("/apps");
    expect(data.map((d) => d.id)).toEqual(["1", "2"]);
    expect(included.map((d) => d.id)).toEqual(["b1"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe(
      "https://api.appstoreconnect.apple.com/v1/apps?cursor=2",
    );
  });

  it("getAll stops at maxPages even if more pages exist", async () => {
    mockFetch.mockResolvedValue(
      mockJson({
        data: [{ type: "apps", id: "x" }],
        links: { next: "https://api.appstoreconnect.apple.com/v1/apps?c=n" },
      }),
    );
    await client.getAll("/apps", undefined, 3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws with status, statusText and body on non-2xx", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve("NOT_AUTHORIZED"),
    });
    await expect(client.get("/apps")).rejects.toThrow("401 Unauthorized: NOT_AUTHORIZED");
  });

  it("translates a timeout into a clear error", async () => {
    mockFetch.mockImplementationOnce((_url: string, options: RequestInit) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return Promise.reject(new DOMException("timed out", "TimeoutError"));
    });
    await expect(client.get("/apps")).rejects.toThrow(/timed out after/);
  });

  it("post sends a JSON body with the right method and content type", async () => {
    mockFetch.mockResolvedValueOnce(
      mockJson({ data: { type: "analyticsReportRequests", id: "r1" } }),
    );
    await client.post("/analyticsReportRequests", { data: { type: "analyticsReportRequests" } });
    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe("POST");
    expect((options.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(options.body).toBe(JSON.stringify({ data: { type: "analyticsReportRequests" } }));
  });

  it("patch sends a JSON body with the PATCH method", async () => {
    mockFetch.mockResolvedValueOnce(mockJson({ data: { type: "bundleIds", id: "b1" } }));
    const res = await client.patch("/bundleIds/b1", { data: { type: "bundleIds", id: "b1" } });
    const [url, options] = mockFetch.mock.calls[0];
    expect(new URL(url).pathname).toBe("/v1/bundleIds/b1");
    expect(options.method).toBe("PATCH");
    expect((options.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(options.body).toBe(JSON.stringify({ data: { type: "bundleIds", id: "b1" } }));
    expect(res.data).toMatchObject({ id: "b1" });
  });

  it("delete sends DELETE without a body or content type by default", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204, statusText: "No Content" });
    await client.delete("/profiles/p1");
    const [url, options] = mockFetch.mock.calls[0];
    expect(new URL(url).pathname).toBe("/v1/profiles/p1");
    expect(options.method).toBe("DELETE");
    expect(options.body).toBeUndefined();
    expect((options.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("delete can send a JSON body for relationship removals", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204, statusText: "No Content" });
    const body = { data: [{ type: "betaTesters", id: "t1" }] };
    await client.delete("/betaGroups/g1/relationships/betaTesters", body);
    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe("DELETE");
    expect(options.body).toBe(JSON.stringify(body));
    expect((options.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("postNoContent tolerates an empty 204 response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204, statusText: "No Content" });
    const body = { data: [{ type: "builds", id: "b1" }] };
    await expect(
      client.postNoContent("/betaGroups/g1/relationships/builds", body),
    ).resolves.toBeUndefined();
    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe("POST");
    expect(options.body).toBe(JSON.stringify(body));
  });

  it("surfaces the error body when a delete fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: "Conflict",
      text: () => Promise.resolve("ENTITY_ERROR"),
    });
    await expect(client.delete("/bundleIds/b1")).rejects.toThrow("409 Conflict: ENTITY_ERROR");
  });

  it("downloadText fetches a presigned URL without an auth header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      text: () => Promise.resolve("crash log body"),
    });
    expect(await client.downloadText("https://example.com/log")).toBe("crash log body");
    const [, options] = mockFetch.mock.calls[0];
    expect(options?.headers).toBeUndefined();
  });

  it("downloadBinary returns base64 plus the content type", async () => {
    mockFetch.mockResolvedValueOnce(mockBytes(Buffer.from([1, 2, 3, 4]), "image/jpeg"));
    const { base64, mimeType } = await client.downloadBinary("https://example.com/shot.jpg");
    expect(base64).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(mimeType).toBe("image/jpeg");
  });

  it("getGzippedReport decompresses a gzip report body to text", async () => {
    mockFetch.mockResolvedValueOnce(
      mockBytes(gzipSync(Buffer.from("a,b,c\n1,2,3\n")), "application/a-gzip"),
    );
    const csv = await client.getGzippedReport("/salesReports", { "filter[vendorNumber]": "1" });
    expect(csv).toBe("a,b,c\n1,2,3\n");
  });

  it("downloadGzipText decompresses a presigned gzip segment", async () => {
    mockFetch.mockResolvedValueOnce(mockBytes(gzipSync(Buffer.from("segment-data"))));
    expect(await client.downloadGzipText("https://example.com/seg")).toBe("segment-data");
  });
});
