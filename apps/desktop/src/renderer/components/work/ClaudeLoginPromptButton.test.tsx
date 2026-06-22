/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ClaudeLoginPromptButton } from "./ClaudeLoginPromptButton";

const originalAde = globalThis.window.ade;

function installAdeStub() {
  globalThis.window.ade = {
    pty: {
      create: vi.fn().mockResolvedValue({
        sessionId: "terminal-claude-login",
        ptyId: "pty-claude-login",
        pid: 123,
      }),
    },
    lanes: {
      list: vi.fn().mockResolvedValue([{ id: "lane-default", name: "Primary" }]),
    },
  } as any;
}

describe("ClaudeLoginPromptButton", () => {
  beforeEach(() => {
    installAdeStub();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("opens claude auth login in the owning chat terminal", async () => {
    const onRevealTerminal = vi.fn();

    render(
      <ClaudeLoginPromptButton
        visible
        storageKey="chat:chat-1"
        laneId="lane-1"
        chatSessionId="chat-1"
        onRevealTerminal={onRevealTerminal}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Login to Claude" }));

    await waitFor(() => {
      expect(window.ade.pty.create).toHaveBeenCalledWith({
        laneId: "lane-1",
        chatSessionId: "chat-1",
        cols: 100,
        rows: 28,
        title: "Claude login",
        tracked: true,
        toolType: "shell",
        startupCommand: "claude auth login",
      });
    });
    expect(onRevealTerminal).toHaveBeenCalledWith({
      terminalId: "terminal-claude-login",
      ptyId: "pty-claude-login",
      label: "Claude login",
    });
  });

  it("dismisses the prompt per storage key", () => {
    const { rerender } = render(
      <ClaudeLoginPromptButton visible storageKey="cli:term-1" laneId="lane-1" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Claude login prompt" }));
    expect(screen.queryByRole("button", { name: "Login to Claude" })).toBeNull();

    rerender(<ClaudeLoginPromptButton visible storageKey="cli:term-1" laneId="lane-1" />);
    expect(screen.queryByRole("button", { name: "Login to Claude" })).toBeNull();
  });
});
