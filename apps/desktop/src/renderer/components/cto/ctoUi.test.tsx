/* @vitest-environment jsdom */

import type { CtoIdentity, CtoCoreMemory, CtoSessionLogEntry } from "../../../shared/types";
import type { LinearSyncQueueItem, LinearWorkflowDefinition, LinearWorkflowRunDetail } from "../../../shared/types";
import {
  buildRunMatchSummary,
  describeTriggerSemantics,
  deriveRunStallSummary,
  shouldShowDelegationOverride,
} from "./LinearSyncPanel";
import { CtoSettingsPanel } from "./CtoSettingsPanel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { resolveCtoPrimaryLaneId } from "./ctoSessionViewState";

describe("CtoSettingsPanel (file group)", () => {
  vi.mock("./IdentityEditor", () => ({
    IdentityEditor: vi.fn(({ onCancel }: { onCancel: () => void }) => (
      <div data-testid="identity-editor">
        <button onClick={onCancel}>Cancel Edit</button>
      </div>
    )),
  }));

  vi.mock("./shared/TimelineEntry", () => ({
    TimelineEntry: vi.fn(({ title }: { title: string }) => (
      <div data-testid="timeline-entry">{title}</div>
    )),
  }));

  vi.mock("./OpenclawConnectionPanel", () => ({
    OpenclawConnectionPanel: vi.fn(() => <div data-testid="openclaw-panel" />),
  }));

  vi.mock("./CtoPromptPreview", () => ({
    CtoPromptPreview: vi.fn(() => <div data-testid="prompt-preview" />),
  }));

  vi.mock("./identityPresets", () => ({
    getCtoPersonalityPreset: vi.fn((key: string) => ({
      label: key === "strategic" ? "Strategic" : key,
      description: `Personality: ${key}`,
    })),
  }));

  /* ── Fixtures ── */

  function makeIdentity(overrides: Partial<CtoIdentity> = {}): CtoIdentity {
    return {
      version: 2,
      persona: "Senior CTO",
      personality: "strategic",
      customPersonality: null,
      modelPreferences: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        reasoningEffort: null,
      },
      ...overrides,
    } as CtoIdentity;
  }

  function makeCoreMemory(overrides: Partial<CtoCoreMemory> = {}): CtoCoreMemory {
    return {
      projectSummary: "A project about testing.",
      criticalConventions: ["TypeScript"],
      userPreferences: [],
      activeFocus: [],
      notes: [],
      ...overrides,
    } as CtoCoreMemory;
  }

  /* ── Tests ── */

  describe("CtoSettingsPanel", () => {
    const onSaveIdentity = vi.fn().mockResolvedValue(undefined);
    const onSaveCoreMemory = vi.fn().mockResolvedValue(undefined);
    const onResetOnboarding = vi.fn();

    beforeEach(() => {
      vi.clearAllMocks();
      onSaveIdentity.mockResolvedValue(undefined);
      onSaveCoreMemory.mockResolvedValue(undefined);
    });

    afterEach(() => {
      cleanup();
    });

    it("renders identity section with model info when identity is provided", () => {
      render(
        <CtoSettingsPanel
          identity={makeIdentity()}
          coreMemory={makeCoreMemory()}
          sessionLogs={[]}
          onSaveIdentity={onSaveIdentity}
          onSaveCoreMemory={onSaveCoreMemory}
        />,
      );
      expect(screen.getByText("anthropic/claude-sonnet-4-6")).toBeTruthy();
    });

    it("shows Loading when identity is null", () => {
      render(
        <CtoSettingsPanel
          identity={null}
          coreMemory={null}
          sessionLogs={[]}
          onSaveIdentity={onSaveIdentity}
          onSaveCoreMemory={onSaveCoreMemory}
        />,
      );
      const loadingElements = screen.getAllByText("Loading...");
      expect(loadingElements.length).toBeGreaterThanOrEqual(1);
    });

    it("displays core memory project summary in view mode", () => {
      render(
        <CtoSettingsPanel
          identity={makeIdentity()}
          coreMemory={makeCoreMemory({ projectSummary: "ADE is an agentic IDE." })}
          sessionLogs={[]}
          onSaveIdentity={onSaveIdentity}
          onSaveCoreMemory={onSaveCoreMemory}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Brief" }));
      expect(screen.getByText("ADE is an agentic IDE.")).toBeTruthy();
    });

    it("shows the reset onboarding button when callback is provided", () => {
      render(
        <CtoSettingsPanel
          identity={makeIdentity()}
          coreMemory={makeCoreMemory()}
          sessionLogs={[]}
          onSaveIdentity={onSaveIdentity}
          onSaveCoreMemory={onSaveCoreMemory}
          onResetOnboarding={onResetOnboarding}
        />,
      );
      expect(screen.getByText("Re-run setup")).toBeTruthy();
    });

    it("does not show reset onboarding when callback is omitted", () => {
      render(
        <CtoSettingsPanel
          identity={makeIdentity()}
          coreMemory={makeCoreMemory()}
          sessionLogs={[]}
          onSaveIdentity={onSaveIdentity}
          onSaveCoreMemory={onSaveCoreMemory}
        />,
      );
      expect(screen.queryByText("Re-run setup")).toBeNull();
    });

    it("calls onSaveCoreMemory with parsed arrays when saving memory edits", async () => {
      render(
        <CtoSettingsPanel
          identity={makeIdentity()}
          coreMemory={makeCoreMemory()}
          sessionLogs={[]}
          onSaveIdentity={onSaveIdentity}
          onSaveCoreMemory={onSaveCoreMemory}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Brief" }));
      const editBtns = screen.getAllByTestId("core-memory-edit-btn");
      expect(editBtns.length).toBeGreaterThanOrEqual(1);
      fireEvent.click(editBtns[0]);

      const saveBtn = screen.getByTestId("core-memory-save-btn");
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(onSaveCoreMemory).toHaveBeenCalledTimes(1);
      });

      const callArgs = onSaveCoreMemory.mock.calls[0][0];
      expect(callArgs).toHaveProperty("projectSummary");
      expect(Array.isArray(callArgs.criticalConventions)).toBe(true);
      expect(Array.isArray(callArgs.userPreferences)).toBe(true);
      expect(Array.isArray(callArgs.activeFocus)).toBe(true);
      expect(Array.isArray(callArgs.notes)).toBe(true);
    });

    it("can cancel memory editing and return to view mode", () => {
      render(
        <CtoSettingsPanel
          identity={makeIdentity()}
          coreMemory={makeCoreMemory()}
          sessionLogs={[]}
          onSaveIdentity={onSaveIdentity}
          onSaveCoreMemory={onSaveCoreMemory}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Brief" }));
      const editBtns = screen.getAllByTestId("core-memory-edit-btn");
      fireEvent.click(editBtns[0]);
      expect(screen.getByTestId("core-memory-cancel-btn")).toBeTruthy();

      fireEvent.click(screen.getByTestId("core-memory-cancel-btn"));
      expect(screen.getAllByTestId("core-memory-view").length).toBeGreaterThanOrEqual(1);
    });

    it("displays memory save error when save fails", async () => {
      onSaveCoreMemory.mockRejectedValueOnce(new Error("Network error"));

      render(
        <CtoSettingsPanel
          identity={makeIdentity()}
          coreMemory={makeCoreMemory()}
          sessionLogs={[]}
          onSaveIdentity={onSaveIdentity}
          onSaveCoreMemory={onSaveCoreMemory}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Brief" }));
      const editBtns = screen.getAllByTestId("core-memory-edit-btn");
      fireEvent.click(editBtns[0]);
      fireEvent.click(screen.getByTestId("core-memory-save-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("core-memory-save-error")).toBeTruthy();
      });
      expect(screen.getByText("Network error")).toBeTruthy();
    });

    it("renders model and personality tags for identity", () => {
      render(
        <CtoSettingsPanel
          identity={makeIdentity({
            personality: "strategic",
            modelPreferences: {
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              reasoningEffort: "high",
            },
          })}
          coreMemory={makeCoreMemory()}
          sessionLogs={[]}
          onSaveIdentity={onSaveIdentity}
          onSaveCoreMemory={onSaveCoreMemory}
        />,
      );
      expect(screen.getByText("anthropic/claude-sonnet-4-6")).toBeTruthy();
      expect(screen.getByText("reasoning: high")).toBeTruthy();
      expect(screen.getByText("Strategic")).toBeTruthy();
    });

    // Removed tests ("shows Configured", "shows Needs work", "renders the CTO
    // runtime header card"): the sub-tab refactor removed the status badges and
    // the "CTO runtime" / "Identity, brief, and continuity" header card. Those
    // UI elements no longer exist in the component.

    it("renders sub-tab navigation", () => {
      render(
        <CtoSettingsPanel
          identity={makeIdentity()}
          coreMemory={makeCoreMemory()}
          sessionLogs={[]}
          onSaveIdentity={onSaveIdentity}
          onSaveCoreMemory={onSaveCoreMemory}
        />,
      );
      expect(screen.getByRole("button", { name: "Identity" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Brief" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Integrations" })).toBeTruthy();
    });

    it("shows session history timeline entries in the Brief tab", () => {
      render(
        <CtoSettingsPanel
          identity={makeIdentity()}
          coreMemory={makeCoreMemory()}
          sessionLogs={[
            {
              id: "s1",
              createdAt: "2026-03-26T00:00:00.000Z",
              summary: "Fixed deployment pipeline",
              capabilityMode: "full_tooling",
            } as CtoSessionLogEntry,
          ]}
          onSaveIdentity={onSaveIdentity}
          onSaveCoreMemory={onSaveCoreMemory}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Brief" }));
      const entries = screen.getAllByTestId("timeline-entry");
      expect(entries).toHaveLength(1);
    });
  });

});

describe("LinearSyncPanel (file group)", () => {
  function makeWorkflow(triggerOverrides: Partial<LinearWorkflowDefinition["triggers"]> = {}): LinearWorkflowDefinition {
    return {
      id: "workflow-1",
      name: "Workflow",
      description: null,
      enabled: true,
      priority: 0,
      source: "repo",
      triggers: {
        assignees: [],
        labels: [],
        projectSlugs: [],
        teamKeys: [],
        priority: [],
        stateTransitions: [],
        owner: [],
        creator: [],
        metadataTags: [],
        ...triggerOverrides,
      },
    } as unknown as LinearWorkflowDefinition;
  }

  function makeRunDetail(overrides: Partial<LinearWorkflowRunDetail> = {}): LinearWorkflowRunDetail {
    return {
      run: {
        id: "run-1",
        issueId: "issue-1",
        identifier: "LIN-1",
        title: "Example",
        workflowId: "workflow-1",
        workflowName: "Workflow",
        workflowVersion: "1",
        source: "linear",
        targetType: "worker_run",
        status: "queued",
        currentStepIndex: 0,
        currentStepId: null,
        executionLaneId: null,
        linkedMissionId: null,
        linkedSessionId: null,
        linkedWorkerRunId: null,
        linkedPrId: null,
        reviewState: null,
        supervisorIdentityKey: null,
        reviewReadyReason: null,
        prState: null,
        prChecksStatus: null,
        prReviewStatus: null,
        latestReviewNote: null,
        retryCount: 0,
        retryAfter: null,
        closeoutState: "pending",
        terminalOutcome: null,
        sourceIssueSnapshot: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides.run,
      } as unknown as LinearWorkflowRunDetail["run"],
      steps: [],
      events: [],
      ingressEvents: [],
      syncEvents: [],
      issue: null,
      reviewContext: null,
      ...overrides,
    } as LinearWorkflowRunDetail;
  }

  describe("LinearSyncPanel", () => {
    it("shows delegation overrides for queue states that still need manual routing or recovery", () => {
      expect(shouldShowDelegationOverride("queued")).toBe(true);
      expect(shouldShowDelegationOverride("retry_wait")).toBe(true);
      expect(shouldShowDelegationOverride("escalated")).toBe(true);
      expect(shouldShowDelegationOverride("awaiting_delegation")).toBe(true);
      expect(shouldShowDelegationOverride("dispatched")).toBe(false);
      expect(shouldShowDelegationOverride("failed")).toBe(false);
      expect(shouldShowDelegationOverride("resolved")).toBe(false);
      expect(shouldShowDelegationOverride("cancelled")).toBe(false);
    });

    it("describes trigger semantics as OR within groups and AND across populated groups", () => {
      expect(describeTriggerSemantics(makeWorkflow())).toContain("Populated groups are OR-ed within the group and AND-ed across groups");
      expect(
        describeTriggerSemantics(
          makeWorkflow({
            assignees: ["alice"],
          })
        )
      ).toContain("This workflow fires when the populated trigger group matches");
      expect(
        describeTriggerSemantics(
          makeWorkflow({
            assignees: ["alice"],
            labels: ["bug"],
          })
        )
      ).toContain("Each populated trigger group must match");
    });

    it("summarizes route matches from run events and route context", () => {
      const detail = makeRunDetail({
        run: {
          routeContext: {
            reason: "Matched by routing rules",
            matchedSignals: ["assignee:alice", "label:bug"],
            routeTags: ["watch-only", "priority:high"],
            watchOnly: false,
          },
        } as unknown as LinearWorkflowRunDetail["run"],
        events: [
          {
            id: "event-1",
            runId: "run-1",
            eventType: "run.created",
            status: "completed",
            message: "Matched workflow 'Workflow'.",
            payload: {
              candidates: [
                {
                  workflowId: "workflow-1",
                  workflowName: "Workflow",
                  priority: 1,
                  matched: true,
                  reasons: ["assignee matched", "label matched"],
                  matchedSignals: ["assignee:alice", "label:bug"],
                },
              ],
              nextStepsPreview: ["launch worker", "wait for review"],
            },
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      const summary = buildRunMatchSummary(detail);
      expect(summary).not.toBeNull();
      expect(summary?.reason).toContain("Matched workflow");
      expect(summary?.matchedSignals).toEqual(["assignee:alice", "label:bug"]);
      expect(summary?.routeTags).toEqual(["watch-only", "priority:high"]);
      expect(summary?.nextStepsPreview).toEqual(["launch worker", "wait for review"]);
      expect(summary?.matchedCandidate?.matched).toBe(true);
    });

    it("derives a readable stall summary from the current step and queue timing", () => {
      const retryItem = {
        id: "run-1",
        status: "retry_wait",
        nextAttemptAt: "2026-01-01T01:00:00.000Z",
      } as LinearSyncQueueItem;

      expect(
        deriveRunStallSummary(
          makeRunDetail({
            run: { status: "awaiting_delegation" } as unknown as LinearWorkflowRunDetail["run"],
          })
        )
      ).toContain("No employee could be resolved");

      expect(
        deriveRunStallSummary(
          makeRunDetail({
            run: { status: "awaiting_lane_choice" } as unknown as LinearWorkflowRunDetail["run"],
          })
        )
      ).toContain("Pick an execution lane");

      expect(
        deriveRunStallSummary(
          makeRunDetail({
            run: {
              status: "waiting_for_target",
              executionContext: {
                stalledReason: "Waiting on PR review.",
                waitingFor: "explicit_completion",
              },
            } as unknown as LinearWorkflowRunDetail["run"],
          }),
          retryItem
        )
      ).toContain("Waiting on PR review.");

      expect(
        deriveRunStallSummary(
          makeRunDetail({
            run: {
              status: "retry_wait",
              executionContext: {
                waitingFor: "explicit_completion",
              },
            } as unknown as LinearWorkflowRunDetail["run"],
          }),
          retryItem
        )
      ).toContain("Retry is scheduled for");
    });
  });

});

describe("ctoSessionViewState (file group)", () => {
  describe("resolveCtoPrimaryLaneId", () => {
    it("prefers the primary lane even when another lane is selected elsewhere in the app", () => {
      expect(resolveCtoPrimaryLaneId([
        { id: "lane-feature", laneType: "worktree" },
        { id: "lane-primary", laneType: "primary" },
      ])).toBe("lane-primary");
    });

    it("falls back to the first lane when a primary lane has not been materialized yet", () => {
      expect(resolveCtoPrimaryLaneId([
        { id: "lane-feature", laneType: "worktree" },
        { id: "lane-bugfix", laneType: "worktree" },
      ])).toBe("lane-feature");
    });

    it("returns null when no lanes are available", () => {
      expect(resolveCtoPrimaryLaneId([])).toBeNull();
    });
  });

});
