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
import { ChatRuntimeScopeProvider } from "./ChatRuntimeScope";
import type { OpenProjectBinding } from "../../../shared/types";

const originalAde = globalThis.window.ade;

const missingCli: AgentCliAuthCardInfo = {
  agent: "codex",
  displayName: "Codex",
  category: "missing",
  authCommand: "codex login",
};

function installAdeStub(state: "missing" | "ready" = "missing") {
  globalThis.window.ade = {
    ai: {
      pinnedToolStatus: vi.fn().mockResolvedValue({
        provider: "codex",
        label: "Codex",
        state,
        fetchAllowed: true,
        downloading: false,
        version: "1.0.0",
      }),
      pinnedToolDownload: vi.fn().mockResolvedValue(undefined),
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

  it("downloads the pinned provider copy from the chat card", async () => {
    render(<AgentCliAuthCard agentCli={missingCli} chatSessionId="chat-1" />);

    fireEvent.click(await screen.findByRole("button", { name: /download/i }));

    await waitFor(() => {
      expect(window.ade.ai.pinnedToolDownload).toHaveBeenCalledWith({ provider: "codex" }, null);
    });
    expect(screen.queryByRole("button", { name: /retry turn/i })).toBeNull();
  });

  it("reads and downloads on the chat's own machine, not the pane's", async () => {
    const studio: OpenProjectBinding = {
      kind: "remote",
      key: "remote:studio:project-1",
      targetId: "studio",
      runtimeName: "Mac Studio",
      projectId: "project-1",
      rootPath: "/Users/me/Projects/app",
      displayName: "app",
    };

    render(
      <ChatRuntimeScopeProvider pin={studio} binding={studio} laneId="studio-lane" sessionId="chat-remote">
        <AgentCliAuthCard agentCli={missingCli} chatSessionId="chat-remote" runtimeName="Mac Studio" />
      </ChatRuntimeScopeProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /download/i }));

    await waitFor(() => {
      expect(window.ade.ai.pinnedToolDownload).toHaveBeenCalledTimes(1);
    });
    const ai = window.ade.ai!;
    expect(vi.mocked(ai.pinnedToolDownload!).mock.calls[0]).toEqual([{ provider: "codex" }, studio]);
    expect(vi.mocked(ai.pinnedToolStatus!).mock.calls.every((call) => (call as unknown[]).includes(studio))).toBe(true);
  });

  it("names the machine where the provider copy will be downloaded", () => {
    render(<AgentCliAuthCard agentCli={missingCli} runtimeName="Mac Studio" />);

    expect(screen.getByText(/downloads it for Mac Studio/i)).toBeTruthy();
  });

  it("names This computer absolutely when no runtime name is supplied", () => {
    render(<AgentCliAuthCard agentCli={missingCli} />);

    expect(screen.getByText(/downloads it for This computer/)).toBeTruthy();
    expect(screen.queryByText(/this machine/i)).toBeNull();
  });

  it("offers Retry once the copy has landed, and it resends the chat's turn", async () => {
    installAdeStub("ready");
    const retrySpy = vi.fn();
    window.addEventListener(CHAT_RETRY_AUTH_TURN_EVENT, retrySpy);
    try {
      render(<AgentCliAuthCard agentCli={missingCli} chatSessionId="chat-7" />);

      fireEvent.click(await screen.findByRole("button", { name: /retry turn/i }));

      expect(retrySpy).toHaveBeenCalledTimes(1);
      const event = retrySpy.mock.calls[0][0] as CustomEvent<{ sessionId?: string }>;
      expect(event.detail.sessionId).toBe("chat-7");
      expect(screen.getByRole("button", { name: /retrying/i })).toBeTruthy();
    } finally {
      window.removeEventListener(CHAT_RETRY_AUTH_TURN_EVENT, retrySpy);
    }
  });

  it("does not offer Retry without a session to resend into", async () => {
    installAdeStub("ready");
    render(<AgentCliAuthCard agentCli={missingCli} />);
    await waitFor(() => expect(window.ade.ai.pinnedToolStatus).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /retry turn/i })).toBeNull();
  });

  it("clears the retry spinner when the pane rejects the retry", async () => {
    installAdeStub("ready");
    render(<AgentCliAuthCard agentCli={missingCli} chatSessionId="chat-7" />);

    fireEvent.click(await screen.findByRole("button", { name: /retry turn/i }));
    expect(screen.getByRole("button", { name: /retrying/i })).toBeTruthy();

    fireEvent(window, new CustomEvent(CHAT_AUTH_RETRY_REJECTED_EVENT, { detail: { sessionId: "chat-7" } }));

    expect(screen.getByRole("button", { name: /retry turn/i })).toBeTruthy();
  });

  it.each([
    ["its own session", "chat-7", true],
    ["a different session", "other-session", false],
  ])("collapses on a recovered event for %s only", async (_label, sessionId, collapses) => {
    installAdeStub("ready");
    render(<AgentCliAuthCard agentCli={missingCli} chatSessionId="chat-7" />);
    await screen.findByRole("button", { name: /retry turn/i });

    fireEvent(window, new CustomEvent(CHAT_AUTH_RECOVERED_EVENT, { detail: { sessionId } }));

    expect(screen.queryByRole("button", { name: /retry turn/i }) === null).toBe(collapses);
    expect(screen.queryByText(/Codex is ready/) !== null).toBe(collapses);
  });
});
