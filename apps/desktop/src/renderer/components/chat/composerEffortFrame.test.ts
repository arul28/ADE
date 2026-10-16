import { describe, expect, it } from "vitest";
import {
  addUltrathinkKeyword,
  hasUltrathinkKeyword,
  removeUltrathinkKeyword,
  resolveComposerEffortFrame,
  ultrathinkKeywordRanges,
} from "./composerEffortFrame";

describe("composer effort frame", () => {
  it.each([
    {
      name: "keeps a slash command first",
      input: "/review changed files",
      operation: "add" as const,
      expected: "/review changed files ultrathink",
      active: true,
      count: 1,
    },
    {
      name: "removes the keyword and its optional colon separator",
      input: "ultrathink: review this",
      operation: "remove" as const,
      expected: "review this",
      active: false,
      count: 0,
    },
    {
      name: "matches the existing keyword case-insensitively without duplication",
      input: "ULTRATHINK is already here",
      operation: "add" as const,
      expected: "ULTRATHINK is already here",
      active: true,
      count: 1,
    },
    {
      name: "requires a whole word",
      input: "ultrathinker",
      operation: "add" as const,
      expected: "ultrathink ultrathinker",
      active: true,
      count: 1,
    },
  ])("$name", ({ input, operation, expected, active, count }) => {
    const output = operation === "add" ? addUltrathinkKeyword(input) : removeUltrathinkKeyword(input);
    expect(output).toBe(expected);
    expect(hasUltrathinkKeyword(output)).toBe(active);
    expect(ultrathinkKeywordRanges(output)).toHaveLength(count);
  });

  it("preserves the text of a recognized token when the switch removes the keyword", () => {
    const tokenText = "@files/ultrathink-notes.md";
    const recognizedFileToken = [{ start: 0, end: tokenText.length }];

    expect(removeUltrathinkKeyword(tokenText, recognizedFileToken)).toBe(tokenText);
    expect(hasUltrathinkKeyword(tokenText, recognizedFileToken)).toBe(false);
    expect(ultrathinkKeywordRanges(tokenText)).toHaveLength(1);
  });

  it("prefers Ultrathink, frames only the highest selected effort, and skips single-tier or unset effort", () => {
    const rainbow = resolveComposerEffortFrame({ ultrathink: true, effort: "ultracode", tiers: ["high", "ultracode"] });
    expect(rainbow?.kind).toBe("ultrathink");
    expect(rainbow).not.toHaveProperty("rgb");
    expect(rainbow).not.toHaveProperty("ultra");

    const ultracode = resolveComposerEffortFrame({ ultrathink: false, effort: "ultracode", tiers: ["high", "ultracode"] });
    expect(ultracode?.kind).toBe("top");
    expect(ultracode).toMatchObject({ ultra: true });
    expect((ultracode as { rgb: string }).rgb.length).toBeGreaterThan(0);

    const max = resolveComposerEffortFrame({ ultrathink: false, effort: "max", tiers: ["low", "max"] });
    expect(max).toMatchObject({ kind: "top", ultra: false });
    expect((max as { rgb: string }).rgb.length).toBeGreaterThan(0);

    expect(resolveComposerEffortFrame({ ultrathink: false, effort: "high", tiers: ["low", "high", "ultracode"] })).toBeNull();
    expect(resolveComposerEffortFrame({ ultrathink: false, effort: "high", tiers: ["high"] })).toBeNull();
    expect(resolveComposerEffortFrame({ ultrathink: false, effort: null, tiers: ["low", "high"] })).toBeNull();
  });
});
