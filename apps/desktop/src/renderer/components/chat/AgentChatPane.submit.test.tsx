/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createDefaultComputerUsePolicy, type AgentChatSessionSummary } from "../../../shared/types";
import { AgentChatPane } from "./AgentChatPane";

function buildSession(sessionId: string): AgentChatSessionSummary {
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

function installAdeMocks(options?: {
  transcript?: string;
  sendError?: Error;
  steerError?: Error;
  listError?: Error;
  handoffResult?: { session: { id: string }; usedFallbackSummary: boolean };
}) {
  const send = options?.sendError
    ? vi.fn().mockRejectedValue(options.sendError)
    : vi.fn().mockResolvedValue(undefined);
  const steer = options?.steerError
    ? vi.fn().mockRejectedValue(options.steerError)
    : vi.fn().mockResolvedValue(undefined);
  const list = options?.listError
    ? vi.fn().mockRejectedValue(options.listError)
    : vi.fn().mockResolvedValue([buildSession("session-1")]);
  const handoff = vi.fn().mockResolvedValue(options?.handoffResult ?? {
    session: { id: "handoff-session-1" },
    usedFallbackSummary: false,
  });

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
        if (provider === "unified") return [{ id: "openai/gpt-5.4-mini" }];
        return [];
      }),
      slashCommands: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
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
      create: vi.fn().mockResolvedValue({ id: "created-session" }),
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

  return { send, steer, list, handoff };
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

describe("AgentChatPane submit recovery", () => {
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

  it("shows chat handoff only for standard locked work chats", async () => {
    const session = buildSession("session-1");
    installAdeMocks();
    renderPane(session);

    expect(await screen.findByRole("button", { name: "Chat handoff" })).not.toBeNull();

    cleanup();
    installAdeMocks();
    renderResolverPane(session);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Chat handoff" })).toBeNull();
    });
  });

  it("disables chat handoff while the current turn is still active", async () => {
    const session = buildSession("session-1");
    installAdeMocks({
      transcript: buildStatusStartedTranscript(session.sessionId),
    });

    renderPane(session);

    const button = await screen.findByRole("button", { name: "Chat handoff" });
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("creates a sibling handoff chat and opens the returned work tab", async () => {
    const session = buildSession("session-1");
    const onSessionCreated = vi.fn().mockResolvedValue(undefined);
    const { handoff } = installAdeMocks({
      handoffResult: {
        session: { id: "session-2" },
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

    fireEvent.click(await screen.findByRole("button", { name: "Chat handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create handoff chat" }));

    await waitFor(() => {
      expect(handoff).toHaveBeenCalledWith({
        sourceSessionId: session.sessionId,
        targetModelId: "openai/gpt-5.4-mini",
      });
      expect(onSessionCreated).toHaveBeenCalledWith("session-2");
    });
  });
});
