import { describe, expect, it } from "vitest";
import {
  CURSOR_CLOUD_PANE_NOTE,
  derivePrMergeReadiness,
  formatCursorCloudFleetRows,
  formatLinearStatus,
  formatPrChecks,
  formatPrComments,
  formatPrMergeState,
  formatPrReview,
  formatPrSummary,
  formatSystemDetails,
} from "../rightPaneFormatters";
import type { CursorCloudFleetEntry } from "../../../../desktop/src/shared/types/config";

function fleetEntry(args: {
  agentId: string;
  name: string;
  status?: "running" | "finished" | "error";
  runStatus?: "running" | "finished" | "error";
  createdAt?: number | null;
  lastModified?: number | null;
}): CursorCloudFleetEntry {
  const { agentId, name, status, runStatus, createdAt, lastModified } = args;
  return {
    agent: {
      agentId,
      name,
      summary: "",
      ...(status !== undefined ? { status } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(lastModified !== undefined ? { lastModified } : {}),
    },
    latestRunId: null,
    branch: null,
    prUrl: null,
    modelId: null,
    ownership: { sessionId: null, sessionTitle: null, laneId: null, laneName: null, linearIssueId: null },
    matchedBy: "repo",
    ...(runStatus !== undefined ? { runStatus } : {}),
  };
}

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

  // ADE-135: `/pr` leads with this summary, so the rollup has to be visible
  // here — otherwise the reader's only checks signal is the row table, which is
  // exactly what read green while nothing verified the commit.
  it("surfaces the checks rollup and its reason in the PR summary", () => {
    const body = formatPrSummary({
      id: "pr-988",
      number: 988,
      title: "Ship the thing",
      state: "open",
      checksStatus: "not_run",
      checksReason: "3 checks reported, none from a CI provider. CI has not run on this commit.",
    });

    expect(body).toContain("checks    not run");
    expect(body).toContain("none from a CI provider");
    expect(body).not.toContain("not_run");
  });

  it("prints no lane row for a PR whose lane is gone", () => {
    const body = formatPrSummary({
      id: "pr-9",
      number: 9,
      title: "Merged work",
      state: "merged",
      laneId: "lane-deleted-uuid",
      detached: { at: "2026-07-30T00:00:00Z", laneName: "prs-tab", laneColor: null },
    });

    // The worktree is gone, so there is nothing to point at — and the dangling
    // id must not be printed as if it were a live one.
    expect(body).not.toMatch(/^lane /m);
    expect(body).not.toContain("lane-deleted-uuid");
    expect(body).not.toContain("prs-tab");
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

  it("refuses a green from third-party rows when the payload carries no rollup", () => {
    // The production call site is `conn.actionList("pr","getChecks")`, which
    // returns a BARE ARRAY — so the `checksStatus` field the test above relies
    // on is always absent there. The row tally itself has to be producer-aware
    // or the TUI prints "3 passing" for a commit nothing verified.
    const body = formatPrChecks([
      { name: "CodeRabbit", status: "completed", conclusion: "success", appSlug: "coderabbitai" },
      { name: "Vercel", status: "completed", conclusion: "success", appSlug: "vercel" },
      { name: "Vercel Preview Comments", status: "completed", conclusion: "success", appSlug: "vercel" },
    ]);

    expect(body).toContain("CI: not run");
    expect(body).not.toContain("3 passing");
    expect(body).toContain("PR checks");
  });

  it("still reports real CI as passing from a bare array", () => {
    // The guard against over-correcting: a genuine Actions run must stay green
    // on the same bare-array path.
    const body = formatPrChecks([
      { name: "ci-pass", status: "completed", conclusion: "success", appSlug: "github-actions" },
    ]);

    expect(body).toContain("1 passing");
    expect(body).not.toContain("CI: not run");
  });

  it("reports a fully skipped suite as not run", () => {
    const body = formatPrChecks([
      { name: "ci / unit", status: "completed", conclusion: "skipped" },
    ]);

    expect(body).toContain("CI: not run");
  });

  it("shows a failed checks read as a failure, not as an empty suite", () => {
    // `prService.getChecks` now REJECTS when neither checks source could be
    // read, and `/pr checks` catches that into `{ error }`. Rendering that as
    // "No PR checks." would tell the reader the commit ran nothing — the same
    // false all-clear the host-side change exists to stop.
    const body = formatPrChecks({ error: "GitHub API rate limit exceeded" });

    expect(body).toContain("could not be read");
    expect(body).toContain("GitHub API rate limit exceeded");
    expect(body).not.toContain("No PR checks.");
  });

  it("shows a failed comments read as a failure", () => {
    const body = formatPrComments({ error: "fetch failed" });

    expect(body).toContain("could not be read");
    expect(body).toContain("fetch failed");
    expect(body).not.toContain("No actionable PR comments.");
  });

  it("names the sources that failed in a partial PR review read", () => {
    // `/pr review` fires three reads and catches each independently, so a
    // partial outage is the common case. The sources that answered still
    // render; the ones that did not must not report a count of zero.
    const body = formatPrReview({
      reviews: [{ state: "approved", reviewer: "octocat" }],
      threads: { error: "GitHub is unavailable" },
      comments: { error: "GitHub is unavailable" },
    });

    expect(body).toContain("1 review");
    expect(body).toContain("threads unavailable");
    expect(body).toContain("comments unavailable");
    expect(body).toContain("GitHub is unavailable");
    expect(body).not.toContain("0 threads");
    expect(body).not.toContain("No PR reviews or comments.");
  });

  it("keeps the empty verdict when every PR review read succeeded", () => {
    const body = formatPrReview({ reviews: [], threads: [], comments: [] });

    expect(body).toContain("No PR reviews or comments.");
    expect(body).not.toContain("could not be read");
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

  it("names a failed review-thread read instead of reporting nothing to action", () => {
    // The aggregate preserves a thread-read failure rather than flattening it
    // to `[]`. Rendering that as "No actionable PR comments." tells an agent a
    // PR is clean on the strength of a read that never happened.
    const body = formatPrComments({
      summary: { checksStatus: "passing", actionableComments: 0 },
      reviewThreads: [],
      comments: [],
      reviewThreadsUnavailable: "GitHub API request failed (HTTP 503)",
    });

    expect(body).toContain("Could not be read");
    expect(body).toContain("review threads: GitHub API request failed (HTTP 503)");
    expect(body).not.toContain("No actionable PR comments.");
  });

  it("still reports a genuinely empty comment set as empty", () => {
    const body = formatPrComments({
      summary: { checksStatus: "passing", actionableComments: 0 },
      reviewThreads: [],
      comments: [],
    });

    expect(body).toContain("No actionable PR comments.");
    expect(body).not.toContain("Could not be read");
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

  it("formats fleet rows as glyph · name · status · age, newest first", () => {
    const now = Date.parse("2026-08-24T12:00:00Z");
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const rows = formatCursorCloudFleetRows([
        fleetEntry({ agentId: "agent-old", name: "old run", createdAt: now - 3 * 60 * 60 * 1000 }),
        fleetEntry({ agentId: "agent-new", name: "new run", createdAt: now - 5 * 60 * 1000 }),
      ]);
      expect(rows[0]).toBe("○ new run · queued · 5m");
      expect(rows[1]).toBe("○ old run · queued · 3h");
    } finally {
      Date.now = originalNow;
    }
  });

  it("orders running cloud agents ahead of finished ones and marks their status", () => {
    const now = Date.now();
    const rows = formatCursorCloudFleetRows([
      fleetEntry({
        agentId: "agent-done",
        name: "done run",
        status: "finished",
        createdAt: now - 60 * 1000,
        runStatus: "finished",
      }),
      fleetEntry({
        agentId: "agent-live",
        name: "live run",
        status: "running",
        createdAt: now - 10 * 60 * 60 * 1000,
        runStatus: "running",
      }),
      fleetEntry({
        agentId: "agent-broke",
        name: "broke run",
        status: "error",
        createdAt: now - 2 * 60 * 1000,
        runStatus: "error",
      }),
    ]);

    expect(rows.map((row) => row.slice(0, 1))).toEqual(["●", "✓", "✗"]);
    expect(rows[0]).toContain("live run · running");
    expect(rows[1]).toContain("done run · finished · 1m");
    expect(rows[2]).toContain("broke run · error · 2m");
  });

  it("appends the agent id only when the row fits the pane budget", () => {
    const shortRows = formatCursorCloudFleetRows([
      fleetEntry({ agentId: "abcdefghij", name: "tiny" }),
    ]);
    expect(shortRows[0]).toBe("○ tiny · queued · abcdefghij");

    const longRows = formatCursorCloudFleetRows([
      fleetEntry({ agentId: "abcdefghij", name: "a very long agent name that fills the row" }),
    ]);
    expect(longRows[0].endsWith("abcdefghij")).toBe(false);
  });

  it("falls back to lastModified for age when createdAt is missing", () => {
    const now = Date.parse("2026-08-24T12:00:00Z");
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const rows = formatCursorCloudFleetRows([
        fleetEntry({ agentId: "agent-m", name: "modified only", lastModified: now - 2 * 60 * 1000 }),
      ]);
      expect(rows[0]).toBe("○ modified only · queued · 2m");
    } finally {
      Date.now = originalNow;
    }
  });

  it("keeps the management note pointing at desktop/iOS", () => {
    expect(CURSOR_CLOUD_PANE_NOTE).toContain("desktop or iOS");
  });
});
