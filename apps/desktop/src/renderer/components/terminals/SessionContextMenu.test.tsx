// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import { SessionContextMenu } from "./SessionContextMenu";

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-1",
    laneName: "Lane 1",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "codex",
    title: "CLI session",
    status: "completed",
    startedAt: "2026-04-14T12:00:00.000Z",
    endedAt: "2026-04-14T12:05:00.000Z",
    exitCode: 0,
    transcriptPath: "/tmp/session-1.log",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "exited",
    resumeCommand: null,
    ...overrides,
  };
}

describe("SessionContextMenu", () => {
  it("shows delete session for ended CLI sessions", () => {
    const { container } = render(
      <SessionContextMenu
        menu={{ session: makeSession(), x: 10, y: 10 }}
        onClose={vi.fn()}
        onCloseSession={vi.fn()}
        onEndChat={vi.fn()}
        onDeleteChat={vi.fn()}
        onDeleteSession={vi.fn()}
        deletingSessionId={null}
        onResume={vi.fn()}
        onCopyResumeCommand={vi.fn()}
        onGoToLane={vi.fn()}
        onCopySessionId={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Delete session" })).toBeTruthy();
    expect(container.textContent ?? "").not.toContain("Delete chat");
  });

  it("keeps delete chat for ended chat sessions", () => {
    const { container } = render(
      <SessionContextMenu
        menu={{ session: makeSession({ toolType: "codex-chat" }), x: 10, y: 10 }}
        onClose={vi.fn()}
        onCloseSession={vi.fn()}
        onEndChat={vi.fn()}
        onDeleteChat={vi.fn()}
        onDeleteSession={vi.fn()}
        deletingSessionId={null}
        onResume={vi.fn()}
        onCopyResumeCommand={vi.fn()}
        onGoToLane={vi.fn()}
        onCopySessionId={vi.fn()}
        onRename={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Delete chat" })).toBeTruthy();
    expect(container.textContent ?? "").not.toContain("Delete session");
  });
});
