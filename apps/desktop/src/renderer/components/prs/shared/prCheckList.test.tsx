// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { PrCheck } from "../../../../shared/types/prs";
import { PrCheckList } from "./prCheckList";

afterEach(cleanup);

function makeCheck(overrides: Partial<PrCheck> = {}): PrCheck {
  return {
    name: "CI / build",
    status: "completed",
    conclusion: "success",
    detailsUrl: "https://github.com/example/repo/actions/runs/1/job/2",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("PrCheckList", () => {
  it("navigates to a specific check when a row is clicked", () => {
    const onSelectCheck = vi.fn();
    const check = makeCheck();
    render(
      <PrCheckList
        checks={[check]}
        onOpenLog={() => {}}
        onSelectCheck={onSelectCheck}
      />,
    );

    fireEvent.click(screen.getByTestId("pr-status-rail-check-row"));
    expect(onSelectCheck).toHaveBeenCalledWith(check);
  });

  it("opens logs externally without selecting the check row", () => {
    const onSelectCheck = vi.fn();
    const onOpenLog = vi.fn();
    const check = makeCheck({ name: "lint" });
    render(
      <PrCheckList
        checks={[check]}
        onOpenLog={onOpenLog}
        onSelectCheck={onSelectCheck}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /View logs for lint/i }));
    expect(onOpenLog).toHaveBeenCalledWith(check);
    expect(onSelectCheck).not.toHaveBeenCalled();
  });

  it("opens the checks tab when a section header is clicked", () => {
    const onOpenChecksTab = vi.fn();
    render(
      <PrCheckList
        checks={[makeCheck({ name: "unit tests" })]}
        onOpenLog={() => {}}
        onOpenChecksTab={onOpenChecksTab}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "CI" }));
    expect(onOpenChecksTab).toHaveBeenCalledTimes(1);
  });
});
