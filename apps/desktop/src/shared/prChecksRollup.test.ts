import { describe, expect, it } from "vitest";
import { rollupChecks, isCiProducerAppSlug, CI_PENDING_GRACE_MS } from "./prChecksRollup";
import type { ChecksRollupCheckRun, ChecksRollupInput } from "./prChecksRollup";
import { ADE_MAIN_REQUIRED_CONTEXTS, PR988_CHECK_RUNS } from "./__fixtures__/pr988CheckRuns";

function input(overrides: Partial<ChecksRollupInput> = {}): ChecksRollupInput {
  return {
    checkRuns: [],
    commitStatuses: [],
    requiredContexts: null,
    requiredSource: "unavailable",
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
        requiredSource: "rulesets",
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

  it("recognizes only github-actions as a CI app slug", () => {
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
        requiredSource: "rulesets",
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
        requiredSource: "rulesets",
      }),
    );

    expect(result.status).toBe("passing");
  });

  it("keeps required order rather than sorting", () => {
    const result = rollupChecks(
      input({
        requiredContexts: ["test-desktop (2)", "install", "test-desktop (1)"],
        requiredSource: "rulesets",
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
        requiredSource: "rulesets",
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
        requiredSource: "unavailable",
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
