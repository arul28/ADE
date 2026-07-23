import React from "react";
import { act } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";
import type { AdeCodeConnection, ProjectLaunchContext } from "../types";
import { captureTuiProductAnalytics, deriveTuiAnalyticsScreen } from "../productAnalytics";

const mocks = vi.hoisted(() => ({
  connectToAde: vi.fn(),
  startTuiHeartbeat: vi.fn(),
  listLanes: vi.fn(),
  listChatSessions: vi.fn(),
  listTerminalSessions: vi.fn(),
  getChatHistory: vi.fn(),
  getSlashCommands: vi.fn(),
  getAvailableModels: vi.fn(),
  fsWatch: vi.fn(),
}));

vi.mock("../connection", () => ({
  connectToAde: mocks.connectToAde,
  INTERACTIVE_PROJECT_REGISTRATION: {
    catalogVisibility: "recent",
    registrationSource: "cli-explicit",
  },
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
      draftKind: "chat",
      draftKindByProject: {},
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

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    watch: mocks.fsWatch,
    default: {
      ...actual,
      watch: mocks.fsWatch,
    },
  };
});

import { AdeCodeApp, BACKGROUND_REFRESH_DEBOUNCE_MS, isLaneWorktreeAvailable, MENTION_REMOTE_DEBOUNCE_MS, shouldHydrateRefreshHistory } from "../app";

const reactActGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousReactActEnvironment: boolean | undefined;

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeAll(() => {
  previousReactActEnvironment = reactActGlobal.IS_REACT_ACT_ENVIRONMENT;
  reactActGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  if (previousReactActEnvironment === undefined) {
    delete reactActGlobal.IS_REACT_ACT_ENVIRONMENT;
  } else {
    reactActGlobal.IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
  }
});

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
    nextWakeAt: overrides.nextWakeAt ?? null,
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
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
  });
}

async function flushInkFrame() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40);
  });
  await flushAsyncEffects();
}

async function waitForFrame(instance: ReturnType<typeof render>, text: string) {
  for (let i = 0; i < 100; i++) {
    if (stripAnsi(instance.frames.join("\n")).includes(text)) return;
    await flushAsyncEffects();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }
  expect(stripAnsi(instance.frames.join("\n"))).toContain(text);
}

async function renderApp(element: React.ReactElement): Promise<ReturnType<typeof render>> {
  let instance: ReturnType<typeof render> | null = null;
  await act(async () => {
    instance = render(element);
  });
  await flushAsyncEffects();
  return instance!;
}

async function unmountApp(instance: ReturnType<typeof render>) {
  await act(async () => {
    instance.unmount();
  });
  await flushAsyncEffects();
}

describe("AdeCodeApp polling", () => {
  let chatListeners: Set<(event: AgentChatEventEnvelope) => void>;
  let connection: AdeCodeConnection;
  const project: ProjectLaunchContext = {
    launchCwd: "/repo",
    projectRoot: "/repo",
    workspaceRoot: "/repo",
    laneHint: null,
    sessionHint: null,
    remote: false,
    remoteLabel: null,
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
    mocks.fsWatch.mockReturnValue({ close: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("polls summary refreshes without hydrating chat history", async () => {
    const instance = await renderApp(<AdeCodeApp project={project} />);

    expect(mocks.getChatHistory).toHaveBeenCalledTimes(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await flushAsyncEffects();

    expect(mocks.listChatSessions).toHaveBeenCalledTimes(2);
    expect(mocks.getChatHistory).toHaveBeenCalledTimes(0);

    await unmountApp(instance);
  });

  it("does not emit analytics for polling or background event streams", async () => {
    const instance = await renderApp(<AdeCodeApp project={project} />);
    const analyticsCalls = () => vi.mocked(connection.action).mock.calls.filter(
      ([domain, action]) => domain === "analytics" && action === "capture",
    );

    const analyticsEvents = analyticsCalls().map(([, , input]) => (input as { event?: string }).event);
    expect(analyticsEvents).toHaveLength(2);
    expect(new Set(analyticsEvents)).toEqual(new Set(["ade_app_opened", "ade_screen_viewed"]));
    const initialAnalyticsCount = analyticsCalls().length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      [...chatListeners][0]?.(event("background-chat", 2, "status"));
      await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_DEBOUNCE_MS);
    });
    await flushAsyncEffects();

    expect(analyticsCalls()).toHaveLength(initialAnalyticsCount);
    await unmountApp(instance);
  });

  it("flushes analytics through the active connection before a signal exit", async () => {
    const instance = await renderApp(<AdeCodeApp project={project} />);
    const heartbeatOptions = mocks.startTuiHeartbeat.mock.calls[0]?.[1] as {
      beforeSignalExit?: (signal: NodeJS.Signals) => Promise<void>;
    };

    expect(heartbeatOptions.beforeSignalExit).toBeTypeOf("function");
    await heartbeatOptions.beforeSignalExit?.("SIGTERM");

    expect(connection.action).toHaveBeenCalledWith("analytics", "flush");
    await unmountApp(instance);
  });

  it("refreshes summaries for background chat events without hydrating active history", async () => {
    const instance = await renderApp(<AdeCodeApp project={project} />);

    expect(chatListeners.size).toBe(1);
    expect(mocks.getChatHistory).toHaveBeenCalledTimes(0);

    await act(async () => {
      [...chatListeners][0]?.(event("background-chat", 2, "status"));
      await Promise.resolve();
    });
    await flushAsyncEffects();

    expect(mocks.listChatSessions).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_REFRESH_DEBOUNCE_MS);
    });
    await flushAsyncEffects();

    expect(mocks.listChatSessions).toHaveBeenCalledTimes(2);
    expect(mocks.getChatHistory).toHaveBeenCalledTimes(0);

    await unmountApp(instance);
  });

  it("starts remote project launches from remote context instead of local saved lane state", async () => {
    mocks.listLanes.mockResolvedValue([
      lane({
        id: "lane-1",
        name: "saved lane",
        laneType: "worktree",
        branchRef: "saved/client-lane",
        worktreePath: "/remote/repo/.ade/worktrees/saved-client-lane",
      }),
      lane({
        id: "main",
        name: "main",
        laneType: "primary",
        branchRef: "main",
        worktreePath: "/remote/repo",
      }),
    ]);
    mocks.listChatSessions.mockResolvedValue([]);

    const instance = await renderApp(<AdeCodeApp project={{ ...project, remote: true }} remote />);

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("branch");
    expect(frame).toContain("main");
    expect(frame).not.toContain("saved/client-lane");
    expect(mocks.startTuiHeartbeat).not.toHaveBeenCalled();

    await unmountApp(instance);
  });

  it("shows startup retry guidance and automatically reconnects", async () => {
    mocks.connectToAde.mockImplementation(async () => {
      throw new Error("socket down");
    });

    const instance = await renderApp(<AdeCodeApp project={project} />);

    await waitForFrame(instance, "r retry now");
    expect(mocks.connectToAde).toHaveBeenCalled();

    const callsBeforeRetry = mocks.connectToAde.mock.calls.length;
    mocks.connectToAde.mockResolvedValue(connection);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await flushAsyncEffects();

    expect(mocks.connectToAde.mock.calls.length).toBeGreaterThan(callsBeforeRetry);

    await unmountApp(instance);
  });

  it("renders remote startup failures as recoverable connection loss", async () => {
    mocks.connectToAde.mockImplementation(async () => {
      throw new Error(
        "Remote ADE connection to Account Studio was interrupted while ADE Code was starting: " +
          "the local bridge lost its upstream runtime connection (write EPIPE).",
      );
    });

    const instance = await renderApp(
      <AdeCodeApp
        project={{ ...project, remote: true, remoteLabel: "Account Studio" }}
        remote
      />,
    );

    await waitForFrame(instance, "ADE Code could not reach Account Studio");
    const frame = stripAnsi(instance.frames.join("\n"));
    expect(frame).toContain("write EPIPE");
    expect(frame).toContain("every retry re-evaluates its saved connection paths");
    expect(frame).toContain("Retrying automatically");
    expect(frame).not.toContain("ade-code failed to start");

    await unmountApp(instance);
  });

  it("debounces mention RPCs and caches lane git/pr suggestions", async () => {
    mocks.listChatSessions.mockResolvedValue([chat({ status: "idle" })]);
    const actionMock = vi.fn(async (domain: string, action: string, args?: Record<string, unknown>) => {
      if (domain === "file" && action === "quickOpen") return [{ path: `src/${String(args?.query ?? "query")}.ts` }];
      if (domain === "git" && action === "listRecentCommits") return [{ shortSha: "abc1234", subject: "Mention cache" }];
      if (domain === "pr" && action === "listAll") return [{ id: "42", number: 42, title: "Mention PR" }];
      return [];
    });
    connection.action = actionMock as unknown as AdeCodeConnection["action"];

    const instance = await renderApp(<AdeCodeApp project={project} />);

    await act(async () => {
      instance.stdin.write("@a");
    });
    await flushInkFrame();

    expect(connection.action).not.toHaveBeenCalledWith("git", "listRecentCommits", expect.anything());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_REMOTE_DEBOUNCE_MS);
    });
    await flushAsyncEffects();

    await act(async () => {
      instance.stdin.write("b");
    });
    await flushInkFrame();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MENTION_REMOTE_DEBOUNCE_MS);
    });
    await flushAsyncEffects();

    const calls = actionMock.mock.calls;
    expect(calls.filter(([domain, action]) => domain === "file" && action === "quickOpen")).toHaveLength(2);
    expect(calls.filter(([domain, action]) => domain === "git" && action === "listRecentCommits")).toHaveLength(1);
    expect(calls.filter(([domain, action]) => domain === "pr" && action === "listAll")).toHaveLength(1);

    await unmountApp(instance);
  });
});

describe("TUI product analytics policy", () => {
  it("derives closed screen names and binds capture to the TUI surface", async () => {
    const base: Parameters<typeof deriveTuiAnalyticsScreen>[0] = {
      activePane: "chat",
      drawerSection: "lanes",
      rightPaneKind: "empty",
      gridViewActive: false,
      addModeActive: false,
      terminalControlActive: false,
    };
    const cases: Array<[string, Parameters<typeof deriveTuiAnalyticsScreen>[0]]> = [
      ["terminal_control", { ...base, activePane: "addMode", addModeActive: true, gridViewActive: true, terminalControlActive: true }],
      ["drawer_chats", { ...base, activePane: "drawer", drawerSection: "chats", addModeActive: true, gridViewActive: true }],
      ["details", { ...base, activePane: "details" }],
      ["details_model_picker", { ...base, activePane: "details", rightPaneKind: "model-picker", addModeActive: true }],
      ["add_chat", { ...base, activePane: "addMode", gridViewActive: true }],
      ["add_chat", { ...base, addModeActive: true, gridViewActive: true }],
      ["multi_chat_grid", { ...base, gridViewActive: true }],
      ["chat", base],
    ];
    for (const [expected, input] of cases) {
      expect(deriveTuiAnalyticsScreen(input)).toBe(expected);
    }

    const action = vi.fn(async () => ({ accepted: true, reason: "accepted" as const }));
    const tuiConnection = { action } as unknown as AdeCodeConnection;
    await expect(captureTuiProductAnalytics(tuiConnection, {
      event: "ade_screen_viewed",
      properties: { screen: "chat" },
    })).resolves.toEqual({ accepted: true, reason: "accepted" });
    expect(action).toHaveBeenCalledWith("analytics", "capture", expect.objectContaining({
      event: "ade_screen_viewed",
      surface: "tui",
      clientEventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      properties: { screen: "chat" },
    }));
  });
});

describe("isLaneWorktreeAvailable", () => {
  it("does not mark a remote-only path missing just because it is absent locally", () => {
    const remoteLane = lane({
      worktreePath: `/tmp/ade-remote-only-${Date.now()}`,
    });

    expect(isLaneWorktreeAvailable(remoteLane)).toBe(false);
    expect(isLaneWorktreeAvailable(remoteLane, { remote: true })).toBe(true);
    expect(isLaneWorktreeAvailable({ ...remoteLane, worktreeAvailable: false }, { remote: true })).toBe(false);
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
