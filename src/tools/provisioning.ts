import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppStoreConnectClient, JsonApiResource, QueryParams } from "../asc/client.js";
import { ok, err, flattenResource, shapeResource } from "../asc/format.js";
import { decodeProfile } from "../asc/profile.js";
import { CREATE, DESTRUCTIVE, OVERWRITE, READ_ONLY } from "./shared.js";

const PROFILE_FIELDS = "name,platform,profileType,profileState,uuid,createdDate,expirationDate";
const CERTIFICATE_FIELDS =
  "certificateType,displayName,name,platform,serialNumber,expirationDate,activated";
const DEVICE_FIELDS = "name,platform,udid,deviceClass,status,model,addedDate";

const PROFILE_TYPES = [
  "IOS_APP_DEVELOPMENT",
  "IOS_APP_STORE",
  "IOS_APP_ADHOC",
  "IOS_APP_INHOUSE",
  "MAC_APP_DEVELOPMENT",
  "MAC_APP_STORE",
  "MAC_APP_DIRECT",
  "TVOS_APP_DEVELOPMENT",
  "TVOS_APP_STORE",
  "TVOS_APP_ADHOC",
  "TVOS_APP_INHOUSE",
  "MAC_CATALYST_APP_DEVELOPMENT",
  "MAC_CATALYST_APP_STORE",
  "MAC_CATALYST_APP_DIRECT",
] as const;

const PROFILE_TYPE_GUIDE =
  "Profile types: IOS_APP_STORE = App Store and TestFlight distribution (no devices, needs a distribution certificate) - the one to use for uploading a release build; IOS_APP_DEVELOPMENT = debug builds on registered devices from Xcode (needs device_ids and a development certificate), it cannot be uploaded to App Store Connect; IOS_APP_ADHOC = release build installed on registered devices outside the App Store (needs device_ids and a distribution certificate); IOS_APP_INHOUSE = Apple Developer Enterprise Program in-house distribution (enterprise accounts only). The MAC_APP_*, TVOS_APP_* and MAC_CATALYST_APP_* types follow the same pattern: *_DEVELOPMENT for debugging, *_STORE for the (Mac) App Store, *_ADHOC / *_INHOUSE as above, MAC_APP_DIRECT and MAC_CATALYST_APP_DIRECT for Developer ID distribution outside the Mac App Store.";

const CERTIFICATE_TYPES = [
  "APPLE_PAY",
  "APPLE_PAY_MERCHANT_IDENTITY",
  "APPLE_PAY_PSP_IDENTITY",
  "APPLE_PAY_RSA",
  "DEVELOPER_ID_KEXT",
  "DEVELOPER_ID_KEXT_G2",
  "DEVELOPER_ID_APPLICATION",
  "DEVELOPER_ID_APPLICATION_G2",
  "DEVELOPMENT",
  "DISTRIBUTION",
  "IDENTITY_ACCESS",
  "IOS_DEVELOPMENT",
  "IOS_DISTRIBUTION",
  "MAC_APP_DISTRIBUTION",
  "MAC_INSTALLER_DISTRIBUTION",
  "MAC_APP_DEVELOPMENT",
  "PASS_TYPE_ID",
  "PASS_TYPE_ID_WITH_NFC",
] as const;

const CERTIFICATE_TYPE_GUIDE =
  "Certificate types: IOS_DEVELOPMENT and DEVELOPMENT (Apple Development) sign debug builds; IOS_DISTRIBUTION (iOS Distribution) and DISTRIBUTION (Apple Distribution, all platforms) sign App Store and Ad Hoc builds; MAC_APP_DISTRIBUTION and MAC_INSTALLER_DISTRIBUTION sign Mac App Store apps and installers; DEVELOPER_ID_APPLICATION(_G2) signs Mac apps distributed outside the Mac App Store.";

const CAPABILITY_TYPES = [
  "ICLOUD",
  "IN_APP_PURCHASE",
  "GAME_CENTER",
  "PUSH_NOTIFICATIONS",
  "WALLET",
  "INTER_APP_AUDIO",
  "MAPS",
  "ASSOCIATED_DOMAINS",
  "PERSONAL_VPN",
  "APP_GROUPS",
  "HEALTHKIT",
  "HOMEKIT",
  "WIRELESS_ACCESSORY_CONFIGURATION",
  "APPLE_PAY",
  "DATA_PROTECTION",
  "SIRIKIT",
  "NETWORK_EXTENSIONS",
  "MULTIPATH",
  "HOT_SPOT",
  "NFC_TAG_READING",
  "CLASSKIT",
  "AUTOFILL_CREDENTIAL_PROVIDER",
  "ACCESS_WIFI_INFORMATION",
  "NETWORK_CUSTOM_PROTOCOL",
  "COREMEDIA_HLS_LOW_LATENCY",
  "SYSTEM_EXTENSION_INSTALL",
  "USER_MANAGEMENT",
  "APPLE_ID_AUTH",
] as const;

const CONTAINER_NOTE =
  "The App Store Connect API has no iCloud container endpoints: it cannot list or create iCloud containers and cannot link a container (or an app group, merchant ID or Sign in with Apple group) to a bundle ID. Enabling ICLOUD here only switches the capability on; create the container and associate it with the App ID in the Apple Developer portal (Certificates, Identifiers & Profiles > Identifiers > the App ID > iCloud > Configure).";

const REGENERATE_NOTE =
  "Changing an App ID's capabilities invalidates its existing provisioning profiles (profileState INVALID); create a new profile afterwards.";

const settingsSchema = z
  .array(
    z.object({
      key: z.enum([
        "ICLOUD_VERSION",
        "DATA_PROTECTION_PERMISSION_LEVEL",
        "APPLE_ID_AUTH_APP_CONSENT",
      ]),
      options: z
        .array(
          z.object({
            key: z.enum([
              "XCODE_5",
              "XCODE_6",
              "COMPLETE_PROTECTION",
              "PROTECTED_UNLESS_OPEN",
              "PROTECTED_UNTIL_FIRST_USER_AUTH",
              "PRIMARY_APP_CONSENT",
            ]),
            enabled: z.boolean().optional(),
          }),
        )
        .optional(),
    }),
  )
  .describe(
    "Capability settings as Apple expects them, e.g. iCloud with CloudKit: [{ key: 'ICLOUD_VERSION', options: [{ key: 'XCODE_6', enabled: true }] }] (XCODE_6 is the portal's 'Include CloudKit support' option, XCODE_5 the legacy one); Data Protection: [{ key: 'DATA_PROTECTION_PERMISSION_LEVEL', options: [{ key: 'COMPLETE_PROTECTION', enabled: true }] }]. Capabilities without settings (e.g. PUSH_NOTIFICATIONS) need none.",
  );

function defined(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
}

async function saveProfile(
  downloadDir: string | undefined,
  fileName: string,
  bytes: Buffer,
  overwrite: boolean,
) {
  if (!downloadDir) {
    throw new Error(
      "Saving to disk is disabled because ASC_DOWNLOAD_DIR is not set. Set ASC_DOWNLOAD_DIR to the directory profiles may be written to, or pass return_base64 instead.",
    );
  }
  if (fileName.includes("\0")) throw new Error("file_name contains a NUL byte");
  if (isAbsolute(fileName)) throw new Error(`${fileName} must be relative to ASC_DOWNLOAD_DIR`);
  if (extname(fileName).toLowerCase() !== ".mobileprovision") {
    throw new Error(`${fileName}: only .mobileprovision files can be written`);
  }
  const base = await realpath(downloadDir);
  const target = resolve(base, fileName);
  const parent = await realpath(dirname(target));
  const rel = relative(base, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${fileName} is outside ASC_DOWNLOAD_DIR`);
  }
  const dest = join(parent, basename(target));
  const existing = await lstat(dest).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink()) throw new Error(`${fileName} is a symbolic link`);
    if (!existing.isFile()) throw new Error(`${fileName} is not a regular file`);
    if (!overwrite) {
      throw new Error(`${fileName} already exists; pass overwrite to replace it`);
    }
  }
  if (overwrite) {
    const temp = join(parent, `.${basename(dest)}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      await rename(temp, dest);
    } catch (e) {
      await unlink(temp).catch(() => {});
      throw e;
    }
  } else {
    const handle = await open(dest, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
    } catch (e) {
      await handle.close();
      await unlink(dest).catch(() => {});
      throw e;
    }
    await handle.close();
  }
  return dest;
}

export function registerProvisioningTools(
  server: McpServer,
  client: AppStoreConnectClient,
  allowWrites = false,
  downloadDir?: string,
) {
  server.tool(
    "list_devices",
    "List registered devices (name, platform, UDID, class, model, status). Filter by platform or status.",
    {
      platform: z
        .enum(["IOS", "MAC_OS", "UNIVERSAL"])
        .optional()
        .describe("Filter by device platform"),
      status: z.enum(["ENABLED", "DISABLED"]).optional().describe("Filter by device status"),
      limit: z.number().int().min(1).max(200).optional().describe("Max devices (default: 100)"),
    },
    READ_ONLY,
    async ({ platform, status, limit }) => {
      try {
        const params: QueryParams = {
          "fields[devices]": DEVICE_FIELDS,
          limit: limit ?? 100,
        };
        if (platform) params["filter[platform]"] = platform;
        if (status) params["filter[status]"] = status;
        const { data } = await client.getAll("/devices", params);
        return ok({ count: data.length, devices: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_certificates",
    `List signing certificates (id, certificateType, name, platform, serial number, expiry, activated). Filter by certificate type. The id is what create_profile takes in certificate_ids; a certificate whose type is IOS_DEVELOPMENT or DEVELOPMENT cannot sign an App Store build. ${CERTIFICATE_TYPE_GUIDE}`,
    {
      certificate_type: z
        .enum(CERTIFICATE_TYPES)
        .optional()
        .describe("Filter by type, e.g. 'IOS_DISTRIBUTION', 'IOS_DEVELOPMENT', 'DISTRIBUTION'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max certificates (default: 100)"),
    },
    READ_ONLY,
    async ({ certificate_type, limit }) => {
      try {
        const params: QueryParams = {
          "fields[certificates]": CERTIFICATE_FIELDS,
          limit: limit ?? 100,
        };
        if (certificate_type) params["filter[certificateType]"] = certificate_type;
        const { data } = await client.getAll("/certificates", params);
        return ok({ count: data.length, certificates: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_profiles",
    `List provisioning profiles (id, name, platform, profileType, state, UUID, expiry) with their bundle ID. Filter by profile state or type. Use get_profile for one profile's certificates, devices and entitlements. ${PROFILE_TYPE_GUIDE}`,
    {
      profile_state: z.enum(["ACTIVE", "INVALID"]).optional().describe("Filter by profile state"),
      profile_type: z.enum(PROFILE_TYPES).optional().describe("Filter by profile type"),
      limit: z.number().int().min(1).max(200).optional().describe("Max profiles (default: 100)"),
    },
    READ_ONLY,
    async ({ profile_state, profile_type, limit }) => {
      try {
        const params: QueryParams = {
          "fields[profiles]": PROFILE_FIELDS,
          "fields[bundleIds]": "identifier,name,platform",
          include: "bundleId",
          limit: limit ?? 100,
        };
        if (profile_state) params["filter[profileState]"] = profile_state;
        if (profile_type) params["filter[profileType]"] = profile_type;
        const { data, included } = await client.getAll("/profiles", params);
        const profiles = data.map((d) =>
          shapeResource(d, included, { relationships: ["bundleId"] }),
        );
        return ok({ count: profiles.length, profiles });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_bundle_ids",
    "List registered bundle IDs / App IDs (id, identifier, name, platform, seed ID). Filter by identifier or platform. The id field (not the reverse-DNS identifier) is what get_bundle_id, enable_capability and create_profile take. Apple may match the identifier filter loosely, so check the identifier of each result.",
    {
      identifier: z
        .string()
        .optional()
        .describe("Filter by bundle identifier, e.g. 'com.acme.app'"),
      platform: z
        .enum(["IOS", "MAC_OS", "UNIVERSAL"])
        .optional()
        .describe("Filter by bundle platform"),
      limit: z.number().int().min(1).max(200).optional().describe("Max bundle IDs (default: 100)"),
    },
    READ_ONLY,
    async ({ identifier, platform, limit }) => {
      try {
        const params: QueryParams = {
          "fields[bundleIds]": "identifier,name,platform,seedId",
          limit: limit ?? 100,
        };
        if (identifier) params["filter[identifier]"] = identifier;
        if (platform) params["filter[platform]"] = platform;
        const { data } = await client.getAll("/bundleIds", params);
        return ok({ count: data.length, bundleIds: data.map((d) => flattenResource(d)) });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_bundle_id",
    "Get one bundle ID (App ID) with its enabled capabilities (type and settings, e.g. iCloud / push notifications) and its provisioning profiles (id, type, state, expiry). Pass either bundle_id_id (the id from list_bundle_ids) or the reverse-DNS identifier. Capability ids returned here are what update_capability and disable_capability take. iCloud containers are not visible through the API: whether a container is linked to the App ID can only be checked in the developer portal, or from the entitlements inside a profile (get_profile).",
    {
      bundle_id_id: z.string().optional().describe("Bundle ID resource id (from list_bundle_ids)"),
      identifier: z
        .string()
        .optional()
        .describe("Exact bundle identifier, e.g. 'com.acme.app' (alternative to bundle_id_id)"),
    },
    READ_ONLY,
    async ({ bundle_id_id, identifier }) => {
      try {
        if (!bundle_id_id && !identifier) return err("Pass either bundle_id_id or identifier.");
        let bundleId: Record<string, unknown> | null;
        if (bundle_id_id) {
          const res = await client.get(`/bundleIds/${encodeURIComponent(bundle_id_id)}`, {
            "fields[bundleIds]": "identifier,name,platform,seedId",
          });
          bundleId = flattenResource(res.data as JsonApiResource);
        } else {
          const { data } = await client.getAll("/bundleIds", {
            "filter[identifier]": identifier,
            "fields[bundleIds]": "identifier,name,platform,seedId",
            limit: 200,
          });
          const match = data.find((d) => d.attributes?.identifier === identifier);
          if (!match) return err(`No bundle ID with identifier ${identifier} found.`);
          bundleId = flattenResource(match);
        }
        const id = encodeURIComponent(String(bundleId?.id));
        const [capabilities, profiles] = await Promise.all([
          client.getAll(`/bundleIds/${id}/bundleIdCapabilities`, {
            "fields[bundleIdCapabilities]": "capabilityType,settings",
            limit: 200,
          }),
          client.getAll(`/bundleIds/${id}/profiles`, {
            "fields[profiles]": PROFILE_FIELDS,
            limit: 200,
          }),
        ]);
        return ok({
          bundleId,
          capabilities: capabilities.data.map((d) => flattenResource(d)),
          profiles: profiles.data.map((d) => flattenResource(d)),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_certificate",
    "Get one signing certificate (type, name, platform, serial number, expiry, activated). With include_content the base64 DER certificate (.cer) is returned too, e.g. to build a .p12 together with the private key of the CSR it was created from. Certificate ids come from list_certificates.",
    {
      certificate_id: z.string().describe("Certificate id (from list_certificates)"),
      include_content: z
        .boolean()
        .optional()
        .describe("Also return certificateContent (base64 DER). Default false."),
    },
    READ_ONLY,
    async ({ certificate_id, include_content }) => {
      try {
        const res = await client.get(`/certificates/${encodeURIComponent(certificate_id)}`, {
          "fields[certificates]": include_content
            ? `${CERTIFICATE_FIELDS},certificateContent`
            : CERTIFICATE_FIELDS,
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "get_profile",
    "Inspect one provisioning profile: type (profileType), state, expiry, bundle ID, the certificates and devices it contains, and the decoded contents of the profile itself (entitlements such as aps-environment, get-task-allow and the iCloud container / service entitlements, team, app identifier, inferred type, certificate serial numbers). Use it to catch a wrong profile type (a development profile has get-task-allow true and a device list; an App Store profile has neither) or a missing iCloud container (no com.apple.developer.icloud-container-identifiers entitlement). The profile content is a CMS-signed property list; it is decoded without verifying the signature, so treat the decoded part as a convenience view of what Apple returned. Profile ids come from list_profiles or get_bundle_id.",
    { profile_id: z.string().describe("Profile id (from list_profiles)") },
    READ_ONLY,
    async ({ profile_id }) => {
      try {
        const id = encodeURIComponent(profile_id);
        const [profile, devices, certificates] = await Promise.all([
          client.get(`/profiles/${id}`, {
            "fields[profiles]": `${PROFILE_FIELDS},profileContent`,
            "fields[bundleIds]": "identifier,name,platform",
            include: "bundleId",
          }),
          client.getAll(`/profiles/${id}/devices`, {
            "fields[devices]": DEVICE_FIELDS,
            limit: 200,
          }),
          client.getAll(`/profiles/${id}/certificates`, {
            "fields[certificates]": CERTIFICATE_FIELDS,
            limit: 200,
          }),
        ]);
        const resource = profile.data as JsonApiResource;
        const { profileContent, ...attributes } = (resource.attributes ?? {}) as Record<
          string,
          unknown
        >;
        const shaped = shapeResource({ ...resource, attributes }, profile.included ?? [], {
          relationships: ["bundleId"],
        });
        let decoded: unknown = null;
        let decodeError: string | undefined;
        try {
          decoded = decodeProfile(String(profileContent ?? ""));
        } catch (e) {
          decodeError = e instanceof Error ? e.message : String(e);
        }
        return ok({
          profile: shaped,
          certificates: certificates.data.map((d) => flattenResource(d)),
          devices: {
            count: devices.data.length,
            items: devices.data.map((d) => flattenResource(d)),
          },
          decoded,
          ...(decodeError ? { decodeError } : {}),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  if (!allowWrites) return;

  server.tool(
    "register_bundle_id",
    "Writes. Register a new bundle ID (App ID) in the developer account. The identifier is permanent (only the name can be changed later). Returns the new id, which enable_capability and create_profile take. Registering a bundle ID does not create the app record in App Store Connect; the API cannot do that, create the app in the App Store Connect web UI.",
    {
      identifier: z
        .string()
        .describe("Reverse-DNS identifier, e.g. 'com.acme.app' (a trailing '.*' makes a wildcard)"),
      name: z.string().describe("Display name in the developer portal"),
      platform: z
        .enum(["IOS", "MAC_OS", "UNIVERSAL"])
        .describe(
          "IOS for iOS/iPadOS/tvOS/watchOS/visionOS apps, MAC_OS for macOS, UNIVERSAL for both",
        ),
      seed_id: z.string().optional().describe("App ID prefix (team ID); defaults to the team's"),
    },
    CREATE,
    async ({ identifier, name, platform, seed_id }) => {
      try {
        const res = await client.post("/bundleIds", {
          data: {
            type: "bundleIds",
            attributes: defined({ identifier, name, platform, seedId: seed_id }),
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_bundle_id",
    "Writes. Rename a bundle ID (the display name only; the identifier cannot be changed). bundle_id_id comes from list_bundle_ids.",
    {
      bundle_id_id: z.string().describe("Bundle ID resource id (from list_bundle_ids)"),
      name: z.string().describe("New display name"),
    },
    OVERWRITE,
    async ({ bundle_id_id, name }) => {
      try {
        const res = await client.patch(`/bundleIds/${encodeURIComponent(bundle_id_id)}`, {
          data: { type: "bundleIds", id: bundle_id_id, attributes: { name } },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_bundle_id",
    "Writes, destructive and permanent. Delete a bundle ID (App ID). Its capabilities and settings are lost and its provisioning profiles become unusable. Apple only allows this for bundle IDs used for development: it fails for a bundle ID that is used by an app in App Store Connect. bundle_id_id comes from list_bundle_ids.",
    { bundle_id_id: z.string().describe("Bundle ID resource id (from list_bundle_ids)") },
    DESTRUCTIVE,
    async ({ bundle_id_id }) => {
      try {
        await client.delete(`/bundleIds/${encodeURIComponent(bundle_id_id)}`);
        return ok({ deleted: bundle_id_id });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "enable_capability",
    `Writes. Enable a capability (App ID service) on a bundle ID, e.g. PUSH_NOTIFICATIONS, ICLOUD (with CloudKit via settings), ASSOCIATED_DOMAINS, APP_GROUPS, IN_APP_PURCHASE, HEALTHKIT. bundle_id_id comes from list_bundle_ids / register_bundle_id; the capability type is one of the enum values. Some capabilities take settings (see the settings parameter). ${CONTAINER_NOTE} ${REGENERATE_NOTE} Returns the capability resource; its id is what update_capability and disable_capability take.`,
    {
      bundle_id_id: z.string().describe("Bundle ID resource id (from list_bundle_ids)"),
      capability_type: z.enum(CAPABILITY_TYPES).describe("Capability to enable"),
      settings: settingsSchema.optional(),
    },
    CREATE,
    async ({ bundle_id_id, capability_type, settings }) => {
      try {
        const res = await client.post("/bundleIdCapabilities", {
          data: {
            type: "bundleIdCapabilities",
            attributes: defined({ capabilityType: capability_type, settings }),
            relationships: { bundleId: { data: { type: "bundleIds", id: bundle_id_id } } },
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_capability",
    `Writes. Replace the settings of a capability that is already enabled on a bundle ID (e.g. switch iCloud between its CloudKit options, or change the Data Protection level). capability_id comes from get_bundle_id. ${CONTAINER_NOTE} ${REGENERATE_NOTE}`,
    {
      capability_id: z.string().describe("Capability id (from get_bundle_id)"),
      settings: settingsSchema,
    },
    OVERWRITE,
    async ({ capability_id, settings }) => {
      try {
        const res = await client.patch(
          `/bundleIdCapabilities/${encodeURIComponent(capability_id)}`,
          { data: { type: "bundleIdCapabilities", id: capability_id, attributes: { settings } } },
        );
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "disable_capability",
    `Writes, destructive. Disable a capability on a bundle ID. The capability and its settings are removed from the App ID (for iCloud this also drops the container association made in the portal, which the API cannot restore). ${REGENERATE_NOTE} capability_id comes from get_bundle_id.`,
    { capability_id: z.string().describe("Capability id (from get_bundle_id)") },
    DESTRUCTIVE,
    async ({ capability_id }) => {
      try {
        await client.delete(`/bundleIdCapabilities/${encodeURIComponent(capability_id)}`);
        return ok({ deleted: capability_id });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "create_certificate",
    `Writes. Create a signing certificate from a certificate signing request (PEM). Generate the key and CSR yourself, e.g. 'openssl req -new -newkey rsa:2048 -nodes -keyout dist.key -out dist.csr -subj "/CN=Distribution"'; keep the private key, Apple never sees it. Returns the certificate including its base64 DER content (certificateContent, a .cer) and id (for create_profile). Apple limits how many active certificates of a type may exist, so this can fail until an old one is revoked in the developer portal (revocation is deliberately not offered here). ${CERTIFICATE_TYPE_GUIDE}`,
    {
      certificate_type: z.enum(CERTIFICATE_TYPES).describe("Type of certificate to create"),
      csr_content: z.string().describe("PEM text of the certificate signing request"),
    },
    CREATE,
    async ({ certificate_type, csr_content }) => {
      try {
        const res = await client.post("/certificates", {
          data: {
            type: "certificates",
            attributes: { certificateType: certificate_type, csrContent: csr_content.trim() },
          },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "create_profile",
    `Writes. Create a provisioning profile for a bundle ID and certificates. Choosing the wrong profile_type is the classic mistake (a Development profile cannot be used to ship a build); for an App Store / TestFlight release use IOS_APP_STORE with a distribution certificate (IOS_DISTRIBUTION or DISTRIBUTION from list_certificates) and no devices. ${PROFILE_TYPE_GUIDE} bundle_id_id comes from list_bundle_ids, certificate_ids from list_certificates, device_ids from list_devices. Enable the needed capabilities (and link the iCloud container in the portal) BEFORE creating the profile, because its entitlements are fixed at creation. Returns the profile without its content; verify it with get_profile and export it with download_profile.`,
    {
      name: z.string().describe("Profile name"),
      profile_type: z.enum(PROFILE_TYPES).describe("Profile type (see the tool description)"),
      bundle_id_id: z.string().describe("Bundle ID resource id (from list_bundle_ids)"),
      certificate_ids: z
        .array(z.string())
        .min(1)
        .describe("Certificate ids (from list_certificates); must match the profile type"),
      device_ids: z
        .array(z.string())
        .optional()
        .describe("Device ids (from list_devices); required for *_DEVELOPMENT and *_ADHOC types"),
    },
    CREATE,
    async ({ name, profile_type, bundle_id_id, certificate_ids, device_ids }) => {
      try {
        const needsDevices = /_(APP_DEVELOPMENT|APP_ADHOC)$/.test(profile_type);
        if (needsDevices && !device_ids?.length) {
          return err(`${profile_type} profiles need device_ids (see list_devices).`);
        }
        if (!needsDevices && device_ids?.length) {
          return err(`${profile_type} profiles do not contain devices; omit device_ids.`);
        }
        const res = await client.post("/profiles", {
          data: {
            type: "profiles",
            attributes: { name, profileType: profile_type },
            relationships: {
              bundleId: { data: { type: "bundleIds", id: bundle_id_id } },
              certificates: { data: certificate_ids.map((id) => ({ type: "certificates", id })) },
              ...(needsDevices
                ? { devices: { data: device_ids!.map((id) => ({ type: "devices", id })) } }
                : {}),
            },
          },
        });
        const { profileContent: _content, ...rest } = flattenResource(
          res.data as JsonApiResource,
        ) as Record<string, unknown>;
        return ok(rest);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "delete_profile",
    "Writes, destructive and permanent. Delete a provisioning profile; it cannot be restored (create a new one instead). Profile ids come from list_profiles.",
    { profile_id: z.string().describe("Profile id (from list_profiles)") },
    DESTRUCTIVE,
    async ({ profile_id }) => {
      try {
        await client.delete(`/profiles/${encodeURIComponent(profile_id)}`);
        return ok({ deleted: profile_id });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "download_profile",
    "Writes to the local disk. Export a provisioning profile as a .mobileprovision file and/or as base64. With file_name the file is written inside the directory set in ASC_DOWNLOAD_DIR (relative path, must end in .mobileprovision, the target directory must already exist, symbolic links are never followed and an existing file is only replaced with overwrite). With return_base64 the content is returned in the result instead, without touching the disk. At least one of the two is required. Install on a Mac by copying the file to ~/Library/MobileDevice/Provisioning Profiles/<uuid>.mobileprovision. Profile ids come from list_profiles.",
    {
      profile_id: z.string().describe("Profile id (from list_profiles)"),
      file_name: z
        .string()
        .optional()
        .describe("File to write inside ASC_DOWNLOAD_DIR, e.g. 'MyApp_AppStore.mobileprovision'"),
      overwrite: z.boolean().optional().describe("Replace an existing file (default false)"),
      return_base64: z.boolean().optional().describe("Return the content base64-encoded"),
    },
    OVERWRITE,
    async ({ profile_id, file_name, overwrite, return_base64 }) => {
      try {
        if (!file_name && !return_base64) {
          return err("Pass file_name to write a file and/or return_base64 to get the content.");
        }
        const res = await client.get(`/profiles/${encodeURIComponent(profile_id)}`, {
          "fields[profiles]": "name,profileType,uuid,profileContent",
        });
        const { profileContent, ...info } = flattenResource(res.data as JsonApiResource) as Record<
          string,
          unknown
        >;
        const bytes = Buffer.from(String(profileContent ?? ""), "base64");
        if (bytes.length === 0 || bytes[0] !== 0x30) {
          return err("Apple returned no usable profile content (is the profile INVALID?).");
        }
        const savedTo = file_name
          ? await saveProfile(downloadDir, file_name, bytes, overwrite ?? false)
          : undefined;
        return ok({
          ...info,
          bytes: bytes.length,
          ...(savedTo ? { savedTo } : {}),
          ...(return_base64 ? { contentBase64: bytes.toString("base64") } : {}),
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "register_device",
    "Writes. Register a device by UDID so it can be added to development and ad hoc profiles. Registered devices count toward the annual device limit, and a device cannot be deleted later, only disabled (update_device). Returns the device id used by create_profile.",
    {
      name: z.string().describe("Device name"),
      udid: z.string().describe("Device UDID"),
      platform: z
        .enum(["IOS", "MAC_OS", "UNIVERSAL"])
        .describe("Device platform (IOS also covers iPadOS, tvOS, watchOS, visionOS)"),
    },
    CREATE,
    async ({ name, udid, platform }) => {
      try {
        const res = await client.post("/devices", {
          data: { type: "devices", attributes: { name, udid, platform } },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_device",
    "Writes. Rename a device and/or enable or disable it. A disabled device still counts toward the annual device limit. Device ids come from list_devices.",
    {
      device_id: z.string().describe("Device id (from list_devices)"),
      name: z.string().optional().describe("New device name"),
      status: z.enum(["ENABLED", "DISABLED"]).optional().describe("New status"),
    },
    OVERWRITE,
    async ({ device_id, name, status }) => {
      try {
        const attributes = defined({ name, status });
        if (Object.keys(attributes).length === 0) return err("Pass name and/or status.");
        const res = await client.patch(`/devices/${encodeURIComponent(device_id)}`, {
          data: { type: "devices", id: device_id, attributes },
        });
        return ok(flattenResource(res.data as JsonApiResource));
      } catch (e) {
        return err(e);
      }
    },
  );
}
