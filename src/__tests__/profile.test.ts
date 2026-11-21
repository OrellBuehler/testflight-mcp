import { describe, it, expect } from "vitest";
import { decodeProfile, extractProfilePlist, parsePlist } from "../asc/profile.js";
import {
  FIXTURE_CERTIFICATE_SERIAL,
  buildProfile,
  profileXml,
  wrapCms,
} from "./profile-fixture.js";

describe("profile decoding", () => {
  it("extracts the embedded plist from CMS-wrapped bytes", () => {
    const xml = profileXml();
    expect(extractProfilePlist(wrapCms(xml))).toBe(xml);
  });

  it("rejects content without a property list", () => {
    expect(() => extractProfilePlist(Buffer.from([0x30, 0x03, 1, 2, 3]))).toThrow(
      /no property list/,
    );
    expect(() => decodeProfile("")).toThrow(/empty/);
  });

  it("decodes metadata, entitlements and certificates", () => {
    const decoded = decodeProfile(buildProfile());
    expect(decoded).toMatchObject({
      name: "Acme App Store",
      uuid: "00000000-0000-0000-0000-000000000001",
      appIdName: "Acme & Co App",
      teamName: "Example Team",
      teamIdentifier: ["TEAM000000"],
      platform: ["iOS"],
      creationDate: "2026-01-01T00:00:00Z",
      expirationDate: "2027-01-01T00:00:00Z",
      provisionedDevices: null,
    });
    expect(decoded.entitlements).toMatchObject({
      "application-identifier": "TEAM000000.com.acme.app",
      "aps-environment": "production",
      "get-task-allow": false,
      "keychain-access-groups": [],
      "com.apple.developer.icloud-container-identifiers": ["iCloud.com.acme.app"],
    });
    expect(decoded.developerCertificates).toHaveLength(1);
    expect(decoded.developerCertificates[0]).toMatchObject({
      serialNumber: FIXTURE_CERTIFICATE_SERIAL,
      commonName: "Test Distribution: Example (TEAM000000)",
    });
    expect(decoded.developerCertificates[0].sha1).toMatch(/^[0-9A-F]{40}$/);
    expect(decoded.developerCertificates[0].sha256).toMatch(/^[0-9A-F]{64}$/);
  });

  it("infers the profile type from devices and get-task-allow", () => {
    expect(decodeProfile(buildProfile()).inferredType).toMatch(/^app-store/);
    expect(decodeProfile(buildProfile({ devices: ["U1"], taskAllow: true })).inferredType).toBe(
      "development",
    );
    expect(decodeProfile(buildProfile({ devices: ["U1", "U2"] })).inferredType).toBe("ad-hoc");
    expect(decodeProfile(buildProfile({ allDevices: true })).inferredType).toMatch(/^enterprise/);
    expect(decodeProfile(buildProfile({ devices: ["U1", "U2"] })).provisionedDevices).toEqual({
      count: 2,
      udids: ["U1", "U2"],
    });
  });

  it("shows a missing iCloud container as an absent entitlement", () => {
    const { entitlements } = decodeProfile(buildProfile({ icloud: false }));
    expect(entitlements).not.toHaveProperty("com.apple.developer.icloud-container-identifiers");
  });

  it("keeps a fingerprint for certificates it cannot parse", () => {
    const decoded = decodeProfile(buildProfile({ certificates: ["AAECAw=="] }));
    expect(decoded.developerCertificates).toEqual([
      { sha256: "054EDEC1D0211F624FED0CBCA9D4F9400B0E491C43742AF2C5B0ABEBF0C990D8" },
    ]);
  });
});

describe("plist parser", () => {
  it("parses scalars, entities, nesting and empty elements", () => {
    const value = parsePlist(`<?xml version="1.0"?><plist version="1.0"><dict>
      <key>a&amp;b</key><string>x &lt;y&gt; &#65;&#x42;</string>
      <key>n</key><integer>-3</integer>
      <key>r</key><real>1.5</real>
      <key>t</key><true/><key>f</key><false/>
      <key>e</key><string></string><key>d</key><dict/><key>l</key><array/>
      <key>nested</key><dict><key>k</key><array><integer>1</integer><string>two</string></array></dict>
    </dict></plist>`);
    expect(value).toEqual({
      "a&b": "x <y> AB",
      n: -3,
      r: 1.5,
      t: true,
      f: false,
      e: "",
      d: {},
      l: [],
      nested: { k: [1, "two"] },
    });
  });

  it("rejects malformed input", () => {
    expect(() => parsePlist("<dict></dict>")).toThrow();
    expect(() => parsePlist("<plist><dict><string>x</string></dict></plist>")).toThrow(/key/);
    expect(() => parsePlist("<plist><bogus>1</bogus></plist>")).toThrow(/unsupported/);
  });
});
