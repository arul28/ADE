import { describe, expect, it } from "vitest";
import {
  formatLinearStatus,
  formatMemorySearch,
  formatPrChecks,
  formatPrComments,
  formatPrReview,
  formatPrSummary,
  formatSystemDetails,
} from "../rightPaneFormatters";

describe("rightPaneFormatters", () => {
  it("formats system details as stable rows", () => {
    const body = formatSystemDetails({
      project: { projectRoot: "/repo", workspaceRoot: "/repo/.ade/worktrees/a" },
      pid: 123,
      mode: "ready",
    });

    expect(body).toContain("project");
    expect(body).toContain("/repo");
    expect(body).toContain("workspace");
    expect(body).toContain("process    123");
    expect(body).not.toContain("{");
  });

  it("formats a PR summary without dumping JSON", () => {
    const body = formatPrSummary({
      id: "pr-1",
      number: 42,
      title: "Tighten ADE Code panes",
      state: "open",
      isDraft: true,
      headBranch: "feature/tui",
      baseBranch: "main",
      htmlUrl: "https://example.com/pr/42",
    });

    expect(body).toContain("#42 · open · draft");
    expect(body).toContain("Tighten ADE Code panes");
    expect(body).toContain("feature/tui -> main");
    expect(body).not.toContain("\"title\"");
  });

  it("formats PR create links from the new action envelope", () => {
    const body = formatPrSummary({
      pr: {
        id: "pr-42",
        laneId: "lane-1",
        repoOwner: "acme",
        repoName: "ade",
        githubPrNumber: 42,
        githubUrl: "https://github.com/acme/ade/pull/42",
        title: "Add PR deeplinks",
        state: "open",
      },
      adeUrl: "https://ade.app/open?type=pr&repo=acme%2Fade&number=42",
    });

    expect(body).toContain("#42 · open");
    expect(body).toContain("github   https://github.com/acme/ade/pull/42");
    expect(body).toContain("ade      https://ade.app/open?type=pr&repo=acme%2Fade&number=42");
  });

  it("derives an ADE PR URL when repo metadata is present", () => {
    const body = formatPrSummary({
      repoOwner: "acme",
      repoName: "ade",
      githubPrNumber: 7,
      title: "Review parity",
      githubUrl: "https://github.com/acme/ade/pull/7",
    });

    expect(body).toContain("github   https://github.com/acme/ade/pull/7");
    expect(body).toContain("ade      https://ade.app/open?type=pr&repo=acme%2Fade&number=7");
  });

  it("summarizes PR checks", () => {
    const body = formatPrChecks([
      { name: "ci / unit", status: "completed", conclusion: "success", completedAt: "2026-05-20T12:34:00.000Z" },
      { name: "lint", status: "queued", conclusion: null },
    ]);

    expect(body).toContain("PR checks");
    expect(body).toContain("1 passing");
    expect(body).toContain("1 pending");
    expect(body).toContain("OK   ci / unit");
    expect(body).toContain("WAIT lint");
  });

  it("summarizes PR review comments and threads", () => {
    const body = formatPrComments({
      summary: { checksStatus: "passing", actionableComments: 2 },
      reviewThreads: [
        {
          id: "thread-1",
          isResolved: false,
          path: "src/index.ts",
          line: 12,
          comments: [{ author: "reviewer", body: "Please handle the loading state." }],
        },
      ],
      comments: [{ author: "reviewer", body: "Please fix the loading state." }],
    });

    expect(body).toContain("PR comments · passing · 2 actionable");
    expect(body).toContain("open src/index.ts:12");
    expect(body).toContain("reviewer: Please handle the loading state.");
    expect(body).not.toContain("\"reviewThreads\"");
  });

  it("summarizes full PR review data", () => {
    const body = formatPrReview({
      reviews: [{ reviewer: "maintainer", state: "changes_requested", body: "Needs a test." }],
      threads: [{ path: "src/a.ts", line: 9, isResolved: true, body: "Nit." }],
      comments: [],
    });

    expect(body).toContain("PR review · 1 review · 1 thread · 0 comments");
    expect(body).toContain("FAIL maintainer: Needs a test.");
    expect(body).toContain("resolved src/a.ts:9");
  });

  it("summarizes memory search results", () => {
    const body = formatMemorySearch({
      query: "deploy lag",
      scope: "project",
      status: "candidate",
      memories: [
        {
          id: "memory-1",
          status: "candidate",
          category: "pattern",
          importance: "high",
          content: "Service B can lag by ~90s after deploy.",
        },
      ],
    });

    expect(body).toContain("Memory · project · candidate · 1 match");
    expect(body).toContain("candidate/pattern/high memory-1");
    expect(body).toContain("Service B can lag");
  });

  it("formats Linear status as stable rows", () => {
    const body = formatLinearStatus({
      tokenStored: true,
      connected: false,
      viewerName: null,
      organizationName: null,
      checkedAt: "2026-05-20T07:34:36.379Z",
      authMode: "oauth",
      oauthAvailable: true,
      tokenExpiresAt: "2026-05-14T06:54:46.643Z",
    });

    expect(body).toContain("connected  no");
    expect(body).toContain("token      stored");
    expect(body).toContain("auth       oauth");
    expect(body).toContain("expires    2026-05-14 06:54");
    expect(body).not.toContain("\"connected\"");
  });
});
