// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { PrReview } from "../../../../shared/types";
import { PrBotReviewCard } from "./PrBotReviewCard";

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
          reviewer: "greptile-apps[bot]",
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

  it("renders an 'App' bot pill next to the reviewer name", () => {
    render(
      <PrBotReviewCard review={makeReview()} repoOwner="acme" repoName="ade" />,
    );
    expect(screen.getByText("App")).toBeTruthy();
  });

  it("takes the display name from the shared bot identity table", () => {
    render(
      <PrBotReviewCard
        review={makeReview({ reviewer: "coderabbitai[bot]", body: "Summary." })}
        repoOwner="acme"
        repoName="ade"
      />,
    );
    const card = document.querySelector("[data-pr-bot-review-card]");
    expect(card?.getAttribute("data-provider")).toBe("coderabbit");
    expect(screen.getByRole("button", { name: /CodeRabbit/ })).toBeTruthy();
  });

  it("uses the GitHub account flag for a short agent login", () => {
    const { container } = render(
      <PrBotReviewCard
        review={makeReview({ reviewer: "cursor", reviewerIsBot: true, body: "Found one P1 bug." })}
        repoOwner="acme"
        repoName="ade"
      />,
    );
    expect(container.querySelector("[data-pr-bot-review-card]")?.getAttribute("data-provider")).toBe("cursor");
    expect(container.querySelector("[data-agent-kind='cursor']")).toBeTruthy();
    expect(screen.getByText("P1")).toBeTruthy();
  });

  it("does not mine severity badges from an unknown bot's prose", () => {
    render(
      <PrBotReviewCard
        review={makeReview({ reviewer: "some-helper[bot]", body: "Priority P0 in the docs." })}
        repoOwner="acme"
        repoName="ade"
      />,
    );
    expect(screen.queryByText("P0")).toBeNull();
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
