import React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { AdeCodeConnection, ProjectLaunchContext } from "../types";

const mocks = vi.hoisted(() => ({
  connectToAde: vi.fn(),
  startTuiHeartbeat: vi.fn(),
  listLanes: vi.fn(),
  listChatSessions: vi.fn(),
  listTerminalSessions: vi.fn(),
  getChatHistory: vi.fn(),
  getSlashCommands: vi.fn(),
  getAvailableModels: vi.fn(),
}));

vi.mock("../connection", () => ({
  connectToAde: mocks.connectToAde,
}));

vi.mock("../heartbeat", () => ({
  startTuiHeartbeat: mocks.startTuiHeartbeat,
}));

vi.mock("../state", async () => {
  const actual = await vi.importActual<typeof import("../state")>("../state");
  return {
    ...actual,
    loadAdeCodeState: () => ({
      lastChatByLane: {},
      lastChatByProjectLane: { "/repo": { "lane-1": "chat-1" } },
      lastLaneByProject: { "/repo": "lane-1" },
      lastLaneId: null,
    }),
    saveAdeCodeProjectState: vi.fn(),
  };
});

vi.mock("../adeApi", async () => {
  const actual = await vi.importActual<typeof import("../adeApi")>("../adeApi");
  return {
    ...actual,
    listLanes: mocks.listLanes,
    listChatSessions: mocks.listChatSessions,
    listTerminalSessions: mocks.listTerminalSessions,
    getChatHistory: mocks.getChatHistory,
    getSlashCommands: mocks.getSlashCommands,
    getAvailableModels: mocks.getAvailableModels,
  };
});

import { AdeCodeApp, shouldHydrateRefreshHistory } from "../app";

function lane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "main",
    laneType: "primary",
    baseRef: "main",
    branchRef: "main",
    worktreePath: "/repo",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function chat(overrides: Partial<AgentChatSessionSummary> = {}): AgentChatSessionSummary {
  return {
    sessionId: "chat-1",
    laneId: "lane-1",
    provider: "codex",
    model: "gpt-5.5",
    modelId: "openai/gpt-5.5",
    status: "active",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    lastOutputPreview: null,
    summary: null,
    ...overrides,
  };
}

function event(sessionId: string, sequence: number, type: string): AgentChatEventEnvelope {
  return {
    sessionId,
    sequence,
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    event: { type } as AgentChatEventEnvelope["event"],
  };
}

async function flushAsyncEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AdeCodeApp polling", () => {
  let chatListeners: Set<(event: AgentChatEventEnvelope) => void>;
  let connection: AdeCodeConnection;
  const project: ProjectLaunchContext = {
    launchCwd: "/repo",
    projectRoot: "/repo",
    workspaceRoot: "/repo",
    laneHint: null,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    chatListeners = new Set();
    connection = {
      mode: "attached",
      projectRoot: "/repo",
      workspaceRoot: "/repo",
      socketPath: "/tmp/ade.sock",
      request: vi.fn(),
      tool: vi.fn(),
      action: vi.fn(),
      actionList: vi.fn(),
      onChatEvent: vi.fn((callback) => {
        chatListeners.add(callback);
        return () => {
          chatListeners.delete(callback);
        };
      }),
      subscribeRuntimeEvents: vi.fn(async () => () => {}),
      close: vi.fn(async () => {}),
    };
    mocks.connectToAde.mockResolvedValue(connection);
    mocks.startTuiHeartbeat.mockReturnValue({ stop: vi.fn() });
    mocks.listLanes.mockResolvedValue([lane()]);
    mocks.listChatSessions.mockResolvedValue([chat()]);
    mocks.listTerminalSessions.mockResolvedValue([]);
    mocks.getChatHistory.mockResolvedValue({
      sessionId: "chat-1",
      events: [event("chat-1", 1, "user_message")],
      truncated: false,
    });
    mocks.getSlashCommands.mockResolvedValue([]);
    mocks.getAvailableModels.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps active polling on summary refreshes without hydrating chat history", async () => {
    const instance = render(<AdeCodeApp project={project} />);
    await flushAsyncEffects();

    expect(mocks.getChatHistory).toHaveBeenCalledTimes(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flushAsyncEffects();

    expect(mocks.listChatSessions).toHaveBeenCalledTimes(2);
    expect(mocks.getChatHistory).toHaveBeenCalledTimes(0);

    instance.unmount();
  });

  it("refreshes summaries for background chat events without hydrating active history", async () => {
    const instance = render(<AdeCodeApp project={project} />);
    await flushAsyncEffects();

    expect(chatListeners.size).toBe(1);
    expect(mocks.getChatHistory).toHaveBeenCalledTimes(0);

    await act(async () => {
      [...chatListeners][0]?.(event("background-chat", 2, "status"));
      await Promise.resolve();
    });
    await flushAsyncEffects();

    expect(mocks.listChatSessions).toHaveBeenCalledTimes(2);
    expect(mocks.getChatHistory).toHaveBeenCalledTimes(0);

    instance.unmount();
  });
});

describe("shouldHydrateRefreshHistory", () => {
  it("hydrates by default and when a lightweight refresh changes sessions", () => {
    expect(shouldHydrateRefreshHistory({
      currentSessionId: "chat-1",
      loadedSessionId: "chat-1",
      nextSessionId: "chat-1",
    })).toBe(true);
    expect(shouldHydrateRefreshHistory({
      hydrateHistory: false,
      currentSessionId: "chat-1",
      loadedSessionId: "chat-1",
      nextSessionId: "chat-2",
    })).toBe(true);
    expect(shouldHydrateRefreshHistory({
      hydrateHistory: false,
      currentSessionId: "chat-1",
      loadedSessionId: null,
      nextSessionId: "chat-1",
    })).toBe(true);
  });

  it("skips history for lightweight refreshes of the already-loaded active session", () => {
    expect(shouldHydrateRefreshHistory({
      hydrateHistory: false,
      currentSessionId: "chat-1",
      loadedSessionId: "chat-1",
      nextSessionId: "chat-1",
    })).toBe(false);
  });
});
