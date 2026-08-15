import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerDiagnosticsTools } from "../tools/diagnostics.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect() {
  const tools = new Map<string, Handler>();
  registerDiagnosticsTools(
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

const logsBody = {
  productData: [
    {
      signatureId: "sig1",
      diagnosticInsights: [{ insightsCategory: "SQLiteSpill", insightsString: "Add an index" }],
      diagnosticLogs: [
        {
          diagnosticMetaData: { event: "disk writes", appVersion: "6.10.1" },
          callStackTree: [{ callStacks: [{ callStackRootFrames: [] }] }],
        },
      ],
    },
  ],
};

const tools = collect();

describe("diagnostics tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("get_perf_power_metrics filters an app and asks for the xcode-metrics media type", async () => {
    mockFetch.mockResolvedValueOnce(resp({ version: "1.0.0", productData: [], insights: {} }));
    await tools.get("get_perf_power_metrics")!({
      app_id: "APP1",
      metric_type: "LAUNCH",
      device_type: "all_iphones",
    });
    const [url, init] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v1/apps/APP1/perfPowerMetrics");
    expect(parsed.searchParams.get("filter[metricType]")).toBe("LAUNCH");
    expect(parsed.searchParams.get("filter[deviceType]")).toBe("all_iphones");
    expect(init.headers.Accept).toContain("application/vnd.apple.xcode-metrics+json");
  });

  it("get_perf_power_metrics reads a single build when given build_id", async () => {
    mockFetch.mockResolvedValueOnce(resp({ productData: [] }));
    await tools.get("get_perf_power_metrics")!({ build_id: "B1" });
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe("/v1/builds/B1/perfPowerMetrics");
  });

  it("get_perf_power_metrics errors without an app or build", async () => {
    const res = await tools.get("get_perf_power_metrics")!({});
    expect(res.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("list_diagnostic_signatures filters by diagnostic type", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "diagnosticSignatures",
            id: "sig1",
            attributes: {
              diagnosticType: "DISK_WRITES",
              signature: "-[DB executeSQL:]",
              weight: 0.85,
            },
          },
        ],
      }),
    );
    const res = await tools.get("list_diagnostic_signatures")!({
      build_id: "B1",
      diagnostic_type: "DISK_WRITES",
    });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/builds/B1/diagnosticSignatures");
    expect(parsed.searchParams.get("filter[diagnosticType]")).toBe("DISK_WRITES");
    expect(JSON.parse(res.content[0].text!).signatures[0]).toMatchObject({ weight: 0.85 });
  });

  it("get_diagnostic_logs strips call stacks by default", async () => {
    mockFetch.mockResolvedValueOnce(resp(structuredClone(logsBody)));
    const res = await tools.get("get_diagnostic_logs")!({ signature_id: "sig1" });
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe("/v1/diagnosticSignatures/sig1/logs");
    const payload = JSON.parse(res.content[0].text!);
    expect(payload.productData[0].diagnosticLogs[0].callStackTree).toBeUndefined();
    expect(payload.productData[0].diagnosticLogs[0].diagnosticMetaData.appVersion).toBe("6.10.1");
    expect(payload.productData[0].diagnosticInsights[0].insightsCategory).toBe("SQLiteSpill");
  });

  it("get_diagnostic_logs keeps call stacks when asked", async () => {
    mockFetch.mockResolvedValueOnce(resp(structuredClone(logsBody)));
    const res = await tools.get("get_diagnostic_logs")!({
      signature_id: "sig1",
      include_call_stacks: true,
    });
    const payload = JSON.parse(res.content[0].text!);
    expect(payload.productData[0].diagnosticLogs[0].callStackTree).toHaveLength(1);
  });
});
