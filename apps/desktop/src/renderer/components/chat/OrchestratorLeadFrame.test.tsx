/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  OrchestratorLeadFrame,
  ORCHESTRATOR_LEAD_FRAME_TEST_ID,
  ORCHESTRATOR_LEAD_RING_TEST_ID,
} from "./OrchestratorLeadFrame";

afterEach(() => {
  cleanup();
});

describe("OrchestratorLeadFrame", () => {
  it("renders the rainbow ring only when active is true", () => {
    const { rerender } = render(
      <OrchestratorLeadFrame active={false}>
        <div data-testid="child">hello</div>
      </OrchestratorLeadFrame>,
    );
    expect(screen.queryByTestId(ORCHESTRATOR_LEAD_FRAME_TEST_ID)).toBeNull();
    expect(screen.queryByTestId(ORCHESTRATOR_LEAD_RING_TEST_ID)).toBeNull();
    expect(screen.getByTestId("child")).toBeTruthy();

    rerender(
      <OrchestratorLeadFrame active>
        <div data-testid="child">hello</div>
      </OrchestratorLeadFrame>,
    );
    const frame = screen.getByTestId(ORCHESTRATOR_LEAD_FRAME_TEST_ID);
    expect(frame).toBeTruthy();
    expect(frame.getAttribute("data-orchestrator-lead-frame")).toBe("");
    expect(screen.getByTestId(ORCHESTRATOR_LEAD_RING_TEST_ID)).toBeTruthy();
    // Child still rendered.
    expect(screen.getByTestId("child")).toBeTruthy();
  });

  it("toggles the static glow via data-attribute", () => {
    const { rerender } = render(
      <OrchestratorLeadFrame active>
        <div />
      </OrchestratorLeadFrame>,
    );
    expect(
      screen.getByTestId(ORCHESTRATOR_LEAD_FRAME_TEST_ID).getAttribute("data-orchestrator-lead-frame-glow"),
    ).toBe("true");

    rerender(
      <OrchestratorLeadFrame active glow={false}>
        <div />
      </OrchestratorLeadFrame>,
    );
    expect(
      screen.getByTestId(ORCHESTRATOR_LEAD_FRAME_TEST_ID).getAttribute("data-orchestrator-lead-frame-glow"),
    ).toBe("false");
  });

  it("preserves caller-supplied className/style on the wrapper", () => {
    render(
      <OrchestratorLeadFrame active className="custom-class" style={{ padding: 7 }}>
        <div />
      </OrchestratorLeadFrame>,
    );
    const frame = screen.getByTestId(ORCHESTRATOR_LEAD_FRAME_TEST_ID);
    expect(frame.className).toMatch(/custom-class/);
    expect(frame.style.padding).toBe("7px");
  });
});
