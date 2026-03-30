import { describe, expect, it } from "vitest";
import {
  buildRunMatchSummary,
  describeTriggerSemantics,
  deriveRunStallSummary,
  shouldShowDelegationOverride,
} from "./LinearSyncPanel";
import type { LinearSyncQueueItem, LinearWorkflowDefinition, LinearWorkflowRunDetail } from "../../../shared/types";

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
