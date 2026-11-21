import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerNotaryTools } from "../tools/notary.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

const root = mkdtempSync(join(tmpdir(), "notary-"));
const dir = join(root, "uploads");
mkdirSync(dir);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ZIP = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.from("payload")]);
const DMG = Buffer.concat([Buffer.alloc(100, 1), Buffer.from("koly"), Buffer.alloc(508)]);
writeFileSync(join(dir, "App 1.0.zip"), ZIP);
writeFileSync(join(dir, "App.dmg"), DMG);
writeFileSync(join(dir, "fake.dmg"), Buffer.alloc(600));
writeFileSync(join(dir, "fake.zip"), "plain text");
writeFileSync(join(root, "outside.zip"), ZIP);

const ID = "2efe2717-52ef-43a5-96dc-0797e4ca1041";
const BASE = "https://appstoreconnect.apple.com/notary/v2/submissions";

function collect(allowWrites = true, uploadDir: string | undefined = dir) {
  const tools = new Map<string, Handler>();
  registerNotaryTools(
    {
      tool: (n: string, _d: string, _s: unknown, _a: unknown, h: Handler) => tools.set(n, h),
    } as any,
    new AppStoreConnectClient(async () => "tok"),
    allowWrites,
    uploadDir,
  );
  return tools;
}

function resp(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const created = resp({
  data: {
    type: "newSubmissions",
    id: ID,
    attributes: {
      awsAccessKeyId: "ASIAEXAMPLE",
      awsSecretAccessKey: "secretkey",
      awsSessionToken: "sessiontoken",
      bucket: "notary-bucket",
      object: "prod/AB12/App 1.0.zip",
    },
  },
});

const tools = collect();

describe("notary tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("registers only read tools unless writes are allowed", () => {
    expect([...collect(false).keys()]).toEqual([
      "list_notarization_submissions",
      "get_notarization_submission",
      "get_notarization_log",
    ]);
    expect([...collect(true).keys()].slice(3)).toEqual(["submit_for_notarization"]);
  });

  it("list_notarization_submissions reads the notary host with the API token", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          { type: "submissions", id: ID, attributes: { name: "App.zip", status: "Accepted" } },
        ],
      }),
    );
    const res = await tools.get("list_notarization_submissions")!({});
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(BASE);
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(res.content[0].text!)).toEqual({
      count: 1,
      submissions: [{ id: ID, type: "submissions", name: "App.zip", status: "Accepted" }],
    });
  });

  it("get_notarization_submission returns the status", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({ data: { type: "submissions", id: ID, attributes: { status: "In Progress" } } }),
    );
    const res = await tools.get("get_notarization_submission")!({ submission_id: ID });
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/${ID}`);
    expect(JSON.parse(res.content[0].text!)).toMatchObject({ id: ID, status: "In Progress" });
  });

  it("get_notarization_log downloads the log without the API token", async () => {
    mockFetch
      .mockResolvedValueOnce(
        resp({ data: { attributes: { developerLogUrl: "https://logs.example/log.json?sig=1" } } }),
      )
      .mockResolvedValueOnce(
        resp({ status: "Invalid", issues: [{ severity: "error", path: "App.zip/App.app" }] }),
      );
    const res = await tools.get("get_notarization_log")!({ submission_id: ID });
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/${ID}/logs`);
    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe("https://logs.example/log.json?sig=1");
    expect(init.headers).toBeUndefined();
    expect(JSON.parse(res.content[0].text!)).toEqual({
      status: "Invalid",
      issues: [{ severity: "error", path: "App.zip/App.app" }],
    });
  });

  describe("submit_for_notarization", () => {
    it("registers the hash, finds the bucket region and uploads with signed S3 credentials", async () => {
      mockFetch
        .mockResolvedValueOnce(created)
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          headers: new Headers({ "x-amz-bucket-region": "us-west-2" }),
        })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      const res = await tools.get("submit_for_notarization")!({ file_path: "App 1.0.zip" });
      expect(res.isError).toBeUndefined();
      const sha256 = createHash("sha256").update(ZIP).digest("hex");

      const [createUrl, createInit] = mockFetch.mock.calls[0];
      expect(createUrl).toBe(BASE);
      expect(createInit.method).toBe("POST");
      expect(JSON.parse(createInit.body)).toEqual({ submissionName: "App 1.0.zip", sha256 });

      const [regionUrl, regionInit] = mockFetch.mock.calls[1];
      expect(regionUrl).toBe("https://notary-bucket.s3.amazonaws.com/");
      expect(regionInit.method).toBe("HEAD");
      expect(regionInit.headers).toBeUndefined();

      const [putUrl, putInit] = mockFetch.mock.calls[2];
      expect(putUrl).toBe(
        "https://notary-bucket.s3.us-west-2.amazonaws.com/prod/AB12/App%201.0.zip",
      );
      expect(putInit.method).toBe("PUT");
      expect(putInit.headers["x-amz-content-sha256"]).toBe(sha256);
      expect(putInit.headers["x-amz-security-token"]).toBe("sessiontoken");
      expect(putInit.headers.Authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/\d{8}\/us-west-2\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
      );
      expect(putInit.headers.Authorization).not.toContain("Bearer");
      expect(Buffer.from(await (putInit.body as Blob).arrayBuffer())).toEqual(ZIP);

      expect(res.content[0].text).not.toMatch(/secretkey|sessiontoken|ASIAEXAMPLE/);
      expect(JSON.parse(res.content[0].text!)).toEqual({
        id: ID,
        name: "App 1.0.zip",
        sha256,
        fileSize: ZIP.length,
        status: "In Progress",
      });
    });

    it("falls back to the default region and accepts disk images", async () => {
      mockFetch
        .mockResolvedValueOnce(created)
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValueOnce({ ok: true, status: 200 });
      const res = await tools.get("submit_for_notarization")!({ file_path: "App.dmg" });
      expect(res.isError).toBeUndefined();
      expect(mockFetch.mock.calls[2][0]).toContain(".s3.us-west-2.amazonaws.com/");
    });

    it("names the submission when the upload fails, without leaking credentials", async () => {
      mockFetch
        .mockResolvedValueOnce(created)
        .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers() })
        .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" });
      const res = await tools.get("submit_for_notarization")!({ file_path: "App 1.0.zip" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain(ID);
      expect(res.content[0].text).toContain("403 Forbidden");
      expect(res.content[0].text).not.toMatch(/secretkey|sessiontoken/);
    });

    it("validates the file before the first request", async () => {
      symlinkSync(join(root, "outside.zip"), join(dir, "link.zip"));
      const cases: [string, RegExp][] = [
        ["../outside.zip", /outside ASC_UPLOAD_DIR/],
        ["link.zip", /outside ASC_UPLOAD_DIR/],
        ["App.app", /only \.zip, \.dmg and \.pkg files/],
        ["fake.zip", /not a zip archive/],
        ["fake.dmg", /not a disk image/],
      ];
      for (const [file_path, message] of cases) {
        const res = await tools.get("submit_for_notarization")!({ file_path });
        expect(res.isError, file_path).toBe(true);
        expect(res.content[0].text, file_path).toMatch(message);
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("is disabled without ASC_UPLOAD_DIR", async () => {
      const res = await collect(true, "").get("submit_for_notarization")!({ file_path: "App.dmg" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(
        /submit_for_notarization is disabled because ASC_UPLOAD_DIR/,
      );
    });
  });
});
