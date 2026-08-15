import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerTestFlightTools } from "../tools/testflight.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect() {
  const tools = new Map<string, Handler>();
  registerTestFlightTools(
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

describe("testflight tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  function route(routes: Record<string, unknown>) {
    mockFetch.mockImplementation((url: string) => {
      const { pathname } = new URL(url);
      if (!(pathname in routes)) throw new Error(`unexpected request to ${pathname}`);
      return Promise.resolve(resp(routes[pathname]));
    });
  }

  function urlFor(path: string) {
    const call = mockFetch.mock.calls.find((c) => new URL(c[0]).pathname === path);
    if (!call) throw new Error(`no request to ${path}`);
    return new URL(call[0]);
  }

  it("get_build_status combines beta detail, review submission and what to test", async () => {
    route({
      "/v1/buildBetaDetails": {
        data: [
          {
            type: "buildBetaDetails",
            id: "d1",
            attributes: {
              internalBuildState: "READY_FOR_BETA_TESTING",
              externalBuildState: "IN_BETA_REVIEW",
            },
          },
        ],
      },
      "/v1/betaAppReviewSubmissions": {
        data: [
          {
            type: "betaAppReviewSubmissions",
            id: "s1",
            attributes: { betaReviewState: "IN_REVIEW", submittedDate: "2026-08-01T10:00:00Z" },
          },
        ],
      },
      "/v1/betaBuildLocalizations": {
        data: [
          {
            type: "betaBuildLocalizations",
            id: "l1",
            attributes: { locale: "en-US", whatsNew: "Fixed the sync bug" },
          },
        ],
      },
    });
    const res = await tools.get("get_build_status")!({ build_id: "B1" });
    expect(urlFor("/v1/buildBetaDetails").searchParams.get("filter[build]")).toBe("B1");
    expect(urlFor("/v1/betaAppReviewSubmissions").searchParams.get("filter[build]")).toBe("B1");
    const payload = JSON.parse(res.content[0].text!);
    expect(payload.buildBetaDetail).toMatchObject({ externalBuildState: "IN_BETA_REVIEW" });
    expect(payload.betaAppReviewSubmission).toMatchObject({ betaReviewState: "IN_REVIEW" });
    expect(payload.whatToTest[0]).toMatchObject({
      locale: "en-US",
      whatsNew: "Fixed the sync bug",
    });
  });

  it("get_build_status returns nulls when there is nothing to report", async () => {
    route({
      "/v1/buildBetaDetails": { data: [] },
      "/v1/betaAppReviewSubmissions": { data: [] },
      "/v1/betaBuildLocalizations": { data: [] },
    });
    const payload = JSON.parse(
      (await tools.get("get_build_status")!({ build_id: "B1" })).content[0].text!,
    );
    expect(payload).toEqual({
      buildId: "B1",
      buildBetaDetail: null,
      betaAppReviewSubmission: null,
      whatToTest: [],
    });
  });

  it("list_beta_app_localizations filters by app and locale", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "betaAppLocalizations",
            id: "l1",
            attributes: { locale: "en-US", feedbackEmail: "beta@acme.test" },
          },
        ],
      }),
    );
    const res = await tools.get("list_beta_app_localizations")!({
      app_id: "APP1",
      locale: "en-US",
    });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/betaAppLocalizations");
    expect(parsed.searchParams.get("filter[app]")).toBe("APP1");
    expect(parsed.searchParams.get("filter[locale]")).toBe("en-US");
    expect(JSON.parse(res.content[0].text!).localizations[0].feedbackEmail).toBe("beta@acme.test");
  });

  it("get_beta_app_review_detail never requests the demo account password", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "betaAppReviewDetails",
            id: "r1",
            attributes: { contactEmail: "dev@acme.test", demoAccountRequired: false },
          },
        ],
      }),
    );
    const res = await tools.get("get_beta_app_review_detail")!({ app_id: "APP1" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/betaAppReviewDetails");
    expect(parsed.searchParams.get("fields[betaAppReviewDetails]")).not.toContain(
      "demoAccountPassword",
    );
    expect(JSON.parse(res.content[0].text!).contactEmail).toBe("dev@acme.test");
  });

  it("get_build_usage_metrics passes the metric data through", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "betaBuildUsages",
            dataPoints: [
              {
                start: "2026-07-15",
                end: "2026-08-15",
                values: { installCount: 180, crashCount: 4, feedbackCount: 23 },
              },
            ],
          },
        ],
      }),
    );
    const res = await tools.get("get_build_usage_metrics")!({ build_id: "B1" });
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe(
      "/v1/builds/B1/metrics/betaBuildUsages",
    );
    const payload = JSON.parse(res.content[0].text!);
    expect(payload.metrics[0].dataPoints[0].values).toEqual({
      installCount: 180,
      crashCount: 4,
      feedbackCount: 23,
    });
  });

  it("get_beta_tester_metrics groups by tester and defaults the period", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("get_beta_tester_metrics")!({ app_id: "APP1" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/apps/APP1/metrics/betaTesterUsages");
    expect(parsed.searchParams.get("groupBy")).toBe("betaTesters");
    expect(parsed.searchParams.get("period")).toBe("P30D");
  });

  it("get_beta_tester_metrics uses the beta group endpoint when given a group", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("get_beta_tester_metrics")!({ group_id: "G1", tester_id: "T1", period: "P7D" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/betaGroups/G1/metrics/betaTesterUsages");
    expect(parsed.searchParams.get("filter[betaTesters]")).toBe("T1");
    expect(parsed.searchParams.get("period")).toBe("P7D");
  });

  it("get_beta_tester_metrics errors without an app or group", async () => {
    const res = await tools.get("get_beta_tester_metrics")!({});
    expect(res.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
