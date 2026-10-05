/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  it("shows the condition and Claude's last check, with no controls when it cannot change the goal", () => {
    render(<GoalCard variant="claude" goal={claudeGoal()} />);
    expect(screen.getByText("all tests pass")).toBeTruthy();
    expect(screen.getByText(/2 tests still failing/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("saves an edit normalized to one line, and Escape discards it", () => {
    const onEdit = vi.fn();
    render(<GoalCard variant="claude" goal={claudeGoal()} onEdit={onEdit} onClear={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit goal" }));
    const editor = screen.getByRole("textbox", { name: "Edit goal" });
    fireEvent.change(editor, { target: { value: "  all tests\npass and PR merged " } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith("all tests pass and PR merged");

    fireEvent.click(screen.getByRole("button", { name: "Edit goal" }));
    const second = screen.getByRole("textbox", { name: "Edit goal" });
    fireEvent.change(second, { target: { value: "something else" } });
    fireEvent.keyDown(second, { key: "Escape" });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "Edit goal" })).toBeNull();
  });

  it("clears on request, and holds both controls while a turn is running", () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <GoalCard variant="claude" goal={claudeGoal()} onEdit={vi.fn()} onClear={onClear} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
    expect(onClear).toHaveBeenCalledTimes(1);

    rerender(<GoalCard variant="claude" goal={claudeGoal()} onEdit={vi.fn()} onClear={onClear} locked />);
    const edit = screen.getByRole("button", { name: "Edit goal" }) as HTMLButtonElement;
    const clear = screen.getByRole("button", { name: "Clear goal" }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(clear.disabled).toBe(true);
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when the condition is blank", () => {
    const { container } = render(<GoalCard variant="claude" goal={claudeGoal({ condition: "   " })} />);
    expect(container.firstChild).toBeNull();
  });
});
