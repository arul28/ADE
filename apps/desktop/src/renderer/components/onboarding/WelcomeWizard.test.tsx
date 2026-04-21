/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OnboardingTourProgress } from "../../../shared/types";

function emptyProgress(): OnboardingTourProgress {
  return {
    wizardCompletedAt: null,
    wizardDismissedAt: null,
    tours: {},
    glossaryTermsSeen: [],
  };
}

let progress: OnboardingTourProgress = emptyProgress();

const markWizardCompleted = vi.fn(async () => {
  progress = { ...progress, wizardCompletedAt: new Date().toISOString() };
  return progress;
});
const markWizardDismissed = vi.fn(async () => {
  progress = { ...progress, wizardDismissedAt: new Date().toISOString() };
  return progress;
});

(globalThis as any).window = (globalThis as any).window ?? {};
(globalThis.window as any).ade = {
  onboarding: {
    getTourProgress: vi.fn(async () => progress),
    markWizardCompleted,
    markWizardDismissed,
    markTourCompleted: vi.fn(async () => progress),
    markTourDismissed: vi.fn(async () => progress),
    updateTourStep: vi.fn(async () => progress),
    markGlossaryTermSeen: vi.fn(async () => progress),
    resetTourProgress: vi.fn(async () => progress),
  },
};

import { useOnboardingStore } from "../../state/onboardingStore";
import { WelcomeWizard, WELCOME_SCREENS } from "./WelcomeWizard";

beforeEach(() => {
  progress = emptyProgress();
  vi.clearAllMocks();
  useOnboardingStore.setState({
    activeTourId: null,
    activeStepIndex: 0,
    wizardOpen: true,
    hydrated: true,
    progress: emptyProgress(),
  });
});

afterEach(() => cleanup());

describe("WelcomeWizard", () => {
  it("renders nothing when wizardOpen is false", () => {
    useOnboardingStore.setState({ wizardOpen: false });
    render(<WelcomeWizard />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the first screen on open", () => {
    render(<WelcomeWizard />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(WELCOME_SCREENS[0].title)).toBeTruthy();
    expect(screen.getByText(`1 / ${WELCOME_SCREENS.length}`)).toBeTruthy();
    expect(screen.getByText(WELCOME_SCREENS[0].eyebrow)).toBeTruthy();
  });

  it("Skip writes wizardDismissedAt via markWizardDismissed", async () => {
    render(<WelcomeWizard />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Skip$/i }));
    });
    expect(markWizardDismissed).toHaveBeenCalledTimes(1);
    expect(markWizardCompleted).not.toHaveBeenCalled();
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);
    expect(useOnboardingStore.getState().progress?.wizardDismissedAt).toBeTruthy();
  });

  it("Escape closes as dismissed", async () => {
    render(<WelcomeWizard />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(markWizardDismissed).toHaveBeenCalledTimes(1);
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);
  });

  it("Clicking through to last screen then the primary CTA writes wizardCompletedAt", async () => {
    render(<WelcomeWizard />);

    for (let i = 0; i < WELCOME_SCREENS.length - 1; i++) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
      });
    }

    const finish = screen.getByRole("button", { name: /let'?s go/i });
    await act(async () => {
      fireEvent.click(finish);
    });

    expect(markWizardCompleted).toHaveBeenCalledTimes(1);
    expect(markWizardDismissed).not.toHaveBeenCalled();
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);
    expect(useOnboardingStore.getState().progress?.wizardCompletedAt).toBeTruthy();
  });

  it("X button also dismisses", async () => {
    render(<WelcomeWizard />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Skip welcome/i));
    });
    expect(markWizardDismissed).toHaveBeenCalledTimes(1);
  });
});
