import { describe, expect, it } from "vitest";

import {
  branchFragmentFromLaneTitle,
  cleanPromptForNaming,
  deriveDeterministicAutoLaneIdentity,
  deriveDeterministicLaneNameFromPrompt,
  deriveDeterministicLaneTitleFromPrompt,
  genericLaneFallbackName,
  genericSuffixFromLaneFallbackName,
  isAutoLaneTemporaryBranch,
  resolveAppliedAutoLaneBranchFragment,
  resolveCoherentAutoLaneIdentity,
} from "./laneNameFallback";

describe("automatic lane identity fallback", () => {
  it("keeps the lane title readable and the branch fragment Git-friendly", () => {
    expect(deriveDeterministicAutoLaneIdentity("Can we discuss how ADE names auto-created lanes?")).toEqual({
      laneTitle: "ADE Names Auto Created Lanes",
      branchFragment: "ade-names-auto-created-lanes",
    });
  });

  it("preserves product capitalization in readable titles", () => {
    expect(deriveDeterministicLaneTitleFromPrompt("The Claude auth login button hangs after OAuth redirects")).toBe(
      "Claude Auth Login Button Hangs",
    );
  });

  it("recognizes only exact automatic temporary branches", () => {
    expect(isAutoLaneTemporaryBranch("ade/1a2b3c4d")).toBe(true);
    expect(isAutoLaneTemporaryBranch("ade/naming-auto-created-lanes")).toBe(false);
    expect(isAutoLaneTemporaryBranch("feature/1a2b3c4d")).toBe(false);
    expect(isAutoLaneTemporaryBranch("ade/ABCDEF12")).toBe(false);
  });

  it("keeps a title and derives the branch when AI copies a mentioned lane's fragment", () => {
    const fallback = deriveDeterministicAutoLaneIdentity(
      "ok something super weird happened. @lane Chat Mention Tags is showing pr 1068",
    );
    expect(fallback.laneTitle).toBe("Ok Something Super Weird Happened");
    expect(resolveCoherentAutoLaneIdentity({
      laneTitle: "Ok Something Super Weird Happened",
      branchFragment: "chat-mention-tags",
    }, fallback)).toEqual({
      laneTitle: "Ok Something Super Weird Happened",
      branchFragment: "ok-something-super-weird-happened",
    });
  });

  it("does not mix a fallback title with a mention-copied branch fragment", () => {
    const fallback = {
      laneTitle: "Ok Something Super Weird Happened",
      branchFragment: "ok-something-super-weird-happened",
    };
    expect(resolveCoherentAutoLaneIdentity({
      laneTitle: null,
      branchFragment: "chat-mention-tags",
    }, fallback)).toEqual(fallback);
  });

  it("keeps a coherent AI title/branch pair", () => {
    expect(resolveCoherentAutoLaneIdentity({
      laneTitle: "Chat Mention Tags",
      branchFragment: "chat-mention-tags",
    }, {
      laneTitle: "Start Skill Image Wann Highlihgt",
      branchFragment: "start-skill-image-wann-highlihgt",
    })).toEqual({
      laneTitle: "Chat Mention Tags",
      branchFragment: "chat-mention-tags",
    });
  });

  it("slugs titles without the prompt stopword list", () => {
    expect(branchFragmentFromLaneTitle("Chat Mention Tags")).toBe("chat-mention-tags");
    expect(branchFragmentFromLaneTitle("!!!")).toBe("parallel-task");
  });

  it("drops a stolen AI fragment when the title was not adopted", () => {
    expect(resolveAppliedAutoLaneBranchFragment({
      adoptedAiTitle: false,
      aiBranchFragment: "chat-mention-tags",
      identityTitle: "Ok Something Super Weird Happened",
      occupied: () => false,
    })).toBe("ok-something-super-weird-happened");
  });

  it("prefers the applied title slug over suffixing an occupied stolen fragment", () => {
    expect(resolveAppliedAutoLaneBranchFragment({
      adoptedAiTitle: true,
      aiBranchFragment: "chat-mention-tags",
      identityTitle: "Ok Something Super Weird Happened",
      occupied: (ref) => ref === "ade/chat-mention-tags",
    })).toBe("ok-something-super-weird-happened");
  });
});

describe("lane name fallback", () => {
  it("derives compact task slugs from prompts", () => {
    expect(deriveDeterministicLaneNameFromPrompt("Can you please fix the login bug?")).toBe("fix-login-bug");
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

  it("does not collapse an unrelated prompt into a provider auth name", () => {
    // Regression: a keyword trap used to rename any prompt that mentioned a
    // provider plus a login-ish phrase to "<provider>-auth-login", inventing
    // words the prompt never contained.
    const name = deriveDeterministicLaneNameFromPrompt(
      "Plan ADE distribution and packaging. Claude runs the handoff, and users sign in once.",
    );
    expect(name).not.toBe("claude-auth-login");
    expect(name).toContain("distribution");
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
