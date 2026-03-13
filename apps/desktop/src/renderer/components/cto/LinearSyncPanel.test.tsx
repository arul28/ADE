// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import type { LinearWorkflowConfig, LinearWorkflowRunDetail, LinearSyncQueueItem } from "../../../shared/types";
import { LinearSyncPanel } from "./LinearSyncPanel";

function buildBasePolicy(): LinearWorkflowConfig {
  return {
    version: 1,
    source: "repo",
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "flow-1",
        name: "Assigned employee -> review handoff",
        enabled: true,
        priority: 100,
        description: "Visual workflow test",
        source: "repo",
        triggers: { assignees: [], labels: [] },
        target: { type: "employee_session", runMode: "assisted", sessionTemplate: "default" },
        steps: [
          { id: "launch", type: "launch_target", name: "Launch delegated employee chat" },
          { id: "complete", type: "complete_issue", name: "Mark workflow complete" },
        ],
        closeout: {
          successState: "in_review",
          failureState: "blocked",
          applyLabels: ["ade"],
          resolveOnSuccess: true,
          reopenOnFailure: true,
          artifactMode: "links",
          reviewReadyWhen: "work_complete",
        },
        retry: { maxAttempts: 3, baseDelaySec: 30 },
        concurrency: { maxActiveRuns: 5, perIssue: 1 },
        observability: { emitNotifications: true, captureIssueSnapshot: true, persistTimeline: true },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };
}

function buildBridge(
  policy = buildBasePolicy(),
  options: {
    queue?: LinearSyncQueueItem[];
    runDetail?: LinearWorkflowRunDetail | null;
  } = {}
) {
  const saveFlowPolicy = vi.fn(async ({ policy: nextPolicy }: { policy: LinearWorkflowConfig }) => nextPolicy);
  const ensureLinearWebhook = vi.fn(async () => ({
    localWebhook: { configured: true, healthy: true, status: "listening", url: "http://127.0.0.1:4580/linear-webhooks" },
    relay: { configured: true, healthy: true, status: "ready", webhookUrl: "https://relay.example.com/webhooks/linear/flow-1" },
    reconciliation: { enabled: true, intervalSec: 30, lastRunAt: "2026-03-05T00:00:00.000Z" },
  }));
  const queue = options.queue ?? [];

  return {
    app: {
      openExternal: vi.fn(async () => {}),
    },
    cto: {
      getLinearConnectionStatus: vi.fn(async () => ({
        tokenStored: true,
        connected: true,
        viewerId: "viewer-1",
        viewerName: "Alex",
        checkedAt: "2026-03-05T00:00:00.000Z",
        message: null,
      })),
      getFlowPolicy: vi.fn(async () => policy),
      saveFlowPolicy,
      listFlowPolicyRevisions: vi.fn(async () => []),
      getLinearSyncDashboard: vi.fn(async () => ({
        enabled: true,
        running: false,
        ingressMode: "webhook-first",
        reconciliationIntervalSec: 30,
        lastPollAt: "2026-03-05T00:00:00.000Z",
        lastSuccessAt: "2026-03-05T00:00:00.000Z",
        lastError: null,
        queue: {
          queued: queue.filter((item) => item.status === "queued").length,
          retryWaiting: queue.filter((item) => item.status === "retry_wait").length,
          escalated: queue.filter((item) => item.status === "escalated").length,
          dispatched: queue.filter((item) => item.status === "dispatched").length,
          failed: queue.filter((item) => item.status === "failed").length,
        },
        claimsActive: 0,
      })),
      listLinearSyncQueue: vi.fn(async () => queue),
      resolveLinearSyncQueueItem: vi.fn(async () => queue[0] ?? null),
      getLinearWorkflowRunDetail: vi.fn(async () => options.runDetail ?? null),
      runLinearSyncNow: vi.fn(async () => ({
        enabled: true,
        running: false,
        ingressMode: "webhook-first",
        reconciliationIntervalSec: 30,
        lastPollAt: "2026-03-05T00:00:00.000Z",
        lastSuccessAt: "2026-03-05T00:00:00.000Z",
        lastError: null,
        queue: {
          queued: queue.filter((item) => item.status === "queued").length,
          retryWaiting: queue.filter((item) => item.status === "retry_wait").length,
          escalated: queue.filter((item) => item.status === "escalated").length,
          dispatched: queue.filter((item) => item.status === "dispatched").length,
          failed: queue.filter((item) => item.status === "failed").length,
        },
        claimsActive: 0,
      })),
      simulateFlowRoute: vi.fn(async () => ({
        workflowId: "flow-1",
        workflowName: "Assigned employee -> review handoff",
        workflow: policy.workflows[0] ?? null,
        target: policy.workflows[0]?.target ?? null,
        reason: "Matched assigned employee and workflow label.",
        candidates: [
          {
            workflowId: "flow-1",
            workflowName: "Assigned employee -> review handoff",
            priority: 100,
            matched: true,
            reasons: ["Assigned employee matched", "Workflow label matched"],
            matchedSignals: ["Assigned employee matched", "Workflow label matched"],
            missingSignals: [],
          },
        ],
        nextStepsPreview: ["Move issue to In Progress", "Launch delegated employee chat"],
        simulation: { matchedWorkflowId: "flow-1", explainsAndAcrossFields: true },
      })),
      getLinearWorkflowCatalog: vi.fn(async () => ({
        users: [{ id: "user-1", name: "Alex", displayName: "Alex", email: "alex@example.com", active: true }],
        labels: [
          { id: "label-1", name: "workflow:backend", color: "#ff0000", teamId: "team-1", teamKey: "MY" },
          { id: "label-2", name: "workflow:cto", color: "#00ff00", teamId: "team-1", teamKey: "MY" },
        ],
        states: [{ id: "state-1", name: "In Progress", type: "started", teamId: "team-1", teamKey: "MY" }],
      })),
      listAgents: vi.fn(async () => [
        {
          id: "agent-1",
          slug: "backend-dev",
          name: "Backend Dev",
          role: "engineer",
          title: "Backend Engineer",
          reportsTo: null,
          capabilities: ["code"],
          status: "idle",
          adapterType: "claude-local",
          adapterConfig: {},
          runtimeConfig: {},
          budgetMonthlyCents: 1000,
          spentMonthlyCents: 100,
          lastHeartbeatAt: null,
          createdAt: "2026-03-05T00:00:00.000Z",
          updatedAt: "2026-03-05T00:00:00.000Z",
          deletedAt: null,
          linearIdentity: { userIds: ["user-1"], displayNames: ["Alex"] },
        },
      ]),
      getLinearIngressStatus: vi.fn(async () => ({
        localWebhook: { configured: true, healthy: true, status: "listening", url: "http://127.0.0.1:4580/linear-webhooks" },
        relay: { configured: true, healthy: true, status: "ready", webhookUrl: "https://relay.example.com/webhooks/linear/flow-1" },
        reconciliation: { enabled: true, intervalSec: 30, lastRunAt: "2026-03-05T00:00:00.000Z" },
      })),
      listLinearIngressEvents: vi.fn(async () => [
        {
          id: "evt-1",
          source: "relay",
          deliveryId: "delivery-1",
          eventId: "event-1",
          entityType: "Issue",
          action: "update",
          issueId: "issue-1",
          issueIdentifier: "MY-1",
          summary: "Issue gained workflow label",
          payload: null,
          createdAt: "2026-03-05T00:00:00.000Z",
        },
      ]),
      ensureLinearWebhook,
      onLinearWorkflowEvent: vi.fn(() => () => {}),
      getLinearProjects: vi.fn(async () => [{ id: "project-1", name: "My Project", slug: "my-project", teamName: "Product" }]),
      startLinearOAuth: vi.fn(async () => ({ sessionId: "oauth-1", authUrl: "https://linear.app/oauth", redirectUri: "https://example.com/callback" })),
      getLinearOAuthSession: vi.fn(async () => ({ sessionId: "oauth-1", status: "pending", connection: null, error: null })),
      setLinearToken: vi.fn(async () => ({
        tokenStored: true,
        connected: true,
        viewerId: "viewer-1",
        viewerName: "Alex",
        checkedAt: "2026-03-05T00:00:00.000Z",
        message: null,
      })),
      clearLinearToken: vi.fn(async () => ({
        tokenStored: false,
        connected: false,
        viewerId: null,
        viewerName: null,
        checkedAt: "2026-03-05T00:00:00.000Z",
        message: "cleared",
      })),
    },
  };
}

describe("LinearSyncPanel", () => {
  beforeEach(() => {
    (window as any).ade = buildBridge();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders visual trigger controls and ingress status", async () => {
    render(<LinearSyncPanel />);

    await waitFor(() => expect(screen.getByText("Assigned to employee")).toBeTruthy());
    expect(screen.getByTestId("linear-first-run-guide")).toBeTruthy();
    expect(screen.getByText("Create your first real-time Linear workflow")).toBeTruthy();
    expect(screen.getByText("Where Linear workflows fit")).toBeTruthy();
    expect(screen.getByText(/CTO > Linear is for issue-driven automation/)).toBeTruthy();
    expect(screen.getByText("Has workflow label")).toBeTruthy();
    expect(screen.getByText("Watch It Live")).toBeTruthy();
    expect(screen.getByText("Optional Real-Time Ingress")).toBeTruthy();
    expect(screen.getByText("Recent Ingress Events")).toBeTruthy();
    expect(screen.getByText("Issue gained workflow label")).toBeTruthy();
  });

  it("authors the common assignee-plus-label workflow without YAML", async () => {
    const bridge = buildBridge();
    (window as any).ade = bridge;

    render(<LinearSyncPanel />);

    await waitFor(() => expect(screen.getByTestId("linear-trigger-assignee-select")).toBeTruthy());

    fireEvent.change(screen.getByTestId("linear-trigger-assignee-select"), { target: { value: "agent-1" } });
    fireEvent.click(screen.getByTestId("linear-trigger-assignee-add"));

    fireEvent.change(screen.getByTestId("linear-trigger-label-select"), { target: { value: "workflow:backend" } });
    fireEvent.click(screen.getByTestId("linear-trigger-label-add"));

    fireEvent.change(screen.getByTestId("linear-start-state-select"), { target: { value: "in_progress" } });
    fireEvent.change(screen.getByTestId("linear-wait-target-select"), { target: { value: "yes" } });
    fireEvent.change(screen.getByTestId("linear-pr-behavior-select"), { target: { value: "per-lane" } });
    fireEvent.change(screen.getByTestId("linear-review-ready-select"), { target: { value: "pr_created" } });
    fireEvent.click(screen.getByTestId("linear-notify-toggle"));
    fireEvent.click(screen.getByTestId("linear-save-policy-btn"));

    await waitFor(() => expect(bridge.cto.saveFlowPolicy).toHaveBeenCalledTimes(1));

    const savedPolicy = bridge.cto.saveFlowPolicy.mock.calls[0]?.[0]?.policy as LinearWorkflowConfig;
    const workflow = savedPolicy.workflows[0];
    expect(workflow?.triggers.assignees).toContain("agent-1");
    expect(workflow?.triggers.labels).toContain("workflow:backend");
    expect(workflow?.closeout?.successState).toBe("in_review");
    expect(workflow?.closeout?.reviewReadyWhen).toBe("pr_created");
    expect(workflow?.steps.map((step) => step.type)).toEqual([
      "set_linear_state",
      "launch_target",
      "wait_for_target_status",
      "wait_for_pr",
      "emit_app_notification",
      "complete_issue",
    ]);
  });

  it("authors a supervised fresh-lane workflow without YAML", async () => {
    const bridge = buildBridge();
    (window as any).ade = bridge;

    render(<LinearSyncPanel />);

    await waitFor(() => expect(screen.getByTestId("linear-target-type-select")).toBeTruthy());

    fireEvent.change(screen.getByTestId("linear-target-type-select"), { target: { value: "worker_run" } });
    fireEvent.change(screen.getByTestId("linear-wait-target-select"), { target: { value: "yes" } });
    fireEvent.change(screen.getByTestId("linear-lane-selection-select"), { target: { value: "fresh_issue_lane" } });
    fireEvent.change(screen.getByTestId("linear-pr-behavior-select"), { target: { value: "per-lane" } });
    fireEvent.change(screen.getByTestId("linear-pr-timing-select"), { target: { value: "after_start" } });
    fireEvent.change(screen.getByTestId("linear-supervisor-mode-select"), { target: { value: "after_pr" } });
    fireEvent.change(screen.getByTestId("linear-supervisor-identity-select"), { target: { value: "cto" } });
    fireEvent.change(screen.getByTestId("linear-supervisor-reject-select"), { target: { value: "loop_back" } });
    fireEvent.change(screen.getByTestId("linear-review-ready-select"), { target: { value: "pr_ready" } });
    fireEvent.click(screen.getByTestId("linear-save-policy-btn"));

    await waitFor(() => expect(bridge.cto.saveFlowPolicy).toHaveBeenCalledTimes(1));

    const savedPolicy = bridge.cto.saveFlowPolicy.mock.calls[0]?.[0]?.policy as LinearWorkflowConfig;
    const workflow = savedPolicy.workflows[0];
    expect(workflow?.target.type).toBe("worker_run");
    expect(workflow?.target.laneSelection).toBe("fresh_issue_lane");
    expect(workflow?.target.prTiming).toBe("after_start");
    expect(workflow?.closeout?.reviewReadyWhen).toBe("pr_ready");
    expect(workflow?.steps.map((step) => step.type)).toEqual([
      "launch_target",
      "wait_for_target_status",
      "wait_for_pr",
      "request_human_review",
      "complete_issue",
    ]);
    expect(workflow?.steps.find((step) => step.type === "request_human_review")?.rejectAction).toBe("loop_back");
  });

  it("renders run timeline detail and supervisor controls for a selected run", async () => {
    const queue: LinearSyncQueueItem[] = [
      {
        id: "run-1",
        runId: "run-1",
        issueId: "issue-1",
        identifier: "MY-1",
        title: "Implement backend workflow",
        status: "escalated",
        workflowId: "flow-1",
        workflowName: "Assigned employee -> review handoff",
        targetType: "worker_run",
        laneId: "lane-42",
        workerId: "agent-1",
        workerSlug: "backend-dev",
        missionId: null,
        sessionId: null,
        workerRunId: "worker-run-1",
        prId: "pr-42",
        prState: "open",
        prChecksStatus: "passing",
        prReviewStatus: "requested",
        currentStepId: "review",
        currentStepLabel: "Supervisor review",
        reviewState: "pending",
        supervisorIdentityKey: "cto",
        reviewReadyReason: null,
        latestReviewNote: null,
        attemptCount: 0,
        nextAttemptAt: null,
        lastError: null,
        createdAt: "2026-03-05T00:00:00.000Z",
        updatedAt: "2026-03-05T00:05:00.000Z",
      },
    ];

    const runDetail: LinearWorkflowRunDetail = {
      run: {
        id: "run-1",
        issueId: "issue-1",
        identifier: "MY-1",
        title: "Implement backend workflow",
        workflowId: "flow-1",
        workflowName: "Assigned employee -> review handoff",
        workflowVersion: "2026-03-05T00:00:00.000Z",
        source: "repo",
        targetType: "worker_run",
        status: "awaiting_human_review",
        currentStepIndex: 2,
        currentStepId: "review",
        executionLaneId: "lane-42",
        linkedMissionId: null,
        linkedSessionId: null,
        linkedWorkerRunId: "worker-run-1",
        linkedPrId: "pr-42",
        reviewState: "pending",
        supervisorIdentityKey: "cto",
        reviewReadyReason: null,
        prState: "open",
        prChecksStatus: "passing",
        prReviewStatus: "requested",
        latestReviewNote: null,
        retryCount: 0,
        retryAfter: null,
        closeoutState: "pending",
        terminalOutcome: null,
        lastError: null,
        sourceIssueSnapshot: {},
        createdAt: "2026-03-05T00:00:00.000Z",
        updatedAt: "2026-03-05T00:05:00.000Z",
      },
      steps: [
        { id: "step-1", runId: "run-1", workflowStepId: "launch", type: "launch_target", name: "Launch worker run", status: "completed", startedAt: "2026-03-05T00:00:10.000Z", completedAt: "2026-03-05T00:00:20.000Z", payload: { laneId: "lane-42" } },
        { id: "step-2", runId: "run-1", workflowStepId: "wait", type: "wait_for_target_status", name: "Wait", status: "completed", startedAt: "2026-03-05T00:01:00.000Z", completedAt: "2026-03-05T00:04:00.000Z", payload: { targetState: "completed" } },
        { id: "step-3", runId: "run-1", workflowStepId: "review", type: "request_human_review", name: "Supervisor review", status: "waiting", startedAt: "2026-03-05T00:05:00.000Z", completedAt: null, payload: { reviewerIdentityKey: "cto" } },
      ],
      events: [
        { id: "event-1", runId: "run-1", eventType: "run.created", status: "queued", message: "Matched workflow 'Assigned employee -> review handoff'.", payload: null, createdAt: "2026-03-05T00:00:00.000Z" },
        { id: "event-2", runId: "run-1", eventType: "step.request_human_review", status: "waiting", message: "Awaiting supervisor approval.", payload: { reviewerIdentityKey: "cto" }, createdAt: "2026-03-05T00:05:00.000Z" },
      ],
      ingressEvents: [
        {
          id: "ingress-1",
          source: "relay",
          deliveryId: "delivery-1",
          eventId: "event-1",
          entityType: "Issue",
          action: "update",
          issueId: "issue-1",
          issueIdentifier: "MY-1",
          summary: "Issue gained workflow label",
          payload: null,
          createdAt: "2026-03-05T00:00:00.000Z",
        },
      ],
      issue: null,
      reviewContext: {
        reviewerIdentityKey: "cto",
        rejectAction: "loop_back",
        loopToStepId: "launch",
        instructions: "Review the worker handoff before moving to In Review.",
      },
    };

    const bridge = buildBridge(buildBasePolicy(), { queue, runDetail });
    (window as any).ade = bridge;

    render(<LinearSyncPanel />);

    await waitFor(() => expect(screen.getByTestId("linear-run-timeline-card")).toBeTruthy());
    expect(screen.getByText("Supervisor action required")).toBeTruthy();
    expect(screen.getByText("Awaiting supervisor approval.")).toBeTruthy();
    expect(screen.getByTestId("linear-run-timeline")).toBeTruthy();

    fireEvent.click(screen.getByText("Approve handoff"));
    await waitFor(() => expect(bridge.cto.resolveLinearSyncQueueItem).toHaveBeenCalledWith({
      queueItemId: "run-1",
      action: "approve",
      note: undefined,
    }));
  });

  it("ensures the webhook from the ingress card", async () => {
    const bridge = buildBridge();
    (window as any).ade = bridge;

    render(<LinearSyncPanel />);

    await waitFor(() => expect(screen.getByTestId("linear-ensure-webhook-btn")).toBeTruthy());
    fireEvent.click(screen.getByTestId("linear-ensure-webhook-btn"));

    await waitFor(() => expect(bridge.cto.ensureLinearWebhook).toHaveBeenCalledTimes(1));
  });
});
