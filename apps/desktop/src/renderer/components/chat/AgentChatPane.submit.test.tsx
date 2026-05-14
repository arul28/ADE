/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type {
  AgentChatEventEnvelope,
  AgentChatParallelLaunchState,
  AgentChatSession,
  AgentChatSessionSummary,
  PrSummary,
  TerminalSessionChangedEvent,
  TerminalSessionDetail,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { invalidateAiDiscoveryCache } from "../../lib/aiDiscoveryCache";
import { useAppStore } from "../../state/appStore";
import { AgentChatPane, isMatchingOptimisticUserMessage } from "./AgentChatPane";

vi.mock("../terminals/TerminalView", () => {
  const ReactMod = require("react") as typeof import("react");
  return {
    TerminalView: (props: { sessionId: string; ptyId: string }) =>
      ReactMod.createElement("div", { "data-testid": "terminal-view" }, `${props.sessionId}:${props.ptyId}`),
  };
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSession(sessionId: string, overrides: Partial<AgentChatSessionSummary> = {}): AgentChatSessionSummary {
  return {
    sessionId,
    laneId: "lane-1",
    provider: "codex",
    model: "gpt-5.4",
    modelId: "openai/gpt-5.4",
    endedAt: null,
    lastOutputPreview: null,
    summary: null,
    startedAt: "2026-03-24T05:57:45.700Z",
    lastActivityAt: "2026-03-24T05:57:45.700Z",
    status: "active",
    sessionProfile: "workflow",
    title: null,
    goal: null,
    completion: null,
    reasoningEffort: "xhigh",
    executionMode: "focused",
    interactionMode: null,
    ...overrides,
  };
}

function buildPrSummary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 224,
    githubUrl: "https://github.com/arul28/ADE/pull/224",
    githubNodeId: "PR_node224",
    title: "Show merged PR state",
    state: "open",
    baseBranch: "main",
    headBranch: "feature/pr-state",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 1,
    deletions: 1,
    lastSyncedAt: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildCreatedSession(sessionId: string, overrides: Partial<AgentChatSession> = {}): AgentChatSession {
  return {
    id: sessionId,
    laneId: "lane-1",
    provider: "codex",
    model: "gpt-5.4",
    modelId: "openai/gpt-5.4",
    status: "idle",
    sessionProfile: "workflow",
    reasoningEffort: "xhigh",
    executionMode: "focused",
    createdAt: "2026-03-24T05:57:45.700Z",
    lastActivityAt: "2026-03-24T05:57:45.700Z",
    ...overrides,
  };
}

function buildStatusStartedTranscript(sessionId: string): string {
  return `${JSON.stringify({
    sessionId,
    timestamp: "2026-03-24T05:57:45.700Z",
    event: {
      type: "status",
      turnStatus: "started",
      turnId: "turn-1",
    },
  })}\n`;
}

function buildPendingInputTranscript(sessionId: string): string {
  return `${JSON.stringify({
    sessionId,
    timestamp: "2026-03-24T05:57:45.700Z",
    event: {
      type: "approval_request",
      itemId: "approval-1",
      kind: "tool_call",
      description: "Which branch should I use?",
      turnId: "turn-1",
      detail: {
        tool: "askUser",
        question: "Which branch should I use?",
      },
    },
  })}\n`;
}

function installAdeMocks(options?: {
  transcript?: string;
  sendError?: Error;
  steerError?: Error;
  listError?: Error;
  handoffResult?: { session: AgentChatSession; usedFallbackSummary: boolean };
  sessions?: AgentChatSessionSummary[];
  includeClaudeModel?: boolean;
  parallelLaunchState?: AgentChatParallelLaunchState | null;
  linkedPr?: PrSummary | null;
}) {
  const send = options?.sendError
    ? vi.fn().mockRejectedValue(options.sendError)
    : vi.fn().mockResolvedValue(undefined);
  const steer = options?.steerError
    ? vi.fn().mockRejectedValue(options.steerError)
    : vi.fn().mockResolvedValue(undefined);
  const list = options?.listError
    ? vi.fn().mockRejectedValue(options.listError)
    : vi.fn().mockResolvedValue(options?.sessions ?? [buildSession("session-1")]);
  const handoff = vi.fn().mockResolvedValue(options?.handoffResult ?? {
    session: buildCreatedSession("handoff-session-1"),
    usedFallbackSummary: false,
  });
  const create = vi.fn().mockImplementation(async (args: Record<string, unknown> = {}) => {
    const overrides: Partial<AgentChatSession> = {
      laneId: typeof args.laneId === "string" ? args.laneId : "lane-1",
      reasoningEffort: (args.reasoningEffort as string | null | undefined) ?? "xhigh",
    };
    if (typeof args.provider === "string") overrides.provider = args.provider as AgentChatSession["provider"];
    if (typeof args.model === "string") overrides.model = args.model;
    if (typeof args.modelId === "string") overrides.modelId = args.modelId;
    return buildCreatedSession("created-session", overrides);
  });
  const createLane = vi.fn().mockResolvedValue({
    id: "lane-created",
    name: "auto-created-lane",
    laneType: "worktree",
    branchRef: "refs/heads/auto-created-lane",
    worktreePath: "/tmp/project-under-test/auto-created-lane",
    parentLaneId: "lane-primary",
  });
  const suggestLaneName = vi.fn().mockResolvedValue("parallel-task");
  const parallelLaunchStateGet = vi.fn().mockResolvedValue(options?.parallelLaunchState ?? null);
  const parallelLaunchStateSet = vi.fn().mockResolvedValue(undefined);
  const chatEventListeners = new Set<(event: AgentChatEventEnvelope) => void>();
  const sessionChangeListeners = new Set<(event: TerminalSessionChangedEvent) => void>();

  globalThis.window.ade = {
    projectConfig: {
      get: vi.fn().mockResolvedValue({
        effective: {
          ai: {
            chat: {
              sendOnEnter: true,
            },
          },
        },
      }),
    },
    ai: {
      getStatus: vi.fn().mockRejectedValue(new Error("no ai status")),
    },
    agentChat: {
      models: vi.fn().mockImplementation(async ({ provider }: { provider: string }) => {
        if (provider === "codex") return [{ id: "gpt-5.4" }];
        if (provider === "claude") return options?.includeClaudeModel ? [{ id: "anthropic/claude-sonnet-4-6" }] : [];
        if (provider === "opencode") return [{ id: "openai/gpt-5.4-mini" }];
        return [];
      }),
      slashCommands: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn().mockImplementation((listener: (event: AgentChatEventEnvelope) => void) => {
        chatEventListeners.add(listener);
        return () => {
          chatEventListeners.delete(listener);
        };
      }),
      handoff,
      send,
      steer,
      list,
      suggestLaneName,
      parallelLaunchState: {
        get: parallelLaunchStateGet,
        set: parallelLaunchStateSet,
      },
      getSummary: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
        const sessions = options?.sessions ?? [buildSession("session-1")];
        return sessions.find((s) => s.sessionId === sessionId) ?? null;
      }),
      editSteer: vi.fn().mockResolvedValue(undefined),
      updateSession: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
      approve: vi.fn().mockResolvedValue(undefined),
      respondToInput: vi.fn().mockResolvedValue(undefined),
      warmupModel: vi.fn().mockResolvedValue(undefined),
      fileSearch: vi.fn().mockResolvedValue([]),
      create,
      dispose: vi.fn().mockResolvedValue(undefined),
    },
    sessions: {
      get: vi.fn().mockResolvedValue({ toolType: "codex-chat" }),
      readTranscriptTail: vi.fn().mockResolvedValue(options?.transcript ?? ""),
      getDelta: vi.fn().mockResolvedValue(null),
      onChanged: vi.fn().mockImplementation((listener: (event: TerminalSessionChangedEvent) => void) => {
        sessionChangeListeners.add(listener);
        return () => {
          sessionChangeListeners.delete(listener);
        };
      }),
    },
    computerUse: {
      getOwnerSnapshot: vi.fn().mockResolvedValue(null),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
    },
    files: {
      listWorkspaces: vi.fn().mockResolvedValue([]),
    },
    lanes: {
      list: vi.fn().mockResolvedValue([]),
      listSnapshots: vi.fn().mockResolvedValue([]),
      create: createLane,
      createChild: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    git: {
      listBranches: vi.fn().mockResolvedValue([]),
      getActionRuntime: vi.fn().mockResolvedValue(null),
      onActionRuntimeEvent: vi.fn().mockImplementation(() => () => undefined),
    },
    diff: {
      getChanges: vi.fn().mockResolvedValue({ staged: [], unstaged: [] }),
    },
    prs: {
      getForLane: vi.fn().mockResolvedValue(options?.linkedPr ?? null),
    },
    pty: {
      create: vi.fn().mockResolvedValue({ ptyId: "pty-created", sessionId: "terminal-created", pid: 1234 }),
      onExit: vi.fn().mockImplementation(() => () => undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      onData: vi.fn().mockImplementation(() => () => undefined),
    },
    terminal: {
      list: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue({ terminalId: "term-1", data: "", nextSince: 0 }),
      write: vi.fn().mockResolvedValue({ ok: true }),
      signal: vi.fn().mockResolvedValue({ ok: true }),
      activeForChat: vi.fn().mockResolvedValue(null),
    },
  } as any;

  return {
    send,
    steer,
    list,
    create,
    createLane,
    suggestLaneName,
    parallelLaunchStateGet,
    parallelLaunchStateSet,
    handoff,
    emitChatEvent: (event: AgentChatEventEnvelope) => {
      for (const listener of chatEventListeners) {
        listener(event);
      }
    },
    emitSessionChanged: (event: TerminalSessionChangedEvent) => {
      for (const listener of sessionChangeListeners) {
        listener(event);
      }
    },
  };
}

function resetChatTestStore() {
  useAppStore.setState({
    project: null,
    laneSnapshots: [],
    lanes: [],
    selectedLaneId: null,
    focusedSessionId: null,
    laneInspectorTabs: {},
    workViewByProject: {},
    laneWorkViewByScope: {},
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

const originalAde = globalThis.window.ade;

beforeEach(() => {
  invalidateAiDiscoveryCache();
  window.localStorage.clear();
  resetChatTestStore();
});

afterEach(() => {
  cleanup();
  invalidateAiDiscoveryCache();
  if (originalAde === undefined) {
    delete (globalThis.window as any).ade;
  } else {
    globalThis.window.ade = originalAde;
  }
});

function renderPane(session: AgentChatSessionSummary) {
  return render(
    <MemoryRouter>
      <AgentChatPane
        laneId={session.laneId}
        lockSessionId={session.sessionId}
        hideSessionTabs
        initialSessionSummary={session}
        onSessionCreated={vi.fn()}
      />
    </MemoryRouter>,
  );
}

function renderResolverPane(session: AgentChatSessionSummary) {
  return render(
    <MemoryRouter>
      <AgentChatPane
        laneId={session.laneId}
        lockSessionId={session.sessionId}
        hideSessionTabs
        initialSessionSummary={session}
        presentation={{ mode: "resolver" }}
      />
    </MemoryRouter>,
  );
}

function renderTabbedPane(session: AgentChatSessionSummary) {
  return render(
    <MemoryRouter>
      <AgentChatPane
        laneId={session.laneId}
        initialSessionId={session.sessionId}
        initialSessionSummary={session}
      />
    </MemoryRouter>,
  );
}

function renderParallelDraftPane(args?: {
  laneId?: string;
  availableModelIdsOverride?: string[];
}) {
  const laneId = args?.laneId ?? "lane-1";
  useAppStore.setState({
    project: { rootPath: "/tmp/project-under-test" } as any,
    lanes: [{
      id: laneId,
      name: "parent-lane",
      laneType: "worktree",
      branchRef: "refs/heads/parent-lane",
      worktreePath: "/tmp/project-under-test/parent-lane",
    } as any],
    selectedLaneId: laneId,
  });

  return render(
    <MemoryRouter initialEntries={["/work"]}>
      <Routes>
        <Route
          path="*"
          element={(
            <>
              <AgentChatPane
                laneId={laneId}
                forceDraftMode
                embeddedWorkLayout
                availableModelIdsOverride={args?.availableModelIdsOverride}
              />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function renderAutoCreateDraftPane(args?: {
  onSessionCreated?: (session: AgentChatSession, options?: any) => void | Promise<void>;
}) {
  const lanes = [
    {
      id: "lane-primary",
      name: "Primary",
      laneType: "primary",
      branchRef: "refs/heads/main",
      worktreePath: "/tmp/project-under-test",
    },
    {
      id: "lane-1",
      name: "current-lane",
      laneType: "worktree",
      branchRef: "refs/heads/current-lane",
      worktreePath: "/tmp/project-under-test/current-lane",
      parentLaneId: "lane-primary",
    },
  ] as any[];
  useAppStore.setState({
    project: { rootPath: "/tmp/project-under-test" } as any,
    lanes,
    selectedLaneId: "lane-1",
  });

  return render(
    <MemoryRouter initialEntries={["/work"]}>
      <Routes>
        <Route
          path="*"
          element={(
            <>
              <AgentChatPane
                laneId="lane-1"
                forceDraftMode
                embeddedWorkLayout
                availableLanes={lanes}
                onLaneChange={vi.fn()}
                onSessionCreated={args?.onSessionCreated}
              />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

async function clickEnabledModelOption(name: RegExp | string) {
  const options = await screen.findAllByRole("option", { name });
  const enabledOption = options.find((option) => option.getAttribute("aria-disabled") !== "true");
  expect(enabledOption).toBeTruthy();
  fireEvent.click(enabledOption!);
}

function expectSessionTabOrder(expectedTitles: string[]) {
  const tabs = screen.getAllByRole("button")
    .filter((button) => expectedTitles.includes(button.textContent?.trim() ?? ""));
  expect(tabs.map((button) => button.textContent?.trim())).toEqual(expectedTitles);
}

describe("AgentChatPane submit recovery", () => {
  it("loads Claude slash commands for a draft chat before session creation", async () => {
    installAdeMocks({ sessions: [], includeClaudeModel: true });
    vi.mocked(window.ade.agentChat.slashCommands).mockImplementation(async (args) => {
      if (args.provider === "claude") {
        return [{
          name: "/agents",
          description: "Manage agent configurations.",
          source: "sdk",
        }];
      }
      return [];
    });

    renderParallelDraftPane({
      availableModelIdsOverride: ["anthropic/claude-sonnet-4-6"],
    });

    const modelTrigger = await screen.findByRole("button", { name: "Select model" });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Claude$/i }));
    await clickEnabledModelOption(/Claude Sonnet 4\.6/i);

    await waitFor(() => {
      expect(window.ade.agentChat.slashCommands).toHaveBeenCalledWith({
        laneId: "lane-1",
        provider: "claude",
      });
    });

    fireEvent.click(await screen.findByLabelText("Open command picker"));

    expect(await screen.findByText("/agents")).toBeTruthy();
  });

  it("opens the chat terminal drawer when a CLI-created terminal belongs to the active chat", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { emitSessionChanged } = installAdeMocks({ sessions: [session] });
    const terminalSession: TerminalSessionDetail = {
      id: "terminal-1",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: "pty-1",
      tracked: true,
      pinned: false,
      manuallyNamed: false,
      goal: null,
      title: "CLI run",
      startedAt: "2026-03-24T05:57:45.700Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: "/tmp/terminal-1.log",
      headShaStart: null,
      headShaEnd: null,
      status: "running",
      lastOutputPreview: null,
      summary: null,
      toolType: "shell",
      runtimeState: "running",
      resumeCommand: null,
      resumeMetadata: null,
      archivedAt: null,
      chatSessionId: session.sessionId,
    };
    vi.mocked(window.ade.sessions.get).mockResolvedValue(terminalSession);

    renderPane(session);

    await screen.findByRole("textbox");
    act(() => {
      emitSessionChanged({ sessionId: terminalSession.id, reason: "created" });
    });

    expect(await screen.findByText("CLI run")).toBeTruthy();
    expect(screen.getByTestId("terminal-view").textContent).toBe("terminal-1:pty-1");
    expect(window.ade.pty.create).not.toHaveBeenCalled();
  });

  it("reveals rapid CLI-created terminals independently", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { emitSessionChanged } = installAdeMocks({ sessions: [session] });
    const terminalSession = (id: string, ptyId: string, title: string): TerminalSessionDetail => ({
      id,
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId,
      tracked: true,
      pinned: false,
      manuallyNamed: false,
      goal: null,
      title,
      startedAt: "2026-03-24T05:57:45.700Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: `/tmp/${id}.log`,
      headShaStart: null,
      headShaEnd: null,
      status: "running",
      lastOutputPreview: null,
      summary: null,
      toolType: "shell",
      runtimeState: "running",
      resumeCommand: null,
      resumeMetadata: null,
      archivedAt: null,
      chatSessionId: session.sessionId,
    });
    const sessionsById = new Map<string, TerminalSessionDetail>([
      ["terminal-1", terminalSession("terminal-1", "pty-1", "CLI run 1")],
      ["terminal-2", terminalSession("terminal-2", "pty-2", "CLI run 2")],
    ]);
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(123);
    vi.mocked(window.ade.sessions.get).mockImplementation(async (sessionId: string) => sessionsById.get(sessionId) ?? null);

    try {
      renderPane(session);

      await screen.findByRole("textbox");
      act(() => {
        emitSessionChanged({ sessionId: "terminal-1", reason: "created" });
      });

      expect(await screen.findByText("CLI run 1")).toBeTruthy();
      act(() => {
        emitSessionChanged({ sessionId: "terminal-2", reason: "created" });
      });

      expect(await screen.findByText("CLI run 2")).toBeTruthy();
      await waitFor(() => {
        expect(screen.getByTestId("terminal-view").textContent).toBe("terminal-2:pty-2");
      });
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("shows a green session indicator while the agent is working", async () => {
    const session = buildSession("session-1");
    installAdeMocks({
      transcript: buildStatusStartedTranscript(session.sessionId),
    });

    renderTabbedPane(session);

    expect(await screen.findByLabelText("Agent working")).toBeTruthy();
  });

  it("shows an amber session indicator while waiting for user input", async () => {
    const session = buildSession("session-1");
    installAdeMocks({
      transcript: buildPendingInputTranscript(session.sessionId),
    });

    renderTabbedPane(session);

    expect(await screen.findByLabelText("Waiting for your input")).toBeTruthy();
  });

  it("blocks the composer prompt while a pending input request is active", async () => {
    const session = buildSession("session-1");
    const { send, steer } = installAdeMocks({
      transcript: buildPendingInputTranscript(session.sessionId),
    });

    renderPane(session);

    expect(await screen.findByText("Answer in the inline question card, or decline.")).toBeTruthy();
    const textbox = screen.getByPlaceholderText("Answer the question card above, or decline it.") as HTMLTextAreaElement;

    expect(textbox.disabled).toBe(true);
    expect(textbox.placeholder).toBe("Answer the question card above, or decline it.");

    fireEvent.keyDown(textbox, { key: "Enter" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(window.ade.agentChat.respondToInput).not.toHaveBeenCalled();
  });

  it("falls back to the session summary when a chat is awaiting input", async () => {
    const session = buildSession("session-1", {
      status: "active",
      awaitingInput: true,
    });
    installAdeMocks({
      sessions: [session],
    });

    renderTabbedPane(session);

    expect(await screen.findByLabelText("Waiting for your input")).toBeTruthy();
    expect(screen.queryByLabelText("Agent working")).toBeNull();
  });

  it("blocks submit when the session summary is awaiting input before the pending card loads", async () => {
    const session = buildSession("session-1", {
      status: "active",
      awaitingInput: true,
    });
    const { send, steer } = installAdeMocks({
      sessions: [session],
    });

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "This should wait." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    expect(await screen.findByText("Answer or decline the pending request before sending another message.")).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it("does not keep showing a working indicator when the session summary is idle", async () => {
    const session = buildSession("session-1", {
      status: "idle",
    });
    installAdeMocks({
      sessions: [session],
      transcript: buildStatusStartedTranscript(session.sessionId),
    });

    renderTabbedPane(session);

    await waitFor(() => {
      expect(screen.queryByLabelText("Agent working")).toBeNull();
    });
    expect(screen.getByLabelText("Ready for next prompt")).toBeTruthy();
  });

  it("keeps the draft cleared after send succeeds even if session refresh fails", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { send } = installAdeMocks({
      listError: new Error("refresh failed"),
    });

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Ship the transcript cleanup." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Ship the transcript cleanup.",
        displayText: "Ship the transcript cleanup.",
      }));
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("automatically injects lane macOS VM capability context into sends", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { send } = installAdeMocks({ sessions: [session] });
    (window.ade as any).macosVm = {
      getStatus: vi.fn().mockResolvedValue({
        platform: "darwin",
        arch: "arm64",
        supported: true,
        checkedAt: "2026-05-07T00:00:00.000Z",
        activeProvider: {
          kind: "lume",
          available: true,
          version: "0.3.9",
          detail: "Lume is available.",
          docsUrl: "https://cua.ai/docs/lume/guide/fundamentals/vm-management",
        },
        tools: [],
        laneVm: {
          id: "macos-vm:lane-1",
          provider: "lume",
          name: "ade-lane-one",
          laneId: "lane-1",
          laneName: "Lane 1",
          laneRoot: "/repo/.ade/worktrees/lane-one",
          state: "running",
          cpuCores: 4,
          memory: "8GB",
          diskSize: "80GB",
          display: "1920x1200",
          guestSharedPath: "/Volumes/My Shared Files",
          sharedDirectory: "/repo/.ade/cache/macos-vms/shares/lane-1/worktree",
          createdAt: "2026-05-07T00:00:00.000Z",
          updatedAt: "2026-05-07T00:00:00.000Z",
          lastStartedAt: "2026-05-07T00:00:00.000Z",
          lastStoppedAt: null,
          ipAddress: "192.168.64.3",
          sshCommand: "ssh lume@192.168.64.3",
          vncUrl: "vnc://127.0.0.1:5900",
          lastError: null,
          metadata: { shareMode: "sanitized-mirror" },
        },
        vms: [],
        docs: {
          appleVirtualization: "https://developer.apple.com/documentation/virtualization",
          appleSharedDirectories: "https://developer.apple.com/documentation/virtualization/vzvirtiofilesystemdeviceconfiguration",
          lume: "https://cua.ai/docs/lume/guide/fundamentals/vm-management",
        },
      }),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
    };

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Use the ADE VM to check the app." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(window.ade.macosVm.getStatus).toHaveBeenCalledWith({ laneId: "lane-1" });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        displayText: "Use the ADE VM to check the app.",
        text: expect.stringContaining("ADE macOS VM capability for this lane"),
      }));
      const sentText = send.mock.calls[0]?.[0]?.text as string;
      expect(sentText).toContain("macos_vm_status");
      expect(sentText).toContain("ade-lane-one (running)");
      expect(sentText).toContain("Use the ADE VM to check the app.");
    });
  });

  it("shows an optimistic queued bubble immediately for Cursor-style sends", async () => {
    const session = buildSession("session-1", { status: "idle" });
    let resolveSend!: () => void;
    const send = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      resolveSend = resolve;
    }));
    const list = vi.fn().mockResolvedValue([session]);
    installAdeMocks({
      sessions: [session],
    });
    window.ade.agentChat.send = send as any;
    window.ade.agentChat.list = list as any;

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Ship the optimistic bubble." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByText("Ship the optimistic bubble.")).toBeTruthy();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Ship the optimistic bubble.",
      }));
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");

    resolveSend();
  });

  it("keeps the optimistic sent bubble visible when send resolves before the chat event arrives", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { send } = installAdeMocks({
      sessions: [session],
    });

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Open the simulator screen in preview." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Open the simulator screen in preview.",
      }));
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    });

    await waitFor(() => {
      expect(screen.getByText("Open the simulator screen in preview.")).toBeTruthy();
    });
  });

  it("matches a recovered committed user message to the optimistic first bubble", () => {
    type UserMessageEvent = Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>;
    const optimistic: AgentChatEventEnvelope = {
      sessionId: "session-1",
      timestamp: "2026-03-24T05:57:45.700Z",
      event: {
        type: "user_message",
        text: "Pearl UI audit handoff",
        attachments: [{ path: "docs/audit.md", type: "file" }],
        deliveryState: "queued",
      },
    };
    const committedUserEvent: UserMessageEvent = {
      type: "user_message",
      text: "Full handoff prompt with all implementation details.",
      displayText: "Pearl UI audit handoff",
      attachments: [{ path: "docs/audit.md", type: "file" }],
    };
    const committed: AgentChatEventEnvelope = {
      sessionId: "session-1",
      timestamp: "2026-03-24T05:57:46.000Z",
      event: committedUserEvent,
    };

    expect(isMatchingOptimisticUserMessage(committed, optimistic)).toBe(true);
    expect(isMatchingOptimisticUserMessage({
      ...committed,
      event: { ...committedUserEvent, steerId: "steer-1", deliveryState: "delivered" },
    }, optimistic)).toBe(false);
    expect(isMatchingOptimisticUserMessage({
      ...committed,
      event: { ...committedUserEvent, attachments: [{ path: "docs/other.md", type: "file" }] },
    }, optimistic)).toBe(false);
  });

  it("renders a duplicated live Codex user_message envelope only once", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { emitChatEvent } = installAdeMocks({
      sessions: [session],
    });

    renderPane(session);

    await screen.findByRole("textbox");
    const envelope: AgentChatEventEnvelope = {
      sessionId: session.sessionId,
      timestamp: "2026-03-24T05:57:46.000Z",
      sequence: 1,
      event: {
        type: "user_message",
        text: "Render this Codex message once.",
      },
    };

    act(() => {
      emitChatEvent(envelope);
      emitChatEvent(envelope);
    });

    await waitFor(() => {
      expect(screen.getAllByText("Render this Codex message once.")).toHaveLength(1);
    });
  });

  it("keeps the draft cleared after steer succeeds even if session refresh fails", async () => {
    const session = buildSession("session-1");
    const { steer } = installAdeMocks({
      transcript: buildStatusStartedTranscript(session.sessionId),
      listError: new Error("refresh failed"),
    });

    renderPane(session);

    const textbox = await screen.findByPlaceholderText("Steer the active turn...");
    fireEvent.change(textbox, { target: { value: "Stop checking docs and just drive the browser." } });
    fireEvent.click(screen.getByLabelText("Send steer message"));

    await waitFor(() => {
      expect(steer).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        text: "Stop checking docs and just drive the browser.",
      });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("restores the draft when the send itself fails", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { send } = installAdeMocks({
      sendError: new Error("send failed"),
    });

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Retry after the failure." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalled();
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Retry after the failure.");
    });
  });

  it("sends the selected Claude interaction mode with the next turn", async () => {
    const session = buildSession("session-1", {
      status: "idle",
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelId: "anthropic/claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "default",
      claudePermissionMode: "default",
    });
    const sessions = [session];
    const updateSession = vi.fn().mockImplementation(async (args: any) => {
      sessions[0] = {
        ...sessions[0]!,
        interactionMode: args.interactionMode ?? sessions[0]!.interactionMode,
        claudePermissionMode: args.claudePermissionMode ?? sessions[0]!.claudePermissionMode,
        permissionMode: args.permissionMode ?? sessions[0]!.permissionMode,
      };
      return sessions[0];
    });
    const { send } = installAdeMocks({
      includeClaudeModel: true,
      sessions,
    });
    window.ade.agentChat.updateSession = updateSession as any;

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Claude permission mode" }));
    fireEvent.click(await screen.findByRole("option", { name: "Plan mode" }));

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        interactionMode: "plan",
      }));
    });

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Just plan the implementation." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Just plan the implementation.",
        interactionMode: "plan",
      }));
    });
  });

  it("waits for Codex permission updates before sending the next turn", async () => {
    const session = buildSession("session-1", {
      status: "idle",
      permissionMode: "default",
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    });
    const sessions = [session];
    let resolveUpdateSession: (() => void) | null = null;
    const updateSession = vi.fn().mockImplementation((args: any) => new Promise((resolve) => {
      resolveUpdateSession = () => {
        sessions[0] = {
          ...sessions[0]!,
          permissionMode: args.permissionMode ?? sessions[0]!.permissionMode,
          codexApprovalPolicy: args.codexApprovalPolicy ?? sessions[0]!.codexApprovalPolicy,
          codexSandbox: args.codexSandbox ?? sessions[0]!.codexSandbox,
          codexConfigSource: args.codexConfigSource ?? sessions[0]!.codexConfigSource,
        };
        resolve(sessions[0]);
      };
    }));
    const { send } = installAdeMocks({
      sessions,
    });
    window.ade.agentChat.updateSession = updateSession as any;

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Codex approval preset" }));
    fireEvent.click(await screen.findByRole("option", { name: "Full access" }));

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        permissionMode: "full-auto",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      }));
    });

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Make the change now." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).not.toHaveBeenCalled();

    const flushUpdateSession = resolveUpdateSession as (() => void) | null;
    expect(flushUpdateSession).toBeTypeOf("function");
    flushUpdateSession?.();

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Make the change now.",
      }));
    });
  });

  it("waits for Codex fast mode updates before sending the next turn", async () => {
    const session = buildSession("session-1", {
      status: "idle",
      codexFastMode: false,
    });
    const sessions = [session];
    const resolveUpdates: Array<() => void> = [];
    const updateSession = vi.fn().mockImplementation((args: any) => new Promise((resolve) => {
      resolveUpdates.push(() => {
        sessions[0] = {
          ...sessions[0]!,
          codexFastMode: args.codexFastMode ?? sessions[0]!.codexFastMode,
        };
        resolve(sessions[0]);
      });
    }));
    const { send } = installAdeMocks({
      sessions,
    });
    window.ade.agentChat.updateSession = updateSession as any;

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Fast mode" }));

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        codexFastMode: true,
      }));
    });

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Use the faster tier." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).not.toHaveBeenCalled();

    resolveUpdates[0]?.();
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Use the faster tier.",
      }));
    });
  });

  it("persists Codex reasoning effort changes on the selected session", async () => {
    const session = buildSession("session-1", {
      status: "idle",
      reasoningEffort: "medium",
    });
    const updateSession = vi.fn().mockImplementation(async (args: any) => ({
      ...session,
      reasoningEffort: args.reasoningEffort,
    }));
    installAdeMocks({
      sessions: [session],
    });
    window.ade.agentChat.updateSession = updateSession as any;

    renderPane(session);

    fireEvent.change(await screen.findByLabelText("Reasoning effort"), {
      target: { value: "high" },
    });

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        reasoningEffort: "high",
      });
    });
  });

  it("resyncs Claude composer permissions from refreshed session state", async () => {
    const session = buildSession("session-1", {
      status: "idle",
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelId: "anthropic/claude-sonnet-4-6",
      permissionMode: "edit",
      interactionMode: "default",
      claudePermissionMode: "default",
    });
    const sessions = [session];
    const { emitChatEvent } = installAdeMocks({
      includeClaudeModel: true,
      sessions,
    });

    renderPane(session);

    const trigger = await screen.findByRole("button", { name: "Claude permission mode" });
    expect(trigger.textContent ?? "").not.toContain("Plan mode");

    sessions[0] = {
      ...session,
      permissionMode: "plan",
      interactionMode: "plan",
      claudePermissionMode: "acceptEdits",
    };

    emitChatEvent({
      sessionId: session.sessionId,
      timestamp: "2026-03-24T07:10:00.000Z",
      event: {
        type: "system_notice",
        noticeKind: "info",
        message: "Session entered plan mode.",
        detail: {
          permissionModeTransition: "entered_plan_mode",
        },
      },
    });

    await waitFor(() => {
      expect(trigger.textContent ?? "").toContain("Plan mode");
    });
  });

  it("moves the most recently selected work chat tab to the top", async () => {
    const newerSession = buildSession("session-newer", {
      title: "Newer chat",
      startedAt: "2026-03-24T06:00:00.000Z",
      lastActivityAt: "2026-03-24T06:05:00.000Z",
    });
    const olderSession = buildSession("session-older", {
      title: "Older chat",
      startedAt: "2026-03-24T05:00:00.000Z",
      lastActivityAt: "2026-03-24T05:05:00.000Z",
    });
    installAdeMocks({
      sessions: [olderSession, newerSession],
    });

    renderTabbedPane(newerSession);

    await waitFor(() => {
      expectSessionTabOrder(["Newer chat", "Older chat"]);
    });

    fireEvent.click(screen.getByRole("button", { name: /Older chat/i }));

    await waitFor(() => {
      expectSessionTabOrder(["Older chat", "Newer chat"]);
    });
  });

  it("does not auto-fetch Cursor inventory on chat boot", async () => {
    let resolveProjectConfig: (value: unknown) => void = () => {};
    const projectConfig = new Promise((resolve) => {
      resolveProjectConfig = resolve;
    });
    installAdeMocks({
      sessions: [],
    });
    useAppStore.setState({
      project: { rootPath: "/tmp/project-under-test" } as any,
      lanes: [{
        id: "lane-1",
        name: "Lane 1",
        laneType: "worktree",
        branchRef: "refs/heads/lane-1",
        worktreePath: "/tmp/project-under-test/lane-1",
      } as any],
      selectedLaneId: "lane-1",
    });
    window.ade.projectConfig.get = vi.fn().mockReturnValue(projectConfig) as any;
    window.ade.ai.getStatus = vi.fn().mockResolvedValue({
      mode: "subscription",
      availableProviders: {
        claude: {
          binary: { present: false, source: "missing", path: null },
          auth: { ready: false, mode: "none", detail: null },
        },
        codex: true,
        cursor: true,
        droid: false,
      },
      models: { claude: [], codex: [], cursor: [], droid: [] },
      features: [],
      detectedAuth: [
        { type: "cli-subscription", cli: "codex", authenticated: true },
        { type: "api-key", provider: "cursor" },
      ],
      availableModelIds: [],
    }) as any;
    window.ade.agentChat.models = vi.fn().mockResolvedValue([]) as any;

    render(
      <MemoryRouter>
        <AgentChatPane laneId="lane-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Loading sessions")).toBeTruthy();

    await act(async () => {
      resolveProjectConfig({
        effective: {
          ai: {
            chat: {
              sendOnEnter: true,
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Loading sessions")).toBeNull();
    });
    expect(await screen.findByText("Start a new conversation")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.ade.agentChat.models).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "cursor" }),
    );
  });

  it("uses Cursor model IDs from AI status without probing Cursor inventory", async () => {
    installAdeMocks({
      sessions: [],
    });
    useAppStore.setState({
      project: { rootPath: "/tmp/project-under-test" } as any,
      lanes: [{
        id: "lane-1",
        name: "Lane 1",
        laneType: "worktree",
        branchRef: "refs/heads/lane-1",
        worktreePath: "/tmp/project-under-test/lane-1",
      } as any],
      selectedLaneId: "lane-1",
    });
    window.ade.ai.getStatus = vi.fn().mockResolvedValue({
      mode: "subscription",
      availableProviders: {
        claude: {
          binary: { present: false, source: "missing", path: null },
          auth: { ready: false, mode: "none", detail: null },
        },
        codex: true,
        cursor: true,
        droid: false,
      },
      models: { claude: [], codex: [], cursor: [], droid: [] },
      features: [],
      detectedAuth: [
        { type: "cli-subscription", cli: "codex", authenticated: true },
        { type: "api-key", provider: "cursor" },
      ],
      availableModelIds: ["cursor/auto"],
    }) as any;
    window.ade.agentChat.models = vi.fn().mockResolvedValue([]) as any;

    render(
      <MemoryRouter>
        <AgentChatPane laneId="lane-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Start a new conversation")).toBeTruthy();
    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.ade.agentChat.models).not.toHaveBeenCalled();
  });

  it("keeps the committed model visible until the backend confirms the switch", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const sessions = [session];
    let resolveUpdateSession!: (value: AgentChatSessionSummary) => void;
    const updateSession = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveUpdateSession = resolve;
    }));
    const warmupModel = vi.fn().mockResolvedValue(undefined);
    installAdeMocks({
      sessions,
      includeClaudeModel: true,
    });
    window.ade.agentChat.updateSession = updateSession as any;
    window.ade.agentChat.warmupModel = warmupModel as any;

    renderPane(session);

    const trigger = await screen.findByRole("button", { name: "Select model" });
    const currentLabel = getModelById(session.modelId ?? "")?.displayName ?? session.modelId ?? "";
    const nextLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
    const nextLabelPattern = new RegExp(escapeRegExp(nextLabel), "i");
    expect(trigger.textContent ?? "").toContain(currentLabel);

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Claude$/i }));
    await clickEnabledModelOption(nextLabelPattern);

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        modelId: "anthropic/claude-sonnet-4-6",
      }));
    });
    expect(screen.getByRole("button", { name: "Select model" }).textContent ?? "").toContain(currentLabel);
    expect(warmupModel).not.toHaveBeenCalled();

    const updatedSession: AgentChatSessionSummary = {
      ...session,
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelId: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "medium",
      permissionMode: "default",
      interactionMode: "default",
      claudePermissionMode: "default",
    };
    sessions[0] = updatedSession;
    resolveUpdateSession(updatedSession);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Select model" }).textContent ?? "").toContain(nextLabel);
    });
    await waitFor(() => {
      expect(warmupModel).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        modelId: "anthropic/claude-sonnet-4-6",
      });
    });
  });

  it("keeps the committed model visible when the backend rejects a switch", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const updateSession = vi.fn().mockRejectedValue(new Error("switch failed"));
    const warmupModel = vi.fn().mockResolvedValue(undefined);
    installAdeMocks({
      sessions: [session],
      includeClaudeModel: true,
    });
    window.ade.agentChat.updateSession = updateSession as any;
    window.ade.agentChat.warmupModel = warmupModel as any;

    renderPane(session);

    const trigger = await screen.findByRole("button", { name: "Select model" });
    const currentLabel = getModelById(session.modelId ?? "")?.displayName ?? session.modelId ?? "";
    const nextLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
    const nextLabelPattern = new RegExp(escapeRegExp(nextLabel), "i");
    expect(trigger.textContent ?? "").toContain(currentLabel);

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Claude$/i }));
    await clickEnabledModelOption(nextLabelPattern);

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        modelId: "anthropic/claude-sonnet-4-6",
      }));
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Select model" }).textContent ?? "").toContain(currentLabel);
    });
    expect(warmupModel).not.toHaveBeenCalled();
  });

  it("bumps a work chat to the top when a turn starts mid-stream", async () => {
    const newerSession = buildSession("session-newer", {
      title: "Newer chat",
      startedAt: "2026-03-24T06:00:00.000Z",
      lastActivityAt: "2026-03-24T06:05:00.000Z",
    });
    const olderSession = buildSession("session-older", {
      title: "Older chat",
      startedAt: "2026-03-24T05:00:00.000Z",
      lastActivityAt: "2026-03-24T05:05:00.000Z",
    });
    const { emitChatEvent } = installAdeMocks({
      sessions: [olderSession, newerSession],
    });

    renderTabbedPane(newerSession);

    await waitFor(() => {
      expectSessionTabOrder(["Newer chat", "Older chat"]);
    });

    emitChatEvent({
      sessionId: olderSession.sessionId,
      timestamp: "2026-03-24T07:00:00.000Z",
      event: {
        type: "status",
        turnStatus: "started",
        turnId: "turn-older-1",
      },
    });

    await waitFor(() => {
      expectSessionTabOrder(["Older chat", "Newer chat"]);
    });
  });

  it("shows chat handoff only for standard locked work chats", async () => {
    const session = buildSession("session-1");
    installAdeMocks();
    renderPane(session);

    expect(await screen.findByRole("button", { name: "Handoff" })).not.toBeNull();

    cleanup();
    installAdeMocks();
    renderResolverPane(session);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Handoff" })).toBeNull();
    });
  });

  it("hides chat handoff when the pane cannot open the created work chat", async () => {
    const session = buildSession("session-1");
    installAdeMocks();

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Handoff" })).toBeNull();
    });
  });

  it("disables chat handoff while the current turn is still active", async () => {
    const session = buildSession("session-1");
    installAdeMocks({
      transcript: buildStatusStartedTranscript(session.sessionId),
    });

    renderPane(session);

    const button = await screen.findByRole("button", { name: "Handoff" });
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("creates a sibling handoff chat and opens the returned work tab", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const onSessionCreated = vi.fn().mockResolvedValue(undefined);
    const { handoff } = installAdeMocks({
      handoffResult: {
        session: buildCreatedSession("session-2"),
        usedFallbackSummary: false,
      },
    });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
          onSessionCreated={onSessionCreated}
        />
      </MemoryRouter>,
    );

    const handoffBtn = await screen.findByRole("button", { name: "Handoff" }) as HTMLButtonElement;
    await waitFor(() => expect(handoffBtn.disabled).toBe(false));
    fireEvent.click(handoffBtn);
    expect(await screen.findByText("Create opens the new work chat and sends the handoff summary as its first message.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Create handoff chat" }));

    await waitFor(() => {
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        sourceSessionId: session.sessionId,
        targetModelId: "openai/gpt-5.4-mini",
        mode: "brief",
        reasoningEffort: "xhigh",
        permissionMode: "default",
        claudePermissionMode: "default",
        opencodePermissionMode: "edit",
        droidPermissionMode: "auto-low",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        cursorModeId: "agent",
        cursorConfigValues: {},
      }));
      expect(onSessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "session-2" }));
    });
  });

  it("sends the selected handoff model and permission mode", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { handoff } = installAdeMocks({
      includeClaudeModel: true,
      handoffResult: {
        session: buildCreatedSession("session-2", {
          provider: "claude",
          model: "sonnet",
          modelId: "anthropic/claude-sonnet-4-6",
          interactionMode: "plan",
          permissionMode: "plan",
        }),
        usedFallbackSummary: false,
      },
    });

    renderPane(session);

    const handoffBtn = await screen.findByRole("button", { name: "Handoff" }) as HTMLButtonElement;
    await waitFor(() => expect(handoffBtn.disabled).toBe(false));
    fireEvent.click(handoffBtn);

    const handoffMenu = (await screen.findByText("Start a sibling chat on another model")).closest("[data-chat-handoff-menu='true']");
    expect(handoffMenu).toBeTruthy();
    fireEvent.click(within(handoffMenu as HTMLElement).getByRole("button", { name: "Select model" }));
    const claudeLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
    fireEvent.click(await screen.findByRole("button", { name: /^Claude$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(claudeLabel), "i"));
    expect(screen.getByText("Fork keeps the complete Claude transcript through the SDK. Brief sends a summary as the first message.")).toBeTruthy();

    const permissionSelect = await screen.findByLabelText("Claude permission mode for handoff") as HTMLSelectElement;
    expect(within(permissionSelect).getByRole("option", { name: "Auto" })).toBeTruthy();
    fireEvent.change(permissionSelect, { target: { value: "plan" } });
    fireEvent.click(await screen.findByRole("button", { name: "Brief handoff" }));

    await waitFor(() => {
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        sourceSessionId: session.sessionId,
        targetModelId: "anthropic/claude-sonnet-4-6",
        mode: "brief",
        claudePermissionMode: "plan",
        permissionMode: "plan",
      }));
    });
  });

  it("can fork a Claude handoff with full SDK history", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { handoff } = installAdeMocks({
      includeClaudeModel: true,
      handoffResult: {
        session: buildCreatedSession("session-2", {
          provider: "claude",
          model: "sonnet",
          modelId: "anthropic/claude-sonnet-4-6",
        }),
        usedFallbackSummary: false,
      },
    });

    renderPane(session);

    const handoffBtn = await screen.findByRole("button", { name: "Handoff" }) as HTMLButtonElement;
    await waitFor(() => expect(handoffBtn.disabled).toBe(false));
    fireEvent.click(handoffBtn);

    const handoffMenu = (await screen.findByText("Start a sibling chat on another model")).closest("[data-chat-handoff-menu='true']");
    expect(handoffMenu).toBeTruthy();
    fireEvent.click(within(handoffMenu as HTMLElement).getByRole("button", { name: "Select model" }));
    const claudeLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
    fireEvent.click(await screen.findByRole("button", { name: /^Claude$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(claudeLabel), "i"));
    fireEvent.click(await screen.findByRole("button", { name: "Fork full history" }));

    await waitFor(() => {
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        sourceSessionId: session.sessionId,
        targetModelId: "anthropic/claude-sonnet-4-6",
        mode: "fork",
      }));
    });
  });

  it("does not wait for onSessionCreated before sending the first message in a new chat", async () => {
    const onSessionCreated = vi.fn().mockImplementation(() => new Promise<void>(() => {}));
    const { send, create } = installAdeMocks({ sessions: [] });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceNewSession
          onSessionCreated={onSessionCreated}
        />
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole("button", { name: "Select model" });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Codex$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Ship the instant route fix." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(create).toHaveBeenCalled();
      expect(onSessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "created-session" }));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "created-session",
        text: "Ship the instant route fix.",
        displayText: "Ship the instant route fix.",
      }));
    });
  });

  it("foreground auto-create opens the new chat in Work instead of routing to Lanes", async () => {
    const onSessionCreated = vi.fn();
    const { send, create, createLane, suggestLaneName } = installAdeMocks({ sessions: [] });
    suggestLaneName.mockResolvedValue("fix-auto-create-flow");
    createLane.mockResolvedValue({
      id: "lane-created",
      name: "fix-auto-create-flow",
      laneType: "worktree",
      branchRef: "refs/heads/fix-auto-create-flow",
      worktreePath: "/tmp/project-under-test/fix-auto-create-flow",
      parentLaneId: "lane-primary",
    });

    renderAutoCreateDraftPane({ onSessionCreated });

    const modelTrigger = await screen.findByRole("button", { name: "Select model" });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Codex$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Fix auto create lane routing." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-primary",
        prompt: "Fix auto create lane routing.",
        modelId: "openai/gpt-5.4",
        fallbackName: expect.stringMatching(/^chat-\d{8}-\d{6}$/),
      }));
      expect(createLane).toHaveBeenCalledWith({
        name: "fix-auto-create-flow",
        parentLaneId: "lane-primary",
      });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ laneId: "lane-created" }));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "created-session",
        text: "Fix auto create lane routing.",
      }));
      expect(onSessionCreated).toHaveBeenCalledWith(
        expect.objectContaining({ id: "created-session", laneId: "lane-created" }),
        { activate: true, source: "draft-launch" },
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/work?laneId=lane-created&sessionId=created-session");
    });
  });

  it("background auto-create reports the new chat without stealing focus and shows a dismissible notice", async () => {
    const onSessionCreated = vi.fn();
    const { createLane, suggestLaneName } = installAdeMocks({ sessions: [] });
    suggestLaneName.mockResolvedValue("background-lane");
    createLane.mockResolvedValue({
      id: "lane-created",
      name: "background-lane",
      laneType: "worktree",
      branchRef: "refs/heads/background-lane",
      worktreePath: "/tmp/project-under-test/background-lane",
      parentLaneId: "lane-primary",
    });

    renderAutoCreateDraftPane({ onSessionCreated });

    const modelTrigger = await screen.findByRole("button", { name: "Select model" });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Codex$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Launch this in the background." } });
    fireEvent.click(await screen.findByRole("button", { name: "Launch in background" }));

    await waitFor(() => {
      expect(onSessionCreated).toHaveBeenCalledWith(
        expect.objectContaining({ id: "created-session", laneId: "lane-created" }),
        { activate: false, source: "draft-launch" },
      );
      expect(screen.getByText("Launched in background-lane")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Dismiss launched chat notice" })).toBeTruthy();
    });
    expect(screen.getByTestId("location").textContent).toBe("/work");

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/work?laneId=lane-created&sessionId=created-session");
    });
  });

  it("keeps the draft box editable while auto-create launch disables send actions", async () => {
    const { suggestLaneName } = installAdeMocks({ sessions: [] });
    let resolveSuggestedName!: (value: string) => void;
    suggestLaneName.mockImplementation(() => new Promise<string>((resolve) => {
      resolveSuggestedName = resolve;
    }));

    renderAutoCreateDraftPane();

    const modelTrigger = await screen.findByRole("button", { name: "Select model" });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Codex$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Launch this and let me keep typing." } });
    fireEvent.click(await screen.findByRole("button", { name: "Launch in background" }));

    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalled();
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Launch in background" }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect((textbox as HTMLTextAreaElement).disabled).toBe(false);

    fireEvent.change(textbox, { target: { value: "Next thought while it launches." } });
    expect((textbox as HTMLTextAreaElement).value).toBe("Next thought while it launches.");

    resolveSuggestedName("still-editable-lane");
    await waitFor(() => {
      expect(screen.getByText("Launched in auto-created-lane")).toBeTruthy();
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Next thought while it launches.");
    });
  });

  it("launches a tracked CLI session from the Work draft composer instead of creating an ADE chat", async () => {
    const { send, create } = installAdeMocks({ sessions: [] });
    const onLaunchCliSession = vi.fn().mockResolvedValue({ sessionId: "terminal-1", ptyId: "pty-1" });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceDraftMode
          embeddedWorkLayout
          workDraftKind="cli"
          onLaunchCliSession={onLaunchCliSession}
        />
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole("button", { name: "Select model" });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Codex$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Run the unified CLI launch." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(onLaunchCliSession).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-1",
        profile: "codex",
        title: "Run the unified CLI launch",
        command: "codex",
        tracked: true,
      }));
    });
    const launchArgs = onLaunchCliSession.mock.calls[0]?.[0];
    expect(launchArgs.startupCommand).toContain("ADE session guidance");
    expect(launchArgs.startupCommand).toContain("Run the unified CLI launch.");
    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps immediate agent events for a freshly created chat before session refresh catches up", async () => {
    const { create, emitChatEvent } = installAdeMocks({ sessions: [] });
    const send = vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      emitChatEvent({
        sessionId,
        timestamp: "2026-03-24T05:57:46.000Z",
        event: {
          type: "status",
          turnStatus: "started",
          turnId: "turn-1",
        },
      });
      emitChatEvent({
        sessionId,
        timestamp: "2026-03-24T05:57:46.100Z",
        event: {
          type: "text",
          text: "Fresh session reply",
          turnId: "turn-1",
          messageId: "assistant-1",
        },
      });
      emitChatEvent({
        sessionId,
        timestamp: "2026-03-24T05:57:46.200Z",
        event: {
          type: "done",
          turnId: "turn-1",
          status: "completed",
          model: "gpt-5.4",
        },
      });
    });
    window.ade.agentChat.send = send as any;

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceNewSession
        />
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole("button", { name: "Select model" });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Codex$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Ship it." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(create).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "created-session",
        text: "Ship it.",
      }));
    });

    expect(await screen.findByText("Fresh session reply")).toBeTruthy();
  });

  it("preserves background streamed events when switching back to a chat with same-timestamp transcript entries", async () => {
    const primarySession = buildSession("session-1", {
      title: "Primary chat",
      lastActivityAt: "2026-03-24T05:57:45.700Z",
    });
    const backgroundSession = buildSession("session-2", {
      title: "Background chat",
      lastActivityAt: "2026-03-24T05:57:45.600Z",
    });
    const { emitChatEvent } = installAdeMocks({
      sessions: [primarySession, backgroundSession],
    });
    window.ade.sessions.readTranscriptTail = vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === "session-2") {
        return `${JSON.stringify({
          sessionId: "session-2",
          timestamp: "2026-03-24T06:00:00.000Z",
          sequence: 1,
          event: {
            type: "status",
            turnStatus: "started",
            turnId: "turn-2",
          },
        })}\n`;
      }
      return "";
    });

    renderTabbedPane(primarySession);

    await screen.findByRole("button", { name: /Primary chat/i });
    await screen.findByRole("button", { name: /Background chat/i });

    emitChatEvent({
      sessionId: "session-2",
      timestamp: "2026-03-24T06:00:00.000Z",
      sequence: 2,
      event: {
        type: "text",
        text: "Background output kept streaming",
        turnId: "turn-2",
        messageId: "assistant-2",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /Background chat/i }));

    expect(await screen.findByText("Background output kept streaming")).toBeTruthy();
  });

  it("reloads a previously viewed chat transcript when switching back to recover missed background output", async () => {
    const primarySession = buildSession("session-1", {
      title: "Primary chat",
      lastActivityAt: "2026-03-24T05:57:45.700Z",
    });
    const backgroundSession = buildSession("session-2", {
      title: "Background chat",
      lastActivityAt: "2026-03-24T05:57:45.600Z",
    });
    let backgroundTranscript = `${JSON.stringify({
      sessionId: "session-2",
      timestamp: "2026-03-24T06:00:00.000Z",
      sequence: 1,
      event: {
        type: "status",
        turnStatus: "started",
        turnId: "turn-2",
      },
    })}\n`;

    installAdeMocks({
      sessions: [primarySession, backgroundSession],
    });
    const readTranscriptTail = vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === "session-2") return backgroundTranscript;
      return "";
    });
    window.ade.sessions.readTranscriptTail = readTranscriptTail as any;

    renderTabbedPane(primarySession);

    const primaryTab = await screen.findByRole("button", { name: /Primary chat/i });
    const backgroundTab = await screen.findByRole("button", { name: /Background chat/i });

    fireEvent.click(backgroundTab);
    await waitFor(() => {
      expect(readTranscriptTail).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-2" }));
    });

    fireEvent.click(primaryTab);

    backgroundTranscript += `${JSON.stringify({
      sessionId: "session-2",
      timestamp: "2026-03-24T06:00:01.000Z",
      sequence: 2,
      event: {
        type: "text",
        text: "Recovered from transcript on revisit",
        turnId: "turn-2",
        messageId: "assistant-2",
      },
    })}\n`;

    fireEvent.click(backgroundTab);

    expect(await screen.findByText("Recovered from transcript on revisit")).toBeTruthy();
    expect(readTranscriptTail).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-2" }));
  });

  it("hydrates a visible inactive grid tile without requiring a click", async () => {
    const session = buildSession("grid-inactive-chat", {
      title: "Grid inactive chat",
    });
    installAdeMocks({ sessions: [session] });
    const readTranscriptTail = vi.fn().mockResolvedValue(`${JSON.stringify({
      sessionId: session.sessionId,
      timestamp: "2026-03-24T06:00:00.000Z",
      sequence: 1,
      event: {
        type: "text",
        text: "Visible inactive grid tile loaded",
        turnId: "turn-grid",
        messageId: "assistant-grid",
      },
    })}\n`);
    window.ade.sessions.readTranscriptTail = readTranscriptTail as any;

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
          layoutVariant="grid-tile"
          isTileActive={false}
          isTileVisible
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Visible inactive grid tile loaded")).toBeTruthy();
    expect(readTranscriptTail).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.sessionId }));
  });

  it("does not hydrate hidden inactive chat tiles", async () => {
    vi.useFakeTimers();
    const session = buildSession("hidden-inactive-chat", {
      title: "Hidden inactive chat",
    });
    installAdeMocks({ sessions: [session] });
    const readTranscriptTail = vi.fn().mockResolvedValue("");
    window.ade.sessions.readTranscriptTail = readTranscriptTail as any;

    try {
      render(
        <MemoryRouter>
          <AgentChatPane
            laneId={session.laneId}
            lockSessionId={session.sessionId}
            hideSessionTabs
            initialSessionSummary={session}
            layoutVariant="grid-tile"
            isTileActive={false}
          />
        </MemoryRouter>,
      );

      await act(async () => {
        vi.advanceTimersByTime(550);
      });
      expect(readTranscriptTail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows 'New chat' in the header when no session is selected", async () => {
    installAdeMocks({ sessions: [] });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceNewSession
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("New chat")).toBeTruthy();
  });

  it("shows the session title in the header when the session has one", async () => {
    const session = buildSession("session-1", {
      title: "Fix login bug",
    });
    installAdeMocks({ sessions: [session] });
    renderPane(session);

    expect(await screen.findByText("Fix login bug")).toBeTruthy();
  });

  it("renders the git toolbar when laneId is provided", async () => {
    const session = buildSession("session-1");
    installAdeMocks({ sessions: [session] });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          laneLabel="feature/auth"
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
        />
      </MemoryRouter>,
    );

    // The git toolbar renders commit/push buttons when laneId is present
    expect(await screen.findByText("Stage & Commit")).toBeTruthy();
    expect(screen.getByText("Push")).toBeTruthy();
  });

  it("labels a merged linked PR in the git toolbar", async () => {
    const session = buildSession("session-1");
    installAdeMocks({
      sessions: [session],
      linkedPr: buildPrSummary({ state: "merged" }),
    });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          laneLabel="feature/auth"
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("MERGED #224")).toBeTruthy();
  });

  it("does not render the git toolbar when laneId is null", async () => {
    const session = buildSession("session-1");
    installAdeMocks({ sessions: [session] });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={null}
          laneLabel="feature/auth"
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
        />
      </MemoryRouter>,
    );

    // Wait for the pane to fully render — no git toolbar when laneId is null
    await waitFor(() => {
      expect(screen.queryByText("Commit")).toBeNull();
    });
  });

  it("launches one child lane per parallel model and opens work-focus tiling", async () => {
    const createdLanes: Array<Record<string, unknown>> = [];
    const { send, suggestLaneName, parallelLaunchStateSet } = installAdeMocks({ sessions: [], includeClaudeModel: true });
    const createChild = vi.fn().mockImplementation(async ({ name, parentLaneId }: { name: string; parentLaneId: string }) => {
      const lane = {
        id: `lane-child-${createdLanes.length + 1}`,
        name,
        laneType: "worktree",
        branchRef: `refs/heads/${name}`,
        worktreePath: `/tmp/project-under-test/${name}`,
        parentLaneId,
      };
      createdLanes.push(lane);
      return lane;
    });
    const create = vi.fn().mockImplementation(async (args: Record<string, unknown>) => buildCreatedSession(
      `session-${String(args.laneId)}`,
      {
        laneId: String(args.laneId),
        provider: args.provider as AgentChatSession["provider"],
        model: String(args.model),
        modelId: String(args.modelId),
        reasoningEffort: (args.reasoningEffort as string | null | undefined) ?? null,
      },
    ));
    suggestLaneName.mockResolvedValue("fix-login");
    window.ade.lanes.createChild = createChild as any;
    window.ade.lanes.list = vi.fn().mockImplementation(async () => ([
      {
        id: "lane-1",
        name: "parent-lane",
        laneType: "worktree",
        branchRef: "refs/heads/parent-lane",
        worktreePath: "/tmp/project-under-test/parent-lane",
      },
      ...createdLanes,
    ])) as any;
    window.ade.agentChat.create = create as any;

    renderParallelDraftPane({
      availableModelIdsOverride: [
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
      ],
    });

    const baseModelTrigger = await screen.findByRole("button", { name: "Select model" });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.click(baseModelTrigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Codex$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: /Parallel models/i }));
    fireEvent.click(screen.getAllByRole("button", { name: "Configure" })[1]!);

    const modelTrigger = await screen.findByRole("button", { name: "Select model" });
    const claudeLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Claude$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(claudeLabel), "i"));

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix the login bug" } });
    fireEvent.click(await screen.findByRole("button", { name: /Send to lanes/i }));

    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-1",
        prompt: "Fix the login bug",
        modelId: "openai/gpt-5.4",
        fallbackName: expect.stringMatching(/^chat-\d{8}-\d{6}$/),
      }));
      expect(createChild).toHaveBeenCalledTimes(2);
    });
    expect(createChild.mock.calls.map(([args]) => args.name)).toEqual([
      "fix-login-codex-gpt-5-4",
      "fix-login-claude-sonnet",
    ]);

    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      laneId: "lane-child-1",
      provider: "codex",
      modelId: "openai/gpt-5.4",
    }));
    expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      laneId: "lane-child-2",
      provider: "claude",
      modelId: "anthropic/claude-sonnet-4-6",
    }));
    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: "session-lane-child-1",
      text: "Fix the login bug",
      displayText: "Fix the login bug",
    }));
    expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: "session-lane-child-2",
      text: "Fix the login bug",
      displayText: "Fix the login bug",
    }));
    expect(parallelLaunchStateSet.mock.calls.some(([args]) =>
      args.projectRoot === "/tmp/project-under-test"
      && args.parentLaneId === "lane-1"
      && args.state?.status === "creating_lanes"
      && args.state.createdLaneIds.includes("lane-child-1"),
    )).toBe(true);
    expect(parallelLaunchStateSet.mock.calls.some(([args]) =>
      args.projectRoot === "/tmp/project-under-test"
      && args.parentLaneId === "lane-1"
      && args.state?.status === "completed"
      && args.state.sentLaneIds.includes("lane-child-2"),
    )).toBe(true);
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/lanes?laneIds=lane-child-1%2Clane-child-2&workFocus=1");
      expect(parallelLaunchStateSet).toHaveBeenLastCalledWith({
        projectRoot: "/tmp/project-under-test",
        parentLaneId: "lane-1",
        state: null,
      });
    });
  });

  it("cleans up a recovered unfinished parallel launch when the parent draft reopens", async () => {
    const deleteLane = vi.fn().mockResolvedValue(undefined);
    const { parallelLaunchStateGet, parallelLaunchStateSet } = installAdeMocks({
      parallelLaunchState: {
        parentLaneId: "lane-1",
        createdLaneIds: ["lane-child-1"],
        sentLaneIds: [],
        status: "sending",
        updatedAt: "2026-04-23T00:00:00.000Z",
        lastError: null,
      },
    });
    window.ade.lanes.delete = deleteLane as any;

    renderParallelDraftPane();

    await waitFor(() => {
      expect(parallelLaunchStateGet).toHaveBeenCalledWith({
        projectRoot: "/tmp/project-under-test",
        parentLaneId: "lane-1",
      });
      expect(deleteLane).toHaveBeenCalledWith({ laneId: "lane-child-1", force: true });
    });
    expect(parallelLaunchStateSet).toHaveBeenCalledWith({
      projectRoot: "/tmp/project-under-test",
      parentLaneId: "lane-1",
      state: null,
    });
  });

  it("surfaces partial rollback failures when a parallel launch cannot clean up", async () => {
    const createdLanes: Array<Record<string, unknown>> = [];
    const send = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Lane 2 failed to send."));
    const deleteLane = vi.fn().mockImplementation(async ({ laneId }: { laneId: string }) => {
      if (laneId === "lane-child-1") {
        throw new Error("worktree locked");
      }
      const index = createdLanes.findIndex((lane) => lane.id === laneId);
      if (index >= 0) createdLanes.splice(index, 1);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { suggestLaneName, parallelLaunchStateSet } = installAdeMocks({ sessions: [], includeClaudeModel: true });
    const createChild = vi.fn().mockImplementation(async ({ name, parentLaneId }: { name: string; parentLaneId: string }) => {
      const lane = {
        id: `lane-child-${createdLanes.length + 1}`,
        name,
        laneType: "worktree",
        branchRef: `refs/heads/${name}`,
        worktreePath: `/tmp/project-under-test/${name}`,
        parentLaneId,
      };
      createdLanes.push(lane);
      return lane;
    });
    const create = vi.fn().mockImplementation(async (args: Record<string, unknown>) => buildCreatedSession(
      `session-${String(args.laneId)}`,
      {
        laneId: String(args.laneId),
        provider: args.provider as AgentChatSession["provider"],
        model: String(args.model),
        modelId: String(args.modelId),
      },
    ));
    suggestLaneName.mockResolvedValue("fix-login");
    window.ade.agentChat.send = send as any;
    window.ade.agentChat.create = create as any;
    window.ade.lanes.createChild = createChild as any;
    window.ade.lanes.delete = deleteLane as any;
    window.ade.lanes.list = vi.fn().mockImplementation(async () => ([
      {
        id: "lane-1",
        name: "parent-lane",
        laneType: "worktree",
        branchRef: "refs/heads/parent-lane",
        worktreePath: "/tmp/project-under-test/parent-lane",
      },
      ...createdLanes,
    ])) as any;

    renderParallelDraftPane({
      availableModelIdsOverride: [
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
      ],
    });

    const baseModelTrigger = await screen.findByRole("button", { name: "Select model" });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.click(baseModelTrigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Codex$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: /Parallel models/i }));
    fireEvent.click(screen.getAllByRole("button", { name: "Configure" })[1]!);
    fireEvent.click(await screen.findByRole("button", { name: "Select model" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Claude$/i }));
    await clickEnabledModelOption(/Claude Sonnet 4\.6/i);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix the login bug" } });
    fireEvent.click(await screen.findByRole("button", { name: /Send to lanes/i }));

    expect(await screen.findByText(/Lane 2 failed to send\./i)).toBeTruthy();
    expect(screen.getByText(/Cleanup could not delete lane lane-child-1/i)).toBeTruthy();
    expect(deleteLane).toHaveBeenNthCalledWith(1, { laneId: "lane-child-1", force: true });
    expect(deleteLane).toHaveBeenNthCalledWith(2, { laneId: "lane-child-2", force: true });
    expect(errorSpy).toHaveBeenCalledWith(
      "parallel launch cleanup failed",
      expect.objectContaining({ laneId: "lane-child-1" }),
    );
    expect(parallelLaunchStateSet.mock.calls.some(([args]) =>
      args.projectRoot === "/tmp/project-under-test"
      && args.parentLaneId === "lane-1"
      && args.state?.status === "cleanup_pending"
      && args.state.createdLaneIds.includes("lane-child-1"),
    )).toBe(true);
    errorSpy.mockRestore();
  });
});
