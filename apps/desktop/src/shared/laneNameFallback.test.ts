import { describe, expect, it } from "vitest";

import {
  cleanPromptForNaming,
  deriveDeterministicLaneNameFromPrompt,
  genericLaneFallbackName,
  genericSuffixFromLaneFallbackName,
} from "./laneNameFallback";

describe("lane name fallback", () => {
  it("derives compact task slugs from prompts", () => {
    expect(deriveDeterministicLaneNameFromPrompt("Can you please fix the login bug?")).toBe("fix-login-bug");
  });

  it("prefers concrete auth/login UI nouns over conversational lead-ins", () => {
    expect(
      deriveDeterministicLaneNameFromPrompt(
        "correct me if im wrong, but i though ade had a way to detect failed claude creds and present a button ro usmthin in the chat to run claude auth login in ade chat temrinal, use context skill, and look into this",
      ),
    ).toBe("claude-auth-login-button");
  });

  it("keeps prompt-specific context for broad provider auth prompts", () => {
    expect(deriveDeterministicLaneNameFromPrompt("Debug the Claude OAuth token expiry bug")).toBe(
      "debug-claude-oauth-token-expiry",
    );
  });

  it("does not treat login history as a provider auth task", () => {
    expect(
      deriveDeterministicLaneNameFromPrompt(
        "Debug cursor SDK chat mobile sync issues. Look at the full login history, then follow the Claude MD guidance.",
      ),
    ).toBe("debug-cursor-sdk-mobile-sync");
  });

  it("turns a URL-heavy 'take a look at' prompt into clean tokens, not url noise", () => {
    // Regression for "take-look-at-https-github".
    expect(
      deriveDeterministicLaneNameFromPrompt("Take a look at https://github.com/org/repo/pull/5"),
    ).toBe("github-org-repo-pull");
  });

  it("strips bare domains and filler verbs", () => {
    expect(deriveDeterministicLaneNameFromPrompt("look into github.com flaky tests")).toBe("github-flaky-tests");
  });

  it("cleanPromptForNaming preserves casing while removing url/filler noise", () => {
    expect(cleanPromptForNaming("Please refactor the Parser at https://example.com/docs")).toBe(
      "refactor the Parser at example docs",
    );
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
