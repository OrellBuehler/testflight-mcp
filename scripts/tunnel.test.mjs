import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureLocalFiles,
  createLaunchAgentPlist,
  createPaths,
  main,
  readLocalCredentials,
  redactSecrets,
  sanitizedEnvironment,
} from "./tunnel.mjs";

const roots = [];
const KEY_ID = "ABCDEF1234";
const ISSUER_ID = "123e4567-e89b-12d3-a456-426614174000";
const PRIVATE_KEY = `-----BEGIN ${"PRIVATE KEY"}-----\nprivate-test-value\n-----END ${"PRIVATE KEY"}-----\n`;
const RUNTIME_KEY = "runtime-test-secret-value";

async function fixture({ copiedFiles = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "testflight-mcp-tunnel-"));
  roots.push(root);
  const repoDirectory = path.join(root, "checkout with spaces");
  const homeDirectory = path.join(root, "home");
  await mkdir(repoDirectory, { recursive: true });
  await mkdir(homeDirectory, { recursive: true });
  const paths = createPaths(repoDirectory, homeDirectory);
  await mkdir(path.join(repoDirectory, "dist"), { recursive: true });
  await mkdir(path.join(repoDirectory, "scripts"), { recursive: true });
  await writeFile(path.join(repoDirectory, ".gitignore"), ".local/\n");
  await writeFile(path.join(repoDirectory, "dist", "index.js"), "export {};\n", { mode: 0o600 });
  await writeFile(
    path.join(repoDirectory, "scripts", "tunnel-runtime.sh"),
    "#!/bin/sh\nexec node tunnel-runtime.mjs\n",
    { mode: 0o600 },
  );

  if (copiedFiles) {
    const credentials = {
      issuerId: ISSUER_ID,
      keyId: KEY_ID,
      privateKeyFile: `AuthKey_${KEY_ID}.p8`,
    };
    await mkdir(paths.sourceCredentialsDirectory, { recursive: true });
    await mkdir(path.dirname(paths.sourceProfile), { recursive: true });
    await mkdir(path.dirname(paths.sourceRuntimeKeyFile), { recursive: true });
    await writeFile(
      path.join(paths.sourceCredentialsDirectory, "credentials.json"),
      JSON.stringify(credentials),
    );
    await writeFile(
      path.join(paths.sourceCredentialsDirectory, credentials.privateKeyFile),
      PRIVATE_KEY,
    );
    await writeFile(
      paths.sourceProfile,
      `config_version: 1\ncontrol_plane:\n  api_key: ${RUNTIME_KEY}\nmcp:\n  commands:\n    - channel: testflight\n      command: npx -y @orellbuehler/testflight-mcp\n`,
    );
    await writeFile(paths.sourceRuntimeKeyFile, `${RUNTIME_KEY}\n`, { mode: 0o600 });
  } else {
    await mkdir(paths.localDirectory, { recursive: true, mode: 0o700 });
    await mkdir(paths.configDirectory, { recursive: true, mode: 0o700 });
    await mkdir(paths.credentialsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
    await mkdir(paths.logDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      paths.credentialsFile,
      JSON.stringify({
        issuerId: ISSUER_ID,
        keyId: KEY_ID,
        privateKeyFile: `AuthKey_${KEY_ID}.p8`,
      }),
      { mode: 0o600 },
    );
    await writeFile(path.join(paths.credentialsDirectory, `AuthKey_${KEY_ID}.p8`), PRIVATE_KEY, {
      mode: 0o600,
    });
    await writeFile(
      paths.profile,
      `command: node\nargs:\n  - ${path.join(repoDirectory, "dist", "index.js")}\n`,
      { mode: 0o600 },
    );
  }
  return { root, repoDirectory, homeDirectory, paths };
}

function harness(paths, { initiallyLoaded = false, manual = false } = {}) {
  let loaded = initiallyLoaded;
  const calls = [];
  const execute = (command, args) => {
    calls.push({ command, args });
    const binary = path.basename(command);
    if (binary === "launchctl" && args[0] === "print") {
      return loaded
        ? { status: 0, stdout: "state = running\npid = 402\n" }
        : { status: 1, stdout: "" };
    }
    if (binary === "launchctl" && args[0] === "bootstrap") {
      loaded = true;
      writeFileSync(paths.healthUrlFile, "http://127.0.0.1:8080\n", { mode: 0o600 });
      return { status: 0, stdout: "" };
    }
    if (binary === "launchctl" && args[0] === "bootout") {
      loaded = false;
      return { status: 0, stdout: "" };
    }
    if (binary === "pgrep") return { status: manual ? 0 : 1, stdout: "" };
    if (binary === "node") return { status: 0, stdout: "v22.19.0\n" };
    return { status: 0, stdout: "" };
  };
  const resolve = (name) => `/fake/bin/${name}`;
  const fetcher = vi.fn(async () => ({ status: 200, body: { cancel: async () => undefined } }));
  return {
    calls,
    fetcher,
    loaded: () => loaded,
    options: {
      platform: "darwin",
      repoDirectory: paths.repoDirectory,
      execute,
      resolve,
      fetcher,
    },
  };
}

function captureOutput() {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return {
    stdout,
    stderr,
    text: () =>
      stdout.mock.calls.map(([value]) => String(value)).join("") +
      stderr.mock.calls.map(([value]) => String(value)).join(""),
    restore: () => {
      stdout.mockRestore();
      stderr.mockRestore();
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TestFlight MCP local tunnel", () => {
  it("copies local config and credentials without changing their source files", async () => {
    const { paths } = await fixture({ copiedFiles: true });
    const output = await configureLocalFiles(paths);
    expect(output).toEqual({ copied: true, runtimeKeyReady: true });
    expect(await readFile(paths.runtimeKeyFile, "utf8")).toBe(`${RUNTIME_KEY}\n`);
    expect(
      await readFile(path.join(paths.credentialsDirectory, `AuthKey_${KEY_ID}.p8`), "utf8"),
    ).toBe(PRIVATE_KEY);
    const localProfile = await readFile(paths.profile, "utf8");
    expect(localProfile).toContain(`node '${path.join(paths.repoDirectory, "dist", "index.js")}'`);
    expect(localProfile).not.toContain("npx");
    expect(localProfile).not.toContain("@orellbuehler/testflight-mcp");
    expect(await readFile(paths.sourceProfile, "utf8")).toContain("@orellbuehler/testflight-mcp");
    await writeFile(
      paths.profile,
      `config_version: 1\nmcp:\n  commands:\n    - channel: testflight\n      command: npx -y @orellbuehler/testflight-mcp\n`,
      { mode: 0o600 },
    );
    await configureLocalFiles(paths);
    expect(await readFile(paths.profile, "utf8")).toContain(
      `node '${path.join(paths.repoDirectory, "dist", "index.js")}'`,
    );
    expect(JSON.parse(await readFile(paths.credentialsFile, "utf8"))).toEqual({
      issuerId: ISSUER_ID,
      keyId: KEY_ID,
      privateKeyFile: `AuthKey_${KEY_ID}.p8`,
    });
    expect((await stat(paths.localDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.runtimeKeyFile)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(path.join(paths.credentialsDirectory, `AuthKey_${KEY_ID}.p8`))).mode & 0o777,
    ).toBe(0o600);
    expect(await readFile(paths.sourceRuntimeKeyFile, "utf8")).toBe(`${RUNTIME_KEY}\n`);
  });

  it("copies a profile API key into the private runtime key file when no key file exists", async () => {
    const { paths } = await fixture({ copiedFiles: true });
    await rm(paths.sourceRuntimeKeyFile, { force: true });
    const result = await configureLocalFiles(paths);
    expect(result.runtimeKeyReady).toBe(true);
    expect(await readFile(paths.runtimeKeyFile, "utf8")).toBe(`${RUNTIME_KEY}\n`);
    expect(await readFile(paths.sourceProfile, "utf8")).toContain(`api_key: ${RUNTIME_KEY}`);
    expect(await readFile(paths.profile, "utf8")).toContain(`api_key: ${RUNTIME_KEY}`);
    expect((await stat(paths.runtimeKeyFile)).mode & 0o777).toBe(0o600);
  });

  it("keeps LaunchAgent plist free of credentials and runtime key values", async () => {
    const { paths } = await fixture();
    const plist = createLaunchAgentPlist(paths);
    expect(plist).toContain(paths.runtimeScript);
    expect(plist).toContain(paths.logDirectory);
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).not.toContain("EnvironmentVariables");
    expect(plist).not.toContain("ASC_PRIVATE_KEY");
    expect(plist).not.toContain("CONTROL_PLANE_API_KEY");
    expect(plist).not.toContain(RUNTIME_KEY);
  });

  it("removes credentials from child environments and redacts user-specific log data", () => {
    const safe = sanitizedEnvironment({
      ASC_PRIVATE_KEY: PRIVATE_KEY,
      ASC_PRIVATE_KEY_PATH: "/outside/key.p8",
      CONTROL_PLANE_API_KEY: RUNTIME_KEY,
      UNRELATED_SECRET: "must-not-cross-the-launch-agent-boundary",
      HOME: "/Users/example",
      PATH: "/usr/bin",
    });
    expect(safe).not.toHaveProperty("ASC_PRIVATE_KEY");
    expect(safe).not.toHaveProperty("CONTROL_PLANE_API_KEY");
    expect(safe).not.toHaveProperty("UNRELATED_SECRET");
    expect(safe).toEqual({ HOME: "/Users/example", PATH: "/usr/bin" });
    const githubToken = `ghp_${"1234567890".repeat(4)}`;
    const text = redactSecrets(
      `Bearer token-value\nhttps://example.test/file?signature=private\napi_key: profile-secret\n${githubToken}\n${os.homedir()}/secret\n${RUNTIME_KEY}\n${PRIVATE_KEY}`,
      [RUNTIME_KEY],
    );
    expect(text).not.toContain("private\n");
    expect(text).not.toContain(os.homedir());
    expect(text).not.toContain(RUNTIME_KEY);
    expect(text).not.toContain("private-test-value");
    expect(text).not.toContain("token-value");
    expect(text).not.toContain("profile-secret");
    expect(text).not.toContain(githubToken);
  });

  it("starts the LaunchAgent idempotently with local executables and repo-local credentials", async () => {
    const { paths, homeDirectory } = await fixture();
    const fake = harness(paths);
    const output = captureOutput();
    try {
      await main(
        ["on"],
        { HOME: homeDirectory, PATH: "/bin", CONTROL_PLANE_API_KEY: RUNTIME_KEY },
        fake.options,
      );
      expect(fake.loaded()).toBe(true);
      expect(
        fake.calls.filter(
          ({ command, args }) => path.basename(command) === "launchctl" && args[0] === "bootstrap",
        ),
      ).toHaveLength(1);
      expect(
        fake.calls.some(
          ({ command, args }) => path.basename(command) === "tunnel-client" && args[0] === "doctor",
        ),
      ).toBe(true);
      expect(output.text()).toContain("State: ON");
      expect(output.text()).not.toContain(RUNTIME_KEY);
      expect(output.text()).not.toContain(PRIVATE_KEY);
      expect(await readFile(paths.runtimeKeyFile, "utf8")).toBe(`${RUNTIME_KEY}\n`);
      expect((await stat(paths.plistFile)).mode & 0o777).toBe(0o600);
      expect(await readFile(paths.runtimeScript, "utf8")).toContain("tunnel-runtime.mjs");
    } finally {
      output.restore();
    }
  });

  it("does not bootstrap a duplicate LaunchAgent", async () => {
    const { paths, homeDirectory } = await fixture();
    await writeFile(paths.healthUrlFile, "http://127.0.0.1:8080\n", { mode: 0o600 });
    const fake = harness(paths, { initiallyLoaded: true });
    const output = captureOutput();
    try {
      await main(["on"], { HOME: homeDirectory, PATH: "/bin" }, fake.options);
      expect(
        fake.calls.filter(
          ({ command, args }) => path.basename(command) === "launchctl" && args[0] === "bootstrap",
        ),
      ).toHaveLength(0);
      expect(output.text()).toContain("State: ON");
    } finally {
      output.restore();
    }
  });

  it("detects a manual tunnel and never stops it", async () => {
    const { paths, homeDirectory } = await fixture();
    const fake = harness(paths, { manual: true });
    const output = captureOutput();
    try {
      await expect(
        main(["on"], { HOME: homeDirectory, PATH: "/bin" }, fake.options),
      ).rejects.toThrow(/manual testflight tunnel/u);
      await main(["off"], { HOME: homeDirectory, PATH: "/bin" }, fake.options);
      expect(
        fake.calls.some(
          ({ command, args }) => path.basename(command) === "launchctl" && args[0] === "bootstrap",
        ),
      ).toBe(false);
      expect(
        fake.calls.some(({ command, args }) => args.includes("kill") || args.includes("-9")),
      ).toBe(false);
      expect(output.text()).toContain("State: MANUAL");
    } finally {
      output.restore();
    }
  });

  it("boots out before removing the plist and reports OFF", async () => {
    const { paths, homeDirectory } = await fixture();
    const fake = harness(paths, { initiallyLoaded: true });
    const output = captureOutput();
    await mkdir(paths.launchAgentsDirectory, { recursive: true });
    await writeFile(paths.plistFile, "plist", { mode: 0o600 });
    try {
      await main(["off"], { HOME: homeDirectory, PATH: "/bin" }, fake.options);
      expect(fake.loaded()).toBe(false);
      expect(
        fake.calls.some(
          ({ command, args }) => path.basename(command) === "launchctl" && args[0] === "bootout",
        ),
      ).toBe(true);
      await expect(stat(paths.plistFile)).rejects.toThrow();
      expect(output.text()).toContain("State: OFF");
    } finally {
      output.restore();
    }
  });

  it("throttles repeated restarts", async () => {
    const { paths, homeDirectory } = await fixture();
    const fake = harness(paths);
    const output = captureOutput();
    try {
      await main(
        ["restart"],
        { HOME: homeDirectory, PATH: "/bin", CONTROL_PLANE_API_KEY: RUNTIME_KEY },
        fake.options,
      );
      await expect(
        main(["restart"], { HOME: homeDirectory, PATH: "/bin" }, fake.options),
      ).rejects.toThrow(/too recently/u);
      expect(
        fake.calls.filter(
          ({ command, args }) => path.basename(command) === "launchctl" && args[0] === "bootstrap",
        ),
      ).toHaveLength(1);
    } finally {
      output.restore();
    }
  });

  it("requires a profile that points at the local build", async () => {
    const { paths, homeDirectory } = await fixture();
    await writeFile(paths.profile, "command: npx\nargs: ['-y', '@orellbuehler/testflight-mcp']\n", {
      mode: 0o600,
    });
    const fake = harness(paths);
    await expect(
      main(
        ["on"],
        { HOME: homeDirectory, PATH: "/bin", CONTROL_PLANE_API_KEY: RUNTIME_KEY },
        fake.options,
      ),
    ).rejects.toThrow(/dist\/index\.js/u);
    expect(
      fake.calls.some(
        ({ command, args }) => path.basename(command) === "launchctl" && args[0] === "bootstrap",
      ),
    ).toBe(false);
  });
});
