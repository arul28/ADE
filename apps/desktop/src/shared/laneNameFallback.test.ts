import { describe, expect, it } from "vitest";

import {
  deriveDeterministicLaneNameFromPrompt,
  genericLaneFallbackName,
  genericSuffixFromLaneFallbackName,
} from "./laneNameFallback";

describe("lane name fallback", () => {
  it("derives compact task slugs from prompts", () => {
    expect(deriveDeterministicLaneNameFromPrompt("Can you please fix the login bug?")).toBe("fix-login-bug");
  });

  it("uses the generic suffix only when the prompt has no meaningful slug", () => {
    expect(deriveDeterministicLaneNameFromPrompt("!!!", { genericSuffix: "20260610-142233" })).toBe(
      "parallel-task-20260610-142233",
    );
    expect(deriveDeterministicLaneNameFromPrompt("Fix the login bug", { genericSuffix: "20260610-142233" })).toBe(
      "fix-login-bug",
    );
  });

  it("extracts old chat timestamp fallback suffixes", () => {
    expect(genericSuffixFromLaneFallbackName("chat-20260514-010203")).toBe("20260514-010203");
    expect(genericLaneFallbackName("20260514-010203")).toBe("parallel-task-20260514-010203");
  });
});
