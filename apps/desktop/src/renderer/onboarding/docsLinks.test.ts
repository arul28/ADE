import { describe, it, expect } from "vitest";
import { docs, DOCS_HOME } from "./docsLinks";

describe("docsLinks", () => {
  it("every URL is under ade-app.dev", () => {
    for (const [key, url] of Object.entries(docs)) {
      expect(url, key).toMatch(/^https:\/\/www\.ade-app\.dev(\/|$)/);
    }
  });

  it("home points at the site root", () => {
    expect(docs.home).toBe("https://www.ade-app.dev");
    expect(DOCS_HOME).toBe(docs.home);
  });

  it("all values are non-empty strings", () => {
    const values = Object.values(docs);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v.length).toBeGreaterThan(0);
  });

  it("every key is unique", () => {
    const keys = Object.keys(docs);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
