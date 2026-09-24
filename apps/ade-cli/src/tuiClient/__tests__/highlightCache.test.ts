import { beforeEach, describe, expect, it } from "vitest";
import {
  __clearHighlightCacheForTests,
  highlightCode,
} from "../highlightCache";

describe("highlightCache", () => {
  beforeEach(() => {
    __clearHighlightCacheForTests();
  });

  it("returns plain single-token lines for unknown languages", () => {
    const result = highlightCode("hello\nworld", "klingon");
    expect(result).toEqual([
      [{ text: "hello" }],
      [{ text: "world" }],
    ]);
  });

  it("classifies typescript keywords, strings, and numbers", () => {
    const lines = highlightCode("const x = \"hi\";\nconst n = 42;", "typescript");
    const flat = lines.flat();
    const categories = new Set(flat.map((t) => t.category).filter(Boolean));
    expect(categories.has("keyword")).toBe(true);
    expect(categories.has("string")).toBe(true);
    expect(categories.has("number")).toBe(true);
  });

  it("decodes HTML entities produced by highlight.js", () => {
    const lines = highlightCode("if (a < b && c > d) {}", "typescript");
    const text = lines.flat().map((t) => t.text).join("");
    expect(text).toBe("if (a < b && c > d) {}");
  });

  it("preserves empty lines as empty token arrays", () => {
    const lines = highlightCode("const a = 1;\n\nconst b = 2;", "typescript");
    expect(lines.length).toBe(3);
    expect(lines[1]).toEqual([]);
  });

});
