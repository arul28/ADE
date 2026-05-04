/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiPermissionMode, PipelineSettings, PrCheck } from "../../../../shared/types";
import type {
  AutoConvergeWaitState,
  ConvergenceStatus,
  IssueInventoryItem,
  PrConvergencePanelProps,
} from "./PrConvergencePanel";
import { PrConvergencePanel } from "./PrConvergencePanel";

vi.mock("./PrPipelineSettings", () => ({
  PrPipelineSettings: ({
    showAutoConvergeSettings,
  }: {
    showAutoConvergeSettings: boolean;
  }) => (
    <div data-testid="pipeline-settings">
      {showAutoConvergeSettings ? "auto-converge-settings" : "manual-settings"}
    </div>
  ),
}));

function makeItem(overrides: Partial<IssueInventoryItem> = {}): IssueInventoryItem {
  return {
    id: "item-1",
    state: "new",
    severity: "major",
    headline: "Tighten convergence state restoration",
    filePath: "src/prs.ts",
    line: 42,
    source: "coderabbit",
    dismissReason: null,
    agentSessionId: null,
    ...overrides,
  };
}

function makeCheck(overrides: Partial<PrCheck> = {}): PrCheck {
  return {
    name: "ci / unit",
    status: "completed",
    conclusion: "failure",
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeConvergence(overrides: Partial<ConvergenceStatus> = {}): ConvergenceStatus {
  return {
    state: "not_started",
    currentRound: 1,
    maxRounds: 5,
    ...overrides,
  };
}

const defaultPipelineSettings: PipelineSettings = {
  autoMerge: false,
  mergeMethod: "repo_default",
  maxRounds: 5,
  onRebaseNeeded: "pause",
};

function renderPanel(overrides: Partial<PrConvergencePanelProps> = {}) {
  const props: PrConvergencePanelProps = {
    prNumber: 117,
    prTitle: "Persist convergence runtime state",
    headBranch: "feature/path-to-merge",
    baseBranch: "main",
    items: [],
    convergence: makeConvergence(),
    checks: [],
    modelId: "openai/gpt-5.4",
    reasoningEffort: "high",
    permissionMode: "guarded_edit" as AiPermissionMode,
    busy: false,
    autoConverge: false,
    pipelineSettings: defaultPipelineSettings,
    waitState: { phase: "idle" },
    onPipelineSettingsChange: vi.fn(),
    onModelChange: vi.fn(),
    onReasoningEffortChange: vi.fn(),
    onPermissionModeChange: vi.fn(),
    onRunNextRound: vi.fn(async () => undefined),
    onAutoConvergeChange: vi.fn(),
    onCopyPrompt: vi.fn(async () => undefined),
    onMarkDismissed: vi.fn(),
    onMarkEscalated: vi.fn(),
    onResetInventory: vi.fn(),
    onViewAgentSession: vi.fn(),
    onStopAutoConverge: vi.fn(),
    onResumePause: vi.fn(),
    onDismissPause: vi.fn(),
    onDismissMerged: vi.fn(),
    ...overrides,
  };

  render(<PrConvergencePanel {...props} />);
  return props;
}

describe("PrConvergencePanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the empty-state copy when no issues or checks are available", () => {
    renderPanel();

    expect(screen.getByText("No issues inventoried yet.")).toBeTruthy();
    expect(screen.getByText(/Sync review comments and CI checks to start the convergence loop/i)).toBeTruthy();
  });

  it("calls onRunNextRound with the typed additional instructions", async () => {
    const user = userEvent.setup();
    const props = renderPanel({
      items: [makeItem()],
      checks: [makeCheck({ conclusion: "success" })],
    });

    await user.type(screen.getByPlaceholderText("Add instructions for this round..."), "focus on review threads");
    await user.click(screen.getByRole("button", { name: "Launch Agent" }));

    expect(props.onRunNextRound).toHaveBeenCalledWith("focus on review threads");
  });

  it("copies the prompt with additional instructions", async () => {
    const user = userEvent.setup();
    const props = renderPanel({
      items: [makeItem()],
      checks: [makeCheck({ conclusion: "success" })],
    });

    await user.type(screen.getByPlaceholderText("Add instructions for this round..."), "rerun failed checks only if needed");
    await user.click(screen.getByRole("button", { name: "Copy Prompt" }));

    expect(props.onCopyPrompt).toHaveBeenCalledWith("rerun failed checks only if needed");
  });

  it("shows the auto-converge waiting banner and deep-links to the active session", async () => {
    const user = userEvent.setup();
    const props = renderPanel({
      autoConverge: true,
      items: [makeItem()],
      convergence: makeConvergence({ state: "converging", currentRound: 1 }),
      waitState: { phase: "agent_running", sessionId: "session-123" },
    });

    expect(screen.getByText("Agent working on round 1...")).toBeTruthy();
    expect(screen.getByTestId("pipeline-settings").textContent).toContain("auto-converge-settings");

    await user.click(screen.getAllByRole("button", { name: /View Session/i })[0]!);
    expect(props.onViewAgentSession).toHaveBeenCalledWith("session-123");
  });

  it("does not describe a manual agent run as the next round", () => {
    renderPanel({
      items: [makeItem()],
      convergence: makeConvergence({ state: "converging", currentRound: 1 }),
      waitState: { phase: "agent_running", sessionId: "session-123" },
    });

    expect(screen.getByText("Agent working on Path to Merge...")).toBeTruthy();
    expect(screen.queryByText("Agent working on round 1...")).toBeNull();
    expect(screen.queryByText("Agent working on round 2...")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop Auto-Converge" })).toBeNull();
  });

  it("expands a review item to show the full stored comment context", async () => {
    const user = userEvent.setup();
    renderPanel({
      items: [
        makeItem({
          body: "The compact headline is not enough.\nPlease include this second line too.",
          author: "reviewer",
          threadCommentCount: 2,
        }),
      ],
    });

    expect(screen.queryByText(/Please include this second line too/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand comment context" }));

    expect(screen.getByText(/Please include this second line too/i)).toBeTruthy();
    expect(screen.getByText("reviewer")).toBeTruthy();
    expect(screen.getByText("2 comments")).toBeTruthy();
  });

  it("hides ignored review items until the ignored section is shown", async () => {
    const user = userEvent.setup();
    renderPanel({
      items: [
        makeItem({
          id: "ignored-1",
          state: "dismissed",
          headline: "Ignore this historical thread",
          dismissReason: "Ignored from Path to Merge",
        }),
      ],
    });

    expect(screen.queryByText("Ignore this historical thread")).toBeNull();
    expect(screen.getByText("Ignored comments are hidden.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Show ignored (1)" }));

    expect(screen.getByText("Ignore this historical thread")).toBeTruthy();
    expect(screen.getByText("Ignored from Path to Merge")).toBeTruthy();
  });

  it("allows dismissing and escalating unresolved review items", async () => {
    const user = userEvent.setup();
    const props = renderPanel({
      items: [
        makeItem({ id: "issue-1", headline: "Address unresolved review feedback" }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "Ignore comment" }));
    expect(props.onMarkDismissed).toHaveBeenCalledWith(["issue-1"], "Ignored from Path to Merge");

    await user.click(screen.getByTitle("Escalate"));
    expect(props.onMarkEscalated).toHaveBeenCalledWith(["issue-1"]);
  });

  it("resets inventory from the review comments header", async () => {
    const user = userEvent.setup();
    const props = renderPanel({
      items: [makeItem()],
    });

    await user.click(screen.getByTitle("Reset inventory"));
    expect(props.onResetInventory).toHaveBeenCalledTimes(1);
  });

  it("shows pause controls and routes them to the provided handlers", async () => {
    const user = userEvent.setup();
    const props = renderPanel({
      autoConverge: true,
      items: [],
      convergence: makeConvergence({ state: "stalled" }),
      waitState: { phase: "paused", reason: "Rebase needed" } satisfies AutoConvergeWaitState,
    });

    expect(screen.getByText("Paused: Rebase needed")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(props.onResumePause).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onDismissPause).toHaveBeenCalledTimes(1);
  });
});
