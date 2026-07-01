/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AgentCliAuthCard,
  CHAT_AUTH_RETRY_REJECTED_EVENT,
  CHAT_AUTH_RECOVERED_EVENT,
  CHAT_RETRY_AUTH_TURN_EVENT,
  type AgentCliAuthCardInfo,
} from "./AgentCliAuthCard";

const originalAde = globalThis.window.ade;

const missingCli: AgentCliAuthCardInfo = {
  agent: "codex",
  displayName: "Codex",
  category: "missing",
  installCommand: "npm install -g @openai/codex",
  authCommand: "codex login",
};

const unauthenticatedCli: AgentCliAuthCardInfo = {
  ...missingCli,
  category: "unauthenticated",
};

const unauthenticatedClaude: AgentCliAuthCardInfo = {
  agent: "claude",
  displayName: "Claude Code",
  category: "unauthenticated",
  installCommand: "npm install -g @anthropic-ai/claude-code",
  authCommand: "claude auth login",
};

function installAdeStub() {
  globalThis.window.ade = {
    pty: {
      create: vi.fn().mockResolvedValue({
        sessionId: "terminal-auth-1",
        ptyId: "pty-auth-1",
        pid: 1234,
      }),
    },
    lanes: {
      list: vi.fn().mockResolvedValue([{ id: "lane-default", name: "Main" }]),
    },
  } as any;
}

describe("AgentCliAuthCard", () => {
  beforeEach(() => {
    installAdeStub();
  });

  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("opens install commands in the chat PTY context", async () => {
    const onRevealTerminal = vi.fn();

    render(
      <AgentCliAuthCard
        agentCli={missingCli}
        laneId="lane-1"
        chatSessionId="chat-1"
        onRevealTerminal={onRevealTerminal}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /run install/i }));

    await waitFor(() => {
      expect(window.ade.pty.create).toHaveBeenCalledWith({
        laneId: "lane-1",
        chatSessionId: "chat-1",
        cols: 100,
        rows: 28,
        title: "install",
        tracked: true,
        toolType: "shell",
        startupCommand: "npm install -g @openai/codex",
      });
    });
    expect(onRevealTerminal).toHaveBeenCalledWith({
      terminalId: "terminal-auth-1",
      ptyId: "pty-auth-1",
      label: "install",
    });
  });

  it("opens auth commands in the chat PTY context", async () => {
    const onRevealTerminal = vi.fn();

    render(
      <AgentCliAuthCard
        agentCli={unauthenticatedCli}
        laneId="lane-1"
        chatSessionId="chat-1"
        onRevealTerminal={onRevealTerminal}
      />,
    );

    expect(screen.queryByText("npm install -g @openai/codex")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /run auth/i }));

    await waitFor(() => {
      expect(window.ade.pty.create).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-1",
        chatSessionId: "chat-1",
        title: "auth",
        toolType: "shell",
        startupCommand: "codex login",
      }));
    });
    expect(onRevealTerminal).toHaveBeenCalledWith({
      terminalId: "terminal-auth-1",
      ptyId: "pty-auth-1",
      label: "auth",
    });
  });

  it("names the remote runtime when the auth flow runs away from the local machine", () => {
    render(<AgentCliAuthCard agentCli={missingCli} runtimeName="Mac Studio" />);

    expect(screen.getByText(/Install the CLI on Mac Studio/i)).toBeTruthy();
  });

  it("labels the Claude login action and surfaces a Retry that resends the turn", () => {
    const retrySpy = vi.fn();
    window.addEventListener(CHAT_RETRY_AUTH_TURN_EVENT, retrySpy);
    try {
      render(<AgentCliAuthCard agentCli={unauthenticatedClaude} laneId="lane-1" chatSessionId="chat-7" />);

      expect(screen.getByText("Claude Code is logged out")).toBeTruthy();
      expect(screen.getByRole("button", { name: /log in to claude/i })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /retry turn/i }));

      expect(retrySpy).toHaveBeenCalledTimes(1);
      const event = retrySpy.mock.calls[0][0] as CustomEvent<{ sessionId?: string }>;
      expect(event.detail.sessionId).toBe("chat-7");
    } finally {
      window.removeEventListener(CHAT_RETRY_AUTH_TURN_EVENT, retrySpy);
    }
  });

  it("does not offer Retry without a session to resend into", () => {
    render(<AgentCliAuthCard agentCli={unauthenticatedClaude} laneId="lane-1" />);
    expect(screen.queryByRole("button", { name: /retry turn/i })).toBeNull();
  });

  it("clears the retry spinner when the pane rejects the retry", () => {
    render(<AgentCliAuthCard agentCli={unauthenticatedClaude} laneId="lane-1" chatSessionId="chat-7" />);

    fireEvent.click(screen.getByRole("button", { name: /retry turn/i }));
    expect(screen.getByRole("button", { name: /retrying/i })).toBeTruthy();

    fireEvent(window, new CustomEvent(CHAT_AUTH_RETRY_REJECTED_EVENT, { detail: { sessionId: "chat-7" } }));

    expect(screen.getByRole("button", { name: /retry turn/i })).toBeTruthy();
  });

  it("collapses to a reconnected confirmation when the session recovers", () => {
    render(<AgentCliAuthCard agentCli={unauthenticatedClaude} laneId="lane-1" chatSessionId="chat-7" />);

    expect(screen.getByText("Claude Code is logged out")).toBeTruthy();

    fireEvent(window, new CustomEvent(CHAT_AUTH_RECOVERED_EVENT, { detail: { sessionId: "chat-7" } }));

    expect(screen.queryByText("Claude Code is logged out")).toBeNull();
    expect(screen.getByText(/Reconnected to Claude Code/i)).toBeTruthy();
  });

  it("ignores reconnected events for a different session", () => {
    render(<AgentCliAuthCard agentCli={unauthenticatedClaude} laneId="lane-1" chatSessionId="chat-7" />);

    fireEvent(window, new CustomEvent(CHAT_AUTH_RECOVERED_EVENT, { detail: { sessionId: "other-session" } }));

    expect(screen.getByText("Claude Code is logged out")).toBeTruthy();
    expect(screen.queryByText(/Reconnected to Claude Code/i)).toBeNull();
  });

  it("uses the project default lane when no chat context is available", async () => {
    render(<AgentCliAuthCard agentCli={missingCli} />);

    const runInstall = screen.getByRole("button", { name: /run install/i });
    expect(runInstall).toHaveProperty("disabled", false);

    fireEvent.click(runInstall);

    await waitFor(() => {
      expect(window.ade.lanes.list).toHaveBeenCalledWith({
        includeArchived: false,
        includeStatus: false,
      });
      expect(window.ade.pty.create).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-default",
        startupCommand: "npm install -g @openai/codex",
      }));
    });
  });
});
