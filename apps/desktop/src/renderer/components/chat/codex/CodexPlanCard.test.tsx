/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexPlanCard } from "./CodexPlanCard";

afterEach(cleanup);

describe("CodexPlanCard", () => {
  it("keeps the plan header marker static while an in-progress task spins", () => {
    const { container } = render(
      <CodexPlanCard
        event={{
          type: "plan",
          itemId: "plan-1",
          turnId: "turn-1",
          state: "active",
          steps: [
            { text: "Inspect the implementation", status: "in_progress" },
            { text: "Apply the fix", status: "pending" },
          ],
        }}
      />,
    );

    const spinningIcons = container.querySelectorAll(".motion-safe\\:animate-spin");
    expect(spinningIcons).toHaveLength(1);
  });

  it("does not open chat info when the nested details toggle handles the keyboard", () => {
    const onOpenInfo = vi.fn();
    render(
      <CodexPlanCard
        event={{
          type: "plan",
          itemId: "plan-1",
          turnId: "turn-1",
          state: "active",
          steps: [],
          streamingText: "Inspect the implementation",
        }}
        onOpenInfo={onOpenInfo}
      />,
    );

    const toggle = screen.getByRole("button", { name: "live" });
    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(onOpenInfo).not.toHaveBeenCalled();

    fireEvent.keyDown(toggle, { key: " " });
    expect(onOpenInfo).not.toHaveBeenCalled();
  });
});
