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
  LinearSyncConfig,
} from "../../../shared/types";

vi.mock("../chat/AgentChatPane", () => ({
  AgentChatPane: ({ laneId, lockSessionId }: { laneId: string | null; lockSessionId?: string | null }) => (
    <div data-testid="chat-pane-props">{`${laneId ?? "none"}::${lockSessionId ?? "none"}`}</div>
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
  const basePolicy: LinearSyncConfig = {
    enabled: false,
    pollingIntervalSec: 300,
    projects: [{ slug: "my-project", defaultWorker: "backend-dev" }],
    routing: { byLabel: { bug: "backend-dev" } },
    assignment: { setAssigneeOnDispatch: false },
    autoDispatch: { default: "escalate", rules: [] },
    concurrency: { global: 5, byState: { todo: 3, in_progress: 5 } },
    reconciliation: { enabled: true, stalledTimeoutSec: 300 },
    classification: { mode: "hybrid", confidenceThreshold: 0.7 },
    artifacts: { mode: "links" },
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
    saveFlowPolicy: vi.fn(async ({ policy }: { policy: LinearSyncConfig }) => policy),
    listFlowPolicyRevisions: vi.fn(async () => []),
    rollbackFlowPolicyRevision: vi.fn(async () => basePolicy),
    simulateFlowRoute: vi.fn(async () => ({
      action: "escalate",
      workerSlug: "backend-dev",
      workerId: "agent-1",
      workerName: "Backend Dev",
      templateId: "bug-fix",
      reason: "Matched bug route.",
      confidence: 0.9,
      matchedRuleId: "rule-1",
      matchedSignals: ["label:bug"],
    })),
    getLinearSyncDashboard: vi.fn(async () => ({
      enabled: false,
      running: false,
      pollingIntervalSec: 300,
      lastPollAt: null,
      lastSuccessAt: null,
      lastError: null,
      queue: { queued: 0, retryWaiting: 0, escalated: 0, dispatched: 0, failed: 0 },
      claimsActive: 0,
    })),
    runLinearSyncNow: vi.fn(async () => ({
      enabled: false,
      running: false,
      pollingIntervalSec: 300,
      lastPollAt: null,
      lastSuccessAt: null,
      lastError: null,
      queue: { queued: 0, retryWaiting: 0, escalated: 0, dispatched: 0, failed: 0 },
      claimsActive: 0,
    })),
    listLinearSyncQueue: vi.fn(async () => []),
    resolveLinearSyncQueueItem: vi.fn(async () => null),
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
      expect((window as any).ade.cto.ensureSession).toHaveBeenCalledWith({ laneId: "lane-1" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("chat-pane-props").textContent).toBe("lane-1::cto-session-1");
    });

    await waitFor(() => {
      expect(screen.getByTestId("cto-capability-badge").textContent).toContain("FULL MCP");
    });
  });

  it("auto-opens the onboarding wizard on first run", async () => {
    mockOnboardingState = { completedSteps: [] };

    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByText("Configure Your CTO")).toBeTruthy();
    });
    expect(screen.getByTestId("cto-onboarding-prompt-preview")).toBeTruthy();
  });

  it("shows the setup banner when onboarding was dismissed before completion", async () => {
    mockOnboardingState = {
      completedSteps: ["identity"],
      dismissedAt: "2026-03-05T00:00:00.000Z",
    };

    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByText("Your CTO setup is incomplete.")).toBeTruthy();
    });
  });

  it("loads and renders core memory view in Settings tab", async () => {
    render(<CtoPage />);

    // Navigate to Settings tab
    clickTab("Settings");

    await waitFor(() => {
      expect(screen.getByTestId("core-memory-view")).toBeTruthy();
    });

    expect(screen.getByText("Test project summary")).toBeTruthy();
    expect(screen.getByText(/no force push/)).toBeTruthy();
    expect(screen.getByText(/stability/)).toBeTruthy();
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

    expect(screen.getByText("Create a lane to start CTO chat.")).toBeTruthy();
    expect((window as any).ade.cto.ensureSession).not.toHaveBeenCalled();
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

  it("calls listAgents and getBudgetSnapshot on mount", async () => {
    render(<CtoPage />);

    await waitFor(() => {
      expect((window as any).ade.cto.listAgents).toHaveBeenCalledWith({ includeDeleted: false });
      expect((window as any).ade.cto.getBudgetSnapshot).toHaveBeenCalledWith({});
    });
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
      expect(screen.getByText("Configure Your CTO")).toBeTruthy();
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

    // Navigate to Routing step (which has the simulation)
    const routingBtn = screen.getByText("Routing");
    fireEvent.click(routingBtn);

    await waitFor(() => {
      expect(screen.getByTestId("linear-simulate-btn")).toBeTruthy();
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
