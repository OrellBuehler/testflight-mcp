import { describe, it, expect } from "vitest";
import { encodeS3Key, signRequest } from "../asc/sigv4.js";

const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const date = new Date("2013-05-24T00:00:00Z");
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("signRequest", () => {
  it("matches the AWS documentation example for GET Object", () => {
    const headers = signRequest({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { Range: "bytes=0-9" },
      payloadHash: EMPTY,
      credentials,
      region: "us-east-1",
      date,
    });
    expect(headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers).not.toHaveProperty("host");
  });

  it("matches the AWS documentation example for PUT Object", () => {
    const headers = signRequest({
      method: "PUT",
      url: `https://examplebucket.s3.amazonaws.com/${encodeS3Key("test$file.text")}`,
      headers: {
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadHash: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
      credentials,
      region: "us-east-1",
      date,
    });
    expect(headers.Authorization).toContain(
      "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("matches the AWS documentation example for a query string", () => {
    const headers = signRequest({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
      payloadHash: EMPTY,
      credentials,
      region: "us-east-1",
      date,
    });
    expect(headers.Authorization).toContain(
      "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });

  it("signs the session token when there is one", () => {
    const headers = signRequest({
      method: "PUT",
      url: "https://bucket.s3.us-west-2.amazonaws.com/key",
      payloadHash: EMPTY,
      credentials: { ...credentials, sessionToken: "tok" },
      region: "us-west-2",
      date,
    });
    expect(headers["x-amz-security-token"]).toBe("tok");
    expect(headers.Authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
  });

  it("keeps slashes and escapes the rest of an object key", () => {
    expect(encodeS3Key("prod/Acme App (1).zip")).toBe("prod/Acme%20App%20%281%29.zip");
  });
});
