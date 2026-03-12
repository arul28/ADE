// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import type { LinearWorkflowConfig } from "../../../shared/types";
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

function buildBridge(policy = buildBasePolicy()) {
  const saveFlowPolicy = vi.fn(async ({ policy: nextPolicy }: { policy: LinearWorkflowConfig }) => nextPolicy);
  const ensureLinearWebhook = vi.fn(async () => ({
    localWebhook: { configured: true, healthy: true, status: "listening", url: "http://127.0.0.1:4580/linear-webhooks" },
    relay: { configured: true, healthy: true, status: "ready", webhookUrl: "https://relay.example.com/webhooks/linear/flow-1" },
    reconciliation: { enabled: true, intervalSec: 30, lastRunAt: "2026-03-05T00:00:00.000Z" },
  }));

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
        queue: { queued: 0, retryWaiting: 0, escalated: 0, dispatched: 0, failed: 0 },
        claimsActive: 0,
      })),
      listLinearSyncQueue: vi.fn(async () => []),
      runLinearSyncNow: vi.fn(async () => ({
        enabled: true,
        running: false,
        ingressMode: "webhook-first",
        reconciliationIntervalSec: 30,
        lastPollAt: "2026-03-05T00:00:00.000Z",
        lastSuccessAt: "2026-03-05T00:00:00.000Z",
        lastError: null,
        queue: { queued: 0, retryWaiting: 0, escalated: 0, dispatched: 0, failed: 0 },
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
          role: "backend",
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
    expect(screen.getByText("Has workflow label")).toBeTruthy();
    expect(screen.getByText("Watch It Live")).toBeTruthy();
    expect(screen.getByText("Real-Time Ingress")).toBeTruthy();
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

  it("ensures the webhook from the ingress card", async () => {
    const bridge = buildBridge();
    (window as any).ade = bridge;

    render(<LinearSyncPanel />);

    await waitFor(() => expect(screen.getByTestId("linear-ensure-webhook-btn")).toBeTruthy());
    fireEvent.click(screen.getByTestId("linear-ensure-webhook-btn"));

    await waitFor(() => expect(bridge.cto.ensureLinearWebhook).toHaveBeenCalledTimes(1));
  });
});
