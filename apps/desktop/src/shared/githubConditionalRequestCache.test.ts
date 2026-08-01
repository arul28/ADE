import { describe, expect, it } from "vitest";
import { createGithubConditionalRequestCache } from "./githubConditionalRequestCache";

describe("githubConditionalRequestCache", () => {
  it("keeps an entry protected until every same-key request releases it", () => {
    const cache = createGithubConditionalRequestCache(1);
    const entry = { etag: '"one"', data: { value: "one" }, linkHeader: null };
    cache.store("one", entry);

    const first = cache.begin("one");
    const second = cache.begin("one");
    expect(first?.entry).toBe(entry);
    expect(second?.entry).toBe(entry);

    first?.release();
    cache.store("two", { etag: '"two"', data: { value: "two" }, linkHeader: null });
    expect(cache.get("one")).toBe(entry);

    second?.release();
    cache.store("three", { etag: '"three"', data: { value: "three" }, linkHeader: null });
    expect(cache.get("one")).toBeNull();
    expect(cache.get("three")?.data).toEqual({ value: "three" });
  });
});
