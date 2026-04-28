// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { PrAiSummary } from "../../../../shared/types";
import { PrAiSummaryCard } from "./PrAiSummaryCard";

function makeSummary(overrides: Partial<PrAiSummary> = {}): PrAiSummary {
  return {
    prId: "pr-1",
    summary: "Refactors the auth middleware to use session cookies.",
    riskAreas: ["auth middleware", "session storage"],
    reviewerHotspots: ["src/auth.ts:42"],
    unresolvedConcerns: ["Missing migration plan"],
    generatedAt: "2026-04-14T10:00:00.000Z",
    headSha: "abc123",
    ...overrides,
  };
}

let regenerateAiSummary: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  regenerateAiSummary = vi.fn().mockResolvedValue(makeSummary({ summary: "Updated summary." }));
  (window as unknown as { ade?: unknown }).ade = {
    prs: { regenerateAiSummary },
  };
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("PrAiSummaryCard", () => {
  it("renders summary paragraph and section chips", () => {
    render(<PrAiSummaryCard prId="pr-1" summary={makeSummary()} />);
    expect(screen.getByText(/refactors the auth middleware/i)).toBeTruthy();
    expect(screen.getByText("auth middleware")).toBeTruthy();
    expect(screen.getByText("src/auth.ts:42")).toBeTruthy();
    expect(screen.getByText("Missing migration plan")).toBeTruthy();
  });

  it("shows skeleton while loading", () => {
    const { container } = render(<PrAiSummaryCard prId="pr-1" summary={null} loading />);
    expect(container.querySelector("[data-pr-ai-summary-skeleton]")).toBeTruthy();
  });

  it("shows Generate CTA when summary is null", () => {
    render(<PrAiSummaryCard prId="pr-1" summary={null} />);
    expect(screen.getByRole("button", { name: /generate summary/i })).toBeTruthy();
  });

  it("calls regenerateAiSummary on Regenerate click and invokes onGenerated", async () => {
    const user = userEvent.setup();
    const onGenerated = vi.fn();
    render(<PrAiSummaryCard prId="pr-1" summary={makeSummary()} onGenerated={onGenerated} />);
    await user.click(screen.getByRole("button", { name: /regenerate/i }));
    await waitFor(() => {
      expect(regenerateAiSummary).toHaveBeenCalledWith("pr-1");
      expect(onGenerated).toHaveBeenCalled();
    });
  });

  it("persists dismissal in sessionStorage and hides the card", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const { container } = render(
      <PrAiSummaryCard prId="pr-42" summary={makeSummary({ prId: "pr-42" })} onDismiss={onDismiss} />,
    );
    await user.click(screen.getByRole("button", { name: /dismiss summary/i }));
    expect(onDismiss).toHaveBeenCalledWith("pr-42");
    expect(container.querySelector("[data-pr-ai-summary-card]")).toBeNull();
    expect(sessionStorage.getItem("ade:pr-ai-summary-dismissed:pr-42")).toBe("1");
  });

  it("respects a pre-existing sessionStorage dismissal", () => {
    sessionStorage.setItem("ade:pr-ai-summary-dismissed:pr-7", "1");
    const { container } = render(<PrAiSummaryCard prId="pr-7" summary={makeSummary({ prId: "pr-7" })} />);
    expect(container.querySelector("[data-pr-ai-summary-card]")).toBeNull();
  });

  it("surfaces errors from regeneration as an alert", async () => {
    const user = userEvent.setup();
    regenerateAiSummary.mockRejectedValueOnce(new Error("rate limited"));
    render(<PrAiSummaryCard prId="pr-1" summary={makeSummary()} />);
    await user.click(screen.getByRole("button", { name: /regenerate/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("rate limited");
    });
  });
});
