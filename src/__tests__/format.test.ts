import { describe, it, expect } from "vitest";
import type { JsonApiResource } from "../asc/client.js";
import {
  ok,
  err,
  imageResult,
  singleRef,
  findIncluded,
  flattenResource,
  shapeResource,
} from "../asc/format.js";

describe("format helpers", () => {
  it("ok passes strings through and JSON-encodes objects", () => {
    expect(ok("hello")).toEqual({ content: [{ type: "text", text: "hello" }] });
    expect(ok({ a: 1 })).toEqual({ content: [{ type: "text", text: '{"a":1}' }] });
  });

  it("err marks the result as an error", () => {
    const res = err(new Error("boom"));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("boom");
  });

  it("imageResult includes an optional caption then the image", () => {
    expect(imageResult("AAAA", "image/png", "cap")).toEqual({
      content: [
        { type: "text", text: "cap" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    });
    expect(imageResult("AAAA", "image/png").content).toHaveLength(1);
  });

  it("singleRef returns a single ref but not arrays", () => {
    expect(singleRef({ data: { type: "builds", id: "1" } })).toEqual({ type: "builds", id: "1" });
    expect(singleRef({ data: [{ type: "builds", id: "1" }] })).toBeNull();
    expect(singleRef(undefined)).toBeNull();
  });

  it("findIncluded matches by type and id", () => {
    const included: JsonApiResource[] = [
      { type: "builds", id: "1", attributes: { version: "10" } },
      { type: "betaTesters", id: "t1", attributes: { email: "a@b.c" } },
    ];
    expect(findIncluded(included, { type: "builds", id: "1" })?.attributes?.version).toBe("10");
    expect(findIncluded(included, { type: "builds", id: "9" })).toBeNull();
    expect(findIncluded(included, null)).toBeNull();
  });

  it("flattenResource lifts attributes to the top level", () => {
    expect(flattenResource({ type: "apps", id: "1", attributes: { name: "X" } })).toEqual({
      id: "1",
      type: "apps",
      name: "X",
    });
    expect(flattenResource(null)).toBeNull();
  });

  it("shapeResource resolves named relationships from included", () => {
    const resource: JsonApiResource = {
      type: "betaFeedbackScreenshotSubmissions",
      id: "f1",
      attributes: { comment: "looks broken" },
      relationships: {
        tester: { data: { type: "betaTesters", id: "t1" } },
        build: { data: { type: "builds", id: "b1" } },
      },
    };
    const included: JsonApiResource[] = [
      { type: "betaTesters", id: "t1", attributes: { email: "a@b.c" } },
      { type: "builds", id: "b1", attributes: { version: "42" } },
    ];
    const shaped = shapeResource(resource, included, { relationships: ["build", "tester"] });
    expect(shaped).toMatchObject({
      id: "f1",
      comment: "looks broken",
      tester: { id: "t1", email: "a@b.c" },
      build: { id: "b1", version: "42" },
    });
  });
});
