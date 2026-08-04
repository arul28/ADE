import { describe, expect, it } from "vitest";
import { normalizeSessionStatusNote } from "./sessionStatusNote";

describe("normalizeSessionStatusNote", () => {
  it("keeps a note past the six-word guideline when it fits the display budget", () => {
    // Six words is guidance for agents, not an amputation point: the decisive
    // state is often in words seven and eight.
    expect(normalizeSessionStatusNote("rebasing lane onto main after CI went green"))
      .toBe("rebasing lane onto main after CI went green");
  });

  it("collapses whitespace and drops empty notes", () => {
    expect(normalizeSessionStatusNote("  fixing   flaky  shard \n")).toBe("fixing flaky shard");
    expect(normalizeSessionStatusNote("   ")).toBeNull();
    expect(normalizeSessionStatusNote(undefined)).toBeNull();
  });

  it("keeps the ellipsis inside the 72-character cap when a note runs past the budget", () => {
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
