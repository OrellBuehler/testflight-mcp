import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

export interface UploadRule {
  tool: string;
  what: string;
  kinds: string;
  extensions: string[];
  maxBytes: number;
}

function extensionList(extensions: string[]) {
  return extensions.length > 1
    ? `${extensions.slice(0, -1).join(", ")} and ${extensions[extensions.length - 1]}`
    : extensions[0];
}

function formatSize(bytes: number) {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
}

export async function resolveUploadFile(
  uploadDir: string | undefined,
  path: string,
  rule: UploadRule,
) {
  if (!uploadDir) {
    throw new Error(
      `${rule.tool} is disabled because ASC_UPLOAD_DIR is not set. Set ASC_UPLOAD_DIR to the directory that holds the ${rule.what}; only ${rule.kinds} files inside it can be uploaded.`,
    );
  }
  const allowed = (p: string) => rule.extensions.includes(extname(p).toLowerCase());
  const wrongType = `${path}: only ${extensionList(rule.extensions)} files can be uploaded`;
  if (!allowed(path)) throw new Error(wrongType);
  const base = await realpath(uploadDir);
  const real = await realpath(resolve(base, path));
  const rel = relative(base, real);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${path} is outside ASC_UPLOAD_DIR`);
  }
  if (!allowed(real)) throw new Error(wrongType);
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  if (info.size > rule.maxBytes) {
    throw new Error(`${path} is larger than ${formatSize(rule.maxBytes)}`);
  }
  return { real, name: basename(path), size: info.size, extension: extname(real).toLowerCase() };
}

export async function readBytes(path: string, position: number, length: number) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function hashFile(path: string, algorithm: "sha256" | "md5" = "sha256") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
