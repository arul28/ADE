// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { PrReview } from "../../../../shared/types";
import { PrBotReviewCard, detectBotProvider } from "./PrBotReviewCard";

vi.mock("../../chat/CodeHighlighter.tsx", () => ({
  HighlightedCode: ({ code }: { code: string }) => <pre>{code}</pre>,
}));

const BASE: Pick<PrReview, "state" | "submittedAt"> & { reviewerAvatarUrl: string | null } = {
  state: "commented",
  submittedAt: "2026-04-14T10:00:00.000Z",
  reviewerAvatarUrl: null,
};

function makeReview(overrides: Partial<PrReview> = {}): PrReview {
  return {
    reviewer: "greptile-apps[bot]",
    body: "Looks good overall.",
    ...BASE,
    ...overrides,
  };
}

beforeEach(() => {
  (window as unknown as { ade?: unknown }).ade = { app: { openExternal: vi.fn() } };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("detectBotProvider", () => {
  it("identifies greptile, seer, coderabbit, claude, sourcery logins", () => {
    expect(detectBotProvider("greptile-apps[bot]")).toBe("greptile");
    expect(detectBotProvider("seer-by-sentry")).toBe("seer");
    expect(detectBotProvider("coderabbitai[bot]")).toBe("coderabbit");
    expect(detectBotProvider("claude-reviewer")).toBe("claude");
    expect(detectBotProvider("sourcery-ai[bot]")).toBe("sourcery");
  });

  it("returns null for human logins", () => {
    expect(detectBotProvider("octocat")).toBeNull();
    expect(detectBotProvider("")).toBeNull();
  });
});

describe("PrBotReviewCard", () => {
  it("starts collapsed and toggles open on click", () => {
    render(
      <PrBotReviewCard review={makeReview({ body: "Hidden body" })} repoOwner="acme" repoName="ade" />,
    );
    const toggle = screen.getByRole("button", { name: /greptile/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/hidden body/i)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/hidden body/i)).toBeTruthy();
  });

  it("shows severity badges parsed from the body", () => {
    render(
      <PrBotReviewCard
        review={makeReview({
          reviewer: "seer-by-sentry",
          body: "Found one P0 crash and one P2 code smell.",
        })}
        repoOwner="acme"
        repoName="ade"
      />,
    );
    expect(screen.getByText("P0")).toBeTruthy();
    expect(screen.getByText("P2")).toBeTruthy();
  });

  it("extracts confidence and issue count in the summary line", () => {
    render(
      <PrBotReviewCard
        review={makeReview({
          reviewer: "coderabbitai[bot]",
          body: "Confidence: High — 3 issues found.",
        })}
        repoOwner="acme"
        repoName="ade"
      />,
    );
    expect(screen.getByText(/coderabbit/i)).toBeTruthy();
    expect(screen.getAllByText(/High/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/3 issues/i).length).toBeGreaterThanOrEqual(1);
  });

  it("sets data-provider for unknown reviewers to 'unknown'", () => {
    const { container } = render(
      <PrBotReviewCard
        review={makeReview({ reviewer: "octocat" })}
        repoOwner="acme"
        repoName="ade"
      />,
    );
    const card = container.querySelector("[data-pr-bot-review-card]");
    expect(card?.getAttribute("data-provider")).toBe("unknown");
  });
});
