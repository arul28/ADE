/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ClaudeActiveGoal } from "../../../shared/types";
import { GoalCard } from "./GoalCard";

afterEach(cleanup);

const claudeGoal = (overrides: Partial<ClaudeActiveGoal> = {}): ClaudeActiveGoal => ({
  condition: "all tests pass",
  iterations: 4,
  setAt: 1_700_000_000_000,
  tokensAtStart: 12_000,
  lastReason: "2 tests still failing",
  updatedAt: 1_700_000_400_000,
  ...overrides,
});

describe("GoalCard (claude variant)", () => {
  it("renders the condition, iteration count, last reason, and the /goal hint read-only", () => {
    render(<GoalCard variant="claude" goal={claudeGoal()} />);
    expect(screen.getByText("all tests pass")).toBeTruthy();
    expect(screen.getByText("iteration 4")).toBeTruthy();
    expect(screen.getByText(/2 tests still failing/)).toBeTruthy();
    expect(screen.getByText("/goal")).toBeTruthy();
    // Read-only: no edit/clear/status buttons like the Codex variant.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("omits the last-reason line when there is no reason yet", () => {
    render(<GoalCard variant="claude" goal={claudeGoal({ lastReason: undefined })} />);
    expect(screen.queryByText(/last:/)).toBeNull();
  });

  it("renders nothing when the condition is blank", () => {
    const { container } = render(<GoalCard variant="claude" goal={claudeGoal({ condition: "   " })} />);
    expect(container.firstChild).toBeNull();
  });
});
