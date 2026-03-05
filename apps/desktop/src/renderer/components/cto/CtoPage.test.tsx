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
  CtoSnapshot,
  WorkerAgentRun,
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
});

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
  return {
    getState: vi.fn(async () => makeSnapshot()),
    ensureSession: vi.fn(async () => makeSession()),
    updateCoreMemory: vi.fn(async ({ patch }: { patch: Partial<CtoCoreMemory> }) => makeSnapshot(patch)),
    listSessionLogs: vi.fn(async () => makeSnapshot().recentSessions),
    updateIdentity: vi.fn(async () => makeSnapshot()),
    listAgents: vi.fn(async () => [makeWorkerAgent()]),
    saveAgent: vi.fn(async () => makeWorkerAgent()),
    removeAgent: vi.fn(async () => {}),
    listAgentRevisions: vi.fn(async () => [] as AgentConfigRevision[]),
    rollbackAgentRevision: vi.fn(async () => makeWorkerAgent()),
    ensureAgentSession: vi.fn(async () => makeSession()),
    getBudgetSnapshot: vi.fn(async () => makeBudgetSnapshot()),
    triggerAgentWakeup: vi.fn(async () => ({ runId: "run-1", status: "queued" as const })),
    listAgentRuns: vi.fn(async () => [] as WorkerAgentRun[]),
    getAgentCoreMemory: vi.fn(async () => makeAgentCoreMemory()),
    updateAgentCoreMemory: vi.fn(async () => makeAgentCoreMemory()),
    listAgentSessionLogs: vi.fn(async () => [] as AgentSessionLogEntry[]),
  };
}

describe("CtoPage", () => {
  beforeEach(() => {
    mockLanes = [{ id: "lane-1" }];
    mockSelectedLaneId = "lane-1";
    (window as any).ade = { cto: buildCtoBridge() };
  });

  afterEach(() => {
    cleanup();
  });

  it("renders org chart, locks persistent CTO session, and shows capability badge", async () => {
    render(<CtoPage />);

    expect(screen.getByText("ORG CHART")).toBeTruthy();

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

  it("loads and renders core memory view", async () => {
    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByTestId("core-memory-view")).toBeTruthy();
    });

    expect(screen.getByText("Test project summary")).toBeTruthy();
    expect(screen.getByText(/no force push/)).toBeTruthy();
    expect(screen.getByText(/stability/)).toBeTruthy();
  });

  it("enters edit mode and saves core memory patch", async () => {
    render(<CtoPage />);

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
  it("shows worker details panel when worker is selected", async () => {
    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByTestId("worker-row-agent-1")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("worker-row-agent-1"));

    await waitFor(() => {
      expect(screen.getByTestId("worker-ops-panel")).toBeTruthy();
    });
  });

  it("triggers Wake Now and shows status", async () => {
    render(<CtoPage />);

    await waitFor(() => {
      expect(screen.getByTestId("worker-row-agent-1")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("worker-row-agent-1"));

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
});
