import { describe, expect, it } from "vitest";
import { GLOSSARY, findTerm } from "./glossary";

const DOCS_PREFIX = "https://www.ade-app.dev/docs/";

describe("glossary", () => {
  it("ships definitions for every v1 term listed in plan §7", () => {
    const expected = [
      "lane",
      "primary-lane",
      "child-lane",
      "attached-lane",
      "worktree",
      "mission",
      "worker",
      "integration",
      "stack",
      "pack",
      "pinned",
      "dirty",
      "behind",
      "rebase",
      "conflict",
      "running",
      "awaiting-input",
      "ended",
      "compaction",
    ];
    const got = new Set(GLOSSARY.map((t) => t.id));
    for (const id of expected) {
      expect(got.has(id), `missing term ${id}`).toBe(true);
    }
  });

  it("every term has non-empty short and long definitions", () => {
    for (const term of GLOSSARY) {
      expect(term.shortDefinition.trim().length, `short for ${term.id}`).toBeGreaterThan(0);
      expect(term.longDefinition.trim().length, `long for ${term.id}`).toBeGreaterThan(0);
    }
  });

  it("short definitions stay concise (≤ 20 words) for fifth-grade readability", () => {
    for (const term of GLOSSARY) {
      const wordCount = term.shortDefinition.trim().split(/\s+/).length;
      expect(wordCount, `short for ${term.id} has ${wordCount} words: "${term.shortDefinition}"`).toBeLessThanOrEqual(20);
    }
  });

  it("every docUrl is a well-formed https ade-app.dev/docs URL", () => {
    for (const term of GLOSSARY) {
      expect(term.docUrl.startsWith(DOCS_PREFIX), `docUrl for ${term.id}: ${term.docUrl}`).toBe(true);
      expect(() => new URL(term.docUrl)).not.toThrow();
    }
  });

  it("term ids are unique", () => {
    const seen = new Set<string>();
    for (const term of GLOSSARY) {
      expect(seen.has(term.id), `duplicate id ${term.id}`).toBe(false);
      seen.add(term.id);
    }
  });

  it("findTerm retrieves by id", () => {
    expect(findTerm("lane")?.term).toBe("Lane");
    expect(findTerm("does-not-exist")).toBeUndefined();
  });
});
