import { describe, expect, it } from "vitest";
import { normalizeSessionStatusNote } from "./sessionStatusNote";

describe("normalizeSessionStatusNote", () => {
  it("keeps the ellipsis inside the 72-character cap when extra words follow an exact boundary", () => {
    const exactSixWordBoundary = [
      "abcdefghijkl",
      "abcdefghijkl",
      "abcdefghijkl",
      "abcdefghijkl",
      "abcdefghijkl",
      "abcdefg",
    ].join(" ");
    expect(Array.from(exactSixWordBoundary)).toHaveLength(72);

    const normalized = normalizeSessionStatusNote(`${exactSixWordBoundary} extra words`);

    expect(normalized).toBe(`${Array.from(exactSixWordBoundary).slice(0, 71).join("")}…`);
    expect(Array.from(normalized ?? "")).toHaveLength(72);
  });
});
