import { describe, expect, it } from "vitest";
import { claudeCompactionSettings, claudeSubagentWindowIneffective, normalizeCompactionSettings } from "./compactionSettings";

describe("normalizeCompactionSettings", () => {
  it("drops a saved auto-compact off: compaction is always on", () => {
    expect(normalizeCompactionSettings({ enabled: false, atTokens: 300_000 })).toEqual({ atTokens: 300_000 });
    expect(claudeCompactionSettings(normalizeCompactionSettings({ enabled: false }))).toEqual({});
  });

  it.each([
    ["a window", { subagentAtTokens: 200_000 }, { subagentAtTokens: 200_000 }],
    ["Auto", { subagentAtTokens: null }, { subagentAtTokens: null }],
    ["not a token count", { subagentAtTokens: -5 }, {}],
  ])("keeps the subagent window: %s", (_name, raw, expected) => {
    expect(normalizeCompactionSettings(raw)).toEqual(expected);
  });
});

describe("claudeSubagentWindowIneffective", () => {
  it.each([
    ["below the main window", { atTokens: 400_000, subagentAtTokens: 200_000 }, false],
    ["equal to the main window", { atTokens: 400_000, subagentAtTokens: 400_000 }, true],
    ["above the main window", { atTokens: 300_000, subagentAtTokens: 500_000 }, true],
    ["main on Auto, so unknown", { subagentAtTokens: 500_000 }, false],
    ["subagents on Auto", { atTokens: 300_000 }, false],
  ])("%s", (_name, settings, expected) => {
    expect(claudeSubagentWindowIneffective(settings)).toBe(expected);
  });
});
