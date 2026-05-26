/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import { WorkCliSessionHeader } from "./WorkCliSessionHeader";

vi.mock("../chat/ChatGitToolbar", () => ({
  ChatGitToolbar: ({ laneId }: { laneId: string }) => <div data-testid="chat-git-toolbar" data-lane-id={laneId} />,
}));

vi.mock("./ToolLogos", () => ({
  ToolLogo: () => <span data-testid="tool-logo" />,
}));

vi.mock("../ui/SmartTooltip", async () => {
  const React = await import("react");
  return { SmartTooltip: ({ children }: { children: unknown }) => React.createElement(React.Fragment, null, children as never) };
});

vi.mock("../../lib/terminalAttention", () => ({
  sessionStatusDot: vi.fn(() => ({ cls: "ade-status-dot", label: "Running", spinning: false })),
  sessionStatusBucket: vi.fn(() => "running"),
  sessionNeedsUserInput: vi.fn(() => false),
}));

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-1",
    laneName: "Lane 1",
    ptyId: "pty-1",
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "claude",
    title: "Claude Code: sidebar parity",
    status: "running",
    startedAt: "2026-05-13T00:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "/tmp/transcript",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    ...overrides,
  };
}

describe("WorkCliSessionHeader", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps Work drawer tools out of the CLI header", () => {
    render(<WorkCliSessionHeader session={makeSession()} />);

    expect(screen.getByText("Claude Code: sidebar parity")).toBeTruthy();
    expect(screen.queryByText("Insert into Claude Code")).toBeNull();
    expect(screen.queryByLabelText("Open iOS Simulator in Work sidebar")).toBeNull();
    expect(screen.queryByLabelText("Open App Control in Work sidebar")).toBeNull();
    expect(screen.queryByLabelText("Open Browser in Work sidebar")).toBeNull();
    expect(screen.queryByLabelText("Open macOS VM in Work sidebar")).toBeNull();
  });

  it("labels detached sessions as ended without stop affordances", () => {
    render(
      <WorkCliSessionHeader
        session={makeSession({
          ptyId: null,
          status: "detached",
          runtimeState: "exited",
          endedAt: "2026-05-13T00:10:00.000Z",
        })}
        onStopRunningSession={vi.fn()}
      />,
    );

    expect(screen.getByText("Ended")).toBeTruthy();
    expect(screen.queryByLabelText("Stop Claude Code")).toBeNull();
  });

  it("wires info, stop, and action affordances to existing session handlers", () => {
    const onInfoClick = vi.fn();
    const onContextMenu = vi.fn();
    const onStopRunningSession = vi.fn();
    const session = makeSession();
    render(
      <WorkCliSessionHeader
        session={session}
        onInfoClick={onInfoClick}
        onContextMenu={onContextMenu}
        onStopRunningSession={onStopRunningSession}
      />,
    );

    fireEvent.click(screen.getByLabelText("Session info"));
    fireEvent.click(screen.getByLabelText("Stop Claude Code"));
    fireEvent.click(screen.getByLabelText("Session actions"));

    expect(onInfoClick).toHaveBeenCalledWith(session, expect.any(Object));
    expect(onStopRunningSession).toHaveBeenCalledWith(session);
    expect(onContextMenu).toHaveBeenCalledWith(session, expect.any(Object));
  });
});
