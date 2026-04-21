/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TourOverlay } from "./TourOverlay";
import { useOnboardingStore } from "../../../state/onboardingStore";

beforeEach(() => {
  useOnboardingStore.setState({
    activeTourId: "lanes",
    activeStepIndex: 0,
    wizardOpen: false,
    hydrated: true,
    progress: {
      wizardCompletedAt: null,
      wizardDismissedAt: null,
      tours: {},
      glossaryTermsSeen: [],
    },
  });
  // Stub matchMedia for prefers-reduced-motion.
  if (!window.matchMedia) {
    (window as any).matchMedia = (q: string) => ({
      matches: false,
      media: q,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    });
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TourOverlay", () => {
  it("Escape key triggers dismissCurrentTour", () => {
    const dismissSpy = vi.fn().mockResolvedValue(undefined);
    useOnboardingStore.setState({ dismissCurrentTour: dismissSpy as any });

    render(
      <TourOverlay
        step={{ target: "#missing", title: "Hi", body: "Body" }}
        stepIndex={0}
        totalSteps={3}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });

  it("ArrowRight advances to the next step when not last", () => {
    const nextSpy = vi.fn().mockResolvedValue(undefined);
    const completeSpy = vi.fn().mockResolvedValue(undefined);
    useOnboardingStore.setState({
      nextStep: nextSpy as any,
      completeCurrentTour: completeSpy as any,
    });

    render(
      <TourOverlay
        step={{ target: "#missing", title: "Hi", body: "Body" }}
        stepIndex={0}
        totalSteps={3}
      />,
    );

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(nextSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("ArrowRight on the last step calls completeCurrentTour", () => {
    const nextSpy = vi.fn().mockResolvedValue(undefined);
    const completeSpy = vi.fn().mockResolvedValue(undefined);
    useOnboardingStore.setState({
      nextStep: nextSpy as any,
      completeCurrentTour: completeSpy as any,
    });

    render(
      <TourOverlay
        step={{ target: "#missing", title: "End", body: "Body" }}
        stepIndex={2}
        totalSteps={3}
      />,
    );

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(nextSpy).not.toHaveBeenCalled();
  });

  it("renders the missing-element fallback when selector cannot be found within 500ms", async () => {
    vi.useFakeTimers();
    render(
      <TourOverlay
        step={{ target: "#not-in-dom", title: "Ghost", body: "Body" }}
        stepIndex={0}
        totalSteps={1}
      />,
    );

    // Initial render shows the dialog; advance past the 500ms retry window.
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByText(/isn't on screen right now/i)).toBeTruthy();
  });
});
