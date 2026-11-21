import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerReviewTools } from "../tools/reviews.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

function collect(allowWrites = true) {
  const tools = new Map<string, Handler>();
  registerReviewTools(
    {
      tool: (n: string, _d: string, _s: unknown, _a: unknown, h: Handler) => tools.set(n, h),
    } as any,
    new AppStoreConnectClient(async () => "tok"),
    allowWrites,
  );
  return tools;
}

const tools = collect();

describe("review tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("registers nothing unless writes are allowed", () => {
    expect([...collect(false).keys()]).toEqual([]);
    expect([...collect(true).keys()]).toEqual([
      "reply_to_customer_review",
      "delete_customer_review_response",
    ]);
  });

  it("reply_to_customer_review posts the response for the review", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () =>
        Promise.resolve({
          data: {
            type: "customerReviewResponses",
            id: "r1",
            attributes: { responseBody: "Thanks!", state: "PENDING_PUBLISH" },
          },
        }),
    });
    const res = await tools.get("reply_to_customer_review")!({
      review_id: "rev1",
      response_body: "Thanks!",
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(new URL(url).pathname).toBe("/v1/customerReviewResponses");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      data: {
        type: "customerReviewResponses",
        attributes: { responseBody: "Thanks!" },
        relationships: { review: { data: { type: "customerReviews", id: "rev1" } } },
      },
    });
    expect(JSON.parse(res.content[0].text!)).toEqual({
      id: "r1",
      type: "customerReviewResponses",
      responseBody: "Thanks!",
      state: "PENDING_PUBLISH",
    });
  });

  it("delete_customer_review_response deletes the response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });
    const res = await tools.get("delete_customer_review_response")!({ response_id: "r1" });
    const [url, init] = mockFetch.mock.calls[0];
    expect(new URL(url).pathname).toBe("/v1/customerReviewResponses/r1");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(res.content[0].text!)).toEqual({ deleted: "r1" });
  });

  it("reports Apple errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: "Conflict",
      text: () => Promise.resolve("ENTITY_ERROR"),
    });
    const res = await tools.get("reply_to_customer_review")!({
      review_id: "x",
      response_body: "y",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("ENTITY_ERROR");
  });
});
