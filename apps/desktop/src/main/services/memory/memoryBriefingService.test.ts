import { describe, expect, it } from "vitest";
import { buildQuery, cleanParts, type BuildMemoryBriefingArgs } from "./memoryBriefingService";

describe("cleanParts", () => {
  it("returns trimmed non-empty strings", () => {
    expect(cleanParts(["hello", "  world  "])).toEqual(["hello", "world"]);
  });

  it("filters out null and undefined values", () => {
    expect(cleanParts([null, "keep", undefined, "this"])).toEqual(["keep", "this"]);
  });

  it("filters out empty strings and whitespace-only strings", () => {
    expect(cleanParts(["", "  ", "valid", "   "])).toEqual(["valid"]);
  });

  it("returns empty array when all values are blank/null", () => {
    expect(cleanParts([null, undefined, "", "  "])).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(cleanParts([])).toEqual([]);
  });

  it("converts null and undefined to empty string before trimming", () => {
    // String(null) = "null" which is non-empty; but the ?? "" catches it first
    expect(cleanParts([null])).toEqual([]);
    expect(cleanParts([undefined])).toEqual([]);
  });

  it("preserves order of remaining values", () => {
    expect(cleanParts(["c", null, "a", "", "b"])).toEqual(["c", "a", "b"]);
  });
});

describe("buildQuery", () => {
  it("combines taskDescription and phaseContext", () => {
    const args: BuildMemoryBriefingArgs = {
      projectId: "proj-1",
      taskDescription: "fix memory scoping",
      phaseContext: "implementation phase",
    };
    expect(buildQuery(args)).toBe("fix memory scoping implementation phase");
  });

  it("includes handoff summaries", () => {
    const args: BuildMemoryBriefingArgs = {
      projectId: "proj-1",
      taskDescription: "task",
      handoffSummaries: ["summary A", "summary B"],
    };
    expect(buildQuery(args)).toBe("task summary A summary B");
  });

  it("includes file patterns", () => {
    const args: BuildMemoryBriefingArgs = {
      projectId: "proj-1",
      taskDescription: "task",
      filePatterns: ["src/**/*.ts", "docs/*.md"],
    };
    expect(buildQuery(args)).toBe("task src/**/*.ts docs/*.md");
  });

  it("combines all fields together", () => {
    const args: BuildMemoryBriefingArgs = {
      projectId: "proj-1",
      taskDescription: "fix bug",
      phaseContext: "debugging",
      handoffSummaries: ["worker-1 done"],
      filePatterns: ["src/main.ts"],
    };
    expect(buildQuery(args)).toBe("fix bug debugging worker-1 done src/main.ts");
  });

  it("returns empty string when all fields are absent", () => {
    const args: BuildMemoryBriefingArgs = {
      projectId: "proj-1",
    };
    expect(buildQuery(args)).toBe("");
  });

  it("returns empty string when all fields are null", () => {
    const args: BuildMemoryBriefingArgs = {
      projectId: "proj-1",
      taskDescription: null,
      phaseContext: null,
      handoffSummaries: undefined,
      filePatterns: undefined,
    };
    expect(buildQuery(args)).toBe("");
  });

  it("trims whitespace from individual parts", () => {
    const args: BuildMemoryBriefingArgs = {
      projectId: "proj-1",
      taskDescription: "  leading whitespace  ",
      phaseContext: "  trailing too  ",
    };
    expect(buildQuery(args)).toBe("leading whitespace trailing too");
  });

  it("skips empty handoff summaries and file patterns", () => {
    const args: BuildMemoryBriefingArgs = {
      projectId: "proj-1",
      taskDescription: "task",
      handoffSummaries: ["", "  ", "valid summary"],
      filePatterns: ["", "valid/*.ts"],
    };
    expect(buildQuery(args)).toBe("task valid summary valid/*.ts");
  });

  it("handles only phaseContext without taskDescription", () => {
    const args: BuildMemoryBriefingArgs = {
      projectId: "proj-1",
      phaseContext: "review phase",
    };
    expect(buildQuery(args)).toBe("review phase");
  });
});
