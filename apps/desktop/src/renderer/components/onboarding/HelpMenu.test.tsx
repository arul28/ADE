/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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

(globalThis as any).window = (globalThis as any).window ?? {};
(globalThis.window as any).ade = {
  onboarding: {
    getTourProgress: vi.fn(async () => progress),
    markWizardCompleted: vi.fn(async () => progress),
    markWizardDismissed: vi.fn(async () => progress),
    markTourCompleted: vi.fn(async () => progress),
    markTourDismissed: vi.fn(async () => progress),
    updateTourStep: vi.fn(async () => progress),
    markGlossaryTermSeen: vi.fn(async () => progress),
    resetTourProgress: vi.fn(async () => progress),
  },
};

import { useAppStore } from "../../state/appStore";
import { useOnboardingStore } from "../../state/onboardingStore";
import { _resetRegistryForTests, registerTour } from "../../onboarding/registry";
import { HelpMenu } from "./HelpMenu";

function renderMenu() {
  return render(
    <MemoryRouter>
      <HelpMenu />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  progress = emptyProgress();
  _resetRegistryForTests();
  useAppStore.setState({ didYouKnowEnabled: true });
  useOnboardingStore.setState({
    activeTourId: null,
    activeStepIndex: 0,
    wizardOpen: false,
    hydrated: true,
    progress: emptyProgress(),
  });
});

afterEach(() => cleanup());

describe("HelpMenu", () => {
  it("opens the menu and renders core items", async () => {
    registerTour({
      id: "lanes",
      title: "Lanes tour",
      route: "/lanes",
      steps: [{ target: "#x", title: "s", body: "b" }],
    });
    renderMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /help menu/i }));
    });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /replay welcome wizard/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /open glossary/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /ade docs/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /lanes tour/i })).toBeTruthy();
  });

  it("stub tours (0 steps) are marked Coming soon and disabled", async () => {
    registerTour({ id: "files", title: "Files tour", route: "/files", steps: [] });
    renderMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /help menu/i }));
    });
    const item = screen.getByRole("menuitem", { name: /files tour/i }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(screen.getByText(/coming soon/i)).toBeTruthy();
  });

  it("completed tours show a check", async () => {
    registerTour({
      id: "lanes",
      title: "Lanes tour",
      route: "/lanes",
      steps: [{ target: "#x", title: "s", body: "b" }],
    });
    useOnboardingStore.setState({
      progress: {
        ...emptyProgress(),
        tours: {
          lanes: { completedAt: new Date().toISOString(), dismissedAt: null, lastStepIndex: 0 },
        },
      },
    });
    renderMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /help menu/i }));
    });
    const item = screen.getByRole("menuitem", { name: /lanes tour/i });
    expect(item.querySelector('[aria-label="Completed"]')).toBeTruthy();
  });

  it("Replay Welcome Wizard calls openWizard and closes the menu", async () => {
    renderMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /help menu/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /replay welcome wizard/i }));
    });
    expect(useOnboardingStore.getState().wizardOpen).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Did you know checkbox toggles the store and keeps the menu open", async () => {
    renderMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /help menu/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /did you know/i }));
    });
    expect(useAppStore.getState().didYouKnowEnabled).toBe(false);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("renders Smart Tooltips and Onboarding checkboxes and they toggle independently", async () => {
    useAppStore.setState({ smartTooltipsEnabled: true, onboardingEnabled: true });
    renderMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /help menu/i }));
    });

    const tooltipToggle = screen.getByRole("menuitemcheckbox", { name: /detailed hover tooltips/i });
    const onboardingToggle = screen.getByRole("menuitemcheckbox", { name: /tours and help chips/i });

    expect(tooltipToggle.getAttribute("aria-checked")).toBe("true");
    expect(onboardingToggle.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      fireEvent.click(tooltipToggle);
    });
    expect(useAppStore.getState().smartTooltipsEnabled).toBe(false);
    expect(useAppStore.getState().onboardingEnabled).toBe(true);

    await act(async () => {
      fireEvent.click(onboardingToggle);
    });
    expect(useAppStore.getState().onboardingEnabled).toBe(false);
    expect(useAppStore.getState().smartTooltipsEnabled).toBe(false);
  });

  it("trigger button carries data-tour='app.helpMenu' so the Lanes tour can anchor to it", () => {
    renderMenu();
    const btn = screen.getByRole("button", { name: /help menu/i });
    expect(btn.getAttribute("data-tour")).toBe("app.helpMenu");
  });

  it("Escape closes the menu", async () => {
    renderMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /help menu/i }));
    });
    expect(screen.getByRole("menu")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
