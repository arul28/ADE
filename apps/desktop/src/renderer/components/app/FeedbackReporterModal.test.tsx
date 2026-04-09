/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackReporterModal } from "./FeedbackReporterModal";

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.ComponentProps<"div">) => <div {...props}>{children}</div>,
  },
}));

vi.mock("../shared/ProviderModelSelector", () => ({
  ProviderModelSelector: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <select
      aria-label="Model"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Select model</option>
      <option value="anthropic/claude-opus-4-6">Claude Opus</option>
    </select>
  ),
}));

describe("FeedbackReporterModal", () => {
  const originalAde = globalThis.window.ade;
  const submissions = [
    {
      id: "failed-1",
      category: "bug",
      userDescription: "The report failed and I need to see what I originally submitted.",
      modelId: "anthropic/claude-opus-4-6",
      status: "failed",
      generatedTitle: null,
      generatedBody: null,
      issueUrl: null,
      issueNumber: null,
      issueState: null,
      error: "Posting failed: GitHub API unavailable",
      createdAt: "2026-04-08T05:19:57.903Z",
      completedAt: "2026-04-08T05:21:34.368Z",
    },
    {
      id: "posted-1",
      category: "enhancement",
      userDescription: "Please add a way to expand the previous submissions tab.",
      modelId: "anthropic/claude-opus-4-6",
      status: "posted",
      generatedTitle: "Expandable submissions in feedback reporter",
      generatedBody: "## Description\n\nLet users inspect the saved payload and error state.",
      issueUrl: "https://github.com/arul28/ADE/issues/144",
      issueNumber: 144,
      issueState: "open",
      error: null,
      createdAt: "2026-04-08T05:01:35.650Z",
      completedAt: "2026-04-08T05:03:18.956Z",
    },
  ];

  beforeEach(() => {
    globalThis.window.ade = {
      github: {
        getStatus: vi.fn(async () => ({ tokenStored: true })),
      },
      feedback: {
        list: vi.fn(async () => submissions),
        onUpdate: vi.fn(() => () => {}),
        submit: vi.fn(),
      },
      app: {
        openExternal: vi.fn(async () => undefined),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("shows failure details for failed submissions and lets users expand posted ones", async () => {
    render(
      <MemoryRouter>
        <FeedbackReporterModal open onOpenChange={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /my submissions/i }));

    expect(await screen.findByText(/Posting failed: GitHub API unavailable/i)).toBeTruthy();
    expect(
      screen.getByText(/The report failed and I need to see what I originally submitted\./i, {
        selector: "div",
      }),
    ).toBeTruthy();

    const postedToggle = await screen.findByRole("button", {
      name: /Expandable submissions in feedback reporter/i,
    });
    expect(postedToggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(postedToggle);

    await waitFor(() => {
      expect(postedToggle.getAttribute("aria-expanded")).toBe("true");
    });
    expect(
      screen.getByText(/Please add a way to expand the previous submissions tab\./i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Let users inspect the saved payload and error state\./i),
    ).toBeTruthy();
  });
});
