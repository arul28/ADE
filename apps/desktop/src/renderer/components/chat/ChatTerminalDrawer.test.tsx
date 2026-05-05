/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatTerminalDrawer } from "./ChatTerminalDrawer";

vi.mock("../terminals/TerminalView", () => {
  const ReactMod = require("react") as typeof import("react");
  return {
    TerminalView: (props: { sessionId: string; ptyId: string }) =>
      ReactMod.createElement("div", { "data-testid": "terminal-view" }, `${props.sessionId}:${props.ptyId}`),
  };
});

const originalAde = globalThis.window.ade;

function installAdeMocks() {
  globalThis.window.ade = {
    terminal: {
      list: vi.fn().mockResolvedValue([]),
    },
    pty: {
      create: vi.fn().mockResolvedValue({
        sessionId: "terminal-race-1",
        ptyId: "pty-race-1",
        pid: 1234,
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
      onExit: vi.fn().mockImplementation(() => () => undefined),
    },
    sessions: {
      onChanged: vi.fn().mockImplementation(() => () => undefined),
    },
    appControl: {
      getStatus: vi.fn().mockResolvedValue({ activeSession: null }),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
    },
  } as any;
}

describe("ChatTerminalDrawer", () => {
  beforeEach(() => {
    installAdeMocks();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("deduplicates a created tab when the same terminal was already revealed", async () => {
    render(
      <ChatTerminalDrawer
        open
        onToggle={vi.fn()}
        laneId="lane-1"
        chatSessionId="chat-1"
        autoCreateOnOpen={false}
        revealRequest={{
          terminalId: "terminal-race-1",
          ptyId: "pty-race-1",
          label: "Drawer event run",
          nonce: 1,
        }}
      />,
    );

    expect(await screen.findByText("Drawer event run")).toBeTruthy();

    fireEvent.click(screen.getByTitle("New terminal"));

    await waitFor(() => {
      expect(window.ade.pty.create).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(/^Terminal \d+$/)).toBeNull();
    expect(screen.getByTestId("terminal-view").textContent).toBe("terminal-race-1:pty-race-1");
  });
});
