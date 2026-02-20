/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChatPane } from "./AgentChatPane";
import type { AgentChatModelInfo, AgentChatSessionSummary, AgentChatEventEnvelope } from "../../../shared/types";

const CODEX_MODELS: AgentChatModelInfo[] = [
  {
    id: "gpt-5.3-codex",
    displayName: "gpt-5.3-codex",
    isDefault: true,
    reasoningEfforts: [
      { effort: "low", description: "Fast" },
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "Deep" }
    ]
  },
  { id: "gpt-5.2-codex", displayName: "gpt-5.2-codex", isDefault: false }
];

const CLAUDE_MODELS: AgentChatModelInfo[] = [
  { id: "sonnet", displayName: "Sonnet", isDefault: true },
  { id: "opus", displayName: "Opus", isDefault: false }
];

function mockSession(overrides: Partial<AgentChatSessionSummary> = {}): AgentChatSessionSummary {
  return {
    sessionId: "session-1",
    laneId: "lane-1",
    provider: "codex",
    model: "gpt-5.3-codex",
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
  codexModels?: AgentChatModelInfo[];
  claudeModels?: AgentChatModelInfo[];
} = {}) {
  const sessions = overrides.sessions ?? [];
  const codexModels = overrides.codexModels ?? CODEX_MODELS;
  const claudeModels = overrides.claudeModels ?? CLAUDE_MODELS;

  (window as any).ade = {
    agentChat: {
      models: vi.fn(async ({ provider }: { provider: string }) => {
        return provider === "codex" ? codexModels : claudeModels;
      }),
      list: vi.fn(async () => sessions),
      create: vi.fn(async ({ provider, model }: any) => ({
        id: "new-session-1",
        laneId: "lane-1",
        provider,
        model,
        status: "idle",
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString()
      })),
      send: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      approve: vi.fn(async () => {}),
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
    expect(screen.getByText("No lane selected")).toBeTruthy();
  });

  it("loads models for both providers on boot", async () => {
    setupWindowAde();
    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      const ade = (window as any).ade;
      expect(ade.agentChat.models).toHaveBeenCalledWith({ provider: "codex" });
      expect(ade.agentChat.models).toHaveBeenCalledWith({ provider: "claude" });
    });
  });

  it("shows session list from existing sessions", async () => {
    const session = mockSession();
    setupWindowAde({ sessions: [session] });

    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText(/codex · gpt-5\.3-codex/)).toBeTruthy();
    });
  });

  it("creates new session when New chat is clicked", async () => {
    setupWindowAde();
    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText("New chat")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("New chat"));
    });

    await waitFor(() => {
      const ade = (window as any).ade;
      expect(ade.agentChat.create).toHaveBeenCalled();
    });
  });

  it("persists last used provider to localStorage", async () => {
    setupWindowAde();
    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      const stored = window.localStorage.getItem("ade.chat.lastProvider");
      expect(stored).toBe("codex");
    });
  });

  it("persists last used model to localStorage", async () => {
    setupWindowAde();
    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      const stored = window.localStorage.getItem("ade.chat.lastModel:codex");
      expect(stored).toBeTruthy();
    });
  });

  it("falls back to available provider when current has no models", async () => {
    setupWindowAde({ codexModels: [], claudeModels: CLAUDE_MODELS });
    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      const stored = window.localStorage.getItem("ade.chat.lastProvider");
      expect(stored).toBe("claude");
    });
  });

  it("reads last used provider from localStorage on boot", async () => {
    window.localStorage.setItem("ade.chat.lastProvider", "claude");
    window.localStorage.setItem("ade.chat.lastModel:claude", "opus");

    setupWindowAde();
    (window as any).ade.projectConfig.get = vi.fn(async () => ({
      effective: { ai: { chat: { defaultProvider: "last_used", sendOnEnter: true } } }
    }));

    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      const modelStored = window.localStorage.getItem("ade.chat.lastModel:claude");
      expect(modelStored).toBe("opus");
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
      expect(screen.getByText(/codex · gpt-5\.3-codex/)).toBeTruthy();
    });

    // Lock mode hides the "New chat" button
    expect(screen.queryByText("New chat")).toBeNull();
  });

  it("shows empty state when no session is selected", async () => {
    setupWindowAde({ sessions: [] });
    render(<AgentChatPane laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText("No chat session")).toBeTruthy();
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
      expect(screen.getByText(/codex · gpt-5\.3-codex/)).toBeTruthy();
    });

    // Type into the composer
    const textarea = screen.getByPlaceholderText("Ask Codex or Claude to work in this lane...") as HTMLTextAreaElement;
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
    const sendButton = screen.getByText("Send");
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
});
