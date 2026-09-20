import { describe, expect, it } from "vitest";
import { isSafeIdentifier, SAFE_IDENTIFIER_PATTERN } from "./safeIdentifier";

describe("isSafeIdentifier", () => {
  it("accepts the ids ADE actually mints", () => {
    for (const id of ["work", "hp_opus_work", "claude", "lv-second", "openrouter", "v1.2", "a_b-c.d", "A1"]) {
      expect(isSafeIdentifier(id)).toBe(true);
    }
  });

  // The whole point: these become path segments under
  // `<adeHome>/provider-homes/...` and keys in the credential store.
  it("rejects the traversal spellings, on POSIX and Windows alike", () => {
    for (const id of [
      ".",
      "..",
      "../escape",
      "..\\escape",
      "a/b",
      "a\\b",
      "/abs",
      "C:\\abs",
      "x:stream",
      "",
      " ",
      "with space",
      "%2e%2e",
      "a\u0000b",
      "café",
      "a\nb",
    ]) {
      expect(isSafeIdentifier(id), `${JSON.stringify(id)} must be rejected`).toBe(false);
    }
  });

  // A Windows separator is not a separator on a POSIX host, so a check that
  // leaned on `path.relative` alone would pass `..\escape` when the test ran on
  // macOS and fail only on the machine that matters. The character class is
  // platform-independent by construction; this pins that.
  it("is platform-independent: the rule is a character class, not a path call", () => {
    expect(SAFE_IDENTIFIER_PATTERN.test("..\\escape")).toBe(false);
    expect(SAFE_IDENTIFIER_PATTERN.test("../escape")).toBe(false);
    expect(SAFE_IDENTIFIER_PATTERN.test("escape")).toBe(true);
  });
});
