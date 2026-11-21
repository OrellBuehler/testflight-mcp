import { X509Certificate, createHash } from "node:crypto";

class PlistData {
  constructor(readonly bytes: Buffer) {}
}

type PlistValue =
  string | number | boolean | PlistData | PlistValue[] | { [key: string]: PlistValue };

const TOKEN = /<(\/?)([A-Za-z]+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity] ?? "";
  });
}

export function parsePlist(xml: string): PlistValue {
  const start = xml.indexOf("<plist");
  if (start < 0) throw new Error("not an XML property list");
  const tokens = [...xml.slice(start).matchAll(TOKEN)]
    .filter((m) => m[4] === undefined || m[4].trim() !== "")
    .map((m) =>
      m[2]
        ? {
            kind: m[1] ? ("close" as const) : m[3] ? ("empty" as const) : ("open" as const),
            tag: m[2],
          }
        : { kind: "text" as const, tag: "", text: m[4] },
    );
  let pos = 0;

  function text(tag: string): string {
    let out = "";
    const next = tokens[pos];
    if (next?.kind === "text") {
      out = (next as { text: string }).text;
      pos++;
    }
    const close = tokens[pos++];
    if (close?.kind !== "close" || close.tag !== tag) throw new Error(`malformed <${tag}> element`);
    return out;
  }

  function value(): PlistValue {
    const token = tokens[pos++];
    if (!token || token.kind === "close" || token.kind === "text") {
      throw new Error("unexpected token in property list");
    }
    if (token.kind === "empty") {
      if (token.tag === "true") return true;
      if (token.tag === "false") return false;
      if (token.tag === "dict") return {};
      if (token.tag === "array") return [];
      if (token.tag === "string") return "";
      if (token.tag === "data") return new PlistData(Buffer.alloc(0));
      throw new Error(`unsupported element <${token.tag}/>`);
    }
    switch (token.tag) {
      case "dict": {
        const dict: { [key: string]: PlistValue } = {};
        while (tokens[pos] && tokens[pos].kind !== "close") {
          const key = tokens[pos++];
          if (key.kind === "empty" && key.tag === "key") {
            dict[""] = value();
            continue;
          }
          if (key.kind !== "open" || key.tag !== "key") throw new Error("expected <key> in dict");
          dict[decodeEntities(text("key"))] = value();
        }
        pos++;
        return dict;
      }
      case "array": {
        const list: PlistValue[] = [];
        while (tokens[pos] && tokens[pos].kind !== "close") list.push(value());
        pos++;
        return list;
      }
      case "string":
      case "date":
        return decodeEntities(text(token.tag));
      case "integer":
        return parseInt(text("integer").trim(), 10);
      case "real":
        return parseFloat(text("real").trim());
      case "data":
        return new PlistData(Buffer.from(text("data").replace(/\s+/g, ""), "base64"));
      case "plist": {
        const inner = value();
        pos++;
        return inner;
      }
      default:
        throw new Error(`unsupported element <${token.tag}>`);
    }
  }

  return value();
}

export function extractProfilePlist(content: Buffer): string {
  const start = content.indexOf("<?xml");
  const endMarker = "</plist>";
  const end = content.lastIndexOf(endMarker);
  if (start < 0 || end < start) {
    throw new Error("no property list found in the profile content");
  }
  return content.subarray(start, end + endMarker.length).toString("utf-8");
}

function plain(value: PlistValue): unknown {
  if (value instanceof PlistData) return { dataBytes: value.bytes.length };
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function certificateInfo(der: Buffer) {
  const sha256 = createHash("sha256").update(der).digest("hex").toUpperCase();
  try {
    const cert = new X509Certificate(der);
    return {
      sha1: cert.fingerprint.replaceAll(":", ""),
      sha256,
      serialNumber: cert.serialNumber,
      commonName: /CN=([^\n]+)/.exec(cert.subject)?.[1],
      validTo: new Date(cert.validTo).toISOString(),
    };
  } catch {
    return { sha256 };
  }
}

function inferType(
  entitlements: { [key: string]: PlistValue },
  hasDevices: boolean,
  allDevices: boolean,
) {
  if (allDevices) return "enterprise (in-house, all devices)";
  if (hasDevices) {
    return entitlements["get-task-allow"] === true ? "development" : "ad-hoc";
  }
  return "app-store (or macOS direct distribution)";
}

export function decodeProfile(base64Content: string) {
  const content = Buffer.from(base64Content, "base64");
  if (content.length === 0) throw new Error("profile content is empty");
  const root = parsePlist(extractProfilePlist(content));
  if (!root || typeof root !== "object" || Array.isArray(root) || root instanceof PlistData) {
    throw new Error("profile property list is not a dictionary");
  }
  const dict = root as { [key: string]: PlistValue };
  const entitlements =
    dict.Entitlements && typeof dict.Entitlements === "object" && !Array.isArray(dict.Entitlements)
      ? (dict.Entitlements as { [key: string]: PlistValue })
      : {};
  const devices = Array.isArray(dict.ProvisionedDevices)
    ? (dict.ProvisionedDevices as string[])
    : undefined;
  const certificates = Array.isArray(dict.DeveloperCertificates)
    ? dict.DeveloperCertificates.filter((c): c is PlistData => c instanceof PlistData).map((c) =>
        certificateInfo(c.bytes),
      )
    : [];
  return {
    name: dict.Name,
    uuid: dict.UUID,
    appIdName: dict.AppIDName,
    teamName: dict.TeamName,
    teamIdentifier: dict.TeamIdentifier,
    applicationIdentifierPrefix: dict.ApplicationIdentifierPrefix,
    platform: dict.Platform,
    creationDate: dict.CreationDate,
    expirationDate: dict.ExpirationDate,
    inferredType: inferType(
      entitlements,
      devices !== undefined,
      dict.ProvisionsAllDevices === true,
    ),
    provisionedDevices: devices ? { count: devices.length, udids: devices } : null,
    developerCertificates: certificates,
    entitlements: plain(entitlements),
  };
}
