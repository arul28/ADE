import { describe, expect, it } from "vitest";
import {
  arePathsEqual,
  isPathEqualOrDescendant,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  isWindowsUncPath,
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

  it("preserves leading and trailing spaces in path segments", () => {
    expect(normalizePath(" docs/spec.md")).toBe(" docs/spec.md");
    expect(normalizePath("src/App.tsx ")).toBe("src/App.tsx ");
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

describe("Windows path predicates", () => {
  it("identifies drive-letter paths, including leading-slash and bare-drive forms", () => {
    expect(isWindowsDrivePath("C:\\Users\\me")).toBe(true);
    expect(isWindowsDrivePath("c:/users/me")).toBe(true);
    expect(isWindowsDrivePath("/C:/Users/me")).toBe(true);
    expect(isWindowsDrivePath("Z:")).toBe(true);

    expect(isWindowsDrivePath("relative/path")).toBe(false);
    expect(isWindowsDrivePath("/unix/path")).toBe(false);
    expect(isWindowsDrivePath("C:relative")).toBe(false);
  });

  it("identifies UNC paths in both backslash and forward-slash form", () => {
    expect(isWindowsUncPath("\\\\server\\share\\file.txt")).toBe(true);
    expect(isWindowsUncPath("//server/share/file.txt")).toBe(true);

    expect(isWindowsUncPath("\\\\")).toBe(false);
    expect(isWindowsUncPath("//")).toBe(false);
    expect(isWindowsUncPath("/unix/path")).toBe(false);
    expect(isWindowsUncPath("C:\\path")).toBe(false);
  });

  it("identifies any Windows absolute path as drive or UNC", () => {
    expect(isWindowsAbsolutePath("C:\\Users")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\srv\\share")).toBe(true);
    expect(isWindowsAbsolutePath("//srv/share")).toBe(true);

    expect(isWindowsAbsolutePath("/unix/path")).toBe(false);
    expect(isWindowsAbsolutePath("relative/path")).toBe(false);
    expect(isWindowsAbsolutePath("")).toBe(false);
  });
});
