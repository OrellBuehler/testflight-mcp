import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads the App Store Connect credentials and exposes a client", async () => {
    vi.stubEnv("ASC_KEY_ID", "KEY123");
    vi.stubEnv("ASC_ISSUER_ID", "ISSUER-1");
    vi.stubEnv("ASC_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
    vi.stubEnv("ASC_VENDOR_NUMBER", "80001234");
    const { config, client } = await import("../config.js");
    expect(config.keyId).toBe("KEY123");
    expect(config.issuerId).toBe("ISSUER-1");
    expect(config.vendorNumber).toBe("80001234");
    expect(config.transport).toBe("stdio");
    expect(client).toBeDefined();
  });

  it("accepts ASC_PRIVATE_KEY_PATH instead of an inline key", async () => {
    vi.stubEnv("ASC_KEY_ID", "KEY123");
    vi.stubEnv("ASC_ISSUER_ID", "ISSUER-1");
    vi.stubEnv("ASC_PRIVATE_KEY", "");
    vi.stubEnv("ASC_PRIVATE_KEY_PATH", "/tmp/AuthKey.p8");
    const { config } = await import("../config.js");
    expect(config.vendorNumber).toBeUndefined();
  });

  it("exits when required env vars are missing", async () => {
    vi.stubEnv("ASC_KEY_ID", "");
    vi.stubEnv("ASC_ISSUER_ID", "");
    vi.stubEnv("ASC_PRIVATE_KEY", "");
    vi.stubEnv("ASC_PRIVATE_KEY_PATH", "");
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(import("../config.js")).rejects.toThrow("exit:1");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits when a private key is missing even if key id and issuer are present", async () => {
    vi.stubEnv("ASC_KEY_ID", "KEY123");
    vi.stubEnv("ASC_ISSUER_ID", "ISSUER-1");
    vi.stubEnv("ASC_PRIVATE_KEY", "");
    vi.stubEnv("ASC_PRIVATE_KEY_PATH", "");
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(import("../config.js")).rejects.toThrow("exit:1");
  });
});
