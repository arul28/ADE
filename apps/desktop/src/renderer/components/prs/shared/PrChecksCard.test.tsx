// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { PrCheck } from "../../../../shared/types/prs";
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
});
