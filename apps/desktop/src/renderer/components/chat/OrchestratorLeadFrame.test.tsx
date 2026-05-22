/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OrchestratorLeadFrame,
  ORCHESTRATOR_LEAD_FRAME_TEST_ID,
  ORCHESTRATOR_LEAD_RING_TEST_ID,
} from "./OrchestratorLeadFrame";

afterEach(() => {
  cleanup();
  // OrchestratorLeadFrame injects a global <style id="orchestrator-lead-frame-keyframes">
  // — clean it up between tests so each test starts from a known DOM state.
  const sheet = document.getElementById("orchestrator-lead-frame-keyframes");
  sheet?.remove();
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

  it("injects keyframe stylesheet on activate (idempotent across mounts)", () => {
    render(
      <OrchestratorLeadFrame active>
        <div />
      </OrchestratorLeadFrame>,
    );
    expect(document.getElementById("orchestrator-lead-frame-keyframes")).toBeTruthy();

    // Mount a second one — should not duplicate the sheet.
    render(
      <OrchestratorLeadFrame active>
        <div />
      </OrchestratorLeadFrame>,
    );
    const sheets = document.querySelectorAll("#orchestrator-lead-frame-keyframes");
    expect(sheets.length).toBe(1);

    const sheet = document.getElementById("orchestrator-lead-frame-keyframes");
    const css = sheet?.textContent ?? "";
    expect(css).toMatch(/@keyframes orchestrator-lead-ring-rotate/);
    expect(css).toMatch(/@keyframes orchestrator-lead-ring-pulse/);
  });

  it("toggles pulse via data-attribute", () => {
    const { rerender } = render(
      <OrchestratorLeadFrame active>
        <div />
      </OrchestratorLeadFrame>,
    );
    expect(
      screen.getByTestId(ORCHESTRATOR_LEAD_FRAME_TEST_ID).getAttribute("data-orchestrator-lead-frame-pulse"),
    ).toBe("true");

    rerender(
      <OrchestratorLeadFrame active pulse={false}>
        <div />
      </OrchestratorLeadFrame>,
    );
    expect(
      screen.getByTestId(ORCHESTRATOR_LEAD_FRAME_TEST_ID).getAttribute("data-orchestrator-lead-frame-pulse"),
    ).toBe("false");
  });

  it("respects prefers-reduced-motion via the embedded stylesheet (static fallback)", () => {
    // The reduced-motion handling lives entirely inside the injected CSS:
    //   @media (prefers-reduced-motion: reduce) { /* disable animation */ }
    // We can't *simulate* the media query inside jsdom, but we can assert that
    // the rule is present in the stylesheet text — so when the browser honors
    // the user's preference, the ring will fall back to a static rainbow.
    render(
      <OrchestratorLeadFrame active>
        <div />
      </OrchestratorLeadFrame>,
    );
    const sheet = document.getElementById("orchestrator-lead-frame-keyframes");
    const css = sheet?.textContent ?? "";
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    // The reduced-motion rule must disable BOTH the rotation animation and
    // the pulse box-shadow animation.
    expect(css).toMatch(/animation: none/);
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
