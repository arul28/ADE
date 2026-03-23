// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrCheck, PrIssueResolutionScope, PrReviewThread } from "../../../../shared/types";
import type { PrIssueResolutionAvailability } from "../../../../shared/prIssueResolution";
import { PrIssueResolverModal } from "./PrIssueResolverModal";

vi.mock("./PrResolverLaunchControls", () => ({
  PrResolverLaunchControls: () => <div data-testid="launch-controls">launch controls</div>,
}));

const failingChecks: PrCheck[] = [
  { name: "ci / unit", status: "completed", conclusion: "failure", detailsUrl: null, startedAt: null, completedAt: null },
];

const reviewThreads: PrReviewThread[] = [
  {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    path: "src/prs.ts",
    line: 18,
    originalLine: 18,
    startLine: null,
    originalStartLine: null,
    diffSide: "RIGHT",
    url: null,
    createdAt: null,
    updatedAt: null,
    comments: [
      { id: "comment-1", author: "reviewer", authorAvatarUrl: null, body: "Please tighten this logic.", url: null, createdAt: null, updatedAt: null },
    ],
  },
];

type ResolverAction = (args: { scope: PrIssueResolutionScope; additionalInstructions: string }) => Promise<void>;

function makeAvailability(overrides: Partial<PrIssueResolutionAvailability> = {}): PrIssueResolutionAvailability {
  return {
    failingCheckCount: 1,
    pendingCheckCount: 0,
    actionableReviewThreadCount: 1,
    hasActionableChecks: true,
    hasActionableComments: true,
    hasAnyActionableIssues: true,
    ...overrides,
  };
}

function renderModal(
  availability: PrIssueResolutionAvailability,
  args: {
    onLaunch?: ReturnType<typeof vi.fn>;
    onCopyPrompt?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const onLaunch = args.onLaunch ?? vi.fn(async () => undefined);
  const onCopyPrompt = args.onCopyPrompt ?? vi.fn(async () => undefined);
  render(
    <PrIssueResolverModal
      open
      prNumber={80}
      prTitle="Stabilize GitHub PR flows"
      availability={availability}
      checks={failingChecks}
      reviewThreads={reviewThreads}
      modelId="openai/gpt-5.4-codex"
      reasoningEffort="high"
      permissionMode="guarded_edit"
      busy={false}
      copyBusy={false}
      copyNotice={null}
      error={null}
      onOpenChange={() => undefined}
      onModelChange={() => undefined}
      onReasoningEffortChange={() => undefined}
      onPermissionModeChange={() => undefined}
      onLaunch={onLaunch as ResolverAction}
      onCopyPrompt={onCopyPrompt as ResolverAction}
    />,
  );
  return { onLaunch, onCopyPrompt };
}

describe("PrIssueResolverModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("defaults to both scope when checks and comments are actionable", async () => {
    const user = userEvent.setup();
    const { onLaunch } = renderModal(makeAvailability());

    await user.click(screen.getByRole("button", { name: /launch agent/i }));

    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({
      scope: "both",
    }));
  });

  it("defaults to comments scope and disables checks-only selection when checks are still running", async () => {
    const user = userEvent.setup();
    const { onLaunch } = renderModal(makeAvailability({
      pendingCheckCount: 1,
      hasActionableChecks: false,
    }));

    expect(screen.getByRole("button", { name: /checks only/i })).toHaveProperty("disabled", true);

    await user.click(screen.getByRole("button", { name: /launch agent/i }));

    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({
      scope: "comments",
    }));
  });

  it("copies the prepared prompt for the currently selected scope", async () => {
    const user = userEvent.setup();
    const onCopyPrompt = vi.fn(async () => undefined);
    renderModal(makeAvailability(), { onCopyPrompt });

    await user.click(screen.getByRole("button", { name: /copy prompt/i }));

    expect(onCopyPrompt).toHaveBeenCalledWith(expect.objectContaining({
      scope: "both",
    }));
  });
});
