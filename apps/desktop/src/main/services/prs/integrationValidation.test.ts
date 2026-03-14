import { describe, expect, it } from "vitest";
import { hasMergeConflictMarkers, parseGitStatusPorcelain } from "./integrationValidation";

describe("integrationValidation", () => {
  it("parses changed and unmerged files from porcelain output", () => {
    expect(
      parseGitStatusPorcelain([
        "UU src/conflicted.ts",
        "M  src/modified.ts",
        "A  src/added.ts",
      ].join("\n")),
    ).toEqual({
      unmergedPaths: ["src/conflicted.ts"],
      changedPaths: ["src/conflicted.ts", "src/modified.ts", "src/added.ts"],
    });
  });

  it("normalizes renamed paths to the new filename", () => {
    expect(
      parseGitStatusPorcelain("R  src/old-name.ts -> src/new-name.ts"),
    ).toEqual({
      unmergedPaths: [],
      changedPaths: ["src/new-name.ts"],
    });
  });

  it("detects merge conflict markers in file contents", () => {
    expect(hasMergeConflictMarkers("<<<<<<< ours\nhello\n=======\nworld\n>>>>>>> theirs\n")).toBe(true);
    expect(hasMergeConflictMarkers("function example() { return 'clean'; }\n")).toBe(false);
  });
});
