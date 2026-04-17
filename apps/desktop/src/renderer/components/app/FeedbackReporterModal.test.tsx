/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackReporterModal } from "./FeedbackReporterModal";
import { useAppStore } from "../../state/appStore";

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
      <option value="anthropic/claude-opus-4-7">Claude Opus</option>
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
      modelId: "anthropic/claude-opus-4-7",
      status: "failed",
      generationMode: "deterministic",
      generationWarning: "ADE used a deterministic draft because AI title and label suggestion failed: GitHub API unavailable",
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
      modelId: "anthropic/claude-opus-4-7",
      status: "posted",
      generationMode: "ai_assisted",
      generationWarning: null,
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
    useAppStore.setState({
      project: {
        rootPath: "/Users/admin/Projects/ADE",
        displayName: "ADE",
        baseRef: "main",
      },
      lanes: [
        {
          id: "lane-feedback",
          name: "feedback-reporter",
          description: null,
          laneType: "worktree",
          baseRef: "main",
          branchRef: "refs/heads/feature/feedback-reporter",
          worktreePath: "/Users/admin/Projects/ADE/.ade/worktrees/feedback-reporter",
          attachedRootPath: null,
          parentLaneId: "lane-main",
          childCount: 0,
          stackDepth: 1,
          parentStatus: null,
          isEditProtected: false,
          status: {
            dirty: true,
            ahead: 2,
            behind: 0,
            remoteBehind: 0,
            rebaseInProgress: false,
          },
          color: null,
          icon: null,
          tags: [],
          createdAt: "2026-04-08T05:00:00.000Z",
          archivedAt: null,
        },
      ] as any,
      selectedLaneId: "lane-feedback",
    });
    const prepareDraft = vi.fn(async () => ({
      category: "bug",
      draftInput: {
        category: "bug",
        summary: "The feedback reporter should show a preview before posting.",
        stepsToReproduce: "1. Open the reporter",
        expectedBehavior: "See a preview",
        actualBehavior: "It posts immediately",
        environment: "ADE Desktop",
        additionalContext: "",
      },
      userDescription: "## Summary\n\nThe feedback reporter should show a preview before posting.",
      modelId: null,
      reasoningEffort: null,
      title: "Show a preview before posting feedback issues",
      body: "## Description\n\nThe feedback reporter should show a preview before posting.",
      labels: ["bug"],
      generationMode: "deterministic",
      generationWarning: "ADE used a deterministic draft because no AI model was selected. Review the generated title and labels before posting.",
    }));
    const submitDraft = vi.fn(async () => ({
      id: "posted-2",
      category: "bug",
      userDescription: "## Summary\n\nThe feedback reporter should show a preview before posting.",
      modelId: null,
      status: "posted",
      generationMode: "deterministic",
      generationWarning: "ADE used a deterministic draft because no AI model was selected. Review the generated title and labels before posting.",
      generatedTitle: "Show a preview before posting feedback issues",
      generatedBody: "## Description\n\nThe feedback reporter should show a preview before posting.",
      issueUrl: "https://github.com/arul28/ADE/issues/145",
      issueNumber: 145,
      issueState: "open",
      error: null,
      createdAt: "2026-04-08T05:30:00.000Z",
      completedAt: "2026-04-08T05:30:02.000Z",
    }));

    globalThis.window.ade = {
      github: {
        getStatus: vi.fn(async () => ({ tokenStored: true })),
      },
      git: {
        listRecentCommits: vi.fn(async () => [
          {
            sha: "abc1234567890",
            shortSha: "abc1234",
            parents: [],
            authorName: "ADE Test",
            authoredAt: "2026-04-08T05:29:00.000Z",
            subject: "Tighten feedback reporter preview flow",
            pushed: false,
          },
        ]),
      },
      feedback: {
        list: vi.fn(async () => submissions),
        onUpdate: vi.fn(() => () => {}),
        prepareDraft,
        submitDraft,
      },
      app: {
        getInfo: vi.fn(async () => ({
          appVersion: "1.2.3",
          isPackaged: false,
          platform: "darwin",
          arch: "arm64",
          versions: {
            electron: "38.0.0",
            chrome: "138.0.0.0",
            node: "22.16.0",
            v8: "13.8.0.0",
          },
          env: {},
        })),
        openExternal: vi.fn(async () => undefined),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({
      project: null,
      lanes: [],
      selectedLaneId: null,
    });
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
    expect(screen.getAllByText(/Deterministic/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/ADE used a deterministic draft because AI title and label suggestion failed/i),
    ).toBeTruthy();
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

  it("prepares a draft from structured fields and posts the reviewed issue", async () => {
    render(
      <MemoryRouter>
        <FeedbackReporterModal open onOpenChange={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.change(
      await screen.findByPlaceholderText(/what changed, what broke/i),
      { target: { value: "The feedback reporter should show a preview before posting." } },
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue(/ADE version: 1\.2\.3 \(dev\)/i)).toBeTruthy();
    });
    expect(screen.getByDisplayValue(/Selected lane: feedback-reporter/i)).toBeTruthy();
    expect(screen.getByDisplayValue(/HEAD commit: abc1234 Tighten feedback reporter preview flow/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));

    expect(await screen.findByText(/draft preview/i)).toBeTruthy();
    expect(screen.getByDisplayValue(/Show a preview before posting feedback issues/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /post to github/i }));

    await waitFor(() => {
      expect((window.ade.feedback.submitDraft as any)).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(/Posted issue #145\./i)).toBeTruthy();
  });
});
