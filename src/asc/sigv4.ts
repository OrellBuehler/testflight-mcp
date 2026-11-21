import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payloadHash: string;
  credentials: AwsCredentials;
  region: string;
  service?: string;
  date?: Date;
}

const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest();
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function encodeS3Key(key: string) {
  return key.split("/").map(encode).join("/");
}

export function signRequest(input: SignInput): Record<string, string> {
  const url = new URL(input.url);
  const service = input.service ?? "s3";
  const amzDate = (input.date ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...input.headers,
    host: url.host,
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": amzDate,
    ...(input.credentials.sessionToken
      ? { "x-amz-security-token": input.credentials.sessionToken }
      : {}),
  };
  const canonical = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = canonical.map(([name]) => name).join(";");
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .sort()
    .join("&");
  const canonicalRequest = [
    input.method,
    url.pathname,
    query,
    ...canonical.map(([name, value]) => `${name}:${value}`),
    "",
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const key = [input.region, service, "aws4_request"].reduce(
    (k, part) => hmac(k, part),
    hmac(`AWS4${input.credentials.secretAccessKey}`, day),
  );
  const signature = hmac(key, stringToSign).toString("hex");
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
