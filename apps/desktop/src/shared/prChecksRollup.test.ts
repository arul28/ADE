import { describe, expect, it } from "vitest";
import { rollupChecks, rollupPrChecks, isCiProducerAppSlug, CI_PENDING_GRACE_MS } from "./prChecksRollup";
import type { ChecksRollupCheckRun, ChecksRollupInput } from "./prChecksRollup";
import { ADE_MAIN_REQUIRED_CONTEXTS, PR988_CHECK_RUNS } from "./__fixtures__/pr988CheckRuns";

function input(overrides: Partial<ChecksRollupInput> = {}): ChecksRollupInput {
  return {
    checkRuns: [],
    commitStatuses: [],
    requiredContexts: null,
    mergeStateBlocked: false,
    headCommitAgeMs: null,
    ...overrides,
  };
}

const actionsRun = (
  name: string,
  conclusion: string | null,
  status = "completed",
): ChecksRollupCheckRun => ({ name, status, conclusion, appSlug: "github-actions" });

describe("rollupChecks — ADE-135 regression", () => {
  it("does not report PR #988 as passing", () => {
    // The reported bug, verbatim: three third-party successes, zero Actions
    // runs, rendered as "CI passed · 3 jobs".
    const result = rollupChecks(input({ checkRuns: [...PR988_CHECK_RUNS] }));

    expect(result.status).not.toBe("passing");
    expect(result.status).toBe("not_run");
    expect(result.reason).toContain("none from a CI provider");
  });

  it("names the required check that never ran on #988", () => {
    // `main` requires `ci-pass`, and nothing on that head reported it.
    const result = rollupChecks(
      input({
        checkRuns: [...PR988_CHECK_RUNS],
        requiredContexts: [...ADE_MAIN_REQUIRED_CONTEXTS],
        headCommitAgeMs: 6 * 60 * 60 * 1000,
      }),
    );

    expect(result.status).not.toBe("passing");
    expect(result.missingRequiredContexts).toEqual(["ci-pass"]);
    expect(result.reason).toContain("ci-pass");
  });
});

describe("rollupChecks — skipped and neutral are not success", () => {
  it("does not go green when every CI check was skipped", () => {
    const result = rollupChecks(
      input({ checkRuns: [actionsRun("build", "skipped"), actionsRun("test", "skipped")] }),
    );

    expect(result.status).toBe("not_run");
    expect(result.reason).toContain("skipped");
  });

  it("does not go green on neutral alone", () => {
    const result = rollupChecks(input({ checkRuns: [actionsRun("lint", "neutral")] }));
    expect(result.status).not.toBe("passing");
  });

  it("still goes green when a skipped check sits beside a real pass", () => {
    // Skipping an irrelevant job is normal and must not block a genuine green.
    const result = rollupChecks(
      input({ checkRuns: [actionsRun("test", "success"), actionsRun("deploy", "skipped")] }),
    );

    expect(result.status).toBe("passing");
    expect(result.reason).toBeNull();
  });
});

describe("rollupChecks — producer awareness", () => {
  it("treats a legacy commit status as CI", () => {
    // Jenkins/Buildkite/CircleCI report this way and are genuinely CI.
    const result = rollupChecks(
      input({ commitStatuses: [{ context: "buildkite/build", state: "success" }] }),
    );

    expect(result.status).toBe("passing");
  });

  it("never lets a third-party app carry a green on its own", () => {
    const result = rollupChecks(
      input({ checkRuns: [{ name: "Vercel", status: "completed", conclusion: "success", appSlug: "vercel" }] }),
    );

    expect(result.status).toBe("not_run");
  });

  it("treats an unknown producer as non-CI rather than assuming the best", () => {
    const result = rollupChecks(
      input({ checkRuns: [{ name: "mystery", status: "completed", conclusion: "success", appSlug: null }] }),
    );

    expect(result.status).toBe("not_run");
  });

  it("excludes known non-CI apps and admits everything else", () => {
    expect(isCiProducerAppSlug("github-actions")).toBe(true);
    expect(isCiProducerAppSlug("GitHub-Actions")).toBe(true);
    expect(isCiProducerAppSlug("vercel")).toBe(false);
    expect(isCiProducerAppSlug(null)).toBe(false);
  });
});

describe("rollupChecks — required contexts", () => {
  it("holds back a green when a required context never reported", () => {
    const result = rollupChecks(
      input({
        checkRuns: [actionsRun("install", "success")],
        requiredContexts: ["install", "ci-pass"],
      }),
    );

    expect(result.status).toBe("pending");
    expect(result.missingRequiredContexts).toEqual(["ci-pass"]);
  });

  it("goes green once every required context has reported", () => {
    const result = rollupChecks(
      input({
        checkRuns: [actionsRun("install", "success"), actionsRun("ci-pass", "success")],
        requiredContexts: ["install", "ci-pass"],
      }),
    );

    expect(result.status).toBe("passing");
  });

  it("keeps required order rather than sorting", () => {
    const result = rollupChecks(
      input({
        requiredContexts: ["test-desktop (2)", "install", "test-desktop (1)"],
      }),
    );

    expect(result.missingRequiredContexts).toEqual([
      "test-desktop (2)",
      "install",
      "test-desktop (1)",
    ]);
  });

  it("reports a real failure ahead of a missing required check", () => {
    // The actionable fact is the red job, not the absent one.
    const result = rollupChecks(
      input({
        checkRuns: [actionsRun("test", "failure")],
        requiredContexts: ["ci-pass"],
      }),
    );

    expect(result.status).toBe("failing");
  });

  it("treats unreadable required contexts as unknown, not as none required", () => {
    // A restrictive token must not manufacture certainty in either direction.
    const result = rollupChecks(
      input({
        checkRuns: [actionsRun("test", "success")],
        requiredContexts: null,
      }),
    );

    expect(result.status).toBe("passing");
    expect(result.missingRequiredContexts).toEqual([]);
  });
});

describe("rollupChecks — quiet when nothing is expected", () => {
  it("stays `none` for a repo with no CI and no signal", () => {
    // Not every repo has CI; inventing a warning for them would be noise.
    expect(rollupChecks(input()).status).toBe("none");
  });

  it("escalates to not_run when GitHub says the merge is blocked", () => {
    const result = rollupChecks(input({ mergeStateBlocked: true }));

    expect(result.status).toBe("not_run");
    expect(result.reason).toContain("blocked");
  });

  it("never downgrades a genuine pass on mergeStateBlocked", () => {
    // `blocked` also means "needs review", so it must not touch a green.
    const result = rollupChecks(
      input({ checkRuns: [actionsRun("test", "success")], mergeStateBlocked: true }),
    );

    expect(result.status).toBe("passing");
  });
});

describe("rollupChecks — age-aware wording", () => {
  it("says CI has not run *yet* on a fresh commit", () => {
    const result = rollupChecks(
      input({
        checkRuns: [{ name: "Vercel", status: "completed", conclusion: "success", appSlug: "vercel" }],
        headCommitAgeMs: 30_000,
      }),
    );

    expect(result.reason).toContain("not run yet");
  });

  it("drops the hedge once the commit is old enough that CI should have started", () => {
    const result = rollupChecks(
      input({
        checkRuns: [{ name: "Vercel", status: "completed", conclusion: "success", appSlug: "vercel" }],
        headCommitAgeMs: CI_PENDING_GRACE_MS + 1,
      }),
    );

    expect(result.reason).toContain("not run on this commit");
    expect(result.reason).not.toContain("yet");
  });
});

describe("rollupChecks — in-flight", () => {
  it("reports pending while an Actions job is still running", () => {
    const result = rollupChecks(
      input({ checkRuns: [actionsRun("test", null, "in_progress"), actionsRun("install", "success")] }),
    );

    expect(result.status).toBe("pending");
  });
});

describe("rollupChecks — non-Actions CI providers (ADE-135 regression)", () => {
  it("does not mark a CircleCI repo permanently not-run", () => {
    // CircleCI, Buildkite, Azure Pipelines and Semaphore report through the
    // Checks API with their own app slugs, not the commit-status API. An
    // Actions-only allowlist marked every one of those repos unverified
    // forever — the original bug, pointing the other way.
    const result = rollupChecks(
      input({
        checkRuns: [
          { name: "ci/circleci: build", status: "completed", conclusion: "success", appSlug: "circleci-checks" },
        ],
      }),
    );

    expect(result.status).toBe("passing");
  });

  it("still refuses a green from a known preview/review bot", () => {
    const result = rollupChecks(
      input({
        checkRuns: [
          { name: "CodeRabbit", status: "completed", conclusion: "success", appSlug: "coderabbitai" },
          { name: "Vercel", status: "completed", conclusion: "success", appSlug: "vercel" },
        ],
      }),
    );

    expect(result.status).toBe("not_run");
  });

  it("accepts branch protection as proof regardless of producer", () => {
    // If every required context reported and passed, the commit was verified —
    // whichever app ran it. This is the safety net for CI we do not recognise.
    const result = rollupChecks(
      input({
        checkRuns: [
          { name: "custom-ci", status: "completed", conclusion: "success", appSlug: "some-unknown-enterprise-ci" },
        ],
        requiredContexts: ["custom-ci"],
      }),
    );

    expect(result.status).toBe("passing");
  });
});

describe("rollupChecks — in-flight statuses and fresh pushes", () => {
  it("treats waiting/requested/pending as in flight, not as terminal-unknown", () => {
    // A deployment-approval gate reports `waiting` with a null conclusion.
    // Coercing that to `completed` made it "unknown" and the PR read not-run.
    for (const status of ["waiting", "requested", "pending"]) {
      const result = rollupChecks(
        input({ checkRuns: [{ name: "deploy", status, conclusion: null, appSlug: "github-actions" }] }),
      );
      expect(result.status, status).toBe("pending");
    }
  });

  it("holds at pending inside the grace window after a fresh push", () => {
    // GitHub takes seconds to register a suite; calling that "CI has not run"
    // flashed a spurious card on every push.
    const result = rollupChecks(
      input({
        checkRuns: [{ name: "Vercel", status: "completed", conclusion: "success", appSlug: "vercel" }],
        headCommitAgeMs: 10_000,
      }),
    );

    expect(result.status).toBe("pending");
  });

  it("treats unknown commit age as stale so a finding is never hidden", () => {
    const result = rollupChecks(
      input({
        checkRuns: [{ name: "Vercel", status: "completed", conclusion: "success", appSlug: "vercel" }],
        headCommitAgeMs: null,
      }),
    );

    expect(result.status).toBe("not_run");
  });
});

describe("rollupChecks — ordering of the branch-protection override", () => {
  it("does not claim CI passed while another job is still running", () => {
    // A satisfied branch-protection gate outranks the producer guess, but not
    // in-flight work — GitHub itself says "some checks haven't completed yet".
    const result = rollupChecks(
      input({
        checkRuns: [
          { name: "ci-pass", status: "completed", conclusion: "success", appSlug: "github-actions" },
          { name: "e2e", status: "in_progress", conclusion: null, appSlug: "github-actions" },
        ],
        requiredContexts: ["ci-pass"],
      }),
    );

    expect(result.status).toBe("pending");
  });

  it("does not stick at pending when a conclusion arrives before the status flips", () => {
    // GitHub can report `status: "queued"` with `conclusion: "skipped"`.
    // Treating that as in-flight left the PR pending forever.
    const result = rollupChecks(
      input({
        checkRuns: [{ name: "build", status: "queued", conclusion: "skipped", appSlug: "github-actions" }],
        headCommitAgeMs: 10 * 60 * 1000,
      }),
    );

    expect(result.status).toBe("not_run");
  });
});

describe("rollupPrChecks — row-level rollup shared by CLI/TUI/toolbars", () => {
  it("refuses a green built only from third-party rows", () => {
    const result = rollupPrChecks([
      { status: "completed", conclusion: "success", appSlug: "coderabbitai" },
      { status: "completed", conclusion: "success", appSlug: "vercel" },
    ]);

    expect(result.status).toBe("not_run");
    expect(result.counts.passing).toBe(0);
    expect(result.counts.total).toBe(2);
  });

  it("reports none for zero checks rather than defaulting to passing", () => {
    // adeRpcServer initialised its verdict to "passing", so an empty list read
    // green on the surface agents consume.
    expect(rollupPrChecks([]).status).toBe("none");
  });

  it("does not count skipped as passing", () => {
    const result = rollupPrChecks([
      { status: "completed", conclusion: "skipped", appSlug: "github-actions" },
    ]);

    expect(result.status).toBe("not_run");
    expect(result.counts.skipped).toBe(1);
  });

  it("treats a slug-less legacy row as CI rather than reporting not-run", () => {
    // `appSlug` only started being populated in this change. Persisted rows,
    // older hosts and the TUI's action payloads all carry checks with no slug;
    // failing those closed would report "CI has not run" for every legacy
    // payload whose CI genuinely passed.
    const result = rollupPrChecks([{ status: "completed", conclusion: "success", appSlug: null }]);

    expect(result.status).toBe("passing");
  });

  it("counts a legacy commit status as CI", () => {
    const result = rollupPrChecks([
      { status: "completed", conclusion: "success", appSlug: "commit_status" },
    ]);

    expect(result.status).toBe("passing");
  });
});
