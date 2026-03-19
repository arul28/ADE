/* @vitest-environment jsdom */

import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { AgentChatPane } from "../chat/AgentChatPane";
import { CtoPage } from "./CtoPage";

vi.mock("../chat/AgentChatPane", () => ({
  AgentChatPane: vi.fn(() => null),
}));

vi.mock("../../state/appStore", () => ({
  useAppStore: (selector: (state: { lanes: { id: string }[]; selectedLaneId: string | null }) => any) =>
    selector({ lanes: [{ id: "lane-1" }], selectedLaneId: "lane-1" }),
}));

const sampleSession = {
  id: "cto-session",
  laneId: "lane-1",
  provider: "codex",
  model: "codex-model",
  status: "active",
  createdAt: "2026-03-01T00:00:00.000Z",
  lastActivityAt: "2026-03-01T00:00:00.000Z",
};

describe("CtoPage chat surface", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    (AgentChatPane as unknown as Mock).mockClear();
    globalThis.window.ade = {
      cto: {
        getState: vi.fn(() => Promise.resolve({ identity: null, coreMemory: null, recentSessions: [], recentSubordinateActivity: [] })),
        getOnboardingState: vi.fn(() => Promise.resolve({ completedSteps: ["step"], dismissedAt: null, completedAt: null })),
        listAgents: vi.fn(() => Promise.resolve([])),
        getBudgetSnapshot: vi.fn(() => Promise.resolve({})),
        ensureSession: vi.fn(() => Promise.resolve({
          ...sampleSession,
          provider: "codex",
          threadId: "thread-1",
        })),
        ensureAgentSession: vi.fn(() => Promise.resolve({
          ...sampleSession,
          provider: "codex",
          threadId: "thread-1",
        })),
        listAgentRevisions: vi.fn(() => Promise.resolve([])),
        listAgentSessionLogs: vi.fn(() => Promise.resolve([])),
        listAgentRuns: vi.fn(() => Promise.resolve([])),
        getAgentCoreMemory: vi.fn(() => Promise.resolve(null)),
        updateCoreMemory: vi.fn(() => Promise.resolve({ coreMemory: null })),
        updateAgentCoreMemory: vi.fn(() => Promise.resolve({ coreMemory: null })),
        onOpenclawConnectionStatus: vi.fn(() => () => undefined),
        ensureSessionForAgent: vi.fn(),
      },
      externalMcp: { listConfigs: vi.fn(() => Promise.resolve([])) },
      prs: { onAiResolutionEvent: () => () => undefined },
    } as any;
  });

  afterEach(() => {
    globalThis.window.ade = originalAde;
  });

  it("renders AgentChatPane when a CTO session exists", async () => {
    render(<CtoPage />);
    await waitFor(() => expect(AgentChatPane).toHaveBeenCalled());
    expect(AgentChatPane).toHaveBeenLastCalledWith(
      expect.objectContaining({
        presentation: expect.objectContaining({ profile: "persistent_identity" }),
      }),
      expect.anything(),
    );
  });
});
