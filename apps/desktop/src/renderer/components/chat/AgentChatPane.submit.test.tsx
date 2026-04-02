/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  createDefaultComputerUsePolicy,
  type AgentChatEventEnvelope,
  type AgentChatSession,
  type AgentChatSessionSummary,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
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
    computerUse: createDefaultComputerUsePolicy(),
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
    computerUse: createDefaultComputerUsePolicy(),
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
        if (provider === "unified") return [{ id: "openai/gpt-5.4-mini" }];
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
    externalMcp: {
      onEvent: vi.fn().mockImplementation(() => () => undefined),
    },
    files: {
      listWorkspaces: vi.fn().mockResolvedValue([]),
    },
  } as any;

  return {
    send,
    steer,
    list,
    create,
    handoff,
    emitChatEvent: (event: AgentChatEventEnvelope) => {
      for (const listener of chatEventListeners) {
        listener(event);
      }
    },
  };
}

const originalAde = globalThis.window.ade;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
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
  });

  it("keeps the draft cleared after send succeeds even if session refresh fails", async () => {
    const session = buildSession("session-1");
    const { send, list } = installAdeMocks({
      listError: new Error("refresh failed"),
    });

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Ship the transcript cleanup." } });
    fireEvent.click(screen.getByTitle("Send"));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Ship the transcript cleanup.",
        displayText: "Ship the transcript cleanup.",
      }));
      expect(list).toHaveBeenCalled();
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("shows an optimistic queued bubble immediately for Cursor-style sends", async () => {
    const session = buildSession("session-1");
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
    fireEvent.click(screen.getByTitle("Send"));

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
    const { steer, list } = installAdeMocks({
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
      expect(list).toHaveBeenCalled();
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("restores the draft when the send itself fails", async () => {
    const session = buildSession("session-1");
    const { send } = installAdeMocks({
      sendError: new Error("send failed"),
    });

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Retry after the failure." } });
    fireEvent.click(screen.getByTitle("Send"));

    await waitFor(() => {
      expect(send).toHaveBeenCalled();
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Retry after the failure.");
    });
  });

  it("sends the selected Claude interaction mode with the next turn", async () => {
    const session = buildSession("session-1", {
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

    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        interactionMode: "plan",
      }));
    });

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Just plan the implementation." } });
    fireEvent.click(screen.getByTitle("Send"));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Just plan the implementation.",
        interactionMode: "plan",
      }));
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
    const session = buildSession("session-1");
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
    fireEvent.click(await screen.findByRole("button", { name: /Anthropic/i }));
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
      computerUse: session.computerUse,
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
    const session = buildSession("session-1");
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
    fireEvent.click(await screen.findByRole("button", { name: /Anthropic/i }));
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
    const session = buildSession("session-1");
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

    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
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
    fireEvent.click(await screen.findByRole("button", { name: /OpenAI/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Ship the instant route fix." } });
    fireEvent.click(screen.getByTitle("Send"));

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

  it("renders the lane navigation button when laneLabel is provided", async () => {
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

    const laneButton = await screen.findByTitle("Go to lane: feature/auth");
    expect(laneButton).toBeTruthy();
    expect(laneButton.textContent).toContain("feature/auth");
  });

  it("does not render the lane navigation button when laneId is null", async () => {
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

    // Wait for the pane to fully render (renders "Select a lane" placeholder when laneId is null)
    await waitFor(() => {
      expect(screen.queryByTitle(/Go to lane:/)).toBeNull();
    });
  });
});
