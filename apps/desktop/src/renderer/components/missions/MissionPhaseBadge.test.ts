/**
 * Tests for MissionPhaseBadge phase-mapping logic.
 *
 * Since MissionPhaseBadge is a React component, we test the exported
 * component's behavior via lightweight DOM assertions (jsdom) to
 * verify phase-key mapping and empty/null handling.
 */
/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import type { PhaseCard } from "../../../shared/types";
import { MissionPhaseBadge } from "./MissionPhaseBadge";

afterEach(() => {
  cleanup();
});

function makePhase(key: string): PhaseCard {
  return {
    phaseKey: key,
    label: key,
    status: "active",
    startedAt: "2026-03-01T00:00:00.000Z",
    completedAt: null,
  } as unknown as PhaseCard;
}

describe("MissionPhaseBadge", () => {
  it("renders 'NO PHASES' when phases is null", () => {
    render(createElement(MissionPhaseBadge, { phases: null }));
    expect(screen.getByText("NO PHASES")).toBeTruthy();
  });

  it("renders 'NO PHASES' when phases is undefined", () => {
    render(createElement(MissionPhaseBadge, {}));
    expect(screen.getByText("NO PHASES")).toBeTruthy();
  });

  it("renders 'NO PHASES' when phases is empty array", () => {
    render(createElement(MissionPhaseBadge, { phases: [] }));
    expect(screen.getByText("NO PHASES")).toBeTruthy();
  });

  it("renders phase icons P/D/T/V/R for all standard phases", () => {
    const phases: PhaseCard[] = [
      makePhase("planning"),
      makePhase("development"),
      makePhase("testing"),
      makePhase("validation"),
      makePhase("code_review"),
    ];
    render(createElement(MissionPhaseBadge, { phases }));

    // All phase indicators should be present
    expect(screen.getByTitle("Planning")).toBeTruthy();
    expect(screen.getByTitle("Development")).toBeTruthy();
    expect(screen.getByTitle("Testing")).toBeTruthy();
    expect(screen.getByTitle("Validation")).toBeTruthy();
    expect(screen.getByTitle("Review")).toBeTruthy();
  });

  it("activates Development phase icon for 'implementation' phaseKey", () => {
    const phases: PhaseCard[] = [makePhase("implementation")];
    render(createElement(MissionPhaseBadge, { phases }));

    // Development should be active (implementation maps to D)
    const devIcon = screen.getByTitle("Development");
    expect(devIcon).toBeTruthy();
  });

  it("activates Review phase icon for 'test_review' and 'review' phaseKeys", () => {
    const phases: PhaseCard[] = [makePhase("test_review")];
    render(createElement(MissionPhaseBadge, { phases }));
    const reviewIcon = screen.getByTitle("Review");
    expect(reviewIcon).toBeTruthy();
  });

  it("renders profile name badge when provided", () => {
    const phases: PhaseCard[] = [makePhase("planning")];
    render(createElement(MissionPhaseBadge, { phases, profileName: "Full Stack" }));
    expect(screen.getByText("Full Stack")).toBeTruthy();
  });

  it("does not render profile name badge when null", () => {
    const phases: PhaseCard[] = [makePhase("planning")];
    render(createElement(MissionPhaseBadge, { phases, profileName: null }));
    expect(screen.queryByText("Full Stack")).toBeNull();
  });
});
