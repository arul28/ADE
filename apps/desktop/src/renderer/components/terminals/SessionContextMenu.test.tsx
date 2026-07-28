/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
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
  binding?: OpenProjectBinding | null,
) {
  const onClose = vi.fn();
  render(
    <SessionContextMenu
      menu={{ session, binding, x: 20, y: 20 }}
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

    expect(onSetChatTag).toHaveBeenCalledWith(session, null, null);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("submits a non-empty tag for the session", () => {
    const session = makeSession();
    const { onClose, onSetChatTag } = renderMenu(session);

    fireEvent.click(screen.getByRole("button", { name: "Set tag…" }));
    const input = screen.getByRole("textbox", { name: "Set Claude session tag" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "review-ready" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSetChatTag).toHaveBeenCalledWith(session, "review-ready", null);
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
    expect(onSettle).toHaveBeenCalledWith(session, null);
  });

  it("allows stale provider input without a live response handle to be dismissed", () => {
    const session = makeSession({
      toolType: "codex-chat",
      runtimeState: "waiting-input",
      pendingInputItemId: null,
    });
    const { onSettle } = renderMenu(session);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss & settle" }));
    expect(onSettle).toHaveBeenCalledWith(session, null);
  });

  it("passes the owning machine binding directly to deferred lifecycle actions", () => {
    const session = makeSession({
      runtimeState: "waiting-input",
      pendingInputItemId: "pending-1",
    });
    const binding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:studio:ade",
      targetId: "studio",
      projectId: "ade",
      rootPath: "/Users/studio/ADE",
      displayName: "ADE",
      runtimeName: "Studio",
      hostname: "studio.local",
    };
    const onSettle = vi.fn();
    renderMenu(session, vi.fn(), onSettle, binding);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss & settle" }));

    expect(onSettle).toHaveBeenCalledWith(session, binding);
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

describe("SessionContextMenu snooze and derived-settle lifecycle", () => {
  let sessionsApi: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    sessionsApi = {
      setSettleOverride: vi.fn().mockResolvedValue(true),
      snoozeSession: vi.fn().mockResolvedValue(true),
      wakeSession: vi.fn().mockResolvedValue(true),
      unsettle: vi.fn().mockResolvedValue(undefined),
    };
    (window as unknown as { ade: unknown }).ade = { sessions: sessionsApi };
  });

  afterEach(() => {
    delete (window as unknown as { ade?: unknown }).ade;
    vi.clearAllMocks();
  });

  /** exit-0 PTY with no `settledAt`: canonically settled, but nothing declared it. */
  function derivedSettledSession(): TerminalSessionSummary {
    return makeSession({
      toolType: "shell",
      status: "completed",
      runtimeState: "exited",
      endedAt: "2026-07-10T12:30:00.000Z",
      exitCode: 0,
      settledAt: null,
    });
  }

  it("gives a DERIVED settled row an Unsettle action backed by the keep-active override", async () => {
    // Regression: this row previously fell out of every branch of the settle
    // chain and rendered no lifecycle action at all.
    renderMenu(derivedSettledSession());

    fireEvent.click(screen.getByRole("button", { name: "Unsettle" }));

    await waitFor(() => {
      expect(sessionsApi.setSettleOverride).toHaveBeenCalledWith("chat-1", "active");
    });
    // There is no `settledAt` column to clear, so the declared path stays unused.
    expect(sessionsApi.unsettle).not.toHaveBeenCalled();
    // "Keep active" would be the identical call here, so it is not duplicated.
    expect(screen.queryByRole("button", { name: "Keep active" })).toBeNull();
  });

  it("keeps the declared-settle path for settledAt rows and adds a keep-active pin", async () => {
    const session = makeSession({
      toolType: "shell",
      status: "completed",
      runtimeState: "exited",
      endedAt: "2026-07-10T12:30:00.000Z",
      exitCode: 0,
      settledAt: "2026-07-10T12:31:00.000Z",
    });
    renderMenu(session);

    fireEvent.click(screen.getByRole("button", { name: "Unsettle" }));
    await waitFor(() => expect(sessionsApi.unsettle).toHaveBeenCalledWith("chat-1"));
    expect(sessionsApi.setSettleOverride).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep active" }));
    await waitFor(() => {
      expect(sessionsApi.setSettleOverride).toHaveBeenCalledWith("chat-1", "active");
    });
  });

  it("expands Snooze into concrete durations and sends an ISO deadline", async () => {
    renderMenu(makeSession());

    fireEvent.click(screen.getByRole("button", { name: "Snooze…" }));
    fireEvent.click(screen.getByRole("button", { name: "1 hour" }));

    await waitFor(() => expect(sessionsApi.snoozeSession).toHaveBeenCalledTimes(1));
    const [sessionId, untilIso] = sessionsApi.snoozeSession.mock.calls[0]!;
    expect(sessionId).toBe("chat-1");
    expect(Date.parse(untilIso as string)).toBeGreaterThan(Date.now());
  });

  it("replaces Snooze with Wake now while the row is snoozed", async () => {
    renderMenu(makeSession({
      snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      snoozedAt: new Date(Date.now() - 60_000).toISOString(),
    }));

    expect(screen.queryByRole("button", { name: "Snooze…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Wake now/ }));

    await waitFor(() => {
      expect(sessionsApi.wakeSession).toHaveBeenCalledWith("chat-1", "manual");
    });
  });
});
