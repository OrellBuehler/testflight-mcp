import { AppStoreConnectClient } from "./asc/client.js";
import { createTokenProvider } from "./asc/jwt.js";

const keyId = (process.env.ASC_KEY_ID || "").trim();
const issuerId = (process.env.ASC_ISSUER_ID || "").trim();
const privateKey = process.env.ASC_PRIVATE_KEY;
const privateKeyPath = (process.env.ASC_PRIVATE_KEY_PATH || "").trim() || undefined;
const vendorNumber = (process.env.ASC_VENDOR_NUMBER || "").trim() || undefined;
const allowWrites = /^(1|true)$/i.test((process.env.ASC_ALLOW_WRITES || "").trim());
const uploadDir = (process.env.ASC_UPLOAD_DIR || "").trim() || undefined;
const downloadDir = (process.env.ASC_DOWNLOAD_DIR || "").trim() || undefined;

if (!keyId || !issuerId || (!privateKey && !privateKeyPath)) {
  console.error(
    "ASC_KEY_ID, ASC_ISSUER_ID and one of ASC_PRIVATE_KEY / ASC_PRIVATE_KEY_PATH are required. " +
      "Create an App Store Connect API key under Users and Access > Integrations > App Store Connect API.",
  );
  process.exit(1);
}

export const config = {
  keyId,
  issuerId,
  vendorNumber,
  allowWrites,
  uploadDir,
  downloadDir,
  transport: "stdio" as const,
};

const tokenProvider = createTokenProvider({ keyId, issuerId, privateKey, privateKeyPath });

export const client = new AppStoreConnectClient(tokenProvider);
