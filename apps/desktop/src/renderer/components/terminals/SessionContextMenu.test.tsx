/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import { SessionContextMenu } from "./SessionContextMenu";

afterEach(cleanup);

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "chat-1",
    laneId: "lane-1",
    laneName: "Lane 1",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "claude-chat",
    title: "Claude chat",
    status: "running",
    startedAt: "2026-07-10T12:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "idle",
    resumeCommand: null,
    ...overrides,
  };
}

function renderMenu(
  session: TerminalSessionSummary,
  onSetChatTag = vi.fn(),
  onSettle = vi.fn(),
) {
  const onClose = vi.fn();
  render(
    <SessionContextMenu
      menu={{ session, x: 20, y: 20 }}
      onClose={onClose}
      onStopRuntime={vi.fn()}
      onStopAndDelete={vi.fn()}
      onDeleteChat={vi.fn()}
      onDeleteSession={vi.fn()}
      deletingSessionId={null}
      onGoToLane={vi.fn()}
      onCopySessionId={vi.fn()}
      onRename={vi.fn()}
      onSetChatTag={onSetChatTag}
      onSettle={onSettle}
    />,
  );
  return { onClose, onSetChatTag, onSettle };
}

describe("SessionContextMenu Claude tags", () => {
  it("opens an inline input and treats an empty submit as clearing the tag", () => {
    const session = makeSession({ claudeTag: "review-ready" });
    const { onClose, onSetChatTag } = renderMenu(session);

    fireEvent.click(screen.getByRole("button", { name: "Set tag…" }));
    const input = screen.getByRole("textbox", { name: "Set Claude session tag" }) as HTMLInputElement;
    expect(input.value).toBe("review-ready");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSetChatTag).toHaveBeenCalledWith(session, null);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("submits a non-empty tag for the session", () => {
    const session = makeSession();
    const { onClose, onSetChatTag } = renderMenu(session);

    fireEvent.click(screen.getByRole("button", { name: "Set tag…" }));
    const input = screen.getByRole("textbox", { name: "Set Claude session tag" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "review-ready" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSetChatTag).toHaveBeenCalledWith(session, "review-ready");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not offer SDK tags for non-Claude chat sessions", () => {
    renderMenu(makeSession({ toolType: "codex-chat" }));
    expect(screen.queryByRole("button", { name: "Set tag…" })).toBeNull();
  });

  it("does not offer SDK tags for ended Claude sessions", () => {
    // Tag writes need a live Claude SDK runtime; the menu gates on running.
    renderMenu(makeSession({ status: "disposed", endedAt: "2026-07-10T13:00:00.000Z" }));
    expect(screen.queryByRole("button", { name: "Set tag…" })).toBeNull();
  });
});

describe("SessionContextMenu settle safety", () => {
  it("offers Dismiss & settle when a chat is waiting on input", () => {
    const session = makeSession({
      runtimeState: "waiting-input",
      pendingInputItemId: "pending-1",
    });
    const { onSettle } = renderMenu(session);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss & settle" }));
    expect(onSettle).toHaveBeenCalledWith(session);
  });

  it("allows stale provider input without a live response handle to be dismissed", () => {
    const session = makeSession({
      toolType: "codex-chat",
      runtimeState: "waiting-input",
      pendingInputItemId: null,
    });
    const { onSettle } = renderMenu(session);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss & settle" }));
    expect(onSettle).toHaveBeenCalledWith(session);
  });

  it("allows an explicit agent ask to settle because settling clears the marker", () => {
    renderMenu(makeSession({
      runtimeState: "waiting-input",
      pendingInputItemId: null,
      attentionRequestedAt: "2026-07-23T12:00:00.000Z",
      attentionMessage: "Review this result?",
    }));

    expect(screen.getByRole("button", { name: "Dismiss & settle" })).toBeTruthy();
  });

  it("requires resolving a native CLI prompt that ADE cannot dismiss truthfully", () => {
    const onSettle = vi.fn();
    renderMenu(makeSession({
      toolType: "codex",
      runtimeState: "waiting-input",
      pendingInputItemId: null,
      attentionRequestedAt: null,
    }), vi.fn(), onSettle);

    const button = screen.getByRole("button", { name: "Resolve input to settle" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(onSettle).not.toHaveBeenCalled();
  });
});
