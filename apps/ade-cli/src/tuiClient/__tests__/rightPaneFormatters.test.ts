import { describe, expect, it } from "vitest";
import {
  derivePrMergeReadiness,
  formatLinearStatus,
  formatPrChecks,
  formatPrComments,
  formatPrMergeState,
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

  it("renders a detached PR's lane as history, not as a live mapping", () => {
    const body = formatPrSummary({
      id: "pr-9",
      number: 9,
      title: "Merged work",
      state: "merged",
      laneId: "lane-deleted-uuid",
      detached: { at: "2026-07-30T00:00:00Z", laneName: "prs-tab", laneColor: null },
    });

    expect(body).toContain("was prs-tab");
    expect(body).not.toContain("lane-deleted-uuid");
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
      adeUrl: "https://ade-app.dev/open?type=pr&repo=acme%2Fade&number=42",
    });

    expect(body).toContain("#42 · open");
    expect(body).toContain("github   https://github.com/acme/ade/pull/42");
    expect(body).toContain("ade      https://ade-app.dev/open?type=pr&repo=acme%2Fade&number=42");
    expect(body).toContain("web      https://app.ade-app.dev/open?type=pr&repo=acme%2Fade&number=42");
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
    expect(body).toContain("ade      https://ade-app.dev/open?type=pr&repo=acme%2Fade&number=7");
    expect(body).toContain("web      https://app.ade-app.dev/open?type=pr&repo=acme%2Fade&number=7");
  });

  it("renders a Ready merge block when GitHub merge state is clean", () => {
    const body = formatPrMergeState({
      mergeStateStatus: "clean",
      reviewDecision: "approved",
      isMergeable: true,
      mergeConflicts: false,
      behindBaseBy: 0,
    });

    expect(body).toContain("Merge · Ready");
    expect(body).toContain("✓ all requirements met");
  });

  it("lists the GitHub merge blockers in priority order", () => {
    const readiness = derivePrMergeReadiness({
      mergeStateStatus: "blocked",
      reviewDecision: "review_required",
      approvalsCount: 0,
      requiredApprovals: 1,
      behindBaseBy: 3,
      mergeConflicts: false,
      canBypass: true,
    });

    expect(readiness.headline).toBe("Blocked");
    expect(readiness.ready).toBe(false);
    expect(readiness.canBypass).toBe(true);
    expect(readiness.blockers).toEqual([
      "review required (0/1 approved)",
      "3 commits behind base",
    ]);
  });

  it("treats `unstable` as mergeable (non-required checks failing is not a blocker)", () => {
    const readiness = derivePrMergeReadiness({
      mergeStateStatus: "unstable",
      reviewDecision: "approved",
      approvalsCount: 1,
      requiredApprovals: 1,
      behindBaseBy: 0,
      mergeConflicts: false,
      canBypass: false,
    });

    expect(readiness.blockers).not.toContain("required checks failing");
    expect(readiness.ready).toBe(true);
    expect(readiness.headline).not.toBe("Blocked");
  });

  it("treats a mergeable PR that is behind base as Ready, not Blocked (info-only)", () => {
    const readiness = derivePrMergeReadiness({
      mergeStateStatus: "clean",
      reviewDecision: "approved",
      approvalsCount: 1,
      requiredApprovals: 1,
      behindBaseBy: 3,
      mergeConflicts: false,
      canBypass: false,
    });

    expect(readiness.blockers).not.toContain("3 commits behind base");
    expect(readiness.headline).toBe("Ready");
    expect(readiness.ready).toBe(true);
  });

  it("flags conflicts and surfaces the bypass hint when the viewer can override", () => {
    const body = formatPrMergeState({
      status: {
        mergeStateStatus: "dirty",
        mergeConflicts: true,
        canBypass: true,
      },
    });

    expect(body).toContain("Merge · Conflicts");
    expect(body).toContain("✗ merge conflicts");
    expect(body).toContain("/pr land confirm <method> bypass");
  });

  it("reports a Checking state while GitHub computes mergeability", () => {
    const readiness = derivePrMergeReadiness({
      mergeStateStatus: "unknown",
      mergeabilityComputing: true,
    });

    expect(readiness.headline).toBe("Checking…");
    expect(readiness.computing).toBe(true);
    expect(readiness.ready).toBe(false);
  });

  it("falls back to legacy conflict/behind fields for older runtimes", () => {
    const readiness = derivePrMergeReadiness({
      mergeConflicts: true,
      behindBaseBy: 2,
    });

    expect(readiness.headline).toBe("Conflicts");
    expect(readiness.blockers).toContain("2 commits behind base");
    expect(readiness.blockers).toContain("merge conflicts");
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

  // ADE-135: three third-party successes and no CI producer used to summarize
  // as "3 passing". The rollup's verdict outranks the row count.
  it("renders a not-run rollup honestly even when every row is green", () => {
    const body = formatPrChecks({
      checksStatus: "not_run",
      checksReason: "3 checks reported, none from a CI provider. CI has not run on this commit.",
      checks: [
        { name: "CodeRabbit", status: "completed", conclusion: "success" },
        { name: "Vercel — Preview", status: "completed", conclusion: "success" },
        { name: "changeset-bot", status: "completed", conclusion: "success" },
      ],
    });

    expect(body).toContain("CI: not run");
    expect(body).not.toContain("3 passing");
  });

  it("reports a fully skipped suite as not run", () => {
    const body = formatPrChecks([
      { name: "ci / unit", status: "completed", conclusion: "skipped" },
    ]);

    expect(body).toContain("CI: not run");
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
    expect(
      formatPrComments({ summary: { checksStatus: "not_run", actionableComments: 0 } }),
    ).toContain("CI: not run");
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
