import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_COUNT = 10_000;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TEXT_TAIL_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESPONSE_FILES = 10;
const MAX_ARTIFACT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MANAGED_MARKER = ".testflight-mcp-managed";
const LOG_EXTENSIONS = new Set([".log", ".txt", ".json", ".out", ".err"]);

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index++) {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  crcTable[index] = crc >>> 0;
}

export interface LogBundleArtifact {
  id: string;
  fileName?: string;
  fileSize?: number;
  downloadUrl: string;
}

export interface ProjectedLog {
  path: string;
  text: string;
  lineCount: number;
  truncated: boolean;
}

interface ZipEntry {
  archiveName: string;
  relativePath: string;
  isDirectory: boolean;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  expandedSize: number;
  localOffset: number;
  dataOffset: number;
  dataEnd: number;
  recordEnd: number;
}

interface LogCandidate extends ProjectedLog {
  priority: number;
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function defaultArtifactRoot(): string {
  return path.join(repoRoot(), ".local", "artifacts");
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Artifact directory is not a private directory.");
  }
  await chmod(directory, 0o700);
}

async function createManagedRunDirectory(artifactRoot: string): Promise<string> {
  const localRoot = path.dirname(artifactRoot);
  await ensurePrivateDirectory(localRoot);
  await ensurePrivateDirectory(artifactRoot);
  await cleanupOldArtifactRuns(artifactRoot);
  const runDirectory = await mkdtemp(path.join(artifactRoot, "run-"));
  await chmod(runDirectory, 0o700);
  try {
    await writeFile(
      path.join(runDirectory, MANAGED_MARKER),
      "testflight-mcp managed artifact run\n",
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  } catch {
    await rm(runDirectory, { recursive: true, force: true });
    throw new Error("Could not create a private artifact directory.");
  }
  return runDirectory;
}

export async function cleanupOldArtifactRuns(
  artifactRoot: string,
  now = Date.now(),
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(artifactRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Could not inspect the private artifact directory.", { cause: error });
  }
  for (const name of names) {
    const candidate = path.join(artifactRoot, name);
    try {
      const info = await lstat(candidate);
      if (!info.isDirectory() || info.isSymbolicLink() || now - info.mtimeMs <= MAX_ARTIFACT_AGE_MS)
        continue;
      const markerPath = path.join(candidate, MANAGED_MARKER);
      const markerInfo = await lstat(markerPath);
      if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) continue;
      if ((await readFile(markerPath, "utf8")) !== "testflight-mcp managed artifact run\n")
        continue;
      await rm(candidate, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
  }
}

function validateDownloadUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Artifact download URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Artifact download URL is not allowed.");
  }
  return url;
}

export async function downloadLogBundle(
  artifact: LogBundleArtifact,
  outputPath: string,
  timeoutMs = 60_000,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const url = validateDownloadUrl(artifact.downloadUrl);
  let response: Response;
  try {
    // A signed URL is itself a credential, so do not attach the App Store token or follow redirects.
    response = await fetcher(url, {
      headers: { Accept: "application/zip, application/octet-stream" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("Artifact download failed.");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Artifact download failed.");
  }

  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    if (!/^\d+$/u.test(lengthHeader) || Number(lengthHeader) > MAX_ARCHIVE_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new Error("Artifact exceeds the download size limit.");
    }
  }

  let size = 0;
  const file = await open(outputPath, "wx", 0o600);
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_ARCHIVE_BYTES) throw new Error("Artifact exceeds the download size limit.");
      await file.writeFile(bytes);
    }
    if (size === 0) throw new Error("Artifact download is empty.");
    await file.sync();
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(outputPath, { force: true });
    throw error instanceof Error && /size limit/u.test(error.message)
      ? error
      : new Error("Artifact download failed.");
  }
  await file.close();
  await chmod(outputPath, 0o600);
  return size;
}

async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    throw new Error("Invalid ZIP bounds.");
  }
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error("ZIP archive is truncated.");
    offset += result.bytesRead;
  }
  return buffer;
}

function decodeZipName(bytes: Buffer, flags: number): string {
  if (!(flags & 0x800) && bytes.some((byte) => byte > 0x7f)) {
    throw new Error("ZIP filenames must use UTF-8 encoding.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("ZIP filename is invalid.");
  }
}

function normalizeZipPath(name: string): { relativePath: string; trailingSlash: boolean } {
  // ZIP names are untrusted filesystem paths; reject forms that escape or normalize differently across platforms.
  if (
    !name ||
    /\p{Cc}/u.test(name) ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/u.test(name)
  ) {
    throw new Error("ZIP contains an unsafe path.");
  }
  const trailingSlash = name.endsWith("/");
  const source = trailingSlash ? name.slice(0, -1) : name;
  const segments = source.split("/");
  const cleanSegments: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (
      segment === ".." ||
      segment.includes(":") ||
      segment.endsWith(".") ||
      segment.endsWith(" ")
    ) {
      throw new Error("ZIP contains an unsafe path.");
    }
    cleanSegments.push(segment);
  }
  if (cleanSegments.length === 0) throw new Error("ZIP contains an unsafe path.");
  return { relativePath: cleanSegments.join("/"), trailingSlash };
}

function validateExtraFields(extra: Buffer): void {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw new Error("ZIP extra field is malformed.");
    const fieldId = extra.readUInt16LE(offset);
    const fieldLength = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + fieldLength > extra.length) throw new Error("ZIP extra field is malformed.");
    if (fieldId === 0x0001 || fieldId === 0x9901)
      throw new Error("ZIP64 and encrypted ZIP entries are unsupported.");
    offset += fieldLength;
  }
}

async function readZipEntries(archivePath: string): Promise<ZipEntry[]> {
  const info = await stat(archivePath);
  if (!info.isFile() || info.size < 22 || info.size > MAX_ARCHIVE_BYTES) {
    throw new Error("ZIP archive size is invalid.");
  }
  const handle = await open(archivePath, "r");
  try {
    const tailLength = Math.min(info.size, 65_557);
    const tailStart = info.size - tailLength;
    const tail = await readAt(handle, tailStart, tailLength);
    let eocdOffset = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) !== 0x06054b50) continue;
      const commentLength = tail.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === tail.length) {
        eocdOffset = tailStart + offset;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error("ZIP end record is missing or malformed.");
    if (eocdOffset >= 20) {
      const locator = await readAt(handle, eocdOffset - 20, 4);
      if (locator.readUInt32LE(0) === 0x07064b50)
        throw new Error("ZIP64 archives are unsupported.");
    }
    const eocd = await readAt(handle, eocdOffset, 22);
    if (eocd.readUInt16LE(4) !== 0 || eocd.readUInt16LE(6) !== 0)
      throw new Error("Multi-disk ZIP archives are unsupported.");
    const entriesOnDisk = eocd.readUInt16LE(8);
    const entryCount = eocd.readUInt16LE(10);
    const centralSize = eocd.readUInt32LE(12);
    const centralOffset = eocd.readUInt32LE(16);
    if (
      entriesOnDisk !== entryCount ||
      entryCount === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      throw new Error("ZIP64 and multi-disk archives are unsupported.");
    }
    if (entryCount > MAX_ENTRY_COUNT || centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new Error("ZIP archive exceeds the extraction limits.");
    }
    if (centralOffset + centralSize !== eocdOffset)
      throw new Error("ZIP central directory bounds are invalid.");

    const central = await readAt(handle, centralOffset, centralSize);
    const entries: ZipEntry[] = [];
    const seenPaths = new Set<string>();
    let expandedTotal = 0;
    let offset = 0;
    for (let index = 0; index < entryCount; index++) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) {
        throw new Error("ZIP central directory is malformed.");
      }
      const flags = central.readUInt16LE(offset + 8);
      const method = central.readUInt16LE(offset + 10);
      const crc32 = central.readUInt32LE(offset + 16);
      const compressedSize = central.readUInt32LE(offset + 20);
      const expandedSize = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const diskStart = central.readUInt16LE(offset + 34);
      const externalAttributes = central.readUInt32LE(offset + 38);
      const localOffset = central.readUInt32LE(offset + 42);
      const recordLength = 46 + nameLength + extraLength + commentLength;
      if (offset + recordLength > central.length || nameLength === 0 || nameLength > 4096) {
        throw new Error("ZIP central directory entry is malformed.");
      }
      const nameBytes = central.subarray(offset + 46, offset + 46 + nameLength);
      const extra = central.subarray(
        offset + 46 + nameLength,
        offset + 46 + nameLength + extraLength,
      );
      validateExtraFields(extra);
      if (
        diskStart !== 0 ||
        compressedSize === 0xffffffff ||
        expandedSize === 0xffffffff ||
        localOffset === 0xffffffff
      ) {
        throw new Error("ZIP64 and multi-disk entries are unsupported.");
      }
      if ((flags & (1 | 0x40 | 0x2000)) !== 0 || (flags & ~(8 | 0x800 | 6)) !== 0) {
        throw new Error("Encrypted or unsupported ZIP entry flags are present.");
      }
      if (method !== 0 && method !== 8) throw new Error("ZIP compression method is unsupported.");
      if (method === 0 && (flags & 6) !== 0)
        throw new Error("ZIP compression flags are unsupported.");
      if (compressedSize > MAX_ARCHIVE_BYTES || expandedSize > MAX_ENTRY_BYTES) {
        throw new Error("ZIP entry exceeds the extraction limits.");
      }
      expandedTotal += expandedSize;
      if (expandedTotal > MAX_EXPANDED_BYTES)
        throw new Error("ZIP archive expands beyond the extraction limit.");

      const archiveName = decodeZipName(nameBytes, flags);
      const { relativePath, trailingSlash } = normalizeZipPath(archiveName);
      const canonicalPath = relativePath.normalize("NFC").toLowerCase();
      if (seenPaths.has(canonicalPath)) throw new Error("ZIP contains duplicate paths.");
      seenPaths.add(canonicalPath);
      const unixMode = (externalAttributes >>> 16) & 0xffff;
      const unixType: number = unixMode & 0o170000;
      if (![0, 0o100000, 0o040000].includes(unixType)) {
        throw new Error("ZIP contains a symbolic link or special filesystem entry.");
      }
      if ((externalAttributes & 0x408) !== 0)
        throw new Error("ZIP contains a reparse point or special filesystem entry.");
      const dosDirectory = (externalAttributes & 0x10) !== 0;
      const isPosixDirectory = [0o040000].includes(unixType);
      const isDirectory = trailingSlash || isPosixDirectory || dosDirectory;
      if (isDirectory && expandedSize !== 0)
        throw new Error("ZIP directory entry has file contents.");

      const localHeader = await readAt(handle, localOffset, 30);
      if (localHeader.readUInt32LE(0) !== 0x04034b50)
        throw new Error("ZIP local header is malformed.");
      const localFlags = localHeader.readUInt16LE(6);
      const localMethod = localHeader.readUInt16LE(8);
      const localNameLength = localHeader.readUInt16LE(26);
      const localExtraLength = localHeader.readUInt16LE(28);
      if (localFlags !== flags || localMethod !== method || localNameLength !== nameLength) {
        throw new Error("ZIP local and central headers disagree.");
      }
      const localName = await readAt(handle, localOffset + 30, localNameLength);
      if (!localName.equals(nameBytes))
        throw new Error("ZIP local and central filenames disagree.");
      const localExtra = await readAt(handle, localOffset + 30 + localNameLength, localExtraLength);
      validateExtraFields(localExtra);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataOffset + compressedSize;
      if (dataEnd > centralOffset || dataEnd < dataOffset)
        throw new Error("ZIP entry data bounds are invalid.");
      let recordEnd = dataEnd;
      if (!(flags & 8)) {
        if (
          localHeader.readUInt32LE(14) !== crc32 ||
          localHeader.readUInt32LE(18) !== compressedSize ||
          localHeader.readUInt32LE(22) !== expandedSize
        ) {
          throw new Error("ZIP local and central sizes disagree.");
        }
      } else {
        const descriptorPrefix = await readAt(handle, dataEnd, 4);
        const hasSignature = descriptorPrefix.readUInt32LE(0) === 0x08074b50;
        const descriptorLength = hasSignature ? 16 : 12;
        if (dataEnd + descriptorLength > centralOffset)
          throw new Error("ZIP data descriptor is truncated.");
        const descriptor = await readAt(handle, dataEnd + (hasSignature ? 4 : 0), 12);
        if (
          descriptor.readUInt32LE(0) !== crc32 ||
          descriptor.readUInt32LE(4) !== compressedSize ||
          descriptor.readUInt32LE(8) !== expandedSize
        ) {
          throw new Error("ZIP data descriptor disagrees with the central directory.");
        }
        recordEnd = dataEnd + descriptorLength;
      }
      if (isDirectory && (compressedSize !== 0 || crc32 !== 0 || method !== 0)) {
        throw new Error("ZIP directory entry is malformed.");
      }
      entries.push({
        archiveName,
        relativePath,
        isDirectory,
        method,
        flags,
        crc32,
        compressedSize,
        expandedSize,
        localOffset,
        dataOffset,
        dataEnd,
        recordEnd,
      });
      offset += recordLength;
    }
    if (offset !== central.length) throw new Error("ZIP central directory length is invalid.");
    const ranges = entries
      .map((entry) => ({ start: entry.localOffset, end: entry.recordEnd }))
      .sort((left, right) => left.start - right.start);
    for (let index = 1; index < ranges.length; index++) {
      if (ranges[index].start < ranges[index - 1].end) throw new Error("ZIP entries overlap.");
    }
    return entries;
  } finally {
    await handle.close();
  }
}

function crc32Update(previous: number, bytes: Buffer): number {
  let crc = previous ^ 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function ensureSafeParent(root: string, relativePath: string): Promise<string> {
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("ZIP extraction parent is unsafe.");
    await chmod(current, 0o700);
  }
  return path.join(current, segments.at(-1)!);
}

async function extractEntry(archivePath: string, root: string, entry: ZipEntry): Promise<void> {
  const destination = await ensureSafeParent(root, entry.relativePath);
  if (entry.isDirectory) {
    await mkdir(destination, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("ZIP directory entry conflicts with a file.");
    await chmod(destination, 0o700);
    return;
  }

  const info = await lstat(path.dirname(destination));
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("ZIP extraction parent is unsafe.");
  let crc = 0;
  let expandedBytes = 0;
  const validator = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      expandedBytes += chunk.byteLength;
      if (expandedBytes > entry.expandedSize || expandedBytes > MAX_ENTRY_BYTES) {
        callback(new Error("ZIP entry expanded beyond its declared size."));
        return;
      }
      crc = crc32Update(crc, chunk);
      callback(null, chunk);
    },
  });
  const input =
    entry.compressedSize === 0
      ? Readable.from([])
      : createReadStream(archivePath, { start: entry.dataOffset, end: entry.dataEnd - 1 });
  try {
    const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
    if (entry.method === 8) await pipeline(input, createInflateRaw(), validator, output);
    else await pipeline(input, validator, output);
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
  if (expandedBytes !== entry.expandedSize || crc !== entry.crc32) {
    await rm(destination, { force: true });
    throw new Error("ZIP entry CRC or expanded size is invalid.");
  }
  await chmod(destination, 0o600);
}

export async function extractLogBundle(archivePath: string, destination: string): Promise<void> {
  const entries = await readZipEntries(archivePath);
  await ensurePrivateDirectory(destination);
  for (const entry of entries) await extractEntry(archivePath, destination, entry);
}

async function listRegularFiles(root: string, current = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === MANAGED_MARKER) continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) output.push(...(await listRegularFiles(root, fullPath)));
    else if (entry.isFile()) output.push(fullPath);
  }
  return output;
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    if (url.search) url.search = "?REDACTED";
    if (url.hash) url.hash = "";
    return url.toString();
  } catch {
    return "[REDACTED URL]";
  }
}

export function redactLogText(input: string, sensitiveValues: string[] = []): string {
  let text = input.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu,
    "[REDACTED PRIVATE KEY]",
  );
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]");
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    "[REDACTED JWT]",
  );
  text = text.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/giu,
    "[REDACTED TOKEN]",
  );
  text = text.replace(/https?:\/\/[^\s"'<>]+/giu, redactUrl);
  text = text.replace(
    /\b([A-Z0-9_.-]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|TEAM_ID|ASC_KEY_ID|ASC_ISSUER_ID)[A-Z0-9_.-]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    "$1=[REDACTED]",
  );
  const home = process.env.HOME || homedir();
  if (home) text = text.split(home).join("~");
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED EMAIL]");
  for (const value of sensitiveValues) {
    if (value) text = text.split(value).join("[REDACTED]");
  }
  for (const name of ["ASC_PRIVATE_KEY", "CONTROL_PLANE_API_KEY", "TESTFLIGHT_MCP_API_KEY"]) {
    const value = process.env[name];
    if (value) text = text.split(value).join("[REDACTED]");
  }
  return text;
}

async function inspectTextCandidate(
  filePath: string,
  root: string,
  maxLines: number,
  actionName: string,
): Promise<LogCandidate | null> {
  const info = await stat(filePath);
  if (info.size > MAX_TEXT_FILE_BYTES) return null;
  const extension = path.extname(filePath).toLowerCase();
  if (!LOG_EXTENSIONS.has(extension)) return null;

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let tail = "";
  let lineCount = 0;
  let lastCharacter = "";
  let carry = "";
  let hasNul = false;
  let hasError = false;
  let hasFailure = false;
  let hasActionName = false;
  const actionNeedle = actionName.trim().toLowerCase();
  try {
    for await (const chunkValue of createReadStream(filePath)) {
      const chunk = Buffer.from(chunkValue);
      if (chunk.includes(0)) hasNul = true;
      const decoded = decoder.decode(chunk, { stream: true });
      const scan = carry + decoded;
      const lowered = scan.toLowerCase();
      if (/\b(error|errors|fatal)\b/u.test(lowered)) hasError = true;
      if (/\b(failed|failure|exit code|terminated with code)\b/u.test(lowered)) hasFailure = true;
      if (actionNeedle && lowered.includes(actionNeedle)) hasActionName = true;
      carry = scan.slice(-Math.max(actionNeedle.length, 64));
      const newlineCount = (decoded.match(/\n/gu) ?? []).length;
      lineCount += newlineCount;
      if (decoded) lastCharacter = decoded.at(-1)!;
      tail += decoded;
      if (Buffer.byteLength(tail, "utf8") > MAX_TEXT_TAIL_BYTES) {
        const bytes = Buffer.from(tail, "utf8").subarray(-MAX_TEXT_TAIL_BYTES);
        tail = bytes.toString("utf8");
        const firstLineBreak = tail.indexOf("\n");
        if (firstLineBreak >= 0) tail = tail.slice(firstLineBreak + 1);
      }
    }
    const finalChunk = decoder.decode();
    if (finalChunk) {
      lineCount += (finalChunk.match(/\n/gu) ?? []).length;
      lastCharacter = finalChunk.at(-1)!;
      tail += finalChunk;
    }
  } catch {
    return null;
  }
  if (hasNul) return null;
  if (lastCharacter && lastCharacter !== "\n") lineCount++;
  const allLines = tail.split(/\r?\n/u);
  if (tail.endsWith("\n")) allLines.pop();
  const truncatedByLines = allLines.length > maxLines;
  let text = allLines.slice(-maxLines).join("\n");
  const truncatedByBytes = info.size > MAX_TEXT_TAIL_BYTES;
  if (truncatedByBytes && text) text = `[Earlier log content omitted]\n${text}`;
  const relativePath = path.relative(root, filePath).split(path.sep).join("/");
  const priority =
    (hasActionName ? 8 : 0) +
    (hasFailure ? 6 : 0) +
    (hasError ? 4 : 0) +
    (extension === ".log" ? 2 : 0);
  return {
    path: redactLogText(relativePath),
    text: redactLogText(text),
    lineCount,
    truncated: truncatedByLines || truncatedByBytes,
    priority,
  };
}

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  bytes = bytes.subarray(0, maxBytes);
  for (let trim = 0; trim < 4; trim++) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytes.length - trim),
      );
    } catch {
      continue;
    }
  }
  return "";
}

export async function projectLogBundle(
  root: string,
  maxLines: number,
  actionName = "",
): Promise<ProjectedLog[]> {
  const candidates: LogCandidate[] = [];
  for (const filePath of await listRegularFiles(root)) {
    const candidate = await inspectTextCandidate(filePath, root, maxLines, actionName);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort(
    (left, right) => right.priority - left.priority || left.path.localeCompare(right.path),
  );

  const output: ProjectedLog[] = [];
  let remainingBytes = MAX_RESPONSE_BYTES;
  for (const candidate of candidates.slice(0, MAX_RESPONSE_FILES)) {
    const text = truncateUtf8(candidate.text, Math.max(0, remainingBytes));
    const usedBytes = Buffer.byteLength(text, "utf8");
    if (usedBytes === 0 && remainingBytes === 0) break;
    output.push({
      path: candidate.path,
      text,
      lineCount: candidate.lineCount,
      truncated: candidate.truncated || usedBytes < Buffer.byteLength(candidate.text, "utf8"),
    });
    remainingBytes = Math.max(0, remainingBytes - usedBytes);
  }
  return output;
}

export async function retrieveCiLog(
  artifact: LogBundleArtifact,
  maxLines: number,
  actionName: string,
  options: { artifactRoot?: string; timeoutMs?: number; fetcher?: typeof fetch } = {},
): Promise<{
  artifact: { id: string; fileName?: string; fileSize?: number };
  logs: ProjectedLog[];
}> {
  const artifactRoot = options.artifactRoot ?? defaultArtifactRoot();
  const runDirectory = await createManagedRunDirectory(artifactRoot);
  const archivePath = path.join(runDirectory, `bundle-${randomBytes(8).toString("hex")}.zip`);
  const extractionDirectory = path.join(runDirectory, "extracted");
  try {
    await downloadLogBundle(artifact, archivePath, options.timeoutMs, options.fetcher);
    await mkdir(extractionDirectory, { mode: 0o700 });
    await chmod(extractionDirectory, 0o700);
    await extractLogBundle(archivePath, extractionDirectory);
    const logs = await projectLogBundle(extractionDirectory, maxLines, actionName);
    return {
      artifact: {
        id: artifact.id,
        fileName: artifact.fileName
          ? redactLogText(path.basename(artifact.fileName.replaceAll("\\", "/"))).slice(0, 500)
          : undefined,
        fileSize: artifact.fileSize,
      },
      logs,
    };
  } catch (error) {
    await rm(runDirectory, { recursive: true, force: true });
    throw error;
  }
}
