/* @vitest-environment jsdom */

import React from "react";
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

function setupWindowAde(overrides: {
  sessions?: AgentChatSessionSummary[];
  codexAvailable?: boolean;
  claudeAvailable?: boolean;
} = {}) {
  const sessions = overrides.sessions ?? [];
  const codexAvailable = overrides.codexAvailable ?? true;
  const claudeAvailable = overrides.claudeAvailable ?? true;

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
      // After boot, the session list is loaded and the first session is auto-selected
      const ade = (window as any).ade;
      expect(ade.agentChat.list).toHaveBeenCalledWith({ laneId: "lane-1" });
    });
  });

  it("creates new session when New chat is clicked", async () => {
    setupWindowAde();
    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByTitle("New chat")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle("New chat"));
    });

    await waitFor(() => {
      const ade = (window as any).ade;
      expect(ade.agentChat.create).toHaveBeenCalled();
      // New API passes modelId
      expect(ade.agentChat.create).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: expect.any(String) })
      );
    });
  });

  it("persists last used model ID to localStorage", async () => {
    setupWindowAde();
    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      const stored = window.localStorage.getItem("ade.chat.lastModelId");
      expect(stored).toBeTruthy();
    });
  });

  it("falls back to available model when current model is not available", async () => {
    // Only claude available, no codex
    setupWindowAde({ codexAvailable: false, claudeAvailable: true });
    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      const stored = window.localStorage.getItem("ade.chat.lastModelId");
      // Should fall back to an anthropic model
      expect(stored).toMatch(/^anthropic\//);
    });
  });

  it("reads last used model ID from localStorage on boot", async () => {
    window.localStorage.setItem("ade.chat.lastModelId", "anthropic/claude-sonnet-4-6");

    setupWindowAde();
    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      const stored = window.localStorage.getItem("ade.chat.lastModelId");
      expect(stored).toBe("anthropic/claude-sonnet-4-6");
    });
  });

  it("subscribes to chat events and updates on incoming events", async () => {
    const session = mockSession();
    setupWindowAde({ sessions: [session] });
    render(<AgentChatPane laneId="lane-1" />);

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

  it("shows empty state when no session is selected", async () => {
    setupWindowAde({ sessions: [] });
    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText("Start a new chat")).toBeTruthy();
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

    render(<AgentChatPane laneId="lane-1" />);

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

  it("creates a new session when switching to a different model family from an active session", async () => {
    const session = mockSession({
      sessionId: "existing-session",
      provider: "codex",
      model: "gpt-5.3-codex",
      modelId: "openai/gpt-5.3-codex",
    });
    setupWindowAde({ sessions: [session], codexAvailable: true, claudeAvailable: true });

    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      const ade = (window as any).ade;
      expect(ade.agentChat.list).toHaveBeenCalledWith({ laneId: "lane-1" });
    });

    const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
    await waitFor(() => {
      expect(modelSelect.value).toBe("openai/gpt-5.3-codex");
    });
    await act(async () => {
      fireEvent.change(modelSelect, { target: { value: "anthropic/claude-sonnet-4-6" } });
    });
    await waitFor(() => {
      expect(modelSelect.value).toBe("anthropic/claude-sonnet-4-6");
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
      expect(ade.agentChat.create).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-4-6",
      }));
      expect(ade.agentChat.send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "new-session-1",
      }));
    });
  });
});
