import { describe, expect, it } from "vitest";

import { foldsCase, pathIsWithinRoot, samePathOnPlatform, trimTrailingSeparators } from "./pathContainment";
import path from "node:path";

describe("foldsCase", () => {
  // The rule `pathCompare.ts` already follows in the main process: Windows
  // path components are case-insensitive and macOS volumes are case-insensitive
  // by default, so both fold; Linux is case-sensitive, so folding there would
  // make two different directories compare equal.
  it("folds on win32 and darwin, and nowhere else", () => {
    expect(foldsCase("win32")).toBe(true);
    expect(foldsCase("darwin")).toBe(true);
    expect(foldsCase("linux")).toBe(false);
    expect(foldsCase("freebsd")).toBe(false);
  });

  // The bare flavor is used by containment that GRANTS, where folding on an
  // assumption ADE cannot verify would admit a write the host never approved.
  it("does not fold for the bare posix flavor", () => {
    expect(foldsCase("posix")).toBe(false);
  });
});

describe("pathIsWithinRoot", () => {
  it("accepts the root itself and anything under it", () => {
    expect(pathIsWithinRoot("/srv/data", "/srv/data", "posix")).toBe(true);
    expect(pathIsWithinRoot("/srv/data", "/srv/data/x/y.txt", "posix")).toBe(true);
  });

  it("requires a separator at the boundary", () => {
    expect(pathIsWithinRoot("/srv/data", "/srv/data-old/x", "posix")).toBe(false);
  });

  it("ignores a trailing separator on either side", () => {
    expect(pathIsWithinRoot("/srv/data/", "/srv/data", "posix")).toBe(true);
    expect(pathIsWithinRoot("/srv/data", "/srv/data/", "posix")).toBe(true);
  });

  it("normalizes a climbing target before deciding", () => {
    expect(pathIsWithinRoot("/srv/data", "/srv/data/sub/../ok.txt", "posix")).toBe(true);
    expect(pathIsWithinRoot("/srv/data", "/srv/data/../escape.txt", "posix")).toBe(false);
  });

  // A relative target resolved against the ROOT is inside the root by
  // construction, which is a decision about a file nothing will ever touch.
  it("resolves a relative target against the base, not the root", () => {
    expect(pathIsWithinRoot("/srv/data", "file.txt", "posix", "/srv/data/sub")).toBe(true);
    expect(pathIsWithinRoot("/srv/data", "file.txt", "posix", "/elsewhere")).toBe(false);
    expect(pathIsWithinRoot("/srv/data", "../file.txt", "posix", "/srv/data/sub")).toBe(true);
    expect(pathIsWithinRoot("/srv/data", "../../file.txt", "posix", "/srv/data/sub")).toBe(false);
  });

  it("does not contain a relative target with no usable base", () => {
    expect(pathIsWithinRoot("/srv/data", "file.txt", "posix")).toBe(false);
    expect(pathIsWithinRoot("/srv/data", "file.txt", "posix", null)).toBe(false);
    expect(pathIsWithinRoot("/srv/data", "file.txt", "posix", "   ")).toBe(false);
    // A relative base is no base: it names no directory either.
    expect(pathIsWithinRoot("/srv/data", "file.txt", "posix", "sub")).toBe(false);
  });

  it("compares Windows paths case-insensitively and across separators", () => {
    expect(pathIsWithinRoot("C:\\work\\proj", "C:\\Work\\Proj\\src\\a.ts", "win32")).toBe(true);
    expect(pathIsWithinRoot("C:\\work\\proj", "C:/work/proj/src/a.ts", "win32")).toBe(true);
    expect(pathIsWithinRoot("C:\\work\\proj", "C:\\work\\proj-old\\a.ts", "win32")).toBe(false);
    expect(pathIsWithinRoot("C:\\work\\proj", "D:\\work\\proj\\a.ts", "win32")).toBe(false);
  });

  it("folds case on darwin and not on linux", () => {
    expect(pathIsWithinRoot("/Users/u/.ade", "/Users/u/.ADE/state", "darwin")).toBe(true);
    expect(pathIsWithinRoot("/Users/u/.ade", "/Users/u/.ADE/state", "linux")).toBe(false);
  });
});

describe("samePathOnPlatform", () => {
  it("is equality, not two-way containment", () => {
    expect(samePathOnPlatform("/home/u", "/home/u/", "posix")).toBe(true);
    expect(samePathOnPlatform("/home/u", "/home/u/docs", "posix")).toBe(false);
    expect(samePathOnPlatform("/home/u/docs/..", "/home/u", "posix")).toBe(true);
  });

  it("follows the platform's case rule", () => {
    expect(samePathOnPlatform("/Users/Producer", "/users/producer", "darwin")).toBe(true);
    expect(samePathOnPlatform("/Users/Producer", "/users/producer", "linux")).toBe(false);
    expect(samePathOnPlatform("C:\\Users\\P", "c:\\users\\p", "win32")).toBe(true);
  });

  it("treats a Windows extended-length prefix as the same path", () => {
    expect(samePathOnPlatform("C:\\Users\\P", "\\\\?\\C:\\Users\\P", "win32")).toBe(true);
  });
});

describe("Windows extended-length prefix", () => {
  it("contains a prefixed child of ADE state the way a refusal must", () => {
    expect(pathIsWithinRoot(
      "C:\\Users\\P\\.ade",
      "\\\\?\\C:\\Users\\P\\.ade\\personal-chats",
      "win32",
    )).toBe(true);
  });

  it("does not strip the prefix under the posix flavor, where it is a filename", () => {
    expect(samePathOnPlatform("C:\\Users\\P", "\\\\?\\C:\\Users\\P", "posix")).toBe(false);
    expect(pathIsWithinRoot("C:\\Users\\P", "\\\\?\\C:\\Users\\P\\x", "posix")).toBe(false);
  });
});

describe("trimTrailingSeparators", () => {
  it("leaves a bare root alone", () => {
    expect(trimTrailingSeparators("/", path.posix)).toBe("/");
    expect(trimTrailingSeparators("C:\\", path.win32)).toBe("C:");
  });

  it("removes every trailing separator, in either spelling", () => {
    expect(trimTrailingSeparators("/srv/data///", path.posix)).toBe("/srv/data");
    expect(trimTrailingSeparators("C:\\work\\proj\\/", path.win32)).toBe("C:\\work\\proj");
  });
});
