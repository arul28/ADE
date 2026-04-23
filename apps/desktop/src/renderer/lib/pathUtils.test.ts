import { describe, expect, it } from "vitest";
import {
  isPathEqualOrDescendant,
  normalizePath,
  normalizePathForComparison,
  remapPathForRename,
} from "./pathUtils";

describe("pathUtils", () => {
  it("preserves Windows drive roots while normalizing separators", () => {
    expect(normalizePath("C:\\")).toBe("C:/");
    expect(normalizePath("/C:/Users/me/repo")).toBe("C:/Users/me/repo");
    expect(normalizePath("C:\\Users\\me\\repo\\")).toBe("C:/Users/me/repo");
  });

  it("compares Windows paths case-insensitively", () => {
    expect(normalizePathForComparison("C:\\Users\\Me\\Repo")).toBe("c:/users/me/repo");
    expect(isPathEqualOrDescendant("c:/users/me/repo/src/main.ts", "C:\\Users\\Me\\Repo")).toBe(true);
  });

  it("remaps renamed Windows descendants without dropping the drive root", () => {
    expect(remapPathForRename("C:/Users/Me/Repo/src/main.ts", "c:/users/me/repo", "D:/Work/Repo")).toBe(
      "D:/Work/Repo/src/main.ts",
    );
  });
});
