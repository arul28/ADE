import { beforeEach, describe, expect, it } from "vitest";
import {
  __clearHighlightCacheForTests,
  __getHighlightCacheStatsForTests,
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

  it("returns plain lines when no language is provided", () => {
    const result = highlightCode("alpha", undefined);
    expect(result).toEqual([[{ text: "alpha" }]]);
  });

  it("returns one HighlightedToken array per line of code", () => {
    const code = ["const a = 1;", "const b = 2;"].join("\n");
    const lines = highlightCode(code, "typescript");
    expect(lines.length).toBe(2);
    // Each line must have at least one token.
    expect(lines[0]?.length).toBeGreaterThan(0);
    expect(lines[1]?.length).toBeGreaterThan(0);
  });

  it("classifies typescript keywords, strings, and numbers", () => {
    const lines = highlightCode("const x = \"hi\";\nconst n = 42;", "typescript");
    const flat = lines.flat();
    const categories = new Set(flat.map((t) => t.category).filter(Boolean));
    expect(categories.has("keyword")).toBe(true);
    expect(categories.has("string")).toBe(true);
    expect(categories.has("number")).toBe(true);
  });

  it("resolves language aliases (tsx → typescript)", () => {
    const a = highlightCode("const x = 1;", "tsx");
    const b = highlightCode("const x = 1;", "typescript");
    expect(a).toEqual(b);
  });

  it("resolves sh and shell aliases to bash", () => {
    const sh = highlightCode("echo hi", "sh");
    const bash = highlightCode("echo hi", "bash");
    const shell = highlightCode("echo hi", "shell");
    expect(sh).toEqual(bash);
    expect(shell).toEqual(bash);
  });

  it("returns identical reference on cache hit", () => {
    const a = highlightCode("const x = 1;", "typescript");
    const b = highlightCode("const x = 1;", "typescript");
    expect(b).toBe(a);
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

  it("caps cache size at 500 entries with insertion-order (LRU) eviction", () => {
    for (let i = 0; i < 600; i += 1) {
      highlightCode(`const v${i} = ${i};`, "typescript");
    }
    expect(__getHighlightCacheStatsForTests().entries).toBe(500);
    // The first 100 entries should have been evicted — re-highlighting v0
    // creates a fresh entry, so it doesn't return the original reference.
    const replayed = highlightCode("const v0 = 0;", "typescript");
    const again = highlightCode("const v0 = 0;", "typescript");
    expect(again).toBe(replayed);
    expect(__getHighlightCacheStatsForTests().entries).toBe(500);
  });
});
