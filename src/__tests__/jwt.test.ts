import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTokenProvider } from "../asc/jwt.js";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function decodeJwt(token: string): { header: any; payload: any } {
  const [h, p] = token.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf-8"));
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf-8"));
  return { header, payload };
}

describe("createTokenProvider", () => {
  it("signs an ES256 token with the expected header and claims", async () => {
    const provider = createTokenProvider({
      keyId: "KEY123",
      issuerId: "ISSUER-1",
      privateKey: pem,
    });
    const token = await provider();
    const { header, payload } = decodeJwt(token);
    expect(header).toMatchObject({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    expect(payload.iss).toBe("ISSUER-1");
    expect(payload.aud).toBe("appstoreconnect-v1");
    expect(payload.exp - payload.iat).toBe(20 * 60);
  });

  it("caches the token until it is close to expiry", async () => {
    let now = 1_700_000_000_000;
    const provider = createTokenProvider({ keyId: "K", issuerId: "I", privateKey: pem }, () => now);
    const a = await provider();
    const b = await provider();
    expect(b).toBe(a);
    now += 21 * 60 * 1000;
    const c = await provider();
    expect(c).not.toBe(a);
  });

  it("unescapes \\n sequences in an inline private key", async () => {
    const escaped = pem.replace(/\n/g, "\\n");
    const provider = createTokenProvider({ keyId: "K", issuerId: "I", privateKey: escaped });
    await expect(provider()).resolves.toBeTypeOf("string");
  });

  it("throws when no key material is configured", async () => {
    const provider = createTokenProvider({ keyId: "K", issuerId: "I" });
    await expect(provider()).rejects.toThrow(/private key/i);
  });
});
