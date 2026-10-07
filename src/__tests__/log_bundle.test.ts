import { deflateRawSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupOldArtifactRuns,
  downloadLogBundle,
  extractLogBundle,
  projectLogBundle,
  redactLogText,
  retrieveCiLog,
} from "../ci/log_bundle.js";

interface ZipFixtureEntry {
  name: string;
  text?: string;
  bytes?: Buffer;
  flags?: number;
  method?: number;
  mode?: number;
  crcOverride?: number;
  expandedSizeOverride?: number;
}

let temporaryRoot: string;

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: ZipFixtureEntry[]): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const contents = entry.bytes ?? Buffer.from(entry.text ?? "", "utf8");
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(contents) : contents;
    const flags = entry.flags ?? 0x800;
    const crc = entry.crcOverride ?? crc32(contents);
    const expandedSize = entry.expandedSizeOverride ?? contents.length;
    const descriptor = (flags & 8) !== 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(descriptor ? 0 : crc, 14);
    local.writeUInt32LE(descriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(descriptor ? 0 : expandedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localParts = [local, name, compressed];
    let recordLength = local.length + name.length + compressed.length;
    if (descriptor) {
      const descriptorBytes = Buffer.alloc(16);
      descriptorBytes.writeUInt32LE(0x08074b50, 0);
      descriptorBytes.writeUInt32LE(crc, 4);
      descriptorBytes.writeUInt32LE(compressed.length, 8);
      descriptorBytes.writeUInt32LE(expandedSize, 12);
      localParts.push(descriptorBytes);
      recordLength += descriptorBytes.length;
    }
    localRecords.push(Buffer.concat(localParts));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(expandedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralRecords.push(Buffer.concat([central, name]));
    localOffset += recordLength;
  }
  const centralBytes = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralBytes, eocd]);
}

async function saveZip(name: string, bytes: Buffer): Promise<string> {
  const filePath = path.join(temporaryRoot, name);
  await writeFile(filePath, bytes, { mode: 0o600 });
  return filePath;
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "testflight-mcp-log-bundle-"));
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Xcode Cloud LOG_BUNDLE handling", () => {
  it("extracts a valid deflated archive into owner-only files", async () => {
    const archive = await saveZip(
      "valid.zip",
      buildZip([{ name: "logs/build.log", text: "compile ok\n", method: 8 }]),
    );
    const destination = path.join(temporaryRoot, "extracted");
    await extractLogBundle(archive, destination);
    expect(await readFile(path.join(destination, "logs/build.log"), "utf8")).toBe("compile ok\n");
    expect((await stat(path.join(destination, "logs/build.log"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(destination, "logs"))).mode & 0o777).toBe(0o700);
  });

  it.each(["../outside.txt", "/tmp/outside.txt", "C:/outside.txt", "folder\\outside.txt"])(
    "rejects unsafe archive path %s",
    async (name) => {
      const archive = await saveZip("unsafe.zip", buildZip([{ name, text: "x" }]));
      await expect(
        extractLogBundle(archive, path.join(temporaryRoot, "extracted")),
      ).rejects.toThrow(/unsafe path/u);
    },
  );

  it("rejects control characters in archive paths", async () => {
    const name = `line${String.fromCharCode(10)}break.log`;
    const archive = await saveZip("control-path.zip", buildZip([{ name, text: "x" }]));
    await expect(
      extractLogBundle(archive, path.join(temporaryRoot, "control-path-out")),
    ).rejects.toThrow(/unsafe path/u);
  });

  it("rejects symbolic links and special filesystem entries", async () => {
    const symlink = await saveZip(
      "symlink.zip",
      buildZip([{ name: "link", text: "target", mode: 0o120777 }]),
    );
    await expect(
      extractLogBundle(symlink, path.join(temporaryRoot, "symlink-out")),
    ).rejects.toThrow(/symbolic link/u);
    const fifo = await saveZip("fifo.zip", buildZip([{ name: "pipe", text: "", mode: 0o010644 }]));
    await expect(extractLogBundle(fifo, path.join(temporaryRoot, "fifo-out"))).rejects.toThrow(
      /symbolic link or special/u,
    );
  });

  it("rejects encrypted and unsupported-compression entries", async () => {
    const encrypted = await saveZip(
      "encrypted.zip",
      buildZip([{ name: "a.log", text: "x", flags: 0x801 }]),
    );
    await expect(
      extractLogBundle(encrypted, path.join(temporaryRoot, "encrypted-out")),
    ).rejects.toThrow(/Encrypted/u);
    const unsupported = await saveZip(
      "unsupported.zip",
      buildZip([{ name: "a.log", text: "x", method: 12 }]),
    );
    await expect(
      extractLogBundle(unsupported, path.join(temporaryRoot, "unsupported-out")),
    ).rejects.toThrow(/compression method/u);
  });

  it("rejects invalid CRCs, truncated ZIPs, and truncated data descriptors", async () => {
    const badCrc = await saveZip(
      "bad-crc.zip",
      buildZip([{ name: "a.log", text: "x", crcOverride: 123 }]),
    );
    await expect(extractLogBundle(badCrc, path.join(temporaryRoot, "bad-crc-out"))).rejects.toThrow(
      /CRC/u,
    );
    const valid = buildZip([{ name: "a.log", text: "x" }]);
    const truncated = await saveZip("truncated.zip", valid.subarray(0, valid.length - 8));
    await expect(
      extractLogBundle(truncated, path.join(temporaryRoot, "truncated-out")),
    ).rejects.toThrow(/end record/u);
    const descriptor = buildZip([{ name: "a.log", text: "x", flags: 0x808 }]);
    const brokenDescriptor = await saveZip(
      "descriptor.zip",
      descriptor.subarray(0, descriptor.length - 10),
    );
    await expect(
      extractLogBundle(brokenDescriptor, path.join(temporaryRoot, "descriptor-out")),
    ).rejects.toThrow(/end record|truncated|bounds/u);
  });

  it("rejects excessive entry counts and expanded sizes before extraction", async () => {
    const manyEntries = await saveZip(
      "many.zip",
      buildZip(Array.from({ length: 10_001 }, (_, index) => ({ name: `entry-${index}.txt` }))),
    );
    await expect(
      extractLogBundle(manyEntries, path.join(temporaryRoot, "many-out")),
    ).rejects.toThrow(/extraction limits/u);
    const oversized = await saveZip(
      "oversized.zip",
      buildZip([{ name: "huge.log", text: "x", expandedSizeOverride: 256 * 1024 * 1024 + 1 }]),
    );
    await expect(
      extractLogBundle(oversized, path.join(temporaryRoot, "oversized-out")),
    ).rejects.toThrow(/extraction limits/u);
    const expandedTotal = await saveZip(
      "total.zip",
      buildZip(
        Array.from({ length: 5 }, (_, index) => ({
          name: `${index}.log`,
          expandedSizeOverride: 220 * 1024 * 1024,
        })),
      ),
    );
    await expect(
      extractLogBundle(expandedTotal, path.join(temporaryRoot, "total-out")),
    ).rejects.toThrow(/expands beyond/u);
  });

  it("supports data descriptors and skips binary files in the text projection", async () => {
    const archive = await saveZip(
      "descriptor-valid.zip",
      buildZip([
        {
          name: "ci_post_clone.log",
          text: "clone started\nerror: missing dependency\n",
          flags: 0x808,
        },
        { name: "crash.log", bytes: Buffer.from([0, 1, 2, 3]) },
      ]),
    );
    const destination = path.join(temporaryRoot, "projection");
    await extractLogBundle(archive, destination);
    const logs = await projectLogBundle(destination, 1, "Archive");
    expect(logs).toEqual([
      expect.objectContaining({
        path: "ci_post_clone.log",
        text: "error: missing dependency",
        lineCount: 2,
        truncated: true,
      }),
    ]);
  });

  it("redacts signed URLs, bearer tokens, PEM keys, email addresses, and the home path", () => {
    const home = process.env.HOME || "/Users/example";
    const githubToken = `ghp_${"1234567890".repeat(4)}`;
    const openAiToken = `sk-${"1234567890".repeat(4)}`;
    const privateKey = [
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      "secret",
      ["-----END", "PRIVATE KEY-----"].join(" "),
    ].join("\n");
    const text = redactLogText(
      `Bearer abc.def\nhttps://example.test/log?token=signed-value\n${home}/private\nuser@example.test\napi_key: profile-secret\n${githubToken}\n${openAiToken}\n${privateKey}`,
    );
    expect(text).not.toContain("signed-value");
    expect(text).not.toContain("abc.def");
    expect(text).not.toContain(`${home}/private`);
    expect(text).not.toContain("user@example.test");
    expect(text).not.toContain("profile-secret");
    expect(text).not.toContain(githubToken);
    expect(text).not.toContain(openAiToken);
    expect(text).not.toContain("secret\n-----END");
  });

  it("downloads without an Authorization header and returns only bounded, redacted text", async () => {
    const archive = buildZip([
      {
        name: "ci_post_clone.log",
        text: [
          "starting",
          `error: ${process.env.HOME || "/Users/example"}/workspace`,
          "https://example.test/log?signature=private",
          "line 4",
          "line 5",
        ].join("\n"),
      },
    ]);
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        expect(init?.redirect).toBe("error");
        expect(init?.headers).toEqual({ Accept: "application/zip, application/octet-stream" });
        return new Response(Uint8Array.from(archive), {
          headers: { "content-type": "application/zip" },
        });
      },
    );
    const result = await retrieveCiLog(
      {
        id: "artifact-1",
        fileName: "Logs.zip",
        fileSize: archive.length,
        downloadUrl: "https://example.test/download?signature=private",
      },
      3,
      "Archive",
      { artifactRoot: path.join(temporaryRoot, "private", "artifacts"), fetcher },
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.artifact).toEqual({
      id: "artifact-1",
      fileName: "Logs.zip",
      fileSize: archive.length,
    });
    expect(result.logs[0].text).toContain("line 5");
    expect(result.logs[0].text).not.toContain("signature=private");
    expect(result.logs[0].text).not.toContain(process.env.HOME || "/Users/example");
    expect(JSON.stringify(result)).not.toContain("/private/artifacts");
  });

  it("rejects insecure download URLs and removes a partial download", async () => {
    const fetcher = vi.fn();
    await expect(
      downloadLogBundle(
        { id: "a", downloadUrl: "http://example.test/a.zip" },
        path.join(temporaryRoot, "insecure.zip"),
        1000,
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow(/not allowed/u);
    await expect(
      downloadLogBundle(
        { id: "a", downloadUrl: "https://user:pass@example.test/a.zip" },
        path.join(temporaryRoot, "credentials.zip"),
        1000,
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow(/not allowed/u);
    expect(fetcher).not.toHaveBeenCalled();

    const failingFetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from("partial"));
              controller.error(new Error("network failure"));
            },
          }),
        ),
    );
    const partialPath = path.join(temporaryRoot, "partial.zip");
    await expect(
      downloadLogBundle(
        { id: "a", downloadUrl: "https://example.test/a.zip" },
        partialPath,
        1000,
        failingFetcher as typeof fetch,
      ),
    ).rejects.toThrow("Artifact download failed.");
    await expect(stat(partialPath)).rejects.toThrow();
  });

  it("rejects downloads over the hard Content-Length limit", async () => {
    const response = new Response("", {
      headers: { "content-length": String(1024 * 1024 * 1024 + 1) },
    });
    const fetcher = vi.fn(async () => response);
    await expect(
      downloadLogBundle(
        { id: "a", downloadUrl: "https://example.test/a.zip" },
        path.join(temporaryRoot, "large.zip"),
        1000,
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow(/size limit/u);
  });

  it("cleans only expired marked artifact runs", async () => {
    const root = path.join(temporaryRoot, "artifacts");
    const managed = path.join(root, "run-old");
    const unmanaged = path.join(root, "other-old");
    await mkdir(managed, { recursive: true });
    await mkdir(unmanaged, { recursive: true });
    await writeFile(
      path.join(managed, ".testflight-mcp-managed"),
      "testflight-mcp managed artifact run\n",
      { mode: 0o600 },
    );
    await writeFile(path.join(managed, "old.zip"), "x");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(managed, old, old);
    await utimes(unmanaged, old, old);
    await cleanupOldArtifactRuns(root);
    expect(await readdir(root)).toEqual(["other-old"]);
  });
});
