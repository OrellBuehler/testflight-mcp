import type { JsonApiRef, JsonApiResource } from "./client.js";

export function ok(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return { content: [{ type: "text" as const, text }] };
}

export function err(e: unknown) {
  return { content: [{ type: "text" as const, text: String(e) }], isError: true as const };
}

export function imageResult(base64: string, mimeType: string, caption?: string) {
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];
  if (caption) content.push({ type: "text" as const, text: caption });
  content.push({ type: "image" as const, data: base64, mimeType });
  return { content };
}

export function singleRef(rel?: { data?: JsonApiRef | JsonApiRef[] | null }): JsonApiRef | null {
  const data = rel?.data;
  if (!data || Array.isArray(data)) return null;
  return data;
}

export function manyRefs(rel?: { data?: JsonApiRef | JsonApiRef[] | null }): JsonApiRef[] {
  const data = rel?.data;
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

export function findIncluded(
  included: JsonApiResource[],
  ref: JsonApiRef | null,
): JsonApiResource | null {
  if (!ref) return null;
  return included.find((r) => r.type === ref.type && r.id === ref.id) ?? null;
}

export function flattenResource(resource: JsonApiResource | null): Record<string, unknown> | null {
  if (!resource) return null;
  return { id: resource.id, type: resource.type, ...resource.attributes };
}

export interface ShapeOptions {
  relationships?: string[];
}

export function shapeResource(
  resource: JsonApiResource,
  included: JsonApiResource[] = [],
  options: ShapeOptions = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: resource.id,
    type: resource.type,
    ...resource.attributes,
  };
  for (const name of options.relationships ?? []) {
    out[name] = flattenResource(findIncluded(included, singleRef(resource.relationships?.[name])));
  }
  return out;
}
