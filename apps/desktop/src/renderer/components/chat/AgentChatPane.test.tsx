/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChatPane } from "./AgentChatPane";
import type { AgentChatSessionSummary, AgentChatEventEnvelope } from "../../../shared/types";

function mockSession(overrides: Partial<AgentChatSessionSummary> = {}): AgentChatSessionSummary {
  return {
    sessionId: "session-1",
    laneId: "lane-1",
    provider: "codex",
    model: "gpt-5.3-codex",
    modelId: "openai/gpt-5.3-codex",
    title: "Initial chat",
    reasoningEffort: "medium",
    status: "idle",
    startedAt: "2026-02-20T10:00:00Z",
    endedAt: null,
    lastActivityAt: "2026-02-20T10:01:00Z",
    lastOutputPreview: null,
    summary: null,
    ...overrides
  };
}

let eventCallback: ((envelope: AgentChatEventEnvelope) => void) | null = null;

function findAncestorWithClass(node: HTMLElement | null, className: string): HTMLElement | null {
  let current = node;
  while (current) {
    if (current.classList.contains(className)) return current;
    current = current.parentElement;
  }
  return null;
}

function clickEnabledModelOption(name: RegExp | string) {
  const option = screen
    .getAllByRole("option", { name })
    .find((candidate) => candidate.getAttribute("aria-disabled") !== "true");
  expect(option).toBeTruthy();
  fireEvent.click(option!);
}

function setupWindowAde(overrides: {
  sessions?: AgentChatSessionSummary[];
  codexAvailable?: boolean;
  claudeAvailable?: boolean;
  availableModelIds?: string[];
} = {}) {
  const sessions = overrides.sessions ?? [];
  const codexAvailable = overrides.codexAvailable ?? true;
  const claudeAvailable = overrides.claudeAvailable ?? true;
  const availableModelIds = overrides.availableModelIds ?? [
    ...(codexAvailable ? ["openai/gpt-5.3-codex"] : []),
    ...(claudeAvailable ? ["anthropic/claude-sonnet-4-6"] : []),
  ];

  (window as any).ade = {
    ai: {
      getStatus: vi.fn(async () => ({
        mode: "subscription",
        availableProviders: {
          codex: codexAvailable,
          claude: claudeAvailable,
        },
        models: {
          codex: codexAvailable ? [{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex" }] : [],
          claude: claudeAvailable ? [{ id: "sonnet", label: "Claude Sonnet" }] : [],
        },
        availableModelIds,
        detectedAuth: [
          ...(codexAvailable ? [{ type: "cli-subscription", cli: "codex", authenticated: true, verified: true }] : []),
          ...(claudeAvailable ? [{ type: "cli-subscription", cli: "claude", authenticated: true, verified: true }] : []),
        ],
        features: [],
      })),
    },
    agentChat: {
      models: vi.fn(async ({ provider }: { provider: string }) => {
        if (provider === "codex") {
          return codexAvailable
            ? [{ id: "gpt-5.3-codex", displayName: "gpt-5.3-codex", isDefault: true }]
            : [];
        }
        return claudeAvailable
          ? [{ id: "sonnet", displayName: "Sonnet", isDefault: true }]
          : [];
      }),
      list: vi.fn(async () => sessions),
      create: vi.fn(async ({ provider, model, modelId }: any) => ({
        id: "new-session-1",
        laneId: "lane-1",
        provider,
        model,
        modelId,
        status: "idle",
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString()
      })),
      send: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      approve: vi.fn(async () => {}),
      changePermissionMode: vi.fn(async () => {}),
      updateSession: vi.fn(async ({ sessionId, modelId, reasoningEffort, permissionMode }: any) => ({
        id: sessionId,
        laneId: "lane-1",
        provider: modelId === "anthropic/claude-sonnet-4-6" ? "claude" : "codex",
        model: modelId === "anthropic/claude-sonnet-4-6" ? "sonnet" : "gpt-5.3-codex",
        modelId,
        reasoningEffort: reasoningEffort ?? "medium",
        permissionMode,
        status: "idle",
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString()
      })),
      onEvent: vi.fn((cb: (envelope: AgentChatEventEnvelope) => void) => {
        eventCallback = cb;
        return () => { eventCallback = null; };
      }),
      listContextPacks: vi.fn(async () => []),
      fetchContextPack: vi.fn(async () => ({ scope: "project", content: "", truncated: false }))
    },
    sessions: {
      get: vi.fn(async () => null),
      readTranscriptTail: vi.fn(async () => "")
    },
    projectConfig: {
      get: vi.fn(async () => ({
        effective: { ai: { chat: { defaultProvider: "codex", sendOnEnter: true } } }
      }))
    },
    files: {
      quickOpen: vi.fn(async () => [])
    }
  };
}

describe("AgentChatPane", () => {
  beforeEach(() => {
    window.localStorage.clear();
    eventCallback = null;
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
  });

  it("renders empty state when no lane is selected", () => {
    setupWindowAde();
    render(<AgentChatPane laneId={null} />);
    expect(screen.getByText("Select a lane to start chatting")).toBeTruthy();
  });

  it("loads models for both providers on boot", async () => {
    setupWindowAde();
    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      const ade = (window as any).ade;
      expect(ade.ai.getStatus).toHaveBeenCalled();
    });
  });

  it("shows session list from existing sessions", async () => {
    const session = mockSession();
    setupWindowAde({ sessions: [session] });

    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      const ade = (window as any).ade;
      expect(ade.agentChat.list).toHaveBeenCalledWith({ laneId: "lane-1" });
    });

    expect(screen.getByText("Start typing below")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Initial chat/i })).toBeTruthy();
  });

  it("creates a new session on first submit after New chat is clicked", async () => {
    setupWindowAde();
    render(<AgentChatPane laneId="lane-1" initialSessionId="latest-session" />);

    await waitFor(() => {
      expect(screen.getByTitle("New chat")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle("New chat"));
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Message the agent..."), {
        target: { value: "hello" },
      });
      fireEvent.click(screen.getByTitle("Send"));
    });

    await waitFor(() => {
      const ade = (window as any).ade;
      expect(ade.agentChat.create).toHaveBeenCalled();
      // New API passes modelId
      expect(ade.agentChat.create).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: expect.any(String), sessionProfile: "light" })
      );
    });
  });

  it("waits for the session-created handoff before sending the first message", async () => {
    setupWindowAde();
    const ade = (window as any).ade;
    let resolveHandoff: (() => void) | null = null;
    const onSessionCreated = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHandoff = resolve;
        }),
    );

    render(<AgentChatPane laneId="lane-1" onSessionCreated={onSessionCreated} />);

    const textarea = await screen.findByPlaceholderText("Message the agent...");

    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: "hello" },
      });
      fireEvent.click(screen.getByTitle("Send"));
    });

    await waitFor(() => {
      expect(ade.agentChat.create).toHaveBeenCalled();
      expect(onSessionCreated).toHaveBeenCalledWith("new-session-1");
    });

    expect(ade.agentChat.send).not.toHaveBeenCalled();

    await act(async () => {
      resolveHandoff?.();
    });

    await waitFor(() => {
      expect(ade.agentChat.send).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "new-session-1",
          text: "hello",
        }),
      );
    });
  });

  it("only creates and sends once for two rapid Enter submits when no session is selected", async () => {
    setupWindowAde();
    const ade = (window as any).ade;

    let resolveCreate: ((value: {
      id: string;
      laneId: string;
      provider: string;
      model: string;
      modelId: string;
      status: string;
      createdAt: string;
      lastActivityAt: string;
    }) => void) | null = null;
    ade.agentChat.create = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        })
    );

    render(<AgentChatPane laneId="lane-1" initialSessionId="existing-session" />);

    const textarea = await screen.findByPlaceholderText("Message the agent...");

    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: "hello" },
      });
    });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter" });
      fireEvent.keyDown(textarea, { key: "Enter" });
    });

    expect(ade.agentChat.create).toHaveBeenCalledTimes(1);
    expect(ade.agentChat.send).not.toHaveBeenCalled();

    await act(async () => {
      resolveCreate?.({
        id: "new-session-1",
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.3-codex",
        modelId: "openai/gpt-5.3-codex",
        status: "idle",
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString()
      });
    });

    await waitFor(() => {
      expect(ade.agentChat.create).toHaveBeenCalledTimes(1);
      expect(ade.agentChat.send).toHaveBeenCalledTimes(1);
      expect(ade.agentChat.send).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "new-session-1",
          text: "hello"
        })
      );
    });
  });

  it("opens a question modal for askUser approvals and sends the typed answer", async () => {
    const session = mockSession({ provider: "unified", modelId: "anthropic/claude-sonnet-4-6-api", model: "anthropic/claude-sonnet-4-6-api" });
    setupWindowAde({ sessions: [session], codexAvailable: false, claudeAvailable: true });
    render(<AgentChatPane laneId="lane-1" lockSessionId="session-1" />);

    await waitFor(() => {
      expect(eventCallback).toBeTruthy();
    });

    await act(async () => {
      eventCallback?.({
        sessionId: "session-1",
        timestamp: new Date().toISOString(),
        event: {
          type: "approval_request",
          itemId: "ask-user-1",
          kind: "tool_call",
          description: "What env should I use?",
          detail: {
            tool: "askUser",
            question: "What env should I use?",
            inputType: "text",
          },
        },
      });
    });

    expect(await screen.findByText("Agent Question")).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Type the answer you want the agent to follow..."), {
        target: { value: "Use staging." },
      });
      fireEvent.click(screen.getByRole("button", { name: /Send Answer/i }));
    });

    await waitFor(() => {
      const ade = (window as any).ade;
      expect(ade.agentChat.approve).toHaveBeenCalledWith({
        sessionId: "session-1",
        itemId: "ask-user-1",
        decision: "accept",
        responseText: "Use staging."
      });
    });
  });

  it("retargets a locked empty session when the model changes before the first send", async () => {
    const session = mockSession();
    setupWindowAde({ sessions: [session] });
    render(<AgentChatPane laneId="lane-1" lockSessionId="session-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Select model")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Select model"));
    });

    await act(async () => {
      clickEnabledModelOption(/Claude Sonnet 4\.6/i);
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Message the agent..."), {
        target: { value: "hello" },
      });
      fireEvent.click(screen.getByTitle("Send"));
    });

    await waitFor(() => {
      const ade = (window as any).ade;
      expect(ade.agentChat.updateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
          modelId: "anthropic/claude-sonnet-4-6"
        })
      );
      expect(ade.agentChat.create).not.toHaveBeenCalled();
      expect(ade.agentChat.send).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "session-1" })
      );
    });
  });

  it("persists last used model ID to localStorage", async () => {
    setupWindowAde();
    render(<AgentChatPane laneId="lane-1" initialSessionId="latest-session" />);

    await waitFor(() => {
      const stored = window.localStorage.getItem("ade.chat.lastModelId");
      expect(stored).toBeTruthy();
    });
  });

  it("falls back to available model when current model is not available", async () => {
    // Only claude available, no codex
    setupWindowAde({ codexAvailable: false, claudeAvailable: true });
    render(<AgentChatPane laneId="lane-1" initialSessionId="existing-session" />);

    await waitFor(() => {
      const stored = window.localStorage.getItem("ade.chat.lastModelId");
      // Should fall back to an anthropic model
      expect(stored).toMatch(/^anthropic\//);
    });
  });

  it("reads last used model ID from localStorage on boot", async () => {
    window.localStorage.setItem("ade.chat.lastModelId", "anthropic/claude-sonnet-4-6");

    setupWindowAde();
    render(<AgentChatPane laneId="lane-1" initialSessionId="existing-session" />);

    await waitFor(() => {
      const stored = window.localStorage.getItem("ade.chat.lastModelId");
      expect(stored).toBe("anthropic/claude-sonnet-4-6");
    });
  });

  it("subscribes to chat events and updates on incoming events", async () => {
    const session = mockSession();
    setupWindowAde({ sessions: [session] });
    render(<AgentChatPane laneId="lane-1" initialSessionId="latest-session" />);

    await waitFor(() => {
      expect(eventCallback).toBeTruthy();
    });

    expect((window as any).ade.agentChat.onEvent).toHaveBeenCalled();
  });

  it("shows locked session info instead of session switcher", async () => {
    const session = mockSession();
    setupWindowAde({ sessions: [session] });
    render(<AgentChatPane laneId="lane-1" lockSessionId="session-1" />);

    await waitFor(() => {
      // Lock mode loads the sessions and uses the locked session
      const ade = (window as any).ade;
      expect(ade.agentChat.list).toHaveBeenCalled();
    });

    // Lock mode hides the "New chat" button
    expect(screen.queryByTitle("New chat")).toBeNull();
  });

  it("clips the transcript region above the composer in locked sessions", async () => {
    const session = mockSession();
    setupWindowAde({ sessions: [session] });
    render(<AgentChatPane laneId="lane-1" lockSessionId="session-1" />);

    const emptyState = await screen.findByText("Chat feels alive here now.");
    const scrollRegion = findAncestorWithClass(emptyState as HTMLElement, "overflow-auto");

    expect(scrollRegion).toBeTruthy();
    expect(scrollRegion?.parentElement?.classList.contains("overflow-hidden")).toBe(true);
  });

  it("shows empty state when no session is selected", async () => {
    setupWindowAde({ sessions: [] });
    render(<AgentChatPane laneId="lane-1" initialSessionId="existing-session" />);

    await waitFor(() => {
      expect(screen.getByText("Start typing below")).toBeTruthy();
    });
  });

  it("renders the minimal empty state when embedded in the work launcher", async () => {
    setupWindowAde({ sessions: [] });
    render(<AgentChatPane laneId="lane-1" forceDraftMode hideSessionTabs />);

    await waitFor(() => {
      expect(screen.getByText("Start typing below")).toBeTruthy();
      // Quick start suggestions are available
      expect(screen.getByText("Explain the project structure")).toBeTruthy();
    });
  });

  it("sends with default execution mode when no selector is present", async () => {
    setupWindowAde({ sessions: [] });
    render(<AgentChatPane laneId="lane-1" forceDraftMode hideSessionTabs />);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Message the agent..."), {
        target: { value: "Use the configured agents to review the repo" },
      });
      fireEvent.click(screen.getByTitle("Send"));
    });

    await waitFor(() => {
      const ade = (window as any).ade;
      expect(ade.agentChat.send).toHaveBeenCalledWith(
        expect.objectContaining({
          displayText: "Use the configured agents to review the repo",
          executionMode: "focused",
        }),
      );
    });
  });

  it("fetches context packs and prepends their content to message on submit", async () => {
    const session = mockSession();
    setupWindowAde({ sessions: [session] });

    // Configure fetchContextPack to return real content
    (window as any).ade.agentChat.fetchContextPack = vi.fn(async ({ scope }: { scope: string }) => ({
      scope,
      content: `[Context Pack: ${scope}] project overview data`,
      truncated: false
    }));

    render(<AgentChatPane laneId="lane-1" initialSessionId="existing-session" />);

    // Wait for boot to complete
    await waitFor(() => {
      const ade = (window as any).ade;
      expect(ade.agentChat.list).toHaveBeenCalled();
    });

    // Type into the composer
    const textarea = screen.getByPlaceholderText("Message the agent...") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Run the tests" } });
    });

    // Open context picker and select a pack by simulating the onContextPacksChange flow.
    // The AgentChatPane passes onContextPacksChange={setSelectedContextPacks} to AgentChatComposer,
    // and on submit it reads selectedContextPacks and calls fetchContextPack.
    // We simulate the # key to open context picker, but since there's async loading involved,
    // let's directly trigger via the keyboard shortcut:
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "#" });
    });

    // Wait for context packs to load (listContextPacks is called)
    // For this test, let's configure listContextPacks to return packs
    (window as any).ade.agentChat.listContextPacks = vi.fn(async () => [
      { scope: "project", label: "Project", description: "Full project context", available: true }
    ]);

    // Re-open the picker to trigger the fetch
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Escape" });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "#" });
    });

    // Wait for the context pack items to appear
    await waitFor(() => {
      expect(screen.getByText("Project")).toBeTruthy();
    });

    // Click on the project pack to select it
    await act(async () => {
      fireEvent.click(screen.getByText("Project"));
    });

    // Close context picker
    await act(async () => {
      fireEvent.click(screen.getByText("Done"));
    });

    // Now submit the message
    const sendButton = screen.getByTitle("Send");
    await act(async () => {
      fireEvent.click(sendButton);
    });

    // Verify fetchContextPack was called
    await waitFor(() => {
      expect((window as any).ade.agentChat.fetchContextPack).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" })
      );
    });

    // Verify send was called with content prepended
    await waitFor(() => {
      const sendCalls = (window as any).ade.agentChat.send.mock.calls;
      expect(sendCalls.length).toBeGreaterThan(0);
      const sentText = sendCalls[0]?.[0]?.text as string;
      expect(sentText).toContain("[Context: Project]");
      expect(sentText).toContain("Run the tests");
    });
  });

  it("retargets an untouched active session when switching to a different model family", async () => {
    const session = mockSession({
      sessionId: "existing-session",
      provider: "codex",
      model: "gpt-5.3-codex",
      modelId: "openai/gpt-5.3-codex",
    });
    setupWindowAde({ sessions: [session], codexAvailable: true, claudeAvailable: true });

    render(<AgentChatPane laneId="lane-1" initialSessionId="latest-session" />);

    await waitFor(() => {
      const ade = (window as any).ade;
      expect(ade.agentChat.list).toHaveBeenCalledWith({ laneId: "lane-1" });
    });

    // The model selector is now a custom dropdown button
    const modelButton = screen.getByLabelText("Select model");
    await waitFor(() => {
      // Verify the current model is displayed in the button text
      expect(modelButton.textContent).toContain("GPT-5.3 Codex");
    });

    // Open the dropdown and select the Claude model
    await act(async () => {
      fireEvent.click(modelButton);
    });
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeTruthy();
    });
    await act(async () => {
      clickEnabledModelOption(/Claude Sonnet 4\.6/i);
    });
    await waitFor(() => {
      expect(modelButton.textContent).toContain("Claude Sonnet 4.6");
    });

    const textarea = screen.getByPlaceholderText("Message the agent...");
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Switch model family now" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle("Send"));
    });

    await waitFor(() => {
      const ade = (window as any).ade;
      expect(ade.agentChat.updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "existing-session",
        modelId: "anthropic/claude-sonnet-4-6",
      }));
      expect(ade.agentChat.send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "existing-session",
      }));
      expect(ade.agentChat.create).not.toHaveBeenCalled();
    });
  });

  it("re-syncs the composer model when the user re-selects the active session tab", async () => {
    const session = mockSession({
      sessionId: "existing-session",
      title: "Claude debugging chat",
    });
    setupWindowAde({ sessions: [session], codexAvailable: true, claudeAvailable: true });

    render(<AgentChatPane laneId="lane-1" initialSessionId="existing-session" />);

    const modelButton = await screen.findByLabelText("Select model");
    await waitFor(() => {
      expect(modelButton.textContent).toContain("GPT-5.3 Codex");
    });

    await act(async () => {
      fireEvent.click(modelButton);
    });
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeTruthy();
    });
    await act(async () => {
      clickEnabledModelOption(/Claude Sonnet 4\.6/i);
    });

    await waitFor(() => {
      expect(modelButton.textContent).toContain("Claude Sonnet 4.6");
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Claude debugging chat/i }));
    });

    await waitFor(() => {
      expect(modelButton.textContent).toContain("GPT-5.3 Codex");
    });
  });

  it("keeps an active session model selected even when it is not currently configured", async () => {
    const session = mockSession({
      sessionId: "latest-session",
      provider: "unified",
      model: "gpt-5-chat-latest",
      modelId: "openai/gpt-5-chat-latest",
      title: "Latest model thread",
    });
    setupWindowAde({
      sessions: [session],
      availableModelIds: ["anthropic/claude-sonnet-4-6"],
      codexAvailable: false,
      claudeAvailable: true,
    });

    render(<AgentChatPane laneId="lane-1" initialSessionId="latest-session" />);

    const modelButton = await screen.findByLabelText("Select model");
    await waitFor(() => {
      expect(modelButton.textContent).toContain("GPT-5 Chat Latest");
    });
  });

  it("falls back to the model label when saved titles and summaries are low-signal", async () => {
    const session = mockSession({
      sessionId: "existing-session",
      title: "completed: .",
      summary: "completed: OK",
    });
    setupWindowAde({ sessions: [session] });

    render(<AgentChatPane laneId="lane-1" />);

    const sessionTab = await screen.findByRole("button", { name: /GPT-5\.3 Codex/i });
    expect(sessionTab.textContent).toContain("GPT-5.3 Codex");
    expect(sessionTab.textContent?.toLowerCase()).not.toContain("completed");
  });

  it("keeps the newly created chat selected while the session list catches up", async () => {
    const session = mockSession({
      sessionId: "existing-session",
      provider: "codex",
      model: "gpt-5.3-codex",
      modelId: "openai/gpt-5.3-codex",
      title: "Existing codex chat",
    });
    setupWindowAde({ sessions: [session], codexAvailable: true, claudeAvailable: true });

    render(<AgentChatPane laneId="lane-1" initialSessionId="existing-session" />);

    await waitFor(() => {
      expect((window as any).ade.agentChat.list).toHaveBeenCalledWith({ laneId: "lane-1" });
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle("New chat"));
    });

    const modelButton = screen.getByLabelText("Select model");
    await act(async () => {
      fireEvent.click(modelButton);
    });
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeTruthy();
    });
    await act(async () => {
      clickEnabledModelOption(/Claude Sonnet 4\.6/i);
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Message the agent..."), {
        target: { value: "Give this a better title" },
      });
      fireEvent.click(screen.getByTitle("Send"));
    });

    await waitFor(() => {
      expect((window as any).ade.agentChat.create).toHaveBeenCalled();
      expect((window as any).ade.agentChat.send).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "new-session-1" }),
      );
    });

    expect(modelButton.textContent).toContain("Claude Sonnet 4.6");
  });

  it("does not let an initial session override a newly created chat after refresh", async () => {
    const session = mockSession({
      sessionId: "existing-session",
      provider: "codex",
      model: "gpt-5.3-codex",
      modelId: "openai/gpt-5.3-codex",
      title: "Existing codex chat",
    });
    setupWindowAde({ sessions: [session], codexAvailable: true, claudeAvailable: true });

    render(<AgentChatPane laneId="lane-1" initialSessionId="existing-session" />);

    await waitFor(() => {
      expect((window as any).ade.agentChat.list).toHaveBeenCalledWith({ laneId: "lane-1" });
    });

    const modelButton = screen.getByLabelText("Select model");

    await act(async () => {
      fireEvent.click(screen.getByTitle("New chat"));
    });

    await act(async () => {
      fireEvent.click(modelButton);
    });
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeTruthy();
    });
    await act(async () => {
      clickEnabledModelOption(/Claude Sonnet 4\.6/i);
    });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Message the agent..."), {
        target: { value: "Stay on the new chat" },
      });
      fireEvent.click(screen.getByTitle("Send"));
    });

    await waitFor(() => {
      expect((window as any).ade.agentChat.create).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-4-6",
      }));
      expect((window as any).ade.agentChat.send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "new-session-1",
      }));
    });

    expect(modelButton.textContent).toContain("Claude Sonnet 4.6");
  });
});
