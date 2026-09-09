/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatTerminalDrawer } from "./ChatTerminalDrawer";
import { terminalStatusLine } from "../terminals/useWorkToolStatuses";
import {
  getWorkTerminalShellCount,
  resetWorkTerminalShellCounts,
  subscribeWorkTerminalShells,
} from "../terminals/workTerminalShells";

/**
 * The tools pane header, reduced to the one thing this file can prove: it reads
 * the SAME list the drawer renders, through the same subscription, and it is a
 * sibling of the drawer rather than its parent — so anything it re-renders for
 * cannot have remounted the drawer.
 */
function ShellCountProbe({ ownerSessionId }: { ownerSessionId: string }) {
  const count = React.useSyncExternalStore(
    subscribeWorkTerminalShells,
    () => getWorkTerminalShellCount(ownerSessionId),
    () => null,
  );
  return <div data-testid="shell-count">{terminalStatusLine(null, count).line ?? "unmeasured"}</div>;
}

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
    resetWorkTerminalShellCounts();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("shows one affordance, not two, when a panel has no shells", async () => {
    render(
      <ChatTerminalDrawer
        open
        onToggle={vi.fn()}
        laneId="lane-1"
        chatSessionId="chat-1"
        autoCreateOnOpen={false}
      />,
    );

    // The empty tab strip is gone: its "+" and the centred button were the same
    // action rendered twice, 28px apart.
    await waitFor(() => expect(screen.queryByTestId("terminal-new-shell")).toBeNull());
    expect(screen.getByText("Start a shell in this lane")).toBeTruthy();
    expect(screen.getByTestId("terminal-empty-new-shell")).toBeTruthy();
    // One line and one button: no paragraph explaining what a shell is, and no
    // `ade terminal` hint competing with the action for the same 280px.
    expect(screen.queryByText("ade terminal")).toBeNull();
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

    fireEvent.click(screen.getByTestId("terminal-new-shell"));

    await waitFor(() => {
      expect(window.ade.pty.create).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(/^Terminal \d+$/)).toBeNull();
    expect(screen.getByTestId("terminal-view").textContent).toBe("terminal-race-1:pty-race-1");
  });

  it("keeps rapid new-terminal clicks to one in-flight PTY create", async () => {
    type CreateResolver = (value: { sessionId: string; ptyId: string; pid: number }) => void;
    const resolveCreate: { current?: CreateResolver } = {};
    vi.mocked(window.ade.pty.create).mockReturnValueOnce(new Promise((resolve) => {
      resolveCreate.current = resolve;
    }) as any);

    render(
      <ChatTerminalDrawer
        open
        onToggle={vi.fn()}
        laneId="lane-1"
        chatSessionId="chat-1"
        autoCreateOnOpen={false}
      />,
    );

    // No shells yet, so the only "+" on screen is the empty state's button —
    // the strip is not rendered for tabs that do not exist.
    const createButton = screen.getByTestId("terminal-empty-new-shell");
    fireEvent.click(createButton);
    fireEvent.click(createButton);

    expect(window.ade.pty.create).toHaveBeenCalledTimes(1);
    expect(resolveCreate.current).toBeTruthy();
    resolveCreate.current!({ sessionId: "terminal-once", ptyId: "pty-once", pid: 1234 });

    await waitFor(() => {
      expect(screen.getByTestId("terminal-view").textContent).toBe("terminal-once:pty-once");
    });
    expect(screen.getAllByText(/^Terminal \d+$/)).toHaveLength(1);
  });

  it("drives the panel chrome row: + opens a shell, split stacks a second, kill closes one", async () => {
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

    fireEvent.click(screen.getByTestId("terminal-new-shell"));
    await waitFor(() => expect(window.ade.pty.create).toHaveBeenCalledTimes(1));

    // One shell besides the active one already exists, so splitting shows it
    // rather than opening a third.
    fireEvent.click(screen.getByTestId("terminal-split"));
    await waitFor(() => expect(screen.getAllByTestId("terminal-view")).toHaveLength(2));
    expect(window.ade.pty.create).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("terminal-kill"));
    await waitFor(() => expect(screen.getAllByTestId("terminal-view")).toHaveLength(1));
    expect(window.ade.pty.dispose).toHaveBeenCalled();
  });

  it("opens a second shell when splitting with nothing to split against", async () => {
    vi.mocked(window.ade.terminal.list).mockResolvedValueOnce([
      {
        terminalId: "terminal-1",
        ptyId: "pty-1",
        title: "Only terminal",
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

    expect(await screen.findByText("Only terminal")).toBeTruthy();

    fireEvent.click(screen.getByTestId("terminal-split"));

    await waitFor(() => expect(window.ade.pty.create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByTestId("terminal-view")).toHaveLength(2));
    // The new shell lands in the split pane; focus stays where the split was
    // requested from, so the top pane is still the shell you were using.
    expect(screen.getAllByTestId("terminal-view")[0].textContent).toBe("terminal-1:pty-1");
  });

  it("moves the pane's shell count when a split opens a shell, without remounting", async () => {
    vi.mocked(window.ade.terminal.list).mockResolvedValueOnce([
      { terminalId: "terminal-1", ptyId: "pty-1", title: "Only terminal", status: "running" },
    ] as any);

    render(
      <>
        <ShellCountProbe ownerSessionId="chat-1" />
        <ChatTerminalDrawer
          open
          onToggle={vi.fn()}
          laneId="lane-1"
          chatSessionId="chat-1"
          autoCreateOnOpen={false}
        />
      </>,
    );

    expect(await screen.findByText("Only terminal")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("shell-count").textContent).toBe("1 shell"));

    // The exact regression: the header said "1 shell" over a split showing two
    // panes, because it was counting a different list.
    fireEvent.click(screen.getByTestId("terminal-split"));
    await waitFor(() => expect(screen.getAllByTestId("terminal-view")).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("shell-count").textContent).toBe("2 shells"));

    // One `terminal.list` for the whole exercise: the count moved because the
    // panel published it, not because anything remounted and re-read.
    expect(window.ade.terminal.list).toHaveBeenCalledTimes(1);
  });

  it("stops reporting a shell count once the panel is gone", async () => {
    vi.mocked(window.ade.terminal.list).mockResolvedValueOnce([
      { terminalId: "terminal-1", ptyId: "pty-1", title: "Only terminal", status: "running" },
    ] as any);

    const view = render(
      <ChatTerminalDrawer
        open
        onToggle={vi.fn()}
        laneId="lane-1"
        chatSessionId="chat-1"
        autoCreateOnOpen={false}
      />,
    );

    expect(await screen.findByText("Only terminal")).toBeTruthy();
    await waitFor(() => expect(getWorkTerminalShellCount("chat-1")).toBe(1));

    // Switching to another tool unmounts the panel; a count left behind would
    // describe shells nobody is showing.
    view.unmount();
    expect(getWorkTerminalShellCount("chat-1")).toBeNull();
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

  it("uses the panel variant for CLI-owned attached terminals without a horizontal resize handle", async () => {
    const view = render(
      <ChatTerminalDrawer
        open
        onToggle={vi.fn()}
        laneId="lane-1"
        chatSessionId="cli-session-1"
        autoCreateOnOpen={false}
      />,
    );

    await waitFor(() => expect(window.ade.terminal.list).toHaveBeenCalled());
    expect(view.container.querySelector(".cursor-row-resize")).toBeNull();
    expect((view.container.firstElementChild as HTMLElement).style.height).toBe("");

    // With no shells the panel shows one affordance — the empty state's button
    // — rather than that plus an empty tab strip carrying a second "+".
    fireEvent.click(screen.getByTestId("terminal-empty-new-shell"));

    await waitFor(() => expect(window.ade.pty.create).toHaveBeenCalledTimes(1));
    expect(window.ade.pty.create).toHaveBeenCalledWith(expect.objectContaining({
      laneId: "lane-1",
      chatSessionId: "cli-session-1",
      toolType: "shell",
    }), null);
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
    }, null);
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
    }, null);
    expect(screen.queryByText("First terminal")).toBeNull();
  });

  it("fills its pane rather than carrying a draggable height of its own", async () => {
    // There is one mode now. The bottom-drawer arm — a persisted pixel height
    // and a resize gutter — had no caller left and is gone; the panel takes the
    // height its pane gives it, and the pane's own splitter is the resize.
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
    const panel = view.container.firstElementChild as HTMLElement;
    expect(view.container.querySelector(".ade-tool-gutter.horizontal")).toBeNull();
    expect(panel.style.height).toBe("");
    expect(panel.className).toContain("h-full");
  });
});
