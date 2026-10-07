#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, open, readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPaths,
  readLocalCredentials,
  readRuntimeKey,
  redactSecrets,
  sanitizedEnvironment,
} from "./tunnel.mjs";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_LOG_BYTES = 4 * 1024 * 1024;
const REDACTION_HOLD_BYTES = 128 * 1024;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readPrivateExecutable(filePath) {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    throw new Error("A local runtime executable path is missing.");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) {
    throw new Error("A local runtime executable path is invalid.");
  }
  await chmod(filePath, 0o600);
  const value = (await readFile(filePath, "utf8")).trim();
  if (!path.isAbsolute(value) || value.includes("\n"))
    throw new Error("A local runtime executable path is invalid.");
  return value;
}

async function openPrivateLog(filePath) {
  const handle = await open(
    filePath,
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const info = await handle.stat();
  if (!info.isFile()) {
    await handle.close();
    throw new Error("A private log path is invalid.");
  }
  await chmod(filePath, 0o600);
  return handle;
}

async function pumpLog(stream, filePath, secrets, home) {
  const handle = await openPrivateLog(filePath);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let size = (await handle.stat()).size;
  try {
    const write = async (text) => {
      if (!text) return;
      const bytes = Buffer.from(redactSecrets(text, secrets, home), "utf8");
      if (bytes.length === 0) return;
      const bounded = bytes.length > MAX_LOG_BYTES ? bytes.subarray(-MAX_LOG_BYTES) : bytes;
      if (size + bounded.length > MAX_LOG_BYTES) {
        const existing = await readFile(filePath);
        const keepSize = Math.max(0, MAX_LOG_BYTES - bounded.length);
        const keep = existing.subarray(
          Math.max(0, existing.length - Math.min(KEEP_LOG_BYTES, keepSize)),
        );
        await handle.truncate(0);
        await handle.writeFile(keep);
        size = keep.length;
      }
      await handle.writeFile(bounded);
      size += bounded.length;
    };

    for await (const chunk of stream) {
      pending += decoder.write(chunk);
      if (Buffer.byteLength(pending, "utf8") > REDACTION_HOLD_BYTES) {
        const decoded = Buffer.from(pending, "utf8");
        let split = Math.max(0, decoded.length - REDACTION_HOLD_BYTES);
        while (split > 0 && (decoded[split] & 0xc0) === 0x80) split--;
        const safe = decoded.subarray(0, split).toString("utf8");
        pending = decoded.subarray(split).toString("utf8");
        await write(safe);
      }
    }
    pending += decoder.end();
    await write(pending);
  } finally {
    await handle.close();
  }
}

async function run() {
  const paths = createPaths(ROOT, process.env.HOME);
  const credentials = await readLocalCredentials(paths);
  const profileInfo = await lstat(paths.profile).catch(() => null);
  if (!profileInfo?.isFile() || profileInfo.isSymbolicLink())
    throw new Error("Local tunnel profile is missing.");
  const profileText = await readFile(paths.profile, "utf8");
  if (
    !profileText.includes(path.join(ROOT, "dist", "index.js")) ||
    /\bnpx\b/iu.test(profileText) ||
    profileText.includes("@orellbuehler/testflight-mcp")
  ) {
    throw new Error("Local tunnel profile does not point at the fork build.");
  }
  const runtimeKey = await readRuntimeKey(paths);
  if (!runtimeKey) throw new Error("Repo-local Runtime API key is missing.");
  const tunnelClient = await readPrivateExecutable(paths.runtimeTunnelClientFile);
  const safeEnvironment = sanitizedEnvironment(process.env);
  delete safeEnvironment.ASC_PRIVATE_KEY_PATH;
  delete safeEnvironment.ASC_KEY_ID;
  delete safeEnvironment.ASC_ISSUER_ID;
  safeEnvironment.HOME = process.env.HOME || "/";
  safeEnvironment.PATH = [
    path.dirname(process.execPath),
    path.dirname(tunnelClient),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(path.delimiter);
  safeEnvironment.ASC_KEY_ID = credentials.keyId;
  safeEnvironment.ASC_ISSUER_ID = credentials.issuerId;
  safeEnvironment.ASC_PRIVATE_KEY_PATH = credentials.privateKeyPath;

  const child = spawn(
    tunnelClient,
    [
      "run",
      "--profile",
      "testflight",
      "--profile-dir",
      paths.configDirectory,
      `--control-plane.api-key=file:${paths.runtimeKeyFile}`,
      "--health.url-file",
      paths.healthUrlFile,
    ],
    {
      cwd: paths.repoDirectory,
      env: safeEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  process.once("SIGINT", () => child.kill("SIGINT"));
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code) => resolve({ code }));
    child.once("error", () => resolve({ code: 1 }));
  });
  const logPromise = Promise.all([
    pumpLog(child.stdout, paths.stdoutLog, [runtimeKey], safeEnvironment.HOME),
    pumpLog(child.stderr, paths.stderrLog, [runtimeKey], safeEnvironment.HOME),
  ]).catch((error) => {
    child.kill("SIGTERM");
    return { error };
  });
  const [logResult, exitResult] = await Promise.all([logPromise, exitPromise]);
  if (!Array.isArray(logResult)) throw logResult.error;
  process.exitCode = typeof exitResult.code === "number" ? exitResult.code : 1;
}

try {
  await run();
} catch {
  process.stderr.write(
    "TestFlight MCP runtime failed. Run npm run mcp:tunnel -- status and logs for safe diagnostics.\n",
  );
  process.exitCode = 1;
}
