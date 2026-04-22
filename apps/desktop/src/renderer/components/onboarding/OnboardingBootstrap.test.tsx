/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../state/appStore";
import { useOnboardingStore } from "../../state/onboardingStore";
import { OnboardingBootstrap } from "./OnboardingBootstrap";

vi.mock("./tour/TourHost", () => ({ TourHost: () => null }));
vi.mock("./DidYouKnow", () => ({ DidYouKnow: () => null }));

const EMPTY_PROGRESS = {
  wizardCompletedAt: null,
  wizardDismissedAt: null,
  tours: {},
  glossaryTermsSeen: [],
};

describe("OnboardingBootstrap", () => {
  beforeEach(() => {
    (window as any).ade = {
      onboarding: {
        getTourProgress: vi.fn(async () => EMPTY_PROGRESS),
        tutorial: {
          clearSessionDismissal: vi.fn(async () => EMPTY_PROGRESS),
          shouldPrompt: vi.fn(async () => false),
        },
      },
    };
    useAppStore.setState({
      onboardingEnabled: true,
      project: null,
      showWelcome: true,
      projectHydrated: true,
    });
    useOnboardingStore.setState({
      activeTourId: "first-journey",
      activeStepIndex: 1,
      hydrated: true,
      progress: EMPTY_PROGRESS,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as any).ade;
  });

  it("advances act0.openProject when a project becomes active", async () => {
    const nextStep = vi.fn(async () => undefined);
    useOnboardingStore.setState({ nextStep: nextStep as any });

    render(
      <MemoryRouter initialEntries={["/project"]}>
        <OnboardingBootstrap />
      </MemoryRouter>,
    );

    expect(nextStep).not.toHaveBeenCalled();

    await act(async () => {
      useAppStore.setState({
        project: {
          rootPath: "/Users/arul/ADE",
          displayName: "ADE",
          baseRef: "main",
        },
        showWelcome: false,
      });
    });

    expect(nextStep).toHaveBeenCalledTimes(1);
  });
});
