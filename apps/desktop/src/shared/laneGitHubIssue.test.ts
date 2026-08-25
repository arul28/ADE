import { describe, expect, it } from "vitest";
import { githubIssueId, githubIssueToLaneIssue, type GitHubIssueLike } from "./laneGitHubIssue";

const SAMPLE_ISSUE: GitHubIssueLike = {
  number: 42,
  title: "Fix attach menu",
  body: "Details",
  html_url: "https://github.com/ade/app/issues/42",
  state: "open",
  state_reason: null,
  labels: [{ name: "bug" }],
  assignees: [{ login: "arul" }],
  user: { login: "arul" },
  created_at: "2026-08-24T00:00:00.000Z",
  updated_at: "2026-08-24T00:00:00.000Z",
};

describe("githubIssueToLaneIssue", () => {
  it("maps a GitHub issue onto a lane issue", () => {
    const issue = githubIssueToLaneIssue("ade", "app", SAMPLE_ISSUE);
    expect(issue).toEqual({
      id: githubIssueId("ade", "app", 42),
      number: 42,
      owner: "ade",
      repo: "app",
      title: "Fix attach menu",
      body: "Details",
      url: "https://github.com/ade/app/issues/42",
      state: "open",
      stateReason: null,
      labels: ["bug"],
      assignees: ["arul"],
      authorLogin: "arul",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
  });

  it("drops pull requests", () => {
    expect(githubIssueToLaneIssue("ade", "app", { ...SAMPLE_ISSUE, pull_request: { url: "https://github.com/ade/app/pull/42" } })).toBeNull();
  });
});
