/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatTerminalDrawer, ChatTerminalToggle } from "./ChatTerminalDrawer";

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
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
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

  it("toggles the terminal drawer open and closed", () => {
    const onToggle = vi.fn();
    const view = render(<ChatTerminalToggle open={false} onToggle={onToggle} />);

    fireEvent.click(screen.getByTitle("Open terminal"));
    expect(onToggle).toHaveBeenCalledTimes(1);

    view.rerender(<ChatTerminalToggle open onToggle={onToggle} />);
    fireEvent.click(screen.getByTitle("Close terminal"));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("does not restore terminal tabs while the drawer is closed", async () => {
    render(
      <ChatTerminalDrawer
        open={false}
        onToggle={vi.fn()}
        laneId="lane-1"
        chatSessionId="chat-1"
        autoCreateOnOpen={false}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.ade.terminal.list).not.toHaveBeenCalled();
    expect(window.ade.appControl.getStatus).not.toHaveBeenCalled();
  });

  it("switches restored terminal tabs", async () => {
    vi.mocked(window.ade.terminal.list).mockResolvedValueOnce([
      {
        terminalId: "terminal-1",
        ptyId: "pty-1",
        title: "First terminal",
        status: "running",
      },
      {
        terminalId: "terminal-2",
        ptyId: "pty-2",
        title: "Second terminal",
        status: "running",
      },
    ] as any);

    render(
      <ChatTerminalDrawer
        open
        onToggle={vi.fn()}
        laneId="lane-1"
        chatSessionId="chat-1"
        autoCreateOnOpen={false}
      />,
    );

    expect(await screen.findByText("First terminal")).toBeTruthy();
    expect(await screen.findByText("Second terminal")).toBeTruthy();
    expect(screen.getByTestId("terminal-view").textContent).toBe("terminal-1:pty-1");

    fireEvent.click(screen.getByRole("button", { name: "Second terminal" }));

    expect(screen.getByTestId("terminal-view").textContent).toBe("terminal-2:pty-2");
  });

  it("closes a restored terminal tab from a stable close target", async () => {
    vi.mocked(window.ade.terminal.list).mockResolvedValueOnce([
      {
        terminalId: "terminal-1",
        ptyId: "pty-1",
        title: "First terminal",
        status: "running",
      },
      {
        terminalId: "terminal-2",
        ptyId: "pty-2",
        title: "Second terminal",
        status: "running",
      },
    ] as any);

    render(
      <ChatTerminalDrawer
        open
        onToggle={vi.fn()}
        laneId="lane-1"
        chatSessionId="chat-1"
        autoCreateOnOpen={false}
      />,
    );

    expect(await screen.findByText("First terminal")).toBeTruthy();
    expect(await screen.findByText("Second terminal")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close First terminal" }));

    expect(window.ade.pty.dispose).toHaveBeenCalledWith({
      ptyId: "pty-1",
      sessionId: "terminal-1",
    });
    expect(screen.queryByText("First terminal")).toBeNull();
    expect(screen.getByText("Second terminal")).toBeTruthy();
  });

  it("closes a restored terminal tab from the keyboard close target", async () => {
    vi.mocked(window.ade.terminal.list).mockResolvedValueOnce([
      {
        terminalId: "terminal-1",
        ptyId: "pty-1",
        title: "First terminal",
        status: "running",
      },
    ] as any);

    render(
      <ChatTerminalDrawer
        open
        onToggle={vi.fn()}
        laneId="lane-1"
        chatSessionId="chat-1"
        autoCreateOnOpen={false}
      />,
    );

    expect(await screen.findByText("First terminal")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("button", { name: "Close First terminal" }), {
      key: " ",
    });

    expect(window.ade.pty.dispose).toHaveBeenCalledWith({
      ptyId: "pty-1",
      sessionId: "terminal-1",
    });
    expect(screen.queryByText("First terminal")).toBeNull();
  });

  it("resizes the drawer by dragging the resize handle", async () => {
    const view = render(
      <ChatTerminalDrawer
        open
        onToggle={vi.fn()}
        laneId="lane-1"
        chatSessionId="chat-1"
        autoCreateOnOpen={false}
      />,
    );

    await waitFor(() => expect(window.ade.terminal.list).toHaveBeenCalled());
    const drawer = view.container.firstElementChild as HTMLElement;
    const handle = view.container.querySelector(".cursor-row-resize");
    expect(handle).toBeTruthy();
    expect(drawer.style.height).toBe("300px");

    fireEvent.mouseDown(handle!, { clientY: 300 });
    fireEvent.mouseMove(document, { clientY: 200 });
    fireEvent.mouseUp(document);

    expect(drawer.style.height).toBe("400px");
  });
});
