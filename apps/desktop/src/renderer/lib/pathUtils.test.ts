import { describe, expect, it } from "vitest";
import {
  arePathsEqual,
  isPathEqualOrDescendant,
  normalizePath,
  normalizePathForComparison,
  normalizePathForWorkspaceComparison,
  remapPathForRename,
} from "./pathUtils";

describe("pathUtils", () => {
  it("preserves Windows drive roots while normalizing separators", () => {
    expect(normalizePath("C:\\")).toBe("C:/");
    expect(normalizePath("/C:/Users/me/repo")).toBe("C:/Users/me/repo");
    expect(normalizePath("C:\\Users\\me\\repo\\")).toBe("C:/Users/me/repo");
  });

  it("collapses dot segments without walking above rooted paths", () => {
    expect(normalizePath("C:\\Users\\me\\repo\\src\\..\\main.ts")).toBe("C:/Users/me/repo/main.ts");
    expect(normalizePath("\\\\server\\share\\repo\\..\\main.ts")).toBe("//server/share/main.ts");
    expect(normalizePath("/repo/src/../../main.ts")).toBe("/main.ts");
    expect(normalizePath("../repo/./src/../main.ts")).toBe("../repo/main.ts");
  });

  it("compares Windows paths case-insensitively", () => {
    expect(normalizePathForComparison("C:\\Users\\Me\\Repo")).toBe("c:/users/me/repo");
    expect(isPathEqualOrDescendant("c:/users/me/repo/src/main.ts", "C:\\Users\\Me\\Repo")).toBe(true);
  });

  it("compares relative paths case-insensitively inside Windows workspaces", () => {
    expect(normalizePathForWorkspaceComparison("src\\Main.ts", "C:\\Repo")).toBe("src/main.ts");
    expect(arePathsEqual("src/Main.ts", "SRC\\main.ts", "C:\\Repo")).toBe(true);
    expect(isPathEqualOrDescendant("src/main.ts", "SRC", "C:\\Repo")).toBe(true);
  });

  it("remaps renamed Windows descendants without dropping the drive root", () => {
    expect(remapPathForRename("C:/Users/Me/Repo/src/main.ts", "c:/users/me/repo", "D:/Work/Repo")).toBe(
      "D:/Work/Repo/src/main.ts",
    );
  });

  it("remaps relative Windows workspace paths case-insensitively", () => {
    expect(remapPathForRename("src/Main.ts", "SRC", "Renamed", "C:\\Repo")).toBe("Renamed/Main.ts");
  });
});
