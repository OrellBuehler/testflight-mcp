import { SignJWT, importPKCS8 } from "jose";
import { readFile } from "node:fs/promises";

export interface AscAuth {
  keyId: string;
  issuerId: string;
  privateKey?: string;
  privateKeyPath?: string;
}

export type TokenProvider = () => Promise<string>;

async function loadKey(auth: AscAuth): Promise<string> {
  if (auth.privateKey && auth.privateKey.trim()) {
    return auth.privateKey.replace(/\\n/g, "\n");
  }
  if (auth.privateKeyPath) {
    return readFile(auth.privateKeyPath, "utf-8");
  }
  throw new Error("No App Store Connect private key configured");
}

export function createTokenProvider(auth: AscAuth, nowMs: () => number = Date.now): TokenProvider {
  let cached: { token: string; expiresAt: number } | null = null;
  let pem: string | null = null;

  return async () => {
    const now = Math.floor(nowMs() / 1000);
    if (cached && cached.expiresAt > now + 60) return cached.token;

    if (pem === null) pem = await loadKey(auth);
    const key = await importPKCS8(pem, "ES256");
    const expiresAt = now + 20 * 60;

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: auth.keyId, typ: "JWT" })
      .setIssuer(auth.issuerId)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .setAudience("appstoreconnect-v1")
      .sign(key);

    cached = { token, expiresAt };
    return token;
  };
}
