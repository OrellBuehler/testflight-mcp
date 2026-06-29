import { gunzipSync } from "node:zlib";
import type { TokenProvider } from "./jwt.js";

export const BASE_URL = "https://api.appstoreconnect.apple.com/v1";

export interface JsonApiRef {
  type: string;
  id: string;
}

export interface JsonApiResource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: JsonApiRef | JsonApiRef[] | null; links?: unknown }>;
  links?: { self?: string };
}

export interface JsonApiResponse {
  data: JsonApiResource | JsonApiResource[];
  included?: JsonApiResource[];
  links?: { self?: string; next?: string };
  meta?: { paging?: { total?: number; limit?: number } };
}

export type QueryParams = Record<string, string | number | boolean | string[] | undefined>;

export class AppStoreConnectClient {
  readonly timeoutMs: number;

  constructor(
    private tokenProvider: TokenProvider,
    timeoutMs = 30000,
  ) {
    this.timeoutMs = timeoutMs;
  }

  private buildUrl(path: string, params?: QueryParams): string {
    const url = new URL(path.startsWith("http") ? path : `${BASE_URL}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          if (v.length === 0) continue;
          url.searchParams.set(k, v.join(","));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  private async request(url: string, options: RequestInit = {}): Promise<Response> {
    const token = await this.tokenProvider();
    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(typeof options.body === "string" ? { "Content-Type": "application/json" } : {}),
          ...((options.headers as Record<string, string>) ?? {}),
        },
        signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new Error(`App Store Connect request timed out after ${this.timeoutMs}ms`, {
          cause: e,
        });
      }
      throw e;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }
    return res;
  }

  async get(path: string, params?: QueryParams): Promise<JsonApiResponse> {
    const res = await this.request(this.buildUrl(path, params));
    return res.json() as Promise<JsonApiResponse>;
  }

  async getAll(
    path: string,
    params?: QueryParams,
    maxPages = 5,
  ): Promise<{ data: JsonApiResource[]; included: JsonApiResource[] }> {
    const data: JsonApiResource[] = [];
    const included: JsonApiResource[] = [];
    let next: string | undefined;
    let page = 0;
    do {
      const res: JsonApiResponse = next ? await this.get(next) : await this.get(path, params);
      if (Array.isArray(res.data)) data.push(...res.data);
      else if (res.data) data.push(res.data);
      if (res.included) included.push(...res.included);
      next = res.links?.next;
      page++;
    } while (next && page < maxPages);
    return { data, included };
  }

  async post(path: string, body: unknown): Promise<JsonApiResponse> {
    const res = await this.request(this.buildUrl(path), {
      method: "POST",
      body: JSON.stringify(body),
    });
    return res.json() as Promise<JsonApiResponse>;
  }

  async downloadText(url: string): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: failed to download ${url}`);
    return res.text();
  }

  async downloadBinary(url: string): Promise<{ base64: string; mimeType: string }> {
    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: failed to download ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      base64: buf.toString("base64"),
      mimeType: res.headers.get("content-type") ?? "image/png",
    };
  }

  async downloadGzipText(url: string): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: failed to download ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    try {
      return gunzipSync(buf).toString("utf-8");
    } catch {
      return buf.toString("utf-8");
    }
  }

  async getGzippedReport(path: string, params: QueryParams): Promise<string> {
    const res = await this.request(this.buildUrl(path, params), {
      headers: { Accept: "application/a-gzip, application/json" },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    try {
      return gunzipSync(buf).toString("utf-8");
    } catch {
      return buf.toString("utf-8");
    }
  }
}
