// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { CtoPage } from "./CtoPage";
import type {
  AgentBudgetSnapshot,
  AgentConfigRevision,
  AgentCoreMemory,
  AgentIdentity,
  AgentSessionLogEntry,
  CtoCoreMemory,
  CtoOnboardingState,
  CtoSnapshot,
  WorkerAgentRun,
  LinearWorkflowConfig,
} from "../../../shared/types";

vi.mock("../chat/AgentChatPane", () => ({
  AgentChatPane: ({
    laneId,
    lockSessionId,
    presentation,
  }: {
    laneId: string | null;
    lockSessionId?: string | null;
    presentation?: { profile?: string; title?: string | null };
  }) => (
    <div data-testid="chat-pane-props">
      {`${laneId ?? "none"}::${lockSessionId ?? "none"}::${presentation?.profile ?? "none"}::${presentation?.title ?? "none"}`}
    </div>
  ),
}));

let mockLanes: Array<{ id: string }> = [{ id: "lane-1" }];
let mockSelectedLaneId: string | null = "lane-1";

vi.mock("../../state/appStore", () => ({
  useAppStore: (selector: (state: { lanes: Array<{ id: string }>; selectedLaneId: string | null }) => unknown) =>
    selector({ lanes: mockLanes, selectedLaneId: mockSelectedLaneId }),
}));

const makeCoreMemory = (overrides?: Partial<CtoCoreMemory>): CtoCoreMemory => ({
  version: 1,
  updatedAt: "2026-03-05T00:00:00.000Z",
  projectSummary: "Test project summary",
  criticalConventions: ["no force push"],
  userPreferences: ["small PRs"],
  activeFocus: ["stability"],
  notes: ["check CI"],
  ...overrides,
});

const makeSnapshot = (memoryOverrides?: Partial<CtoCoreMemory>): CtoSnapshot => ({
  identity: {
    name: "CTO",
    version: 1,
    persona: "Technical lead",
    modelPreferences: { provider: "claude", model: "sonnet" },
    memoryPolicy: { autoCompact: true, compactionThreshold: 0.7, preCompactionFlush: true, temporalDecayHalfLifeDays: 30 },
    updatedAt: "2026-03-05T00:00:00.000Z",
  },
  coreMemory: makeCoreMemory(memoryOverrides),
  recentSessions: [
    {
      id: "s1",
      sessionId: "sess-1",
      summary: "Reviewed auth module",
      startedAt: "2026-03-05T10:00:00.000Z",
      endedAt: "2026-03-05T10:10:00.000Z",
      provider: "claude",
      modelId: null,
      capabilityMode: "full_mcp",
      createdAt: "2026-03-05T10:00:00.000Z",
    },
  ],
  recentSubordinateActivity: [],
});

let mockSnapshot = makeSnapshot();
let mockOnboardingState: CtoOnboardingState = { completedSteps: ["identity", "project", "integrations"], completedAt: "2026-03-05T00:00:00.000Z" };

const makeSession = () => ({
  id: "cto-session-1",
  laneId: "lane-1",
  provider: "claude",
  model: "sonnet",
  identityKey: "cto",
  capabilityMode: "full_mcp" as const,
  status: "idle" as const,
  createdAt: "2026-03-05T00:00:00.000Z",
  lastActivityAt: "2026-03-05T00:00:00.000Z",
});

const makeWorkerAgent = (overrides?: Partial<AgentIdentity>): AgentIdentity => ({
  id: "agent-1",
  slug: "backend-dev",
  name: "Backend Dev",
  role: "backend" as any,
  title: "Backend Developer",
  reportsTo: null,
  capabilities: ["code", "test"],
  status: "idle",
  adapterType: "claude-local" as any,
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 5000,
  spentMonthlyCents: 1200,
  lastHeartbeatAt: undefined,
  createdAt: "2026-03-05T00:00:00.000Z",
  updatedAt: "2026-03-05T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const makeBudgetSnapshot = (): AgentBudgetSnapshot => ({
  computedAt: "2026-03-05T00:00:00.000Z",
  monthKey: "2026-03",
  companyBudgetMonthlyCents: 50000,
  companySpentMonthlyCents: 1200,
  companyExactSpentCents: 1000,
  companyEstimatedSpentCents: 200,
  companyRemainingCents: 48800,
  workers: [
    {
      agentId: "agent-1",
      name: "Backend Dev",
      budgetMonthlyCents: 5000,
      spentMonthlyCents: 1200,
      exactSpentCents: 1000,
      estimatedSpentCents: 200,
      remainingCents: 3800,
      status: "idle" as const,
    },
  ],
});

const makeAgentCoreMemory = (): AgentCoreMemory => ({
  version: 1,
  updatedAt: "2026-03-05T00:00:00.000Z",
  projectSummary: "Worker memory summary",
  criticalConventions: ["lint before push"],
  userPreferences: [],
  activeFocus: [],
  notes: [],
});

function buildCtoBridge() {
  const basePolicy: LinearWorkflowConfig = {
    version: 1,
    source: "repo",
    settings: { ctoLinearAssigneeName: "CTO", ctoLinearAssigneeAliases: ["cto"] },
    workflows: [
      {
        id: "cto-mission-autopilot",
        name: "CTO -> Mission autopilot",
        enabled: true,
        priority: 100,
        triggers: { assignees: ["CTO"], projectSlugs: ["my-project"], labels: ["bug"] },
        target: { type: "mission", runMode: "autopilot", workerSelector: { mode: "slug", value: "backend-dev" } },
        steps: [
          { id: "launch", type: "launch_target", name: "Launch mission" },
          { id: "wait", type: "wait_for_target_status", name: "Wait", targetStatus: "completed" },
          { id: "complete", type: "complete_issue", name: "Complete" },
        ],
        closeout: { successState: "done", failureState: "blocked", applyLabels: ["ade"], resolveOnSuccess: true, reopenOnFailure: true, artifactMode: "links" },
      },
    ],
    files: [],
    migration: { hasLegacyConfig: false, needsSave: false },
    legacyConfig: null,
  };

  return {
    getState: vi.fn(async () => mockSnapshot),
    ensureSession: vi.fn(async () => makeSession()),
    updateCoreMemory: vi.fn(async ({ patch }: { patch: Partial<CtoCoreMemory> }) => makeSnapshot(patch)),
    listSessionLogs: vi.fn(async () => makeSnapshot().recentSessions),
    updateIdentity: vi.fn(async () => makeSnapshot()),
    listAgents: vi.fn(async () => [makeWorkerAgent()]),
    saveAgent: vi.fn(async () => makeWorkerAgent()),
    removeAgent: vi.fn(async () => {}),
    setAgentStatus: vi.fn(async () => {}),
    listAgentRevisions: vi.fn(async () => [] as AgentConfigRevision[]),
    rollbackAgentRevision: vi.fn(async () => makeWorkerAgent()),
    ensureAgentSession: vi.fn(async () => makeSession()),
    getBudgetSnapshot: vi.fn(async () => makeBudgetSnapshot()),
    triggerAgentWakeup: vi.fn(async () => ({ runId: "run-1", status: "queued" as const })),
    listAgentRuns: vi.fn(async () => [] as WorkerAgentRun[]),
    getAgentCoreMemory: vi.fn(async () => makeAgentCoreMemory()),
    updateAgentCoreMemory: vi.fn(async () => makeAgentCoreMemory()),
    listAgentSessionLogs: vi.fn(async () => [] as AgentSessionLogEntry[]),
    getLinearConnectionStatus: vi.fn(async () => ({
      tokenStored: false,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: "2026-03-05T00:00:00.000Z",
      message: "Linear token not configured.",
    })),
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
      message: "Linear token cleared.",
    })),
    getFlowPolicy: vi.fn(async () => basePolicy),
    saveFlowPolicy: vi.fn(async ({ policy }: { policy: LinearWorkflowConfig }) => policy),
    listFlowPolicyRevisions: vi.fn(async () => []),
    rollbackFlowPolicyRevision: vi.fn(async () => basePolicy),
    simulateFlowRoute: vi.fn(async () => ({
      workflowId: "cto-mission-autopilot",
      workflowName: "CTO -> Mission autopilot",
      workflow: basePolicy.workflows[0],
      target: basePolicy.workflows[0]?.target ?? null,
      reason: "Matched bug route.",
      candidates: [
        {
          workflowId: "cto-mission-autopilot",
          workflowName: "CTO -> Mission autopilot",
          priority: 100,
          matched: true,
          reasons: ["Assignee matched CTO", "Label matched bug"],
          matchedSignals: ["Assigned employee matched", "Workflow label matched"],
          missingSignals: [],
        },
      ],
      nextStepsPreview: ["Launch mission", "Wait", "Complete"],
      simulation: { matchedWorkflowId: "cto-mission-autopilot", explainsAndAcrossFields: true },
    })),
    getLinearSyncDashboard: vi.fn(async () => ({
      enabled: false,
      running: false,
      ingressMode: "webhook-first",
      reconciliationIntervalSec: 30,
      lastPollAt: null,
      lastSuccessAt: null,
      lastError: null,
      queue: { queued: 0, retryWaiting: 0, escalated: 0, dispatched: 0, failed: 0 },
      claimsActive: 0,
    })),
    runLinearSyncNow: vi.fn(async () => ({
      enabled: false,
      running: false,
      ingressMode: "webhook-first",
      reconciliationIntervalSec: 30,
      lastPollAt: null,
      lastSuccessAt: null,
      lastError: null,
      queue: { queued: 0, retryWaiting: 0, escalated: 0, dispatched: 0, failed: 0 },
      claimsActive: 0,
    })),
    listLinearSyncQueue: vi.fn(async () => []),
    resolveLinearSyncQueueItem: vi.fn(async () => null),
    getLinearWorkflowCatalog: vi.fn(async () => ({
      users: [{ id: "user-1", name: "Alex", displayName: "Alex", email: "alex@example.com", active: true }],
      labels: [{ id: "label-1", name: "bug", color: "#ff0000", teamId: "team-1", teamKey: "MY" }],
      states: [{ id: "state-1", name: "In Progress", type: "started", teamId: "team-1", teamKey: "MY" }],
    })),
    getLinearIngressStatus: vi.fn(async () => ({
      localWebhook: { configured: true, healthy: true, status: "listening", url: "http://127.0.0.1:4580/linear-webhooks" },
      relay: { configured: true, healthy: true, status: "ready", webhookUrl: "https://relay.example.com/webhooks/linear/1" },
      reconciliation: { enabled: true, intervalSec: 30, lastRunAt: "2026-03-05T00:00:00.000Z" },
    })),
    listLinearIngressEvents: vi.fn(async () => [
      {
        id: "ingress-1",
        source: "relay",
        deliveryId: "delivery-1",
        eventId: "event-1",
        entityType: "Issue",
        action: "update",
        issueId: "issue-1",
        issueIdentifier: "MY-1",
        summary: "Issue label changed",
        payload: null,
        createdAt: "2026-03-05T00:00:00.000Z",
      },
    ]),
    ensureLinearWebhook: vi.fn(async () => ({
      localWebhook: { configured: true, healthy: true, status: "listening", url: "http://127.0.0.1:4580/linear-webhooks" },
      relay: { configured: true, healthy: true, status: "ready", webhookUrl: "https://relay.example.com/webhooks/linear/1" },
      reconciliation: { enabled: true, intervalSec: 30, lastRunAt: "2026-03-05T00:00:00.000Z" },
    })),
    onLinearWorkflowEvent: vi.fn(() => () => {}),
    getOnboardingState: vi.fn(async () => mockOnboardingState),
    dismissOnboarding: vi.fn(async () => {
      mockOnboardingState = { ...mockOnboardingState, dismissedAt: "2026-03-05T00:00:00.000Z" };
      return mockOnboardingState;
    }),
    resetOnboarding: vi.fn(async () => {
      mockOnboardingState = { completedSteps: [] };
      return mockOnboardingState;
    }),
    completeOnboardingStep: vi.fn(async ({ stepId }: { stepId: string }) => {
      mockOnboardingState = {
        ...mockOnboardingState,
        completedSteps: Array.from(new Set([...mockOnboardingState.completedSteps, stepId])),
      };
      return mockOnboardingState;
    }),
    previewSystemPrompt: vi.fn(async () => ({ prompt: "You are CTO.", tokenEstimate: 3 })),
    getLinearProjects: vi.fn(async () => [
      { id: "project-1", name: "My Project", slug: "my-project", teamName: "Product" },
    ]),
  };
}

/** Click a tab by its label text */
function clickTab(label: string) {
  const tabs = screen.getAllByText(label);
  // Tab buttons are font-mono uppercase — find the one that's a button
  const tab = tabs.find((el) => el.closest("button"));
  if (tab) fireEvent.click(tab);
}

describe("CtoPage", () => {
  beforeEach(() => {
    mockLanes = [{ id: "lane-1" }];
    mockSelectedLaneId = "lane-1";
    mockSnapshot = makeSnapshot();
    mockOnboardingState = { completedSteps: ["identity", "project", "integrations"], completedAt: "2026-03-05T00:00:00.000Z" };
    window.location.hash = "";
    (window as any).ade = {
      cto: buildCtoBridge(),
      onboarding: {
        detectDefaults: vi.fn(async () => ({
          projectTypes: ["node", "ci"],
          indicators: [
            { file: "package.json", type: "node", confidence: 0.95 },
            { file: ".github/workflows/test.yml", type: "github-actions", confidence: 0.7 },
          ],
          suggestedConfig: { version: 1 },
          suggestedWorkflows: [],
        })),
      },
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("renders agent sidebar, locks persistent CTO session, and shows capability badge", async () => {
    render(<CtoPage />);

    // Sidebar shows "Department" header
    expect(screen.getByText("Department")).toBeTruthy();

    await waitFor(() => {
      expect((window as any).ade.cto.ensureSession).toHaveBeenCalledWith({
        laneId: "lane-1",
        permissionMode: "full-auto",
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("chat-pane-props").textContent).toBe("lane-1::cto-session-1::persistent_identity::CTO");
    });

    await waitFor(() => {
      expect(screen.getByTestId("cto-capability-badge").textContent).toContain("FULL MCP");
    });
  });

  it("auto-opens the onboarding wizard on first run", async () => {
    mockOnboardingState = { completedSteps: [] };

    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByText(/Configure Your CTO/i)).toBeTruthy();
    });
    expect(screen.getByTestId("cto-onboarding-prompt-preview")).toBeTruthy();
    expect((window as any).ade.cto.ensureSession).not.toHaveBeenCalled();
    expect((window as any).ade.cto.listAgents).not.toHaveBeenCalled();
    expect((window as any).ade.cto.getBudgetSnapshot).not.toHaveBeenCalled();
  });

  it("lets the user dismiss onboarding on first run", async () => {
    mockOnboardingState = { completedSteps: [] };

    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByText(/Configure Your CTO/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Skip for now"));

    await waitFor(() => {
      expect(screen.queryByText(/Configure Your CTO/i)).toBeNull();
    });
    expect((window as any).ade.cto.dismissOnboarding).toHaveBeenCalledTimes(1);
  });

  it("can finish onboarding without connecting Linear", async () => {
    mockOnboardingState = { completedSteps: [] };

    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByText(/Configure Your CTO/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Save & Continue" }));
    await waitFor(() => {
      expect(screen.getByText("Project Context")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Save & Continue" }));
    await waitFor(() => {
      expect(screen.getByText("Integrations")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Finish Without Linear" }));

    await waitFor(() => {
      expect(screen.queryByText(/Configure Your CTO/i)).toBeNull();
    });
    expect((window as any).ade.cto.completeOnboardingStep).toHaveBeenCalledWith({ stepId: "integrations" });
  });

  it("shows the setup banner when onboarding was dismissed before completion", async () => {
    mockOnboardingState = {
      completedSteps: ["identity"],
      dismissedAt: "2026-03-05T00:00:00.000Z",
    };

    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByText(/Finish your persistent CTO setup/i)).toBeTruthy();
    });
  });

  it("loads and renders core memory view in Settings tab", async () => {
    render(<CtoPage />);

    // Navigate to Settings tab
    clickTab("Settings");

    await waitFor(() => {
      expect(screen.getByTestId("core-memory-view")).toBeTruthy();
    });

    expect(screen.getAllByText("Test project summary").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/no force push/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/stability/).length).toBeGreaterThan(0);
  });

  it("enters edit mode and saves core memory patch", async () => {
    render(<CtoPage />);
    clickTab("Settings");

    await waitFor(() => {
      expect(screen.getByTestId("core-memory-edit-btn")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("core-memory-edit-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("core-memory-save-btn")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("core-memory-save-btn"));

    await waitFor(() => {
      expect((window as any).ade.cto.updateCoreMemory).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId("core-memory-view")).toBeTruthy();
    });
  });

  it("shows save error when updateCoreMemory rejects", async () => {
    (window as any).ade.cto.updateCoreMemory = vi.fn(async () => {
      throw new Error("Network failure");
    });

    render(<CtoPage />);
    clickTab("Settings");

    await waitFor(() => {
      expect(screen.getByTestId("core-memory-edit-btn")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("core-memory-edit-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("core-memory-save-btn")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("core-memory-save-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("core-memory-save-error").textContent).toContain("Network failure");
    });
  });

  it("shows error when CTO bridge is unavailable", async () => {
    (window as any).ade = {};

    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByTestId("cto-error").textContent).toContain("CTO bridge is unavailable");
    });
  });

  it("shows no-lane message when no lane exists", async () => {
    mockLanes = [];
    mockSelectedLaneId = null;

    render(<CtoPage />);

    expect(screen.getByText(/Create a lane to start the persistent CTO session/i)).toBeTruthy();
    expect((window as any).ade.cto.ensureSession).not.toHaveBeenCalled();
  });

  it("opens the Team tab when the URL hash points to team setup", async () => {
    window.location.hash = "#team-setup";

    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByText("Department Overview")).toBeTruthy();
    });

    window.location.hash = "";
  });

  it("shows loading state while ensureSession is pending", async () => {
    let resolve!: (v: ReturnType<typeof makeSession>) => void;
    (window as any).ade.cto.ensureSession = vi.fn(
      () => new Promise<ReturnType<typeof makeSession>>((r) => { resolve = r; })
    );

    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByTestId("cto-loading")).toBeTruthy();
    });

    resolve(makeSession());

    await waitFor(() => {
      expect(screen.queryByTestId("cto-loading")).toBeNull();
    });
  });

  it("does not show capability badge until session is established", async () => {
    let resolve!: (v: ReturnType<typeof makeSession>) => void;
    (window as any).ade.cto.ensureSession = vi.fn(
      () => new Promise<ReturnType<typeof makeSession>>((r) => { resolve = r; })
    );

    render(<CtoPage />);

    expect(screen.queryByTestId("cto-capability-badge")).toBeNull();

    await waitFor(() => {
      expect((window as any).ade.cto.ensureSession).toHaveBeenCalled();
    });

    resolve(makeSession());

    await waitFor(() => {
      expect(screen.getByTestId("cto-capability-badge")).toBeTruthy();
    });
  });

  // W2: Worker agents
  it("loads and renders worker tree in sidebar", async () => {
    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByTestId("worker-tree")).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByTestId("worker-row-agent-1")).toBeTruthy();
    });

    expect(screen.getByText("Backend Dev")).toBeTruthy();
  });

  it("saves Linear identity mapping fields for a worker", async () => {
    render(<CtoPage />);

    await waitFor(() => expect(screen.getByTestId("worker-row-agent-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("worker-row-agent-1"));

    await waitFor(() => expect(screen.getByText("Edit")).toBeTruthy());
    fireEvent.click(screen.getByText("Edit"));

    await waitFor(() => expect(screen.getByText("Linear Identity Matching")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("user-123, user-456"), { target: { value: "user-1, user-2" } });
    fireEvent.change(screen.getByPlaceholderText("Alex Johnson, A. Johnson"), { target: { value: "Alex Johnson" } });
    fireEvent.change(screen.getByPlaceholderText("alex, backend-oncall"), { target: { value: "alex" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect((window as any).ade.cto.saveAgent).toHaveBeenCalledWith(expect.objectContaining({
        agent: expect.objectContaining({
          linearIdentity: {
            userIds: ["user-1", "user-2"],
            displayNames: ["Alex Johnson"],
            aliases: ["alex"],
          },
        }),
      }));
    });
  });

  it("calls listAgents but defers getBudgetSnapshot on initial chat mount", async () => {
    render(<CtoPage />);

    await waitFor(() => {
      expect((window as any).ade.cto.listAgents).toHaveBeenCalledWith({ includeDeleted: false });
    });

    expect((window as any).ade.cto.getBudgetSnapshot).not.toHaveBeenCalled();
  });

  it("displays budget summary", async () => {
    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByTestId("budget-company-row")).toBeTruthy();
    });
  });

  // W3: Heartbeat & activation
  it("shows worker details panel when worker is selected and Team tab is active", async () => {
    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByTestId("worker-row-agent-1")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("worker-row-agent-1"));

    // Clicking a worker switches to Chat tab by default; navigate to Team
    clickTab("Team");

    await waitFor(() => {
      expect(screen.getByTestId("worker-ops-panel")).toBeTruthy();
    });
  });

  it("does not start worker chat sessions while browsing the Team tab", async () => {
    render(<CtoPage />);

    await waitFor(() => expect(screen.getByTestId("worker-row-agent-1")).toBeTruthy());

    clickTab("Team");
    fireEvent.click(screen.getByTestId("worker-row-agent-1"));

    await waitFor(() => {
      expect(screen.getByTestId("worker-ops-panel")).toBeTruthy();
    });

    expect((window as any).ade.cto.ensureAgentSession).not.toHaveBeenCalled();

    clickTab("Chat");

    await waitFor(() => {
      expect((window as any).ade.cto.ensureAgentSession).toHaveBeenCalledWith({
        agentId: "agent-1",
        laneId: "lane-1",
        permissionMode: "full-auto",
      });
    });
  });

  it("renders worker activity in the selected worker detail view", async () => {
    (window as any).ade.cto.listAgentRuns = vi.fn(async () => [
      {
        id: "run-1",
        agentId: "agent-1",
        status: "completed",
        wakeupReason: "manual",
        context: {},
        createdAt: "2026-03-05T10:30:00.000Z",
        updatedAt: "2026-03-05T10:31:00.000Z",
      },
    ]);
    (window as any).ade.cto.listAgentSessionLogs = vi.fn(async () => [
      {
        id: "session-1",
        sessionId: "sess-1",
        summary: "Reviewed auth module",
        startedAt: "2026-03-05T10:00:00.000Z",
        endedAt: "2026-03-05T10:10:00.000Z",
        provider: "claude",
        modelId: null,
        capabilityMode: "full_mcp",
        createdAt: "2026-03-05T10:00:00.000Z",
      },
    ]);

    render(<CtoPage />);
    await waitFor(() => expect(screen.getByTestId("worker-row-agent-1")).toBeTruthy());

    fireEvent.click(screen.getByText("Team"));
    fireEvent.click(screen.getByTestId("worker-row-agent-1"));

    await waitFor(() => {
      expect(screen.getByText("Worker Activity")).toBeTruthy();
      expect(screen.getByText("Heartbeat: manual")).toBeTruthy();
      expect(screen.getByText("Reviewed auth module")).toBeTruthy();
    });
  });

  it("triggers Wake Now and shows status", async () => {
    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByTestId("worker-row-agent-1")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("worker-row-agent-1"));
    clickTab("Team");

    await waitFor(() => {
      expect(screen.getByTestId("worker-wake-now-btn")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("worker-wake-now-btn"));

    await waitFor(() => {
      expect((window as any).ade.cto.triggerAgentWakeup).toHaveBeenCalledWith({
        agentId: "agent-1",
        reason: "manual",
        context: { source: "cto_ui" },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("worker-wake-status")).toBeTruthy();
    });
  });

  it("pauses and resumes a selected worker", async () => {
    render(<CtoPage />);

    await waitFor(() => expect(screen.getByTestId("worker-row-agent-1")).toBeTruthy());
    fireEvent.click(screen.getByText("Team"));
    fireEvent.click(screen.getByTestId("worker-row-agent-1"));

    await waitFor(() => expect(screen.getByTestId("worker-pause-btn")).toBeTruthy());
    fireEvent.click(screen.getByTestId("worker-pause-btn"));

    await waitFor(() => {
      expect((window as any).ade.cto.setAgentStatus).toHaveBeenCalledWith({ agentId: "agent-1", status: "paused" });
    });
  });

  it("re-runs setup from settings", async () => {
    render(<CtoPage />);
    clickTab("Settings");

    await waitFor(() => expect(screen.getByRole("button", { name: /re-run setup/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /re-run setup/i }));

    await waitFor(() => {
      expect((window as any).ade.cto.resetOnboarding).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Configure Your CTO/i)).toBeTruthy();
    });
  });

  it("renders linear sync panel in Linear tab", async () => {
    render(<CtoPage />);

    // Navigate to Linear tab
    clickTab("Linear");

    await waitFor(() => {
      expect(screen.getByTestId("linear-sync-panel")).toBeTruthy();
    });
    expect(screen.getByTestId("linear-connection-panel")).toBeTruthy();

    expect((window as any).ade.cto.getFlowPolicy).toHaveBeenCalled();
    expect((window as any).ade.cto.getLinearSyncDashboard).toHaveBeenCalled();
  });

  it("simulates a route from Linear tab routing step", async () => {
    render(<CtoPage />);

    // Navigate to Linear tab
    clickTab("Linear");

    await waitFor(() => {
      expect(screen.getByTestId("linear-sync-panel")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("linear-simulate-btn"));

    await waitFor(() => {
      expect((window as any).ade.cto.simulateFlowRoute).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId("linear-simulation-result")).toBeTruthy();
    });
  });
});
