/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CodexGoalBanner } from "./CodexGoalBanner";

afterEach(() => cleanup());

describe("CodexGoalBanner", () => {
  it("invokes onEdit with the typed objective when the user presses Enter", () => {
    const onEdit = vi.fn();
    render(
      <CodexGoalBanner
        goal={{ objective: "Refactor auth middleware", status: "active" }}
        onEdit={onEdit}
        onClear={() => undefined}
      />,
    );

    // Click the objective text to enter edit mode
    fireEvent.click(screen.getByText("Refactor auth middleware"));
    const input = screen.getByLabelText("Edit goal objective") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Refactor auth for compliance" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onEdit).toHaveBeenCalledWith("Refactor auth for compliance");
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("invokes onClear when the clear button is clicked", () => {
    const onClear = vi.fn();
    render(
      <CodexGoalBanner
        goal={{ objective: "Refactor auth", status: "active" }}
        onEdit={() => undefined}
        onClear={onClear}
      />,
    );

    fireEvent.click(screen.getByLabelText("Clear goal"));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("does not submit an edit when clearing during edit mode", () => {
    const onEdit = vi.fn();
    const onClear = vi.fn();
    render(
      <CodexGoalBanner
        goal={{ objective: "Refactor auth", status: "active" }}
        onEdit={onEdit}
        onClear={onClear}
      />,
    );

    fireEvent.click(screen.getByText("Refactor auth"));
    const input = screen.getByLabelText("Edit goal objective");
    fireEvent.change(input, { target: { value: "Temporary draft" } });
    const clearButton = screen.getByLabelText("Clear goal");
    fireEvent.mouseDown(clearButton);
    fireEvent.click(clearButton);

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("does not invoke onEdit when Escape cancels the edit", () => {
    const onEdit = vi.fn();
    render(
      <CodexGoalBanner
        goal={{ objective: "Refactor auth", status: "active" }}
        onEdit={onEdit}
        onClear={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText("Refactor auth"));
    const input = screen.getByLabelText("Edit goal objective");
    fireEvent.change(input, { target: { value: "Discarded change" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onEdit).not.toHaveBeenCalled();
  });

  it("returns null when the goal has no objective", () => {
    const { container } = render(
      <CodexGoalBanner
        goal={{ objective: "", status: "active" }}
        onEdit={() => undefined}
        onClear={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the status pill label with underscores replaced", () => {
    render(
      <CodexGoalBanner
        goal={{ objective: "Stay under budget", status: "budget_limited" }}
        onEdit={() => undefined}
        onClear={() => undefined}
      />,
    );
    expect(screen.getByText(/budget limited/i)).toBeTruthy();
  });
});
