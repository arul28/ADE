import { describe, expect, it } from "vitest";
import {
  buildPathToMergeSeedPrompt,
  buildWatchTurnPrompt,
  pathToMergeChatTitle,
  type PathToMergeSeedInputs,
} from "./pathToMergeSeedPrompt";

const PR: PathToMergeSeedInputs["pr"] = {
  githubPrNumber: 42,
  githubUrl: "https://github.com/arul28/ADE/pull/42",
  title: "Add the thing",
  repoOwner: "arul28",
  repoName: "ADE",
  baseBranch: "main",
  headBranch: "feature/x",
};

function build(overrides: Partial<PathToMergeSeedInputs> = {}): string {
  return buildPathToMergeSeedPrompt({
    pr: PR,
    laneWorktreePath: "/work/lane-1",
    gating: "both",
    additionalInstructions: null,
    pollIntervalSeconds: 600,
    ...overrides,
  });
}

describe("pathToMergeChatTitle", () => {
  it("names the chat after the PR number", () => {
    expect(pathToMergeChatTitle({ githubPrNumber: 42 })).toBe("Path to Merge #42");
  });
});

describe("buildPathToMergeSeedPrompt", () => {
  it("anchors the agent to the PR, repo, and lane worktree", () => {
    const seed = build();
    expect(seed).toContain("Path to Merge watcher for pull request #42 in arul28/ADE");
    expect(seed).toContain("https://github.com/arul28/ADE/pull/42");
    expect(seed).toContain("Working directory (this PR's lane worktree): /work/lane-1");
  });

  it("encodes each gating mode as a distinct hard rule", () => {
    expect(build({ gating: "both" })).toContain("GATING = BOTH (CI + review).");
    expect(build({ gating: "checks" })).toContain("GATING = CI ONLY.");
    expect(build({ gating: "comments" })).toContain("GATING = REVIEW COMMENTS ONLY.");
  });

  it("teaches the squash → --admin → --auto ladder and forbids --delete-branch", () => {
    const seed = build();
    expect(seed).toContain("gh pr merge 42 --squash");
    expect(seed).toContain("--squash --admin");
    expect(seed).toContain("--squash --auto");
    expect(seed).toContain("NEVER pass `--delete-branch`");
    expect(seed).toContain("gh api -X DELETE repos/arul28/ADE/git/refs/heads/feature/x");
  });

  it("surfaces the poll interval in minutes so the agent paces itself", () => {
    expect(build({ pollIntervalSeconds: 600 })).toContain("roughly every 10 min (600s)");
  });

  it("appends operator instructions verbatim only when provided", () => {
    expect(build({ additionalInstructions: "Ping @arul before merging." }))
      .toContain("## Additional operator instructions\nPing @arul before merging.");
    expect(build({ additionalInstructions: "   " })).not.toContain("## Additional operator instructions");
  });
});

describe("buildWatchTurnPrompt", () => {
  it("nudges a single bounded turn and references the PR number", () => {
    const prompt = buildWatchTurnPrompt({ githubPrNumber: 42 });
    expect(prompt).toContain("Watch turn for PR #42.");
    expect(prompt).toContain("single next action toward merging");
  });
});
