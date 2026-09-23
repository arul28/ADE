import { describe, expect, it } from "vitest";

import { foldsCase, pathFlavorOf } from "./pathCase";

describe("foldsCase", () => {
  // Windows path components are case-insensitive and macOS volumes are
  // case-insensitive by default, so both fold; Linux is case-sensitive, so
  // folding there would make two different directories compare equal.
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

describe("pathFlavorOf", () => {
  it("reads drive-letter and UNC spellings as win32, in either slash", () => {
    for (const value of ["C:\\repo", "c:/repo", "C:", "C:\\", "\\\\server\\share", "//server/share"]) {
      expect(pathFlavorOf(value)).toBe("win32");
    }
  });

  it("reads everything else as posix", () => {
    for (const value of ["/Users/me/repo", "relative/path", "", "C", "C:repo", "//", "\\\\"]) {
      expect(pathFlavorOf(value)).toBe("posix");
    }
  });
});
