#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, statSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LABEL = "dev.mylife.testflight-mcp-tunnel";
export const RESTART_THROTTLE_MS = 5_000;
const READY_TIMEOUT_MS = 30_000;
const READY_RETRY_MS = 500;
const LOG_TAIL_BYTES = 64 * 1024;
const LOG_TAIL_LINES = 100;
const CREDENTIAL_FILE = "credentials.json";
const KEY_FILE_PATTERN = /^AuthKey_[A-Za-z0-9]{10}\.p8$/u;
const ISSUER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_ID_PATTERN = /^[A-Za-z0-9]{10}$/u;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createPaths(
  repoDirectory = REPO_ROOT,
  homeDirectory = process.env.HOME || homedir(),
) {
  const localDirectory = path.join(repoDirectory, ".local");
  const runtimeDirectory = path.join(localDirectory, "runtime");
  const logDirectory = path.join(localDirectory, "logs");
  const configDirectory = path.join(localDirectory, "config");
  const credentialsDirectory = path.join(localDirectory, "credentials");
  const launchAgentsDirectory = path.join(homeDirectory, "Library", "LaunchAgents");
  return {
    repoDirectory,
    localDirectory,
    runtimeDirectory,
    logDirectory,
    configDirectory,
    credentialsDirectory,
    credentialsFile: path.join(credentialsDirectory, CREDENTIAL_FILE),
    profile: path.join(configDirectory, "testflight.yaml"),
    runtimeKeyFile: path.join(runtimeDirectory, "control-plane-api-key"),
    runtimeNodeFile: path.join(runtimeDirectory, "node-path"),
    runtimeTunnelClientFile: path.join(runtimeDirectory, "tunnel-client-path"),
    healthUrlFile: path.join(runtimeDirectory, "health.url"),
    restartMarker: path.join(runtimeDirectory, "last-restart"),
    runtimeScript: path.join(repoDirectory, "scripts", "tunnel-runtime.sh"),
    plistFile: path.join(launchAgentsDirectory, `${LABEL}.plist`),
    launchAgentsDirectory,
    stdoutLog: path.join(logDirectory, "stdout.log"),
    stderrLog: path.join(logDirectory, "stderr.log"),
    managerStdoutLog: path.join(logDirectory, "manager.stdout.log"),
    managerStderrLog: path.join(logDirectory, "manager.stderr.log"),
    sourceCredentialsDirectory: path.join(homeDirectory, ".config", "mylife", "xcode-cloud"),
    sourceProfile: path.join(homeDirectory, ".config", "tunnel-client", "testflight.yaml"),
    sourceRuntimeKeyFile: path.join(
      homeDirectory,
      ".config",
      "mylife",
      "testflight-mcp",
      "control-plane-api-key",
    ),
  };
}

export function sanitizedEnvironment(environment = process.env) {
  // LaunchAgent children should inherit only the OS process settings they need, not ambient API secrets.
  const safeNames = [
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "PATH",
    "SHELL",
    "TERM",
  ];
  return Object.fromEntries(
    safeNames.flatMap((name) => (environment[name] ? [[name, environment[name]]] : [])),
  );
}

export function resolveExecutable(name, pathValue = process.env.PATH || "") {
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, name);
    try {
      const metadata = statSync(candidate);
      if (metadata.isFile() && (metadata.mode & 0o111) !== 0) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function runCommand(
  execute,
  command,
  argumentsList,
  { environment = sanitizedEnvironment(), timeout = 30_000, cwd } = {},
) {
  return execute(command, argumentsList, {
    encoding: "utf8",
    env: environment,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createLaunchAgentPlist(paths) {
  const string = (value) => `    <string>${xmlEscape(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    string(LABEL),
    "  <key>ProgramArguments</key>",
    "  <array>",
    string("/bin/sh"),
    string(paths.runtimeScript),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    string(paths.repoDirectory),
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    string("Background"),
    "  <key>ThrottleInterval</key>",
    "  <integer>30</integer>",
    "  <key>StandardOutPath</key>",
    string(paths.managerStdoutLog),
    "  <key>StandardErrorPath</key>",
    string(paths.managerStderrLog),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Private runtime directories must be real directories.");
  }
  await chmod(directory, 0o700);
}

async function ensureLocalDirectories(paths) {
  for (const directory of [
    paths.localDirectory,
    paths.configDirectory,
    paths.credentialsDirectory,
    paths.runtimeDirectory,
    paths.logDirectory,
  ]) {
    await ensurePrivateDirectory(directory);
  }
}

async function ensureLaunchAgentsDirectory(paths) {
  await mkdir(paths.launchAgentsDirectory, { recursive: true, mode: 0o700 });
  const library = path.dirname(paths.launchAgentsDirectory);
  const libraryInfo = await lstat(library);
  const agentsInfo = await lstat(paths.launchAgentsDirectory);
  if (
    !libraryInfo.isDirectory() ||
    libraryInfo.isSymbolicLink() ||
    !agentsInfo.isDirectory() ||
    agentsInfo.isSymbolicLink()
  ) {
    throw new Error("LaunchAgents must be a real user directory.");
  }
  await chmod(paths.launchAgentsDirectory, 0o700);
}

async function writePrivateFile(filePath, contents, mode = 0o600, replace = true) {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode });
    await chmod(temporaryPath, mode);
    if (replace) await rename(temporaryPath, filePath);
    else {
      await link(temporaryPath, filePath);
      await rm(temporaryPath, { force: true });
    }
  } catch {
    await rm(temporaryPath, { force: true });
    throw new Error("Could not securely write a private TestFlight MCP file.");
  }
}

async function readRegularFile(filePath, maximumBytes, errorMessage) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error("invalid file");
    return await handle.readFile();
  } catch {
    throw new Error(errorMessage);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readRuntimeKey(paths) {
  let metadata;
  try {
    metadata = await lstat(paths.runtimeKeyFile);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("Could not inspect the private Runtime API key file.");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) {
    throw new Error("The Runtime API key path must be a regular private file.");
  }
  await chmod(paths.runtimeKeyFile, 0o600);
  const key = (
    await readRegularFile(
      paths.runtimeKeyFile,
      16_384,
      "Could not read the private Runtime API key file.",
    )
  )
    .toString("utf8")
    .replace(/\r?\n$/u, "");
  validateRuntimeKey(key);
  return key;
}

function validateRuntimeKey(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16_384 ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    throw new Error("The Runtime API key must be a non-empty single-line value.");
  }
}

function parseYamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) return undefined;
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  const comment = trimmed.indexOf(" #");
  return comment >= 0 ? trimmed.slice(0, comment).trim() : trimmed;
}

function profileRuntimeKey(profile) {
  // Older tunnel profiles can keep this key inline; mirror it into the private runtime file without changing the source profile.
  const lines = profile.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    const section = lines[index].match(/^(\s*)control_plane:\s*(?:#.*)?$/u);
    if (!section) continue;
    const sectionIndent = section[1].length;
    for (let child = index + 1; child < lines.length; child++) {
      const line = lines[child];
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const indentation = line.match(/^\s*/u)?.[0].length ?? 0;
      if (indentation <= sectionIndent) break;
      const apiKey = line.match(/^\s*api_key:\s*(.*?)\s*$/u);
      if (!apiKey) continue;
      const value = parseYamlScalar(apiKey[1]);
      if (
        typeof value !== "string" ||
        !value ||
        /^(?:null|~|\[\]|\{\})$/iu.test(value) ||
        value.startsWith("${") ||
        value.startsWith("file:")
      ) {
        return undefined;
      }
      validateRuntimeKey(value);
      return value;
    }
  }
  return undefined;
}

async function resolveRuntimeKey(paths, environment) {
  const savedKey = await readRuntimeKey(paths);
  if (savedKey) return;
  const environmentKey = environment.CONTROL_PLANE_API_KEY;
  if (!environmentKey) {
    throw new Error("Runtime API key is missing. Set CONTROL_PLANE_API_KEY once and run ON again.");
  }
  validateRuntimeKey(environmentKey);
  await writePrivateFile(paths.runtimeKeyFile, `${environmentKey}\n`, 0o600, false);
}

export async function readLocalCredentials(paths) {
  let credentials;
  try {
    credentials = JSON.parse(
      (
        await readRegularFile(paths.credentialsFile, 16_384, "Credentials are missing or invalid.")
      ).toString("utf8"),
    );
  } catch {
    throw new Error(
      "Repo-local App Store Connect credentials are missing or invalid. Run configure first.",
    );
  }
  if (
    !ISSUER_PATTERN.test(credentials?.issuerId ?? "") ||
    !KEY_ID_PATTERN.test(credentials?.keyId ?? "") ||
    !KEY_FILE_PATTERN.test(credentials?.privateKeyFile ?? "") ||
    credentials.privateKeyFile !== `AuthKey_${credentials.keyId}.p8`
  ) {
    throw new Error("Repo-local App Store Connect credentials are invalid.");
  }
  const keyPath = path.join(paths.credentialsDirectory, credentials.privateKeyFile);
  let keyInfo;
  try {
    keyInfo = await lstat(keyPath);
  } catch {
    throw new Error("The repo-local App Store Connect private key is missing.");
  }
  if (
    !keyInfo.isFile() ||
    keyInfo.isSymbolicLink() ||
    keyInfo.size === 0 ||
    keyInfo.size > 64 * 1024
  ) {
    throw new Error("The repo-local App Store Connect private key is invalid.");
  }
  await chmod(paths.credentialsFile, 0o600);
  await chmod(keyPath, 0o600);
  return { keyId: credentials.keyId, issuerId: credentials.issuerId, privateKeyPath: keyPath };
}

async function copyIfMissing(
  sourcePath,
  destinationPath,
  maximumBytes,
  transform = (bytes) => bytes,
) {
  try {
    const destination = await lstat(destinationPath);
    if (!destination.isFile() || destination.isSymbolicLink()) {
      throw new Error("The existing repo-local file must be a regular file.");
    }
    await chmod(destinationPath, 0o600);
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const bytes = await readRegularFile(
    sourcePath,
    maximumBytes,
    "A required source file is missing or invalid.",
  );
  await writePrivateFile(destinationPath, transform(bytes), 0o600, false);
  return true;
}

async function pointCopiedProfileAtLocalBuild(paths) {
  const expectedEntry = path.join(paths.repoDirectory, "dist", "index.js");
  const profile = (
    await readRegularFile(
      paths.profile,
      2 * 1024 * 1024,
      "The copied TestFlight profile is invalid.",
    )
  ).toString("utf8");
  if (
    profile.includes(expectedEntry) &&
    !/\bnpx\b/iu.test(profile) &&
    !profile.includes("@orellbuehler/testflight-mcp")
  ) {
    return;
  }

  const lines = profile.split(/\r?\n/u);
  // Rewrite only an explicit upstream command; preserve other profile settings and custom commands.
  const commandLines = lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) =>
        /^\s*command:\s*/u.test(line) &&
        (/\bnpx\b/iu.test(line) || line.includes("@orellbuehler/testflight-mcp")),
    );
  if (commandLines.length === 0) return;
  if (commandLines.length !== 1) {
    throw new Error(
      "Could not safely update the copied TestFlight command. Point its command at this checkout's dist/index.js.",
    );
  }

  const { index, line } = commandLines[0];
  const prefix = line.match(/^(\s*command:\s*)/u)?.[1];
  if (!prefix) throw new Error("Could not safely update the copied TestFlight command.");
  const quotedEntry = `'${expectedEntry.replaceAll("'", "'\\''")}'`;
  lines[index] = `${prefix}${JSON.stringify(`node ${quotedEntry}`)}`;
  await writePrivateFile(paths.profile, `${lines.join("\n").replace(/\n*$/u, "")}\n`, 0o600);
}

export async function configureLocalFiles(paths) {
  await ensureLocalDirectories(paths);
  const ignore = await readFile(path.join(paths.repoDirectory, ".gitignore"), "utf8").catch(
    () => "",
  );
  if (!/^\.local\/$/mu.test(ignore)) {
    throw new Error("The repository must ignore .local/ before private files can be configured.");
  }

  const rawCredentials = await readRegularFile(
    path.join(paths.sourceCredentialsDirectory, CREDENTIAL_FILE),
    16_384,
    "The existing App Store Connect credentials are missing or invalid.",
  );
  let credentials;
  try {
    credentials = JSON.parse(rawCredentials.toString("utf8"));
  } catch {
    throw new Error("The existing App Store Connect credentials are invalid.");
  }
  if (
    !ISSUER_PATTERN.test(credentials?.issuerId ?? "") ||
    !KEY_ID_PATTERN.test(credentials?.keyId ?? "") ||
    !KEY_FILE_PATTERN.test(credentials?.privateKeyFile ?? "") ||
    credentials.privateKeyFile !== `AuthKey_${credentials.keyId}.p8`
  ) {
    throw new Error("The existing App Store Connect credentials are invalid.");
  }
  const sourceKeyPath = path.join(paths.sourceCredentialsDirectory, credentials.privateKeyFile);
  const sourceKey = await readRegularFile(
    sourceKeyPath,
    64 * 1024,
    "The existing App Store Connect private key is missing or invalid.",
  );
  if (sourceKey.length === 0)
    throw new Error("The existing App Store Connect private key is empty.");
  await copyIfMissing(
    sourceKeyPath,
    path.join(paths.credentialsDirectory, credentials.privateKeyFile),
    64 * 1024,
  );
  await copyIfMissing(
    path.join(paths.sourceCredentialsDirectory, CREDENTIAL_FILE),
    paths.credentialsFile,
    16_384,
    () =>
      Buffer.from(
        `${JSON.stringify(
          {
            issuerId: credentials.issuerId,
            keyId: credentials.keyId,
            privateKeyFile: credentials.privateKeyFile,
          },
          null,
          2,
        )}\n`,
      ),
  );
  await copyIfMissing(paths.sourceProfile, paths.profile, 2 * 1024 * 1024);
  await pointCopiedProfileAtLocalBuild(paths);
  try {
    await copyIfMissing(paths.sourceRuntimeKeyFile, paths.runtimeKeyFile, 16_384);
  } catch (error) {
    if (!String(error?.message).includes("missing or invalid")) throw error;
  }
  if (!(await readRuntimeKey(paths))) {
    const profile = (
      await readRegularFile(
        paths.profile,
        2 * 1024 * 1024,
        "The copied TestFlight profile is invalid.",
      )
    ).toString("utf8");
    const key = profileRuntimeKey(profile);
    if (key) await writePrivateFile(paths.runtimeKeyFile, `${key}\n`, 0o600, false);
  }
  return { copied: true, runtimeKeyReady: Boolean(await readRuntimeKey(paths)) };
}

export function createRuntimePath(executablePaths) {
  const directories = [
    ...Object.values(executablePaths)
      .filter(Boolean)
      .map((filePath) => path.dirname(filePath)),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(directories)].join(path.delimiter);
}

async function preflight(
  paths,
  environment,
  baseExecutables,
  execute,
  resolve = resolveExecutable,
) {
  const names = ["node", "tunnel-client", "plutil"];
  const executablePaths = {
    ...baseExecutables,
    node: resolve("node", environment.PATH),
    tunnelClient: resolve("tunnel-client", environment.PATH),
    plutil: resolve("plutil", environment.PATH),
  };
  const missing = names.filter(
    (name) => !executablePaths[name === "tunnel-client" ? "tunnelClient" : name],
  );
  if (missing.length)
    throw new Error(
      `Required executable is unavailable: ${missing.join(", ")}. Check the interactive shell PATH.`,
    );

  await readLocalCredentials(paths);
  const profileInfo = await lstat(paths.profile).catch(() => null);
  if (!profileInfo?.isFile() || profileInfo.isSymbolicLink()) {
    throw new Error("The repo-local testflight profile is missing or invalid.");
  }
  await chmod(paths.profile, 0o600);
  const profile = await readRegularFile(
    paths.profile,
    2 * 1024 * 1024,
    "The repo-local testflight profile is missing or invalid.",
  );
  const profileText = profile.toString("utf8");
  const expectedEntry = path.join(paths.repoDirectory, "dist", "index.js");
  if (
    !profileText.includes(expectedEntry) ||
    /\bnpx\b/iu.test(profileText) ||
    profileText.includes("@orellbuehler/testflight-mcp")
  ) {
    throw new Error(
      "Update .local/config/testflight.yaml to run this checkout's dist/index.js with Node.",
    );
  }
  const builtEntry = path.join(paths.repoDirectory, "dist", "index.js");
  const buildInfo = await lstat(builtEntry).catch(() => null);
  if (!buildInfo?.isFile() || buildInfo.isSymbolicLink()) {
    throw new Error("The local TestFlight MCP build is missing. Run npm run build first.");
  }
  const nodeVersion = runCommand(execute, executablePaths.node, ["--version"], {
    environment: sanitizedEnvironment(environment),
  });
  const nodeMajor = nodeVersion.stdout?.trim().match(/^v?(\d+)/u)?.[1];
  if (nodeVersion.status !== 0 || !nodeMajor || Number(nodeMajor) < 20) {
    throw new Error("Node.js 20 or newer is required for the repo-local TestFlight MCP build.");
  }
  return executablePaths;
}

function validatePlist(executablePath, filePath, execute) {
  const result = runCommand(execute, executablePath, ["-lint", filePath]);
  if (result.status !== 0)
    throw new Error("Generated LaunchAgent plist is invalid; it was not loaded.");
}

function readLaunchAgent(executablePath, execute = spawnSync) {
  const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
  const result = runCommand(execute, executablePath, ["print", `${domain}/${LABEL}`]);
  if (result.error?.code === "ENOENT")
    throw new Error("launchctl is unavailable in this macOS session.");
  if (result.error || result.status === null)
    throw new Error("Could not inspect the TestFlight MCP LaunchAgent safely.");
  const loaded = result.status === 0;
  const state = result.stdout?.match(/^\s*state = ([^\r\n]+)$/mu)?.[1]?.trim();
  const pid = result.stdout?.match(/^\s*pid = (\d+)\s*$/mu)?.[1];
  return { domain, loaded, running: loaded && state === "running" && Boolean(pid) };
}

function hasManualTunnelProcess(executablePath, execute = spawnSync) {
  const result = runCommand(execute, executablePath, [
    "-f",
    "tunnel-client run --profile testflight",
  ]);
  if (result.error?.code === "ENOENT")
    throw new Error("pgrep is unavailable; cannot safely detect a manual tunnel process.");
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("Could not safely inspect running tunnel processes.");
}

async function isTunnelReady(paths, fetcher = fetch) {
  let baseUrl;
  try {
    const metadata = await lstat(paths.healthUrlFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    baseUrl = new URL(
      (await readRegularFile(paths.healthUrlFile, 4096, "Invalid health URL."))
        .toString("utf8")
        .trim(),
    );
  } catch {
    return false;
  }
  if (
    baseUrl.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname)
  )
    return false;
  try {
    const response = await fetcher(new URL("/readyz", baseUrl), {
      signal: AbortSignal.timeout(1500),
    });
    const ready = response.status === 200;
    await response.body?.cancel().catch(() => undefined);
    return ready;
  } catch {
    return false;
  }
}

async function inspectState(paths, executablePaths, dependencies) {
  const launchAgent = readLaunchAgent(executablePaths.launchctl, dependencies.execute);
  const healthReady = launchAgent.loaded ? await isTunnelReady(paths, dependencies.fetcher) : false;
  const manual = launchAgent.loaded
    ? false
    : hasManualTunnelProcess(executablePaths.pgrep, dependencies.execute);
  const state = launchAgent.loaded
    ? launchAgent.running && healthReady
      ? "ON"
      : "ERROR"
    : manual
      ? "MANUAL"
      : "OFF";
  return { state, launchAgent, healthReady };
}

async function printStatus(paths, executablePaths, dependencies, currentStatus = null) {
  const status = currentStatus ?? (await inspectState(paths, executablePaths, dependencies));
  process.stdout.write(
    [
      `State: ${status.state}`,
      `LaunchAgent: ${status.launchAgent.loaded ? "loaded" : "unloaded"}`,
      "Tunnel profile: testflight",
      `Health: ${status.healthReady ? "ready" : "unavailable"}`,
      `Logs: ${paths.logDirectory}`,
    ].join("\n") + "\n",
  );
}

function runTunnelDoctor(executablePath, paths, environment, credentials, execute) {
  const safeEnvironment = sanitizedEnvironment(environment);
  safeEnvironment.HOME = path.dirname(path.dirname(paths.launchAgentsDirectory));
  safeEnvironment.PATH = environment.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
  delete safeEnvironment.ASC_PRIVATE_KEY_PATH;
  delete safeEnvironment.ASC_KEY_ID;
  delete safeEnvironment.ASC_ISSUER_ID;
  safeEnvironment.ASC_KEY_ID = credentials.keyId;
  safeEnvironment.ASC_ISSUER_ID = credentials.issuerId;
  safeEnvironment.ASC_PRIVATE_KEY_PATH = credentials.privateKeyPath;
  const result = runCommand(
    execute,
    executablePath,
    [
      "doctor",
      "--profile",
      "testflight",
      "--profile-dir",
      paths.configDirectory,
      `--control-plane.api-key=file:${paths.runtimeKeyFile}`,
    ],
    { environment: safeEnvironment, cwd: paths.repoDirectory },
  );
  if (result.status !== 0) {
    throw new Error("tunnel-client doctor failed. Confirm the local profile and Runtime API key.");
  }
}

async function turnOn(paths, environment, baseExecutables, dependencies) {
  const initialStatus = await inspectState(paths, baseExecutables, dependencies);
  if (initialStatus.state === "ON") {
    await printStatus(paths, baseExecutables, dependencies, initialStatus);
    return;
  }
  if (initialStatus.state === "ERROR") {
    await printStatus(paths, baseExecutables, dependencies, initialStatus);
    throw new Error(
      "The LaunchAgent is already loaded but is not ready. Check local logs or run OFF before retrying.",
    );
  }
  if (initialStatus.state === "MANUAL") {
    await printStatus(paths, baseExecutables, dependencies, initialStatus);
    throw new Error(
      "A manual testflight tunnel is already running. Stop it with Ctrl-C, then run ON again.",
    );
  }

  await ensureLocalDirectories(paths);
  const executablePaths = await preflight(
    paths,
    environment,
    baseExecutables,
    dependencies.execute,
    dependencies.resolve,
  );
  const credentials = await readLocalCredentials(paths);
  await resolveRuntimeKey(paths, environment);
  runTunnelDoctor(
    executablePaths.tunnelClient,
    paths,
    environment,
    credentials,
    dependencies.execute,
  );

  await ensureLaunchAgentsDirectory(paths);
  await Promise.all([
    writePrivateFile(paths.stdoutLog, "", 0o600),
    writePrivateFile(paths.stderrLog, "", 0o600),
    writePrivateFile(paths.managerStdoutLog, "", 0o600),
    writePrivateFile(paths.managerStderrLog, "", 0o600),
    writePrivateFile(paths.runtimeNodeFile, `${executablePaths.node}\n`, 0o600),
    writePrivateFile(paths.runtimeTunnelClientFile, `${executablePaths.tunnelClient}\n`, 0o600),
  ]);
  await rm(paths.healthUrlFile, { force: true });
  await writePrivateFile(paths.plistFile, createLaunchAgentPlist(paths), 0o600);
  validatePlist(executablePaths.plutil, paths.plistFile, dependencies.execute);

  const bootstrap = runCommand(dependencies.execute, baseExecutables.launchctl, [
    "bootstrap",
    initialStatus.launchAgent.domain,
    paths.plistFile,
  ]);
  if (bootstrap.status !== 0) {
    const concurrentState = await inspectState(paths, baseExecutables, dependencies);
    if (concurrentState.state === "ON") {
      await printStatus(paths, baseExecutables, dependencies, concurrentState);
      return;
    }
    if (concurrentState.launchAgent.loaded) {
      await printStatus(paths, baseExecutables, dependencies, concurrentState);
      throw new Error(
        "LaunchAgent is loaded but not ready after bootstrap. Check its private logs before retrying.",
      );
    }
    await rm(paths.plistFile, { force: true });
    throw new Error(
      "Could not bootstrap the TestFlight MCP LaunchAgent. Check launchd availability and local logs.",
    );
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastStatus = null;
  while (Date.now() < deadline) {
    lastStatus = await inspectState(paths, baseExecutables, dependencies);
    if (lastStatus.state === "ON") {
      await printStatus(paths, baseExecutables, dependencies, lastStatus);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_RETRY_MS));
  }
  await printStatus(paths, baseExecutables, dependencies, lastStatus);
  throw new Error(
    "LaunchAgent loaded but tunnel-client did not become ready before timeout. Check private logs.",
  );
}

async function turnOff(paths, executablePaths, dependencies) {
  const initial = readLaunchAgent(executablePaths.launchctl, dependencies.execute);
  if (initial.loaded) {
    const bootout = runCommand(dependencies.execute, executablePaths.launchctl, [
      "bootout",
      `${initial.domain}/${LABEL}`,
    ]);
    if (
      bootout.status !== 0 &&
      readLaunchAgent(executablePaths.launchctl, dependencies.execute).loaded
    ) {
      throw new Error("Could not stop the loaded LaunchAgent; plist was retained for safety.");
    }
  }
  await rm(paths.plistFile, { force: true });
  await rm(paths.healthUrlFile, { force: true });
  await printStatus(paths, executablePaths, dependencies);
}

export function redactSecrets(input, secrets = [], home = process.env.HOME || homedir()) {
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
  text = text.replace(/https?:\/\/[^\s"'<>]+/giu, (raw) => {
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
  });
  text = text.replace(
    /\b([A-Z0-9_.-]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|TEAM_ID|ASC_KEY_ID|ASC_ISSUER_ID)[A-Z0-9_.-]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    "$1=[REDACTED]",
  );
  if (home) text = text.split(home).join("~");
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED EMAIL]");
  for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
  return text;
}

async function readSafeLogTail(filePath, secrets) {
  let metadata;
  try {
    metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return "No log entries yet.";
  } catch (error) {
    if (error?.code === "ENOENT") return "No log entries yet.";
    throw new Error("Could not safely inspect a private log file.");
  }
  await chmod(filePath, 0o600);
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let contents;
  try {
    const info = await handle.stat();
    const start = Math.max(0, info.size - LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    contents = buffer.toString("utf8");
  } finally {
    await handle.close();
  }
  if (!contents) return "No log entries yet.";
  if (metadata.size > LOG_TAIL_BYTES) contents = contents.slice(contents.indexOf("\n") + 1);
  const lines = contents.split(/\r?\n/u).filter(Boolean).slice(-LOG_TAIL_LINES);
  return redactSecrets(lines.join("\n"), secrets);
}

async function showLogs(paths) {
  const secrets = [];
  try {
    const runtimeKey = await readRuntimeKey(paths);
    if (runtimeKey) secrets.push(runtimeKey);
  } catch {
    // Continue with generic token and PEM redaction when the private key file is unavailable.
  }
  process.stdout.write(`Logs: ${paths.logDirectory}\n`);
  process.stdout.write(`--- stdout.log ---\n${await readSafeLogTail(paths.stdoutLog, secrets)}\n`);
  process.stdout.write(`--- stderr.log ---\n${await readSafeLogTail(paths.stderrLog, secrets)}\n`);
}

function executableSet(environment, resolve) {
  const launchctl = resolve("launchctl", environment.PATH);
  const pgrep = resolve("pgrep", environment.PATH);
  if (!launchctl || !pgrep)
    throw new Error("launchctl and pgrep are required to manage a user LaunchAgent safely.");
  return { launchctl, pgrep };
}

async function checkRestartThrottle(paths, now = Date.now()) {
  let markerExists = false;
  try {
    await lstat(paths.restartMarker);
    markerExists = true;
    const text = (
      await readRegularFile(paths.restartMarker, 128, "Invalid restart throttle marker.")
    )
      .toString("utf8")
      .trim();
    const last = Number(text);
    if (!Number.isFinite(last) || last <= 0) throw new Error("invalid marker");
    if (now - last < RESTART_THROTTLE_MS) {
      throw new Error(
        "Restart was requested too recently. Wait a few seconds before trying again.",
      );
    }
  } catch (error) {
    if (String(error?.message).includes("too recently")) throw error;
    if (markerExists) throw new Error("The restart throttle marker is invalid.");
  }
  await writePrivateFile(paths.restartMarker, `${now}\n`, 0o600);
}

export async function main(
  argumentsList = process.argv.slice(2),
  environment = process.env,
  options = {},
) {
  const command = argumentsList[0];
  if (
    !command ||
    argumentsList.length > 1 ||
    !["configure", "on", "off", "restart", "toggle", "status", "logs"].includes(command)
  ) {
    throw new Error("Usage: npm run mcp:tunnel -- configure|on|off|restart|toggle|status|logs");
  }
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("TestFlight MCP Tunnel management requires macOS.");
  }
  const paths = createPaths(options.repoDirectory ?? REPO_ROOT, environment.HOME || homedir());
  const dependencies = {
    execute: options.execute ?? spawnSync,
    resolve: options.resolve ?? resolveExecutable,
    fetcher: options.fetcher ?? fetch,
  };
  if (command === "configure") {
    const result = await configureLocalFiles(paths);
    process.stdout.write(
      `Repo-local files are ready with private permissions; the copied profile uses this checkout's dist/index.js. Runtime API key: ${result.runtimeKeyReady ? "ready" : "missing; set CONTROL_PLANE_API_KEY once before ON"}.\n`,
    );
    return;
  }
  if (command === "logs") return showLogs(paths);
  const baseExecutables = executableSet(environment, dependencies.resolve);
  if (command === "status") return printStatus(paths, baseExecutables, dependencies);
  if (command === "on") return turnOn(paths, environment, baseExecutables, dependencies);
  if (command === "off") return turnOff(paths, baseExecutables, dependencies);

  const status = await inspectState(paths, baseExecutables, dependencies);
  if (status.state === "MANUAL") {
    await printStatus(paths, baseExecutables, dependencies, status);
    throw new Error(
      "A manual testflight tunnel is already running. Stop it with Ctrl-C before using this command.",
    );
  }
  if (command === "restart") {
    await checkRestartThrottle(paths);
    if (status.state === "ON" || status.state === "ERROR")
      await turnOff(paths, baseExecutables, dependencies);
    return turnOn(paths, environment, baseExecutables, dependencies);
  }
  if (status.state === "ON" || status.state === "ERROR")
    return turnOff(paths, baseExecutables, dependencies);
  return turnOn(paths, environment, baseExecutables, dependencies);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`Error: ${error?.message || "TestFlight MCP Tunnel command failed."}\n`);
    process.exitCode = 2;
  }
}
