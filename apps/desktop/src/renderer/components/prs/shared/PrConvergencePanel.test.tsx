/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiPermissionMode,
  IssueInventoryItem,
  IssueInventorySnapshot,
  PipelineSettings,
  PrCheck,
} from "../../../../shared/types";
import type { PrConvergencePanelProps, PathToMergeRuntimeState } from "./PrConvergencePanel";
import { PrConvergencePanel } from "./PrConvergencePanel";

// ---------------------------------------------------------------------------
// Mock sub-components so we test the panel in isolation
// ---------------------------------------------------------------------------
vi.mock("./PrPipelineSettings", () => ({
  PrPipelineSettings: (props: Record<string, unknown>) => (
    <div data-testid="pipeline-settings" data-auto-converge={String(props.autoConverge)} />
  ),
}));

vi.mock("./PrResolverLaunchControls", () => ({
  PrResolverLaunchControls: () => <div data-testid="launch-controls">launch controls</div>,
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRuntime(overrides: Partial<PathToMergeRuntimeState> = {}): PathToMergeRuntimeState {
  return {
    phase: "idle",
    currentRound: 0,
    maxRounds: 5,
    autoConverge: false,
    agentSessionId: null,
    sessionHref: null,
    sessionLaneId: null,
    pauseReason: null,
    pollerPhase: "idle",
    ...overrides,
  };
}

function makeItem(overrides: Partial<IssueInventoryItem> = {}): IssueInventoryItem {
  return {
    id: `item-${Math.random().toString(36).slice(2, 8)}`,
    prId: "pr-1",
    source: "coderabbit",
    type: "review_thread",
    externalId: "ext-1",
    state: "new",
    round: 1,
    filePath: null,
    line: null,
    severity: null,
    headline: "Test headline",
    body: null,
    author: null,
    url: null,
    dismissReason: null,
    agentSessionId: null,
    createdAt: "2026-03-31T00:00:00Z",
    updatedAt: "2026-03-31T00:00:00Z",
    ...overrides,
  };
}

function makeSnapshot(items: IssueInventoryItem[] = []): IssueInventorySnapshot {
  return {
    prId: "pr-1",
    items,
    convergence: {
      currentRound: 1,
      maxRounds: 5,
      issuesPerRound: [],
      totalNew: items.filter((i) => i.state === "new").length,
      totalFixed: items.filter((i) => i.state === "fixed").length,
      totalDismissed: items.filter((i) => i.state === "dismissed").length,
      totalEscalated: items.filter((i) => i.state === "escalated").length,
      totalSentToAgent: items.filter((i) => i.state === "sent_to_agent").length,
      isConverging: false,
      canAutoAdvance: true,
    },
    runtime: {
      prId: "pr-1",
      autoConvergeEnabled: false,
      status: "idle",
      pollerStatus: "idle",
      currentRound: 1,
      activeSessionId: null,
      activeLaneId: null,
      activeHref: null,
      pauseReason: null,
      lastError: null,
      errorMessage: null,
      lastStartedAt: null,
      lastPolledAt: null,
      lastPausedAt: null,
      lastStoppedAt: null,
      createdAt: "2026-03-31T00:00:00Z",
      updatedAt: "2026-03-31T00:00:00Z",
    } as IssueInventorySnapshot["runtime"],
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
    prNumber: 42,
    prTitle: "Fix convergence loop",
    headBranch: "feature/convergence",
    baseBranch: "main",
    snapshot: null,
    checks: [],
    runtime: makeRuntime(),
    modelId: "anthropic/claude-sonnet-4-6",
    reasoningEffort: "medium",
    permissionMode: "guarded_edit" as AiPermissionMode,
    busy: false,
    additionalInstructions: "",
    onAdditionalInstructionsChange: vi.fn(),
    onModelChange: vi.fn(),
    onReasoningEffortChange: vi.fn(),
    onPermissionModeChange: vi.fn(),
    onAutoConvergeChange: vi.fn(),
    onLaunchAgent: vi.fn(async () => undefined),
    onStartNextRound: vi.fn(async () => undefined),
    onCopyPrompt: vi.fn(async () => undefined),
    onStop: vi.fn(async () => undefined),
    onViewSession: vi.fn(),
    onMarkDismissed: vi.fn(),
    onMarkEscalated: vi.fn(),
    onResetInventory: vi.fn(),
    pipelineSettings: defaultPipelineSettings,
    onPipelineSettingsChange: vi.fn(),
    ...overrides,
  };

  render(<PrConvergencePanel {...props} />);
  return props;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PrConvergencePanel", () => {
  afterEach(() => {
    cleanup();
  });

  // -------------------------------------------------------------------------
  // Header / basic rendering
  // -------------------------------------------------------------------------
  describe("header rendering", () => {
    it("displays PR number, title, and branch names", () => {
      renderPanel();
      expect(screen.getByText("#42")).toBeTruthy();
      expect(screen.getByText("Fix convergence loop")).toBeTruthy();
      expect(screen.getByText("feature/convergence")).toBeTruthy();
      expect(screen.getByText("main")).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Phase / status rendering
  // -------------------------------------------------------------------------
  describe("phase display", () => {
    it("shows Idle status when phase is idle", () => {
      renderPanel({ runtime: makeRuntime({ phase: "idle" }) });
      expect(screen.getByText("Idle")).toBeTruthy();
    });

    it("shows Agent working status when phase is working", () => {
      renderPanel({ runtime: makeRuntime({ phase: "working" }) });
      expect(screen.getByText("Agent working")).toBeTruthy();
    });

    it("shows Converged status when phase is converged", () => {
      renderPanel({ runtime: makeRuntime({ phase: "converged" }) });
      expect(screen.getByText("Converged")).toBeTruthy();
    });

    it("shows Error status when phase is error", () => {
      renderPanel({ runtime: makeRuntime({ phase: "error" }) });
      expect(screen.getByText("Error")).toBeTruthy();
    });

    it("shows Paused status when phase is paused", () => {
      renderPanel({ runtime: makeRuntime({ phase: "paused" }) });
      expect(screen.getByText("Paused")).toBeTruthy();
    });

    it("shows Launching status when phase is launching", () => {
      renderPanel({ runtime: makeRuntime({ phase: "launching" }) });
      expect(screen.getByText("Launching")).toBeTruthy();
    });

    it("shows Stopped status when phase is stopped", () => {
      renderPanel({ runtime: makeRuntime({ phase: "stopped" }) });
      expect(screen.getByText("Stopped")).toBeTruthy();
    });

    it("shows Merged status when phase is merged", () => {
      renderPanel({ runtime: makeRuntime({ phase: "merged" }) });
      expect(screen.getByText("Merged")).toBeTruthy();
    });

    it("shows pause reason when provided", () => {
      renderPanel({ runtime: makeRuntime({ phase: "paused", pauseReason: "Rebase needed" }) });
      expect(screen.getByText("Rebase needed")).toBeTruthy();
    });

    it("displays round info in the runtime summary", () => {
      renderPanel({ runtime: makeRuntime({ currentRound: 3, maxRounds: 7 }) });
      expect(screen.getByText(/Round 3 of 7/)).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Auto-converge toggle
  // -------------------------------------------------------------------------
  describe("auto-converge toggle", () => {
    it("shows Manual launch label and enable button when autoConverge is off", () => {
      renderPanel({ runtime: makeRuntime({ autoConverge: false }) });
      expect(screen.getAllByText("Manual launch").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("Auto-converge OFF")).toBeTruthy();
      expect(screen.getByRole("button", { name: /enable auto-converge/i })).toBeTruthy();
    });

    it("shows Auto-converge label when autoConverge is on", () => {
      renderPanel({ runtime: makeRuntime({ autoConverge: true }) });
      expect(screen.getByText("Convergence settings")).toBeTruthy();
      expect(screen.getByText("Auto-converge ON")).toBeTruthy();
    });

    it("calls onAutoConvergeChange when enable button is clicked", async () => {
      const user = userEvent.setup();
      const props = renderPanel({ runtime: makeRuntime({ autoConverge: false }) });

      await user.click(screen.getByRole("button", { name: /enable auto-converge/i }));
      expect(props.onAutoConvergeChange).toHaveBeenCalledWith(true);
    });

    it("renders PrPipelineSettings when autoConverge is on", () => {
      renderPanel({ runtime: makeRuntime({ autoConverge: true }) });
      expect(screen.getByTestId("pipeline-settings")).toBeTruthy();
    });

    it("renders PrResolverLaunchControls when autoConverge is off", () => {
      renderPanel({ runtime: makeRuntime({ autoConverge: false }) });
      expect(screen.getByTestId("launch-controls")).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------
  describe("empty state", () => {
    it("shows empty inventory message when snapshot is null", () => {
      renderPanel({ snapshot: null });
      expect(screen.getByText("No inventory yet")).toBeTruthy();
    });

    it("shows empty inventory message when snapshot has zero items", () => {
      renderPanel({ snapshot: makeSnapshot([]) });
      expect(screen.getByText("No inventory yet")).toBeTruthy();
    });

    it("shows empty checks message when checks array is empty", () => {
      renderPanel({ checks: [] });
      expect(screen.getByText("No checks found")).toBeTruthy();
      expect(screen.getByText("No checks")).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Issue inventory display
  // -------------------------------------------------------------------------
  describe("issue inventory display", () => {
    it("groups items by state and shows section headers", () => {
      const items = [
        makeItem({ id: "i1", state: "new", headline: "New issue 1" }),
        makeItem({ id: "i2", state: "new", headline: "New issue 2" }),
        makeItem({ id: "i3", state: "fixed", headline: "Fixed issue" }),
        makeItem({ id: "i4", state: "dismissed", headline: "Dismissed issue", dismissReason: "Not relevant" }),
        makeItem({ id: "i5", state: "escalated", headline: "Escalated issue" }),
      ];

      renderPanel({ snapshot: makeSnapshot(items) });

      expect(screen.getByText("New issue 1")).toBeTruthy();
      expect(screen.getByText("New issue 2")).toBeTruthy();
      expect(screen.getByText("Fixed issue")).toBeTruthy();
      expect(screen.getByText("Dismissed issue")).toBeTruthy();
      expect(screen.getByText("Escalated issue")).toBeTruthy();
    });

    it("shows item headline, source label, and location", () => {
      const items = [
        makeItem({
          id: "loc1",
          state: "new",
          headline: "Missing null check",
          source: "coderabbit",
          filePath: "src/main.ts",
          line: 42,
        }),
      ];

      renderPanel({ snapshot: makeSnapshot(items) });

      expect(screen.getByText("Missing null check")).toBeTruthy();
      expect(screen.getByText("CodeRabbit")).toBeTruthy();
      expect(screen.getByText("src/main.ts:42")).toBeTruthy();
    });

    it("shows file path without line when line is null", () => {
      const items = [
        makeItem({
          id: "loc2",
          state: "new",
          headline: "General file issue",
          filePath: "src/utils.ts",
          line: null,
        }),
      ];

      renderPanel({ snapshot: makeSnapshot(items) });
      expect(screen.getByText("src/utils.ts")).toBeTruthy();
    });

    it("shows sent_to_agent items with working badge", () => {
      const items = [
        makeItem({ id: "w1", state: "sent_to_agent", headline: "Working item" }),
      ];

      renderPanel({ snapshot: makeSnapshot(items) });
      expect(screen.getByText("Working item")).toBeTruthy();
      expect(screen.getByText("working")).toBeTruthy();
    });

    it("displays dismiss reason text for dismissed items", () => {
      const items = [
        makeItem({ id: "d1", state: "dismissed", headline: "Dismissed one", dismissReason: "False positive" }),
      ];

      renderPanel({ snapshot: makeSnapshot(items) });
      expect(screen.getByText("False positive")).toBeTruthy();
    });

    it("shows body preview when body is present", () => {
      const items = [
        makeItem({ id: "b1", state: "new", headline: "With body", body: "This is the body preview text" }),
      ];

      renderPanel({ snapshot: makeSnapshot(items) });
      expect(screen.getByText("This is the body preview text")).toBeTruthy();
    });

    it("shows thread latest comment author in summary", () => {
      const items = [
        makeItem({ id: "a1", state: "new", headline: "Authored item", threadLatestCommentAuthor: "alice" }),
      ];

      renderPanel({ snapshot: makeSnapshot(items) });
      expect(screen.getByText("Latest reply by alice")).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // CI checks display
  // -------------------------------------------------------------------------
  describe("CI checks display", () => {
    it("shows failing check count", () => {
      const checks: PrCheck[] = [
        { name: "ci / lint", status: "completed", conclusion: "failure", detailsUrl: null, startedAt: null, completedAt: null },
        { name: "ci / test", status: "completed", conclusion: "success", detailsUrl: null, startedAt: null, completedAt: null },
      ];

      renderPanel({ checks });
      expect(screen.getByText("1 failing")).toBeTruthy();
      expect(screen.getByText("ci / lint")).toBeTruthy();
      expect(screen.getByText("ci / test")).toBeTruthy();
    });

    it("shows All passing when all checks succeed", () => {
      const checks: PrCheck[] = [
        { name: "ci / lint", status: "completed", conclusion: "success", detailsUrl: null, startedAt: null, completedAt: null },
        { name: "ci / test", status: "completed", conclusion: "success", detailsUrl: null, startedAt: null, completedAt: null },
      ];

      renderPanel({ checks });
      expect(screen.getByText("All passing")).toBeTruthy();
    });

    it("shows running status for in-progress checks", () => {
      const checks: PrCheck[] = [
        { name: "ci / build", status: "in_progress", conclusion: null, detailsUrl: null, startedAt: null, completedAt: null },
      ];

      renderPanel({ checks });
      expect(screen.getByText("ci / build")).toBeTruthy();
      expect(screen.getByText("running")).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Action callbacks
  // -------------------------------------------------------------------------
  describe("action callbacks", () => {
    it("calls onLaunchAgent with additional instructions when Launch Agent clicked (manual mode)", async () => {
      const user = userEvent.setup();
      const newItems = [makeItem({ id: "n1", state: "new", headline: "New one" })];
      const props = renderPanel({
        runtime: makeRuntime({ autoConverge: false }),
        snapshot: makeSnapshot(newItems),
        additionalInstructions: "focus on tests",
      });

      await user.click(screen.getByRole("button", { name: /launch agent/i }));
      expect(props.onLaunchAgent).toHaveBeenCalledWith("focus on tests");
    });

    it("calls onStartNextRound with additional instructions when Start Next Round clicked (auto mode)", async () => {
      const user = userEvent.setup();
      const newItems = [makeItem({ id: "n2", state: "new", headline: "New two" })];
      const props = renderPanel({
        runtime: makeRuntime({ autoConverge: true }),
        snapshot: makeSnapshot(newItems),
        additionalInstructions: "skip lint",
      });

      await user.click(screen.getByRole("button", { name: /start next round/i }));
      expect(props.onStartNextRound).toHaveBeenCalledWith("skip lint");
    });

    it("calls onCopyPrompt when Copy prompt clicked", async () => {
      const user = userEvent.setup();
      const props = renderPanel({ additionalInstructions: "my instructions" });

      await user.click(screen.getByRole("button", { name: /copy prompt/i }));
      expect(props.onCopyPrompt).toHaveBeenCalledWith("my instructions");
    });

    it("calls onStop when Stop button clicked", async () => {
      const user = userEvent.setup();
      const props = renderPanel({
        runtime: makeRuntime({ agentSessionId: "session-1" }),
      });

      await user.click(screen.getByRole("button", { name: /stop/i }));
      expect(props.onStop).toHaveBeenCalled();
    });

    it("calls onResetInventory when Reset button clicked", async () => {
      const user = userEvent.setup();
      const items = [makeItem({ id: "r1", state: "new", headline: "Reset me" })];
      const props = renderPanel({ snapshot: makeSnapshot(items) });

      await user.click(screen.getByRole("button", { name: /reset/i }));
      expect(props.onResetInventory).toHaveBeenCalled();
    });

    it("calls onMarkDismissed when Dismiss button clicked on an item", async () => {
      const user = userEvent.setup();
      const items = [makeItem({ id: "dismiss-1", state: "new", headline: "Dismiss me" })];
      const props = renderPanel({ snapshot: makeSnapshot(items) });

      const dismissButtons = screen.getAllByRole("button", { name: /dismiss/i });
      // The first Dismiss button belongs to the item row
      await user.click(dismissButtons[0]);
      expect(props.onMarkDismissed).toHaveBeenCalledWith(["dismiss-1"], "Dismissed from Path to Merge");
    });

    it("calls onMarkEscalated when Escalate button clicked on an item", async () => {
      const user = userEvent.setup();
      const items = [makeItem({ id: "esc-1", state: "new", headline: "Escalate me" })];
      const props = renderPanel({ snapshot: makeSnapshot(items) });

      await user.click(screen.getByRole("button", { name: /escalate/i }));
      expect(props.onMarkEscalated).toHaveBeenCalledWith(["esc-1"]);
    });

    it("calls onViewSession when View agent session clicked", async () => {
      const user = userEvent.setup();
      const props = renderPanel({
        runtime: makeRuntime({ sessionHref: "https://session.url/123" }),
      });

      await user.click(screen.getByRole("button", { name: /view agent session/i }));
      expect(props.onViewSession).toHaveBeenCalledWith("https://session.url/123");
    });
  });

  // -------------------------------------------------------------------------
  // Disabled states
  // -------------------------------------------------------------------------
  describe("disabled states", () => {
    it("disables Launch Agent button when busy", () => {
      const items = [makeItem({ id: "b1", state: "new", headline: "New" })];
      renderPanel({
        busy: true,
        snapshot: makeSnapshot(items),
        runtime: makeRuntime({ autoConverge: false }),
      });

      const launchBtn = screen.getByRole("button", { name: /launching|working|launch agent/i });
      expect(launchBtn).toHaveProperty("disabled", true);
    });

    it("disables action button when there are no new items", () => {
      const items = [makeItem({ id: "f1", state: "fixed", headline: "Fixed one" })];
      renderPanel({
        snapshot: makeSnapshot(items),
        runtime: makeRuntime({ autoConverge: false }),
      });

      const launchBtn = screen.getByRole("button", { name: /launch agent/i });
      expect(launchBtn).toHaveProperty("disabled", true);
    });

    it("disables action button when session is active (working phase)", () => {
      const items = [makeItem({ id: "w1", state: "new", headline: "New one" })];
      renderPanel({
        snapshot: makeSnapshot(items),
        runtime: makeRuntime({ phase: "working" }),
      });

      const actionBtn = screen.getByRole("button", { name: /working/i });
      expect(actionBtn).toHaveProperty("disabled", true);
    });

    it("disables Dismiss button on fixed items", () => {
      const items = [makeItem({ id: "fx1", state: "fixed", headline: "Already fixed" })];
      renderPanel({ snapshot: makeSnapshot(items) });

      const dismissButtons = screen.getAllByRole("button", { name: /dismiss/i });
      const rowDismiss = dismissButtons[0];
      expect(rowDismiss).toHaveProperty("disabled", true);
    });

    it("disables Escalate button on dismissed items", () => {
      const items = [makeItem({ id: "dx1", state: "dismissed", headline: "Already dismissed" })];
      renderPanel({ snapshot: makeSnapshot(items) });

      const escalateBtn = screen.getByRole("button", { name: /escalate/i });
      expect(escalateBtn).toHaveProperty("disabled", true);
    });

    it("disables Reset button when there are no items", () => {
      renderPanel({ snapshot: makeSnapshot([]) });
      const resetBtn = screen.getByRole("button", { name: /reset/i });
      expect(resetBtn).toHaveProperty("disabled", true);
    });

    it("does not show Stop button when no agent session is active", () => {
      renderPanel({ runtime: makeRuntime({ agentSessionId: null }) });
      expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
    });

    it("does not show View agent session button when no sessionHref", () => {
      renderPanel({ runtime: makeRuntime({ sessionHref: null }) });
      expect(screen.queryByRole("button", { name: /view agent session/i })).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Action button label changes
  // -------------------------------------------------------------------------
  describe("action button labels", () => {
    it("shows Working... when session is active", () => {
      const items = [makeItem({ id: "n1", state: "new", headline: "New" })];
      renderPanel({
        snapshot: makeSnapshot(items),
        runtime: makeRuntime({ phase: "working" }),
      });
      expect(screen.getByText("Working...")).toBeTruthy();
    });

    it("shows Launching... when phase is launching", () => {
      const items = [makeItem({ id: "n1", state: "new", headline: "New" })];
      renderPanel({
        snapshot: makeSnapshot(items),
        runtime: makeRuntime({ phase: "launching" }),
      });
      expect(screen.getByText("Launching...")).toBeTruthy();
    });

    it("shows Start Next Round when autoConverge is on and idle", () => {
      const items = [makeItem({ id: "n1", state: "new", headline: "New" })];
      renderPanel({
        snapshot: makeSnapshot(items),
        runtime: makeRuntime({ autoConverge: true, phase: "idle" }),
      });
      expect(screen.getByText("Start Next Round")).toBeTruthy();
    });

    it("shows Launch Agent when autoConverge is off and idle", () => {
      const items = [makeItem({ id: "n1", state: "new", headline: "New" })];
      renderPanel({
        snapshot: makeSnapshot(items),
        runtime: makeRuntime({ autoConverge: false, phase: "idle" }),
      });
      expect(screen.getByText("Launch Agent")).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Poller phase badges
  // -------------------------------------------------------------------------
  describe("poller phase badges", () => {
    it("shows Waiting for checks badge", () => {
      renderPanel({ runtime: makeRuntime({ pollerPhase: "waiting_checks" }) });
      expect(screen.getByText("Waiting for checks")).toBeTruthy();
    });

    it("shows Waiting for comments badge", () => {
      renderPanel({ runtime: makeRuntime({ pollerPhase: "waiting_comments" }) });
      expect(screen.getByText("Waiting for comments")).toBeTruthy();
    });

    it("shows Polling badge", () => {
      renderPanel({ runtime: makeRuntime({ pollerPhase: "polling" }) });
      expect(screen.getByText("Polling")).toBeTruthy();
    });

    it("shows Polling paused badge", () => {
      renderPanel({ runtime: makeRuntime({ pollerPhase: "paused" }) });
      expect(screen.getByText("Polling paused")).toBeTruthy();
    });

    it("does not show poller badge when idle", () => {
      renderPanel({ runtime: makeRuntime({ pollerPhase: "idle" }) });
      expect(screen.queryByText("Waiting for checks")).toBeNull();
      expect(screen.queryByText("Waiting for comments")).toBeNull();
      expect(screen.queryByText(/^Polling$/)).toBeNull();
      expect(screen.queryByText("Polling paused")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Additional instructions textarea
  // -------------------------------------------------------------------------
  describe("additional instructions", () => {
    it("renders textarea with current value in manual mode", () => {
      renderPanel({
        runtime: makeRuntime({ autoConverge: false }),
        additionalInstructions: "hello world",
      });

      const textarea = screen.getByPlaceholderText("Add instructions for this round...");
      expect((textarea as HTMLTextAreaElement).value).toBe("hello world");
    });

    it("renders textarea with current value in auto-converge mode", () => {
      renderPanel({
        runtime: makeRuntime({ autoConverge: true }),
        additionalInstructions: "auto hello",
      });

      const textarea = screen.getByPlaceholderText("Additional instructions for this round...");
      expect((textarea as HTMLTextAreaElement).value).toBe("auto hello");
    });

    it("calls onAdditionalInstructionsChange when typing", async () => {
      const user = userEvent.setup();
      const props = renderPanel({
        runtime: makeRuntime({ autoConverge: false }),
        additionalInstructions: "",
      });

      const textarea = screen.getByPlaceholderText("Add instructions for this round...");
      await user.type(textarea, "x");
      expect(props.onAdditionalInstructionsChange).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Summary counts
  // -------------------------------------------------------------------------
  describe("summary counts", () => {
    it("displays counts for each state in summary area", () => {
      const items = [
        makeItem({ id: "s1", state: "new" }),
        makeItem({ id: "s2", state: "new" }),
        makeItem({ id: "s3", state: "fixed" }),
        makeItem({ id: "s4", state: "dismissed" }),
        makeItem({ id: "s5", state: "escalated" }),
        makeItem({ id: "s6", state: "sent_to_agent" }),
      ];

      renderPanel({ snapshot: makeSnapshot(items) });

      // State labels appear both in summary counts and section headers, so use getAllByText.
      expect(screen.getAllByText("New").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Fixed").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Dismissed").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Escalated").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Working").length).toBeGreaterThanOrEqual(1);
    });
  });
});
