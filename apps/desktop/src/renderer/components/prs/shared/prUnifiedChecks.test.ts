import { describe, expect, it } from "vitest";

import type { PrActionRun, PrCheck } from "../../../../shared/types";
import {
  buildUnifiedChecks,
  findUnifiedCheckId,
  formatCheckDuration,
  unifiedChecksToPrChecks,
} from "./prUnifiedChecks";

function makeRun(overrides: Partial<PrActionRun> = {}): PrActionRun {
  return {
    id: 1,
    name: "CI",
    status: "completed",
    conclusion: "success",
    headSha: "deadbeef",
    htmlUrl: "https://github.com/acme/repo/actions/runs/1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    jobs: [],
    ...overrides,
  };
}

function makeCheck(overrides: Partial<PrCheck> = {}): PrCheck {
  return {
    name: "CI / build",
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("buildUnifiedChecks", () => {
  it("dedupes runs with the same workflow name, keeping the latest by createdAt", () => {
    const older = makeRun({
      id: 1,
      name: "CI",
      createdAt: "2026-01-01T00:00:00.000Z",
      jobs: [
        { id: 10, name: "build", status: "completed", conclusion: "failure", startedAt: null, completedAt: null, steps: [] },
      ],
    });
    const newer = makeRun({
      id: 2,
      name: "CI",
      createdAt: "2026-01-02T00:00:00.000Z",
      jobs: [
        { id: 20, name: "build", status: "completed", conclusion: "success", startedAt: null, completedAt: null, steps: [] },
      ],
    });

    const items = buildUnifiedChecks([], [older, newer]);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("job-20");
    expect(items[0]!.conclusion).toBe("success");
  });

  it("does not double-list a check that maps to an actions job (by job id)", () => {
    const run = makeRun({
      jobs: [
        { id: 99, name: "build", status: "completed", conclusion: "success", startedAt: null, completedAt: null, steps: [] },
      ],
    });
    const matchingCheck = makeCheck({
      name: "build",
      detailsUrl: "https://github.com/acme/repo/actions/runs/1/job/99",
    });

    const items = buildUnifiedChecks([matchingCheck], [run]);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe("actions_job");
  });

  it("keeps an external (non-actions) check that does not map to any job", () => {
    const run = makeRun({
      jobs: [
        { id: 1, name: "build", status: "completed", conclusion: "success", startedAt: null, completedAt: null, steps: [] },
      ],
    });
    const externalCheck = makeCheck({
      name: "vercel/preview",
      detailsUrl: "https://vercel.com/preview/abc",
    });

    const items = buildUnifiedChecks([externalCheck], [run]);
    expect(items.map((i) => i.source).sort()).toEqual(["actions_job", "check"]);
  });

  it("sorts so failing checks come first, then in_progress, then completed-success — and stable-by-name within tier", () => {
    const items = buildUnifiedChecks(
      [
        makeCheck({ name: "zzz-pass", status: "completed", conclusion: "success" }),
        makeCheck({ name: "aaa-pass", status: "completed", conclusion: "success" }),
        makeCheck({ name: "running", status: "in_progress", conclusion: null }),
        makeCheck({ name: "broken", status: "completed", conclusion: "failure" }),
      ],
      [],
    );

    expect(items.map((i) => i.name)).toEqual(["broken", "running", "aaa-pass", "zzz-pass"]);
  });
});

describe("findUnifiedCheckId", () => {
  it("resolves a check to its actions job id when the details URL has a job id", () => {
    const run = makeRun({
      jobs: [
        { id: 42, name: "lint", status: "completed", conclusion: "success", startedAt: null, completedAt: null, steps: [] },
      ],
    });
    const checks = [
      makeCheck({ name: "lint", detailsUrl: "https://github.com/acme/repo/actions/runs/1/job/42" }),
    ];
    expect(findUnifiedCheckId(checks[0]!, checks, [run])).toBe("job-42");
  });

  it("falls back to check id when nothing matches", () => {
    const orphan = makeCheck({ name: "external-only" });
    expect(findUnifiedCheckId(orphan, [orphan], [])).toBe("check-external-only");
  });
});

describe("formatCheckDuration / unifiedChecksToPrChecks", () => {
  it("formats sub-minute durations as seconds and longer ones as 'm s'", () => {
    expect(formatCheckDuration(45)).toBe("45s");
    expect(formatCheckDuration(60)).toBe("1m");
    expect(formatCheckDuration(125)).toBe("2m 5s");
  });

  it("projects unified items back to PrCheck-compatible rows with normalized statuses", () => {
    const run = makeRun({
      jobs: [
        { id: 1, name: "test", status: "completed", conclusion: "success", startedAt: null, completedAt: null, steps: [] },
      ],
    });

    const projected = unifiedChecksToPrChecks([], [run]);
    expect(projected).toHaveLength(1);
    expect(projected[0]!.name).toBe("CI / test");
    expect(projected[0]!.status).toBe("completed");
    expect(projected[0]!.conclusion).toBe("success");
  });
});
