/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type {
  AgentChatEventEnvelope,
  AgentChatParallelLaunchState,
  AgentChatSession,
  AgentChatSessionSummary,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { invalidateAiDiscoveryCache } from "../../lib/aiDiscoveryCache";
import { useAppStore } from "../../state/appStore";
import { AgentChatPane } from "./AgentChatPane";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSession(sessionId: string, overrides: Partial<AgentChatSessionSummary> = {}): AgentChatSessionSummary {
  return {
    sessionId,
    laneId: "lane-1",
    provider: "codex",
    model: "gpt-5.4",
    modelId: "openai/gpt-5.4-codex",
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

function buildCreatedSession(sessionId: string, overrides: Partial<AgentChatSession> = {}): AgentChatSession {
  return {
    id: sessionId,
    laneId: "lane-1",
    provider: "codex",
    model: "gpt-5.4",
    modelId: "openai/gpt-5.4-codex",
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
  const create = vi.fn().mockResolvedValue(buildCreatedSession("created-session"));
  const suggestLaneName = vi.fn().mockResolvedValue("parallel-task");
  const parallelLaunchStateGet = vi.fn().mockResolvedValue(options?.parallelLaunchState ?? null);
  const parallelLaunchStateSet = vi.fn().mockResolvedValue(undefined);
  const chatEventListeners = new Set<(event: AgentChatEventEnvelope) => void>();

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
      getForLane: vi.fn().mockResolvedValue(null),
    },
    pty: {
      onExit: vi.fn().mockImplementation(() => () => undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      onData: vi.fn().mockImplementation(() => () => undefined),
    },
  } as any;

  return {
    send,
    steer,
    list,
    create,
    suggestLaneName,
    parallelLaunchStateGet,
    parallelLaunchStateSet,
    handoff,
    emitChatEvent: (event: AgentChatEventEnvelope) => {
      for (const listener of chatEventListeners) {
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
    runLaneId: null,
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
    fireEvent.click(await screen.findByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Ship the transcript cleanup.",
        displayText: "Ship the transcript cleanup.",
      }));
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
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
    fireEvent.click(await screen.findByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Queued — will be delivered after this turn/i)).toBeTruthy();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Ship the optimistic bubble.",
      }));
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");

    resolveSend();

    await waitFor(() => {
      expect(screen.queryByText(/Queued — will be delivered after this turn/i)).toBeNull();
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
    fireEvent.click(screen.getByTitle("Send steer message"));

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
    fireEvent.click(await screen.findByRole("button", { name: /^Send$/i }));

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
    fireEvent.click(await screen.findByRole("button", { name: /^Send$/i }));

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
    fireEvent.click(await screen.findByTitle("Send"));

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
    fireEvent.click(await screen.findByRole("button", { name: "Create handoff chat" }));

    await waitFor(() => {
      expect(handoff).toHaveBeenCalledWith({
        sourceSessionId: session.sessionId,
        targetModelId: "openai/gpt-5.4-mini",
      });
      expect(onSessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "session-2" }));
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
    const codexLabel = getModelById("openai/gpt-5.4-codex")?.displayName ?? "GPT-5.4 Codex";

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Codex$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Ship the instant route fix." } });
    fireEvent.click(await screen.findByRole("button", { name: /^Send$/i }));

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
    const codexLabel = getModelById("openai/gpt-5.4-codex")?.displayName ?? "GPT-5.4 Codex";

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: /^Codex$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Ship it." } });
    fireEvent.click(await screen.findByRole("button", { name: /^Send$/i }));

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
        "openai/gpt-5.4-codex",
        "anthropic/claude-sonnet-4-6",
      ],
    });

    const baseModelTrigger = await screen.findByRole("button", { name: "Select model" });
    const codexLabel = getModelById("openai/gpt-5.4-codex")?.displayName ?? "GPT-5.4 Codex";
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
        modelId: "openai/gpt-5.4-codex",
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
      modelId: "openai/gpt-5.4-codex",
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
        "openai/gpt-5.4-codex",
        "anthropic/claude-sonnet-4-6",
      ],
    });

    const baseModelTrigger = await screen.findByRole("button", { name: "Select model" });
    const codexLabel = getModelById("openai/gpt-5.4-codex")?.displayName ?? "GPT-5.4 Codex";
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
