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

  it("renders a filled progress bar and tokens used/budget when budget is set", () => {
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
    const progressbar = screen.getByRole("progressbar");
    expect(progressbar).toBeTruthy();
    expect(progressbar.getAttribute("aria-valuenow")).toBe("250000");
    expect(progressbar.getAttribute("aria-valuemax")).toBe("1000000");
    expect(screen.getByText(/250\.0k\s*\/\s*1\.0M/)).toBeTruthy();
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

  it("uses 'budget hit' label for budget_limited status", () => {
    render(
      <CodexGoalCard
        goal={{ objective: "Finish verification", status: "budget_limited", tokensUsed: 9, tokenBudget: 10 }}
      />,
    );
    expect(screen.getByText(/budget hit/i)).toBeTruthy();
  });
});
