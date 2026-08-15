import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerAnalyticsTools } from "../tools/analytics.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(vendor?: string) {
  const tools = new Map<string, Handler>();
  registerAnalyticsTools(
    { tool: (n: string, _d: string, _s: unknown, h: Handler) => tools.set(n, h) } as any,
    new AppStoreConnectClient(async () => "tok"),
    vendor,
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

function gzipResp(text: string) {
  const buf = gzipSync(Buffer.from(text));
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/a-gzip" }),
    arrayBuffer: () =>
      Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
  };
}

describe("analytics tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("create_analytics_report_request posts the app relationship", async () => {
    const tools = collect();
    mockFetch.mockResolvedValueOnce(
      resp({
        data: {
          type: "analyticsReportRequests",
          id: "r1",
          attributes: { accessType: "ONE_TIME_SNAPSHOT" },
        },
      }),
    );
    await tools.get("create_analytics_report_request")!({ app_id: "APP1" });
    const [url, options] = mockFetch.mock.calls[0];
    expect(new URL(url).pathname).toBe("/v1/analyticsReportRequests");
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body);
    expect(body.data.relationships.app.data).toEqual({ type: "apps", id: "APP1" });
    expect(body.data.attributes.accessType).toBe("ONE_TIME_SNAPSHOT");
  });

  it("list_analytics_reports filters by category", async () => {
    const tools = collect();
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_analytics_reports")!({ report_request_id: "r1", category: "APP_USAGE" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/analyticsReportRequests/r1/reports");
    expect(parsed.searchParams.get("filter[category]")).toBe("APP_USAGE");
  });

  it("download_analytics_report_segment decompresses a segment listed beforehand", async () => {
    const tools = collect();
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [{ type: "analyticsReportSegments", id: "s1", attributes: { url: "https://seg/1" } }],
      }),
    );
    await tools.get("list_analytics_report_segments")!({ report_id: "rep1" });
    mockFetch.mockResolvedValueOnce(gzipResp("date,units\n2026-06-01,5\n"));
    const res = await tools.get("download_analytics_report_segment")!({
      segment_url: "https://seg/1",
    });
    expect(mockFetch.mock.calls[1][0]).toBe("https://seg/1");
    expect(res.content[0].text).toBe("date,units\n2026-06-01,5\n");
  });

  it("download_analytics_report_segment refuses a url Apple never returned", async () => {
    const tools = collect();
    const res = await tools.get("download_analytics_report_segment")!({
      segment_url: "https://attacker.example/steal",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("list_analytics_report_segments");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("download_analytics_report_segment does not treat a listed url as a prefix match", async () => {
    const tools = collect();
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [{ type: "analyticsReportSegments", id: "s1", attributes: { url: "https://seg/1" } }],
      }),
    );
    await tools.get("list_analytics_report_segments")!({ report_id: "rep1" });
    const res = await tools.get("download_analytics_report_segment")!({
      segment_url: "https://seg/1.attacker.example/x",
    });
    expect(res.isError).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("download_sales_report uses the default vendor number and decompresses CSV", async () => {
    const tools = collect("80001234");
    mockFetch.mockResolvedValueOnce(gzipResp("Provider\tSKU\n"));
    const res = await tools.get("download_sales_report")!({ report_date: "2026-06-01" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/salesReports");
    expect(parsed.searchParams.get("filter[vendorNumber]")).toBe("80001234");
    expect(parsed.searchParams.get("filter[reportType]")).toBe("SALES");
    expect(res.content[0].text).toBe("Provider\tSKU\n");
  });

  it("download_sales_report errors clearly when no vendor number is available", async () => {
    const tools = collect();
    const res = await tools.get("download_sales_report")!({ report_date: "2026-06-01" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("vendor number");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("download_finance_report passes the region code", async () => {
    const tools = collect("80001234");
    mockFetch.mockResolvedValueOnce(gzipResp("financial\n"));
    await tools.get("download_finance_report")!({ report_date: "2026-06", region_code: "ZZ" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/financeReports");
    expect(parsed.searchParams.get("filter[regionCode]")).toBe("ZZ");
  });
});
