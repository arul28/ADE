/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startTourMock = vi.fn(async (_id: string) => undefined);
const startTutorialMock = vi.fn(async () => {
  await startTourMock("first-journey");
});

vi.mock("../../state/onboardingStore", () => ({
  useOnboardingStore: {
    getState: () => ({
      startTour: startTourMock,
      startTutorial: startTutorialMock,
    }),
  },
}));

const tutorialStart = vi.fn(async () => undefined);
const tutorialDismiss = vi.fn(async (_p: boolean) => undefined);
const tutorialSetSilenced = vi.fn(async (_s: boolean) => undefined);
const tutorialShouldPrompt = vi.fn(async () => true);

(globalThis as any).window = (globalThis as any).window ?? {};
(globalThis.window as any).ade = {
  onboarding: {
    tutorial: {
      start: tutorialStart,
      dismiss: tutorialDismiss,
      setSilenced: tutorialSetSilenced,
      shouldPrompt: tutorialShouldPrompt,
      complete: vi.fn(async () => undefined),
      updateAct: vi.fn(async () => undefined),
      clearSessionDismissal: vi.fn(async () => undefined),
    },
    getTourProgress: vi.fn(async () => ({
      wizardCompletedAt: null,
      wizardDismissedAt: null,
      tours: {},
      glossaryTermsSeen: [],
    })),
  },
};

(globalThis.window as any).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
});

import { TutorialPromptCard } from "./TutorialPromptCard";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("TutorialPromptCard", () => {
  it("renders nothing when visible is false", () => {
    render(<TutorialPromptCard visible={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders corner variant (default) header, body, buttons, and checkbox when visible", () => {
    render(<TutorialPromptCard visible={true} onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/new to ade\? take the 10-minute tour/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^start tour$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^not now$/i })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /don't show this again/i })).toBeTruthy();
    expect(screen.getByText(/replay anytime from the/i)).toBeTruthy();
  });

  it("renders hero variant with welcome title and CTAs", () => {
    render(<TutorialPromptCard visible={true} variant="hero" onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/welcome to ade/i)).toBeTruthy();
    expect(screen.getByText(/take the 10-minute guided tour/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^start tour$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^not now$/i })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /don't show this again/i })).toBeTruthy();
  });

  it("renders corner variant explicitly when passed variant=corner", () => {
    render(<TutorialPromptCard visible={true} variant="corner" onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/new to ade\? take the 10-minute tour/i)).toBeTruthy();
  });

  it("Start tour calls tutorial.start and startTour then closes", async () => {
    const onClose = vi.fn();
    render(<TutorialPromptCard visible={true} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^start tour$/i }));
    });
    expect(tutorialStart).toHaveBeenCalledTimes(1);
    expect(startTourMock).toHaveBeenCalledWith("first-journey");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Not now (unchecked) calls tutorial.dismiss(false) then closes", async () => {
    const onClose = vi.fn();
    render(<TutorialPromptCard visible={true} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^not now$/i }));
    });
    expect(tutorialDismiss).toHaveBeenCalledWith(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Don't show again + Not now calls tutorial.dismiss(true)", async () => {
    const onClose = vi.fn();
    render(<TutorialPromptCard visible={true} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: /don't show this again/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^not now$/i }));
    });
    // dismiss(true) is the preferred permanent-dismiss call.
    expect(tutorialDismiss).toHaveBeenCalledWith(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
