// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { PrActionRun, PrCheck } from "../../../../shared/types/prs";
import { PrChecksCard } from "./PrChecksCard";

afterEach(cleanup);

function check(overrides: Partial<PrCheck> & Pick<PrCheck, "name">): PrCheck {
  return {
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

// Attention rows render only the check name as text (the action buttons are
// icon-only and durations are omitted when start/complete are null), so the
// row's text content is the displayName.
function rowNames(): string[] {
  return screen
    .queryAllByTestId("pr-checks-card-row")
    .map((row) => (row.textContent ?? "").trim());
}

describe("PrChecksCard summary + bucketing", () => {
  it("renders an empty state with no rows when there are no checks", () => {
    render(<PrChecksCard checks={[]} actionRuns={[]} />);
    expect(screen.getByTestId("pr-checks-card").textContent).toContain("No checks yet");
    expect(screen.queryAllByTestId("pr-checks-card-row")).toHaveLength(0);
  });

  it("counts passed over the full total and surfaces only failing + pending rows", () => {
    render(
      <PrChecksCard
        checks={[
          check({ name: "build", conclusion: "success" }),
          check({ name: "lint", conclusion: "success" }),
          check({ name: "e2e", conclusion: "failure" }),
          check({ name: "deploy", status: "in_progress", conclusion: null }),
        ]}
        actionRuns={[]}
      />,
    );
    // 2 of 4 passed (the failure + the in-progress are not "passed").
    expect(screen.getByTestId("pr-checks-card").textContent).toContain("2/4 passed");
    // Attention list shows the failing + pending checks, never the passing ones.
    const names = rowNames();
    expect(names).toContain("e2e");
    expect(names).toContain("deploy");
    expect(names).not.toContain("build");
    expect(names).not.toContain("lint");
  });

  it("treats a completed check with a null conclusion as needs-attention (not silently hidden)", () => {
    render(
      <PrChecksCard
        checks={[
          check({ name: "pass", conclusion: "success" }),
          check({ name: "stuck", status: "completed", conclusion: null }),
        ]}
        actionRuns={[]}
      />,
    );
    // The null-conclusion completed check counts against "passed" …
    expect(screen.getByTestId("pr-checks-card").textContent).toContain("1/2 passed");
    // … and is surfaced in the attention list rather than dropped.
    expect(rowNames()).toContain("stuck");
  });

  it("lists every check in fill mode so the right rail's growth target is never an empty stretch", () => {
    render(
      <PrChecksCard
        fill
        checks={[
          check({ name: "build", conclusion: "success" }),
          check({ name: "lint", conclusion: "success" }),
          check({ name: "e2e", conclusion: "failure" }),
        ]}
        actionRuns={[]}
      />,
    );
    // Failing first (buildUnifiedChecks already orders failure → running → done).
    expect(rowNames()).toEqual(["e2e", "build", "lint"]);
  });

  it("buckets neutral/skipped as skip — counted in total but excluded from the attention list", () => {
    render(
      <PrChecksCard
        checks={[
          check({ name: "pass", conclusion: "success" }),
          check({ name: "neutral-check", status: "completed", conclusion: "neutral" }),
          check({ name: "skipped-check", status: "completed", conclusion: "skipped" }),
        ]}
        actionRuns={[]}
      />,
    );
    // Skipped/neutral are part of the denominator but are not "passed" …
    expect(screen.getByTestId("pr-checks-card").textContent).toContain("1/3 passed");
    // … and they do not appear in the needs-attention rows.
    expect(screen.queryAllByTestId("pr-checks-card-row")).toHaveLength(0);
  });

  it("re-runs the selected check when its check-run id is available", () => {
    const onRerunChecks = vi.fn();
    render(
      <PrChecksCard
        checks={[check({ id: 42, name: "e2e", conclusion: "failure" })]}
        actionRuns={[]}
        onRerunChecks={onRerunChecks}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-run e2e" }));
    expect(onRerunChecks).toHaveBeenCalledWith({ checkRunIds: [42] });
  });

  it("re-runs an Actions job with its job id instead of its backing check-run id", () => {
    const onRerunChecks = vi.fn();
    const actionRun: PrActionRun = {
      id: 7,
      name: "CI",
      status: "completed",
      conclusion: "failure",
      headSha: "abc123",
      htmlUrl: "https://github.com/ade-dev/ade/actions/runs/7",
      createdAt: "2026-07-27T11:55:00.000Z",
      updatedAt: "2026-07-27T11:59:00.000Z",
      jobs: [{
        id: 77,
        checkRunId: 88,
        name: "e2e",
        status: "completed",
        conclusion: "failure",
        startedAt: null,
        completedAt: null,
        steps: [],
      }],
    };
    render(
      <PrChecksCard
        checks={[]}
        actionRuns={[actionRun]}
        onRerunChecks={onRerunChecks}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-run CI / e2e" }));
    expect(onRerunChecks).toHaveBeenCalledWith({ actionJobIds: [77] });
  });

  // ADE-135: a required job that never reported is the finding. It has to be
  // visible in the same list as the results that did arrive, in GitHub's order.
  it("renders missing required contexts as ghost rows ahead of real checks", () => {
    render(
      <PrChecksCard
        checks={[check({ name: "e2e", conclusion: "failure" })]}
        actionRuns={[]}
        missingRequired={["CI / build", "CI / lint"]}
      />,
    );

    const ghosts = screen.getAllByTestId("pr-checks-card-ghost-row");
    expect(ghosts.map((row) => (row.textContent ?? "").trim())).toEqual([
      "CI / buildrequired · not reported",
      "CI / lintrequired · not reported",
    ]);
    expect(rowNames()).toEqual(["e2e"]);
  });

  it("renders ghost rows even when nothing at all reported", () => {
    render(<PrChecksCard checks={[]} actionRuns={[]} missingRequired={["CI / build"]} />);
    expect(screen.getAllByTestId("pr-checks-card-ghost-row")).toHaveLength(1);
  });
});
