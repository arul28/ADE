/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CodexGoalCard } from "./CodexGoalCard";

afterEach(() => cleanup());

describe("CodexGoalCard", () => {
  it("renders nothing when objective is blank", () => {
    const { container } = render(
      <CodexGoalCard
        goal={{ objective: "", status: "active" }}
        onEdit={() => undefined}
        onClear={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders objective, status label, and tokens used when no budget is set", () => {
    render(
      <CodexGoalCard
        goal={{ objective: "Refactor auth", status: "active", tokensUsed: 12345 }}
      />,
    );
    expect(screen.getByText("Refactor auth")).toBeTruthy();
    expect(screen.getByText(/^active$/i)).toBeTruthy();
    expect(screen.getByText(/12\.3k/)).toBeTruthy();
  });

  it("ignores provider token budgets and only shows tokens used", () => {
    render(
      <CodexGoalCard
        goal={{
          objective: "Ship onboarding refresh",
          status: "active",
          tokensUsed: 250_000,
          tokenBudget: 1_000_000,
        }}
      />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText(/250\.0k/)).toBeTruthy();
    expect(screen.queryByText(/1\.0M/)).toBeNull();
  });

  it("submits an edited objective via onEdit when the user presses Enter", () => {
    const onEdit = vi.fn();
    render(
      <CodexGoalCard
        goal={{ objective: "Refactor auth middleware", status: "active" }}
        onEdit={onEdit}
        onClear={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText("Refactor auth middleware"));
    const textarea = screen.getByLabelText("Edit goal objective") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Refactor auth for compliance" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onEdit).toHaveBeenCalledWith("Refactor auth for compliance");
  });

  it("limits edits to the Codex goal objective maximum", () => {
    render(
      <CodexGoalCard
        goal={{ objective: "Refactor auth middleware", status: "active" }}
        onEdit={() => undefined}
        onClear={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText("Refactor auth middleware"));
    const textarea = screen.getByLabelText("Edit goal objective") as HTMLTextAreaElement;
    expect(textarea.maxLength).toBe(4000);
  });

  it("disables goal controls while a mutation is pending", () => {
    const onEdit = vi.fn();
    const onClear = vi.fn();
    render(
      <CodexGoalCard
        goal={{ objective: "Refactor auth", status: "active" }}
        onEdit={onEdit}
        onClear={onClear}
        pending
      />,
    );

    expect(screen.getByText(/^updating$/i)).toBeTruthy();
    expect(screen.getByText("Refactor auth").closest("button")?.hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Edit goal").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText("Clear goal"));
    expect(onClear).not.toHaveBeenCalled();
  });

  it("does not invoke onEdit when Escape cancels the edit", () => {
    const onEdit = vi.fn();
    render(
      <CodexGoalCard
        goal={{ objective: "Refactor auth", status: "active" }}
        onEdit={onEdit}
        onClear={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText("Refactor auth"));
    const textarea = screen.getByLabelText("Edit goal objective");
    fireEvent.change(textarea, { target: { value: "Discarded change" } });
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onEdit).not.toHaveBeenCalled();
  });

  it("invokes onClear when the clear button is pressed", () => {
    const onClear = vi.fn();
    render(
      <CodexGoalCard
        goal={{ objective: "Refactor auth", status: "active" }}
        onClear={onClear}
      />,
    );
    fireEvent.click(screen.getByLabelText("Clear goal"));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("disables editing when onEdit is not provided (read-only card)", () => {
    render(
      <CodexGoalCard
        goal={{ objective: "Read-only goal", status: "active" }}
      />,
    );
    expect(screen.queryByLabelText("Edit goal")).toBeNull();
    const button = screen.getByText("Read-only goal").closest("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
  });

  it("shows provider budget-limited goals as active", () => {
    render(
      <CodexGoalCard
        goal={{ objective: "Finish verification", status: "budget_limited", tokensUsed: 9, tokenBudget: 10 }}
      />,
    );
    expect(screen.getByText(/^active$/i)).toBeTruthy();
    expect(screen.queryByText(/budget/i)).toBeNull();
  });

  it("labels provider usage limits without debug wording", () => {
    render(
      <CodexGoalCard
        goal={{ objective: "Wait for reset", status: "usage_limited" }}
      />,
    );
    expect(screen.getByText(/^usage paused$/i)).toBeTruthy();
  });
});
