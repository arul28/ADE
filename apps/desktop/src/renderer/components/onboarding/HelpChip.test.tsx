/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Provide an onboarding IPC stub so markGlossaryTermSeen doesn't blow up.
(globalThis as any).window = (globalThis as any).window ?? {};
(globalThis.window as any).ade = {
  onboarding: {
    markGlossaryTermSeen: vi.fn(async () => ({
      wizardCompletedAt: null,
      wizardDismissedAt: null,
      tours: {},
      glossaryTermsSeen: ["lane"],
    })),
  },
};

import { HelpChip } from "./HelpChip";
import { useAppStore } from "../../state/appStore";
import { GLOSSARY } from "../../onboarding/glossary";

const termFixture = {
  id: "lane",
  term: "Lane",
  shortDefinition: "A separate workspace for one task.",
  longDefinition: "A Lane is like its own desk for one task.",
  docUrl: "https://www.ade-app.dev/docs/lanes/overview",
};

beforeEach(() => {
  // Inject the fixture term into the shared glossary for the duration of the test.
  GLOSSARY.length = 0;
  GLOSSARY.push(termFixture);
  useAppStore.setState({ onboardingEnabled: true });
  vi.clearAllMocks();
});

afterEach(() => {
  GLOSSARY.length = 0;
  cleanup();
});

describe("HelpChip", () => {
  it("renders nothing when onboardingEnabled is false", () => {
    useAppStore.setState({ onboardingEnabled: false });
    render(<HelpChip termId="lane" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a button with aria-label when onboardingEnabled is true", () => {
    render(<HelpChip termId="lane" />);
    const btn = screen.getByRole("button", { name: /What is Lane\?/i });
    expect(btn).toBeTruthy();
  });

  it("renders nothing and warns when the term id is unknown", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<HelpChip termId="nope" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("click opens the glossary popover", async () => {
    render(<HelpChip termId="lane" />);
    const btn = screen.getByRole("button", { name: /What is Lane\?/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(screen.getByRole("dialog", { name: /Lane/ })).toBeTruthy();
  });
});
