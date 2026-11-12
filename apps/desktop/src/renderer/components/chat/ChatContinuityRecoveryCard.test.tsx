/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentChatNoticeDetail, OpenProjectBinding } from "../../../shared/types";
import { expectNoJargon } from "../../../test/jargonGuard";
import { ChatContinuityRecoveryCard as CardUnderTest } from "./ChatContinuityRecoveryCard";
import { ChatRuntimeScopeProvider } from "./ChatRuntimeScope";

/** The chat's machine: recovery runs there. */
const CHAT_PIN: OpenProjectBinding = { kind: "local", key: "local:/repo", rootPath: "/repo", displayName: "repo" };

/** The card inside its chat's scope, as the chat pane renders it. */
function ChatContinuityRecoveryCard(props: React.ComponentProps<typeof CardUnderTest>) {
  return (
    <ChatRuntimeScopeProvider pin={CHAT_PIN} binding={CHAT_PIN} laneId={null} sessionId={props.sessionId ?? null}>
      <CardUnderTest {...props} />
    </ChatRuntimeScopeProvider>
  );
}

const originalAde = globalThis.window.ade;
let recoverContinuity: ReturnType<typeof vi.fn>;

const lostThread: AgentChatNoticeDetail = {
  kind: "continuity_recovery",
  state: "required",
  reason: "thread_missing",
  originalThreadId: "codex-thread-abc",
};

function installAdeStub() {
  recoverContinuity = vi.fn().mockResolvedValue({ ok: true, mode: "recover_from_history", threadId: "codex-thread-xyz" });
  globalThis.window.ade = {
    agentChat: { recoverContinuity },
  } as any;
}

function onSelectSession(): { calls: () => string[]; stop: () => void } {
  const listener = vi.fn();
  window.addEventListener("ade:work:select-session", listener);
  return {
    calls: () => listener.mock.calls.map((call) => (call[0] as CustomEvent<{ sessionId?: string }>).detail.sessionId ?? ""),
    stop: () => window.removeEventListener("ade:work:select-session", listener),
  };
}

const tryAgain = () => screen.queryByRole("button", { name: /try again/i });
const startNewChat = () => screen.queryByRole("button", { name: /start a new chat/i });

describe("ChatContinuityRecoveryCard", () => {
  beforeEach(() => {
    installAdeStub();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  // While ADE is still reconnecting by itself there is nothing to choose. An
  // attempt that never reported back (ADE restarted, the attempt hung) must
  // not spin forever: past its window the choices come back.
  it.each([
    { name: "a fresh automatic attempt", detail: { autoRecovery: "pending" as const, autoRecoveryStartedAt: new Date().toISOString() }, offersChoices: false },
    { name: "an attempt that never reported back", detail: { autoRecovery: "pending" as const, autoRecoveryStartedAt: new Date(Date.now() - 10 * 60_000).toISOString() }, offersChoices: true },
    { name: "a failed automatic attempt", detail: { autoRecovery: "failed" as const }, offersChoices: true },
    { name: "a lost thread with no automatic attempt", detail: {}, offersChoices: true },
  ])("offers the choices only when ADE is not reconnecting by itself: $name", ({ detail, offersChoices }) => {
    render(<ChatContinuityRecoveryCard detail={{ ...lostThread, ...detail }} sessionId="chat-1" turnActive={false} />);

    expect(Boolean(tryAgain())).toBe(offersChoices);
    expect(Boolean(startNewChat())).toBe(offersChoices);
    if (!offersChoices) expect(screen.getByTestId("continuity-reconnecting")).toBeTruthy();
  });

  it("offers the choices once a pending attempt runs out of time while on screen", () => {
    vi.useFakeTimers();
    render(<ChatContinuityRecoveryCard
      detail={{ ...lostThread, autoRecovery: "pending", autoRecoveryStartedAt: new Date().toISOString() }}
      sessionId="chat-1"
      turnActive={false}
    />);
    expect(tryAgain()).toBeNull();

    React.act(() => { vi.advanceTimersByTime(91_000); });

    expect(tryAgain()).toBeTruthy();
    expect(startNewChat()).toBeTruthy();
    expect(screen.queryByTestId("continuity-reconnecting")).toBeNull();
  });

  // A thread the provider no longer has cannot come back, so "Try again"
  // rebuilds it from ADE's copy; any other failure may have been a blip.
  it.each([
    { reason: "thread_missing" as const, mode: "recover_from_history" },
    { reason: "unknown" as const, mode: "retry_original" },
  ])("Try again after $reason runs $mode and the card settles", async ({ reason, mode }) => {
    recoverContinuity.mockResolvedValueOnce({ ok: true, mode, threadId: "codex-thread-xyz" });
    render(<ChatContinuityRecoveryCard detail={{ ...lostThread, reason }} sessionId="chat-1" turnActive={false} />);

    fireEvent.click(tryAgain()!);

    await waitFor(() => expect(screen.getByTestId("continuity-reconnected")).toBeTruthy());
    expect(recoverContinuity).toHaveBeenCalledWith({ sessionId: "chat-1", mode }, CHAT_PIN);
    expect(tryAgain()).toBeNull();
  });

  it.each([
    { name: "a turn is running", sessionId: "chat-1", turnActive: true },
    { name: "there is no session to recover into", sessionId: null, turnActive: false },
  ])("does nothing while $name", ({ sessionId, turnActive }) => {
    render(<ChatContinuityRecoveryCard detail={lostThread} sessionId={sessionId} turnActive={turnActive} />);

    expect(tryAgain()).toHaveProperty("disabled", true);
    expect(startNewChat()).toHaveProperty("disabled", true);
    fireEvent.click(tryAgain()!);
    expect(recoverContinuity).not.toHaveBeenCalled();
  });

  it("keeps the choices after a failed attempt and never shows the raw failure", async () => {
    recoverContinuity.mockRejectedValueOnce(
      new Error("Error invoking remote method 'recoverContinuity': socket closed"),
    );
    const { container } = render(<ChatContinuityRecoveryCard detail={lostThread} sessionId="chat-1" turnActive={false} />);

    fireEvent.click(tryAgain()!);

    await waitFor(() => expect(tryAgain()).toHaveProperty("disabled", false));
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/remote method|socket/i);
    expect(text).not.toContain("codex-thread-abc");
    expectNoJargon(text);
  });

  it("opens the new chat, both right after starting it and from a superseded notice", async () => {
    recoverContinuity.mockResolvedValueOnce({ ok: true, mode: "start_new_chat", newSessionId: "session-new" });
    const selected = onSelectSession();
    try {
      render(<ChatContinuityRecoveryCard detail={lostThread} sessionId="chat-1" turnActive={false} />);
      fireEvent.click(startNewChat()!);
      await waitFor(() => expect(selected.calls()).toEqual(["session-new"]));
      expect(recoverContinuity).toHaveBeenCalledWith({ sessionId: "chat-1", mode: "start_new_chat" }, CHAT_PIN);
      cleanup();

      render(<ChatContinuityRecoveryCard
        detail={{ ...lostThread, supersededBySessionId: "session-later" }}
        sessionId="chat-1"
        turnActive={false}
      />);
      expect(tryAgain()).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /open/i }));
      await waitFor(() => expect(selected.calls()).toEqual(["session-new", "session-later"]));
    } finally {
      selected.stop();
    }
  });
});
