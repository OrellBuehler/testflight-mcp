import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { AppStoreConnectClient } from "../asc/client.js";
import { registerProvisioningTools } from "../tools/provisioning.js";
import { buildProfile } from "./profile-fixture.js";

type Handler = (args: any) => Promise<{ content: { text?: string }[]; isError?: boolean }>;

const root = mkdtempSync(join(tmpdir(), "profiles-"));
const dir = join(root, "allowed");
mkdirSync(dir);

function collect(allowWrites = true, downloadDir: string | null = dir) {
  const tools = new Map<string, Handler>();
  registerProvisioningTools(
    {
      tool: (n: string, _d: string, _s: unknown, _a: unknown, h: Handler) => tools.set(n, h),
    } as any,
    new AppStoreConnectClient(async () => "tok"),
    allowWrites,
    downloadDir ?? undefined,
  );
  return tools;
}

function sent(mockFetch: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = mockFetch.mock.calls[index];
  return {
    method: init?.method ?? "GET",
    path: new URL(url).pathname,
    params: new URL(url).searchParams,
    body: init?.body ? JSON.parse(init.body) : undefined,
  };
}

function profileResponse(base64: string, extra: Record<string, unknown> = {}) {
  return resp({
    data: {
      type: "profiles",
      id: "PR1",
      attributes: {
        name: "Acme App Store",
        profileType: "IOS_APP_STORE",
        uuid: "00000000-0000-0000-0000-000000000001",
        profileContent: base64,
        ...extra,
      },
    },
  });
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

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("provisioning tools", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it("list_devices filters by platform and status", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_devices")!({ platform: "IOS", status: "ENABLED" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/devices");
    expect(parsed.searchParams.get("filter[platform]")).toBe("IOS");
    expect(parsed.searchParams.get("filter[status]")).toBe("ENABLED");
  });

  it("list_certificates filters by certificate type", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_certificates")!({ certificate_type: "IOS_DISTRIBUTION" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/certificates");
    expect(parsed.searchParams.get("filter[certificateType]")).toBe("IOS_DISTRIBUTION");
  });

  it("list_profiles includes and resolves the bundle id", async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        data: [
          {
            type: "profiles",
            id: "pr1",
            attributes: { name: "Acme Dist" },
            relationships: { bundleId: { data: { type: "bundleIds", id: "bid1" } } },
          },
        ],
        included: [{ type: "bundleIds", id: "bid1", attributes: { identifier: "com.acme.app" } }],
      }),
    );
    const res = await tools.get("list_profiles")!({});
    expect(new URL(mockFetch.mock.calls[0][0]).searchParams.get("include")).toBe("bundleId");
    expect(JSON.parse(res.content[0].text!).profiles[0].bundleId).toMatchObject({
      identifier: "com.acme.app",
    });
  });

  it("list_bundle_ids filters by identifier", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_bundle_ids")!({ identifier: "com.acme.app" });
    const parsed = new URL(mockFetch.mock.calls[0][0]);
    expect(parsed.pathname).toBe("/v1/bundleIds");
    expect(parsed.searchParams.get("filter[identifier]")).toBe("com.acme.app");
  });

  it("list_profiles filters by profile type", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_profiles")!({ profile_type: "IOS_APP_STORE" });
    expect(sent(mockFetch).params.get("filter[profileType]")).toBe("IOS_APP_STORE");
    expect(sent(mockFetch).params.get("fields[profiles]")).not.toContain("profileContent");
  });

  it("list_certificates asks for the type and activation state", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    await tools.get("list_certificates")!({});
    const fields = sent(mockFetch).params.get("fields[certificates]")!;
    expect(fields).toContain("certificateType");
    expect(fields).toContain("activated");
    expect(fields).not.toContain("certificateContent");
  });

  it("registers only read tools unless writes are allowed", () => {
    expect([...collect(false).keys()]).toEqual([
      "list_devices",
      "list_certificates",
      "list_profiles",
      "list_bundle_ids",
      "get_bundle_id",
      "get_certificate",
      "get_profile",
    ]);
    expect([...collect(true).keys()].slice(7)).toEqual([
      "register_bundle_id",
      "update_bundle_id",
      "delete_bundle_id",
      "enable_capability",
      "update_capability",
      "disable_capability",
      "create_certificate",
      "create_profile",
      "delete_profile",
      "download_profile",
      "register_device",
      "update_device",
    ]);
  });

  it("get_bundle_id looks up an exact identifier and lists capabilities and profiles", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/v1/bundleIds") {
        return resp({
          data: [
            { type: "bundleIds", id: "B2", attributes: { identifier: "com.acme.app.extension" } },
            { type: "bundleIds", id: "B1", attributes: { identifier: "com.acme.app" } },
          ],
        });
      }
      if (path.endsWith("/bundleIdCapabilities")) {
        return resp({
          data: [
            {
              type: "bundleIdCapabilities",
              id: "B1_ICLOUD",
              attributes: { capabilityType: "ICLOUD" },
            },
          ],
        });
      }
      return resp({
        data: [{ type: "profiles", id: "PR1", attributes: { profileType: "IOS_APP_STORE" } }],
      });
    });
    const res = await tools.get("get_bundle_id")!({ identifier: "com.acme.app" });
    const out = JSON.parse(res.content[0].text!);
    expect(out.bundleId.id).toBe("B1");
    expect(out.capabilities[0].capabilityType).toBe("ICLOUD");
    expect(out.profiles[0].profileType).toBe("IOS_APP_STORE");
    const paths = mockFetch.mock.calls.map(([u]) => new URL(u).pathname);
    expect(paths).toContain("/v1/bundleIds/B1/bundleIdCapabilities");
    expect(paths).toContain("/v1/bundleIds/B1/profiles");
  });

  it("get_bundle_id reports an unknown identifier and requires an argument", async () => {
    mockFetch.mockResolvedValueOnce(resp({ data: [] }));
    expect((await tools.get("get_bundle_id")!({ identifier: "com.acme.none" })).isError).toBe(true);
    expect((await tools.get("get_bundle_id")!({})).isError).toBe(true);
  });

  it("get_bundle_id by id fetches the bundle id directly", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/v1/bundleIds/B1"
        ? resp({
            data: { type: "bundleIds", id: "B1", attributes: { identifier: "com.acme.app" } },
          })
        : resp({ data: [] }),
    );
    const out = JSON.parse(
      (await tools.get("get_bundle_id")!({ bundle_id_id: "B1" })).content[0].text!,
    );
    expect(out.bundleId.identifier).toBe("com.acme.app");
  });

  it("get_certificate only requests the content when asked", async () => {
    mockFetch.mockResolvedValue(resp({ data: { type: "certificates", id: "C1", attributes: {} } }));
    await tools.get("get_certificate")!({ certificate_id: "C1" });
    expect(sent(mockFetch).path).toBe("/v1/certificates/C1");
    expect(sent(mockFetch).params.get("fields[certificates]")).not.toContain("certificateContent");
    await tools.get("get_certificate")!({ certificate_id: "C1", include_content: true });
    expect(sent(mockFetch, 1).params.get("fields[certificates]")).toContain("certificateContent");
  });

  it("get_profile combines metadata, certificates, devices and the decoded entitlements", async () => {
    const content = buildProfile({ devices: ["00000000-0000000000000001"], taskAllow: true });
    mockFetch.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/v1/profiles/PR1") {
        return resp({
          data: {
            type: "profiles",
            id: "PR1",
            attributes: {
              name: "Acme Dev",
              profileType: "IOS_APP_DEVELOPMENT",
              profileContent: content,
            },
            relationships: { bundleId: { data: { type: "bundleIds", id: "B1" } } },
          },
          included: [{ type: "bundleIds", id: "B1", attributes: { identifier: "com.acme.app" } }],
        });
      }
      if (path.endsWith("/devices")) {
        return resp({ data: [{ type: "devices", id: "D1", attributes: { name: "Test Phone" } }] });
      }
      return resp({
        data: [
          { type: "certificates", id: "C1", attributes: { certificateType: "IOS_DEVELOPMENT" } },
        ],
      });
    });
    const res = await tools.get("get_profile")!({ profile_id: "PR1" });
    const out = JSON.parse(res.content[0].text!);
    expect(out.profile.profileType).toBe("IOS_APP_DEVELOPMENT");
    expect(out.profile.profileContent).toBeUndefined();
    expect(out.profile.bundleId.identifier).toBe("com.acme.app");
    expect(out.certificates[0].certificateType).toBe("IOS_DEVELOPMENT");
    expect(out.devices).toMatchObject({ count: 1 });
    expect(out.decoded.inferredType).toBe("development");
    expect(out.decoded.entitlements["get-task-allow"]).toBe(true);
    expect(out.decoded.entitlements["com.apple.developer.icloud-container-identifiers"]).toEqual([
      "iCloud.com.acme.app",
    ]);
    expect(res.content[0].text).not.toContain(content);
  });

  it("get_profile still returns the API data when the content cannot be decoded", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/v1/profiles/PR1"
        ? profileResponse(Buffer.from("not a profile").toString("base64"))
        : resp({ data: [] }),
    );
    const out = JSON.parse(
      (await tools.get("get_profile")!({ profile_id: "PR1" })).content[0].text!,
    );
    expect(out.profile.name).toBe("Acme App Store");
    expect(out.decoded).toBeNull();
    expect(out.decodeError).toMatch(/no property list/);
  });

  describe("write tools", () => {
    const noContent = { ok: true, status: 204, statusText: "No Content" };

    it("register_bundle_id posts the identifier, name and platform", async () => {
      mockFetch.mockResolvedValueOnce(
        resp({ data: { type: "bundleIds", id: "B1", attributes: {} } }),
      );
      await tools.get("register_bundle_id")!({
        identifier: "com.acme.app",
        name: "Acme",
        platform: "IOS",
      });
      expect(sent(mockFetch)).toMatchObject({
        method: "POST",
        path: "/v1/bundleIds",
        body: {
          data: {
            type: "bundleIds",
            attributes: { identifier: "com.acme.app", name: "Acme", platform: "IOS" },
          },
        },
      });
    });

    it("update_bundle_id renames and delete_bundle_id deletes", async () => {
      mockFetch.mockResolvedValueOnce(
        resp({ data: { type: "bundleIds", id: "B1", attributes: {} } }),
      );
      await tools.get("update_bundle_id")!({ bundle_id_id: "B1", name: "New" });
      expect(sent(mockFetch)).toMatchObject({
        method: "PATCH",
        path: "/v1/bundleIds/B1",
        body: { data: { type: "bundleIds", id: "B1", attributes: { name: "New" } } },
      });
      mockFetch.mockResolvedValueOnce(noContent);
      const res = await tools.get("delete_bundle_id")!({ bundle_id_id: "B1" });
      expect(sent(mockFetch, 1)).toMatchObject({ method: "DELETE", path: "/v1/bundleIds/B1" });
      expect(JSON.parse(res.content[0].text!)).toEqual({ deleted: "B1" });
    });

    it("enable_capability posts the type, settings and bundle id relationship", async () => {
      mockFetch.mockResolvedValueOnce(
        resp({ data: { type: "bundleIdCapabilities", id: "B1_ICLOUD", attributes: {} } }),
      );
      const settings = [{ key: "ICLOUD_VERSION", options: [{ key: "XCODE_6", enabled: true }] }];
      await tools.get("enable_capability")!({
        bundle_id_id: "B1",
        capability_type: "ICLOUD",
        settings,
      });
      expect(sent(mockFetch)).toMatchObject({
        method: "POST",
        path: "/v1/bundleIdCapabilities",
        body: {
          data: {
            type: "bundleIdCapabilities",
            attributes: { capabilityType: "ICLOUD", settings },
            relationships: { bundleId: { data: { type: "bundleIds", id: "B1" } } },
          },
        },
      });
    });

    it("enable_capability omits settings when none are given", async () => {
      mockFetch.mockResolvedValueOnce(
        resp({ data: { type: "bundleIdCapabilities", id: "x", attributes: {} } }),
      );
      await tools.get("enable_capability")!({
        bundle_id_id: "B1",
        capability_type: "PUSH_NOTIFICATIONS",
      });
      expect(sent(mockFetch).body.data.attributes).toEqual({
        capabilityType: "PUSH_NOTIFICATIONS",
      });
    });

    it("update_capability patches the settings and disable_capability deletes", async () => {
      mockFetch.mockResolvedValueOnce(
        resp({ data: { type: "bundleIdCapabilities", id: "c", attributes: {} } }),
      );
      const settings = [
        {
          key: "DATA_PROTECTION_PERMISSION_LEVEL",
          options: [{ key: "COMPLETE_PROTECTION", enabled: true }],
        },
      ];
      await tools.get("update_capability")!({ capability_id: "B1_DATA_PROTECTION", settings });
      expect(sent(mockFetch)).toMatchObject({
        method: "PATCH",
        path: "/v1/bundleIdCapabilities/B1_DATA_PROTECTION",
        body: {
          data: {
            type: "bundleIdCapabilities",
            id: "B1_DATA_PROTECTION",
            attributes: { settings },
          },
        },
      });
      mockFetch.mockResolvedValueOnce(noContent);
      await tools.get("disable_capability")!({ capability_id: "B1_ICLOUD" });
      expect(sent(mockFetch, 1)).toMatchObject({
        method: "DELETE",
        path: "/v1/bundleIdCapabilities/B1_ICLOUD",
      });
    });

    it("create_certificate posts the trimmed CSR and certificate type", async () => {
      mockFetch.mockResolvedValueOnce(
        resp({
          data: { type: "certificates", id: "C1", attributes: { certificateContent: "AAAA" } },
        }),
      );
      const res = await tools.get("create_certificate")!({
        certificate_type: "IOS_DISTRIBUTION",
        csr_content:
          "-----BEGIN CERTIFICATE REQUEST-----\nabc\n-----END CERTIFICATE REQUEST-----\n",
      });
      expect(sent(mockFetch)).toMatchObject({
        method: "POST",
        path: "/v1/certificates",
        body: {
          data: {
            type: "certificates",
            attributes: {
              certificateType: "IOS_DISTRIBUTION",
              csrContent:
                "-----BEGIN CERTIFICATE REQUEST-----\nabc\n-----END CERTIFICATE REQUEST-----",
            },
          },
        },
      });
      expect(JSON.parse(res.content[0].text!).certificateContent).toBe("AAAA");
    });

    it("create_profile builds an App Store profile without devices", async () => {
      mockFetch.mockResolvedValueOnce(profileResponse("SECRETCONTENT"));
      const res = await tools.get("create_profile")!({
        name: "Acme App Store",
        profile_type: "IOS_APP_STORE",
        bundle_id_id: "B1",
        certificate_ids: ["C1"],
      });
      expect(sent(mockFetch)).toMatchObject({
        method: "POST",
        path: "/v1/profiles",
        body: {
          data: {
            type: "profiles",
            attributes: { name: "Acme App Store", profileType: "IOS_APP_STORE" },
            relationships: {
              bundleId: { data: { type: "bundleIds", id: "B1" } },
              certificates: { data: [{ type: "certificates", id: "C1" }] },
            },
          },
        },
      });
      expect(sent(mockFetch).body.data.relationships.devices).toBeUndefined();
      expect(res.content[0].text).not.toContain("SECRETCONTENT");
      expect(JSON.parse(res.content[0].text!).profileType).toBe("IOS_APP_STORE");
    });

    it("create_profile includes devices for development and ad hoc profiles", async () => {
      for (const profile_type of ["IOS_APP_DEVELOPMENT", "IOS_APP_ADHOC", "TVOS_APP_ADHOC"]) {
        mockFetch.mockResolvedValueOnce(profileResponse("x"));
        await tools.get("create_profile")!({
          name: "n",
          profile_type,
          bundle_id_id: "B1",
          certificate_ids: ["C1"],
          device_ids: ["D1", "D2"],
        });
        const body = sent(mockFetch, mockFetch.mock.calls.length - 1).body;
        expect(body.data.relationships.devices.data).toEqual([
          { type: "devices", id: "D1" },
          { type: "devices", id: "D2" },
        ]);
      }
    });

    it("create_profile rejects a missing or misplaced device list before calling Apple", async () => {
      const create = tools.get("create_profile")!;
      const base = { name: "n", bundle_id_id: "B1", certificate_ids: ["C1"] };
      expect((await create({ ...base, profile_type: "IOS_APP_DEVELOPMENT" })).isError).toBe(true);
      expect(
        (await create({ ...base, profile_type: "IOS_APP_ADHOC", device_ids: [] })).isError,
      ).toBe(true);
      expect(
        (await create({ ...base, profile_type: "IOS_APP_STORE", device_ids: ["D1"] })).isError,
      ).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("delete_profile deletes by id", async () => {
      mockFetch.mockResolvedValueOnce(noContent);
      await tools.get("delete_profile")!({ profile_id: "PR1" });
      expect(sent(mockFetch)).toMatchObject({ method: "DELETE", path: "/v1/profiles/PR1" });
    });

    it("register_device and update_device send the documented attributes", async () => {
      mockFetch.mockResolvedValue(resp({ data: { type: "devices", id: "D1", attributes: {} } }));
      await tools.get("register_device")!({
        name: "Test Phone",
        udid: "0000-TEST",
        platform: "IOS",
      });
      expect(sent(mockFetch)).toMatchObject({
        method: "POST",
        path: "/v1/devices",
        body: {
          data: {
            type: "devices",
            attributes: { name: "Test Phone", udid: "0000-TEST", platform: "IOS" },
          },
        },
      });
      await tools.get("update_device")!({ device_id: "D1", status: "DISABLED" });
      expect(sent(mockFetch, 1)).toMatchObject({
        method: "PATCH",
        path: "/v1/devices/D1",
        body: { data: { type: "devices", id: "D1", attributes: { status: "DISABLED" } } },
      });
      expect((await tools.get("update_device")!({ device_id: "D1" })).isError).toBe(true);
    });

    it("reports Apple errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        statusText: "Conflict",
        text: () => Promise.resolve("ENTITY_ERROR"),
      });
      const res = await tools.get("register_bundle_id")!({
        identifier: "com.acme.app",
        name: "Acme",
        platform: "IOS",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("409 Conflict: ENTITY_ERROR");
    });
  });

  describe("download_profile", () => {
    const profile = buildProfile({});
    const bytes = Buffer.from(profile, "base64");

    function files() {
      return readdirSync(dir).sort();
    }

    beforeEach(() => {
      for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
      mockFetch.mockImplementation(async () => profileResponse(profile));
    });

    it("requires a destination", async () => {
      const res = await tools.get("download_profile")!({ profile_id: "PR1" });
      expect(res.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("requests the profile content", async () => {
      await tools.get("download_profile")!({ profile_id: "PR1", return_base64: true });
      expect(sent(mockFetch).path).toBe("/v1/profiles/PR1");
      expect(sent(mockFetch).params.get("fields[profiles]")).toContain("profileContent");
    });

    it("returns base64 without touching the disk", async () => {
      const res = await collect(true, null).get("download_profile")!({
        profile_id: "PR1",
        return_base64: true,
      });
      const out = JSON.parse(res.content[0].text!);
      expect(out.contentBase64).toBe(profile);
      expect(out.bytes).toBe(bytes.length);
      expect(out.savedTo).toBeUndefined();
      expect(files()).toEqual([]);
    });

    it("writes the .mobileprovision file inside the download directory", async () => {
      const res = await tools.get("download_profile")!({
        profile_id: "PR1",
        file_name: "acme.mobileprovision",
      });
      const out = JSON.parse(res.content[0].text!);
      expect(readFileSync(join(dir, "acme.mobileprovision")).equals(bytes)).toBe(true);
      expect(out.savedTo.endsWith("acme.mobileprovision")).toBe(true);
      expect(out.contentBase64).toBeUndefined();
      expect(files()).toEqual(["acme.mobileprovision"]);
    });

    it("writes into an existing subdirectory", async () => {
      mkdirSync(join(dir, "sub"));
      const res = await tools.get("download_profile")!({
        profile_id: "PR1",
        file_name: "sub/acme.mobileprovision",
      });
      expect(res.isError).toBeUndefined();
      expect(existsSync(join(dir, "sub", "acme.mobileprovision"))).toBe(true);
    });

    it("is disabled without ASC_DOWNLOAD_DIR", async () => {
      const res = await collect(true, null).get("download_profile")!({
        profile_id: "PR1",
        file_name: "acme.mobileprovision",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("ASC_DOWNLOAD_DIR");
    });

    it("rejects traversal, absolute paths and other extensions", async () => {
      const outside = join(root, "evil.mobileprovision");
      for (const file_name of [
        "../evil.mobileprovision",
        "sub/../../evil.mobileprovision",
        outside,
        "acme.txt",
        "acme",
        ".mobileprovision",
        "acme.mobileprovision\0.txt",
      ]) {
        const res = await tools.get("download_profile")!({ profile_id: "PR1", file_name });
        expect(res.isError, file_name).toBe(true);
      }
      expect(existsSync(outside)).toBe(false);
      expect(files()).toEqual([]);
    });

    it("rejects a symlinked directory that points outside", async () => {
      const outsideDir = join(root, "outside");
      mkdirSync(outsideDir);
      symlinkSync(outsideDir, join(dir, "link"));
      const res = await tools.get("download_profile")!({
        profile_id: "PR1",
        file_name: "link/acme.mobileprovision",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("outside ASC_DOWNLOAD_DIR");
      expect(readdirSync(outsideDir)).toEqual([]);
    });

    it("never follows a symlinked target file, with or without overwrite", async () => {
      const victim = join(root, "victim.txt");
      writeFileSync(victim, "keep");
      symlinkSync(victim, join(dir, "acme.mobileprovision"));
      for (const overwrite of [false, true]) {
        const res = await tools.get("download_profile")!({
          profile_id: "PR1",
          file_name: "acme.mobileprovision",
          overwrite,
        });
        expect(res.isError).toBe(true);
      }
      expect(readFileSync(victim, "utf-8")).toBe("keep");
    });

    it("refuses a dangling symlink target", async () => {
      symlinkSync(join(root, "does-not-exist"), join(dir, "acme.mobileprovision"));
      const res = await tools.get("download_profile")!({
        profile_id: "PR1",
        file_name: "acme.mobileprovision",
      });
      expect(res.isError).toBe(true);
      expect(existsSync(join(root, "does-not-exist"))).toBe(false);
    });

    it("keeps an existing file unless overwrite is set", async () => {
      writeFileSync(join(dir, "acme.mobileprovision"), "old");
      const res = await tools.get("download_profile")!({
        profile_id: "PR1",
        file_name: "acme.mobileprovision",
      });
      expect(res.isError).toBe(true);
      expect(readFileSync(join(dir, "acme.mobileprovision"), "utf-8")).toBe("old");
      const again = await tools.get("download_profile")!({
        profile_id: "PR1",
        file_name: "acme.mobileprovision",
        overwrite: true,
      });
      expect(again.isError).toBeUndefined();
      expect(readFileSync(join(dir, "acme.mobileprovision")).equals(bytes)).toBe(true);
      expect(files()).toEqual(["acme.mobileprovision"]);
    });

    it("does not write anything when Apple returns no usable content", async () => {
      mockFetch.mockImplementation(async () => profileResponse(""));
      const res = await tools.get("download_profile")!({
        profile_id: "PR1",
        file_name: "acme.mobileprovision",
      });
      expect(res.isError).toBe(true);
      expect(files()).toEqual([]);
    });
  });
});
