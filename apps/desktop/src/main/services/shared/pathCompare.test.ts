import { describe, expect, it } from "vitest";
import {
  isPathInside,
  pathComparisonKey,
  pathKey,
  pathsEqual,
  stripExtendedLengthPrefix,
} from "./pathCompare";

// Platform is injected rather than mocked so every case runs on every host.
describe("pathCompare", () => {
  describe("win32", () => {
    it("treats a drive-letter case difference as the same path", () => {
      // The regression this exists for: Node resolves "C:\", provider ledgers
      // often record "c:\", and usage data silently vanished on the mismatch.
      expect(pathsEqual("C:\\Users\\arul\\ADE", "c:\\users\\arul\\ade", "win32")).toBe(true);
    });

    it("accepts forward slashes as separators", () => {
      expect(pathsEqual("C:/Users/arul/ADE", "C:\\Users\\arul\\ADE", "win32")).toBe(true);
    });

    it("ignores a trailing separator", () => {
      expect(pathsEqual("C:\\Users\\arul\\ADE\\", "C:\\Users\\arul\\ADE", "win32")).toBe(true);
    });

    it("keeps distinct paths distinct", () => {
      expect(pathsEqual("C:\\Users\\arul", "C:\\Users\\brul", "win32")).toBe(false);
    });

    it("collapses . and .. segments", () => {
      expect(pathsEqual("C:\\Users\\arul\\..\\arul\\ADE", "C:\\Users\\arul\\ADE", "win32")).toBe(true);
    });

    it("keeps the trailing separator on a root, and only on a root", () => {
      expect(pathKey("C:\\", "win32")).toBe("c:\\");
      expect(pathKey("C:\\Users\\arul\\", "win32")).toBe("c:\\users\\arul");
    });

    /**
     * A bare share and a share with its trailing separator name the same root.
     * `path.win32.normalize` appends the separator to the bare spelling, so both
     * arrive at the root-keeping branch — the two must not diverge there.
     */
    it("keys both spellings of a bare UNC share the same", () => {
      expect(pathKey("\\\\server\\share", "win32")).toBe(pathKey("\\\\server\\share\\", "win32"));
      expect(pathsEqual("\\\\server\\share", "\\\\server\\share\\", "win32")).toBe(true);
    });

    it("still trims the trailing separator below a UNC root", () => {
      expect(pathsEqual("\\\\server\\share\\repo\\", "\\\\server\\share\\repo", "win32")).toBe(true);
    });
  });

  describe("linux stays case-sensitive", () => {
    it("does not fold case", () => {
      expect(pathsEqual("/home/arul/ADE", "/home/arul/ade", "linux")).toBe(false);
    });

    it("still normalizes separators and traversal", () => {
      expect(pathsEqual("/home/arul/../arul/ADE/", "/home/arul/ADE", "linux")).toBe(true);
    });
  });

  describe("darwin folds case like win32", () => {
    it("matches a case-different path", () => {
      expect(pathsEqual("/Users/arul/ADE", "/users/arul/ade", "darwin")).toBe(true);
    });
  });

  describe("isPathInside", () => {
    it("matches the parent itself", () => {
      expect(isPathInside("C:\\proj", "C:\\proj", "win32")).toBe(true);
    });

    it("matches a descendant regardless of case", () => {
      expect(isPathInside("c:\\PROJ\\src\\main.ts", "C:\\proj", "win32")).toBe(true);
    });

    it("rejects a sibling that merely shares a name prefix", () => {
      // The bug a bare startsWith introduces.
      expect(isPathInside("C:\\project-old\\src", "C:\\project", "win32")).toBe(false);
    });

    it("rejects a parent path", () => {
      expect(isPathInside("C:\\proj", "C:\\proj\\src", "win32")).toBe(false);
    });

    it("applies the same segment rule on posix", () => {
      expect(isPathInside("/project-old/src", "/project", "linux")).toBe(false);
      expect(isPathInside("/project/src", "/project", "linux")).toBe(true);
    });
  });

  describe("pathComparisonKey", () => {
    it("folds a path-derived identifier on case-insensitive platforms", () => {
      expect(pathComparisonKey("C--Users-arul-ADE", "win32")).toBe("c--users-arul-ade");
    });

    it("leaves it alone on linux", () => {
      expect(pathComparisonKey("C--Users-arul-ADE", "linux")).toBe("C--Users-arul-ADE");
    });

    it("does not path-normalize the identifier", () => {
      // It is no longer a path; normalizing would corrupt it.
      expect(pathComparisonKey("a--b--c", "linux")).toBe("a--b--c");
    });
  });

  describe("stripExtendedLengthPrefix", () => {
    it("removes the `\\\\?\\` prefix from a drive path", () => {
      // Codex records exactly this: 116 of 117 cwd-bearing rows in a real
      // ~/.codex/state_5.sqlite are in extended-length form.
      expect(stripExtendedLengthPrefix("\\\\?\\C:\\Users\\arul\\ADE", "win32"))
        .toBe("C:\\Users\\arul\\ADE");
    });

    it("folds the escaped UNC spelling back to a plain UNC path", () => {
      expect(stripExtendedLengthPrefix("\\\\?\\UNC\\server\\share\\repo", "win32"))
        .toBe("\\\\server\\share\\repo");
    });

    it("leaves a plain path and a real UNC path untouched", () => {
      expect(stripExtendedLengthPrefix("C:\\Users\\arul", "win32")).toBe("C:\\Users\\arul");
      expect(stripExtendedLengthPrefix("\\\\server\\share", "win32")).toBe("\\\\server\\share");
    });

    it("never touches a posix path, where `\\\\?\\` is a legal filename", () => {
      expect(stripExtendedLengthPrefix("\\\\?\\weird", "linux")).toBe("\\\\?\\weird");
      expect(stripExtendedLengthPrefix("\\\\?\\weird", "darwin")).toBe("\\\\?\\weird");
    });

    it("tolerates empty input", () => {
      expect(stripExtendedLengthPrefix(null, "win32")).toBe("");
      expect(stripExtendedLengthPrefix("", "win32")).toBe("");
    });
  });

  describe("extended-length paths compare as their plain spelling", () => {
    it("is equal to the same path without the prefix", () => {
      expect(pathsEqual("\\\\?\\C:\\Users\\arul\\ADE", "C:\\Users\\arul\\ADE", "win32")).toBe(true);
    });

    it("is contained by a scope root written plainly", () => {
      // The exact shape of the Codex bug: without the strip, path.relative reads
      // `\\?\C:\` as a UNC root and every session tests as out of scope.
      expect(isPathInside("\\\\?\\C:\\Users\\arul\\ADE\\apps", "C:\\Users\\arul\\ADE", "win32")).toBe(true);
    });

    it("still respects segment boundaries through the prefix", () => {
      expect(isPathInside("\\\\?\\C:\\project-old", "C:\\project", "win32")).toBe(false);
    });

    it("keys identically with or without the prefix", () => {
      expect(pathKey("\\\\?\\C:\\Users\\arul", "win32")).toBe(pathKey("C:\\Users\\arul", "win32"));
    });
  });

  describe("empty input", () => {
    it("never matches", () => {
      expect(pathsEqual("", "C:\\proj", "win32")).toBe(false);
      expect(pathsEqual(null, undefined, "win32")).toBe(false);
      expect(isPathInside("", "C:\\proj", "win32")).toBe(false);
      expect(pathKey("", "win32")).toBe("");
    });
  });
});
