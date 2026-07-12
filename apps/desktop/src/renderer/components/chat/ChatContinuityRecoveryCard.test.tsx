/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentChatNoticeDetail } from "../../../shared/types";
import { expectNoJargon } from "../../../test/jargonGuard";
import { ChatContinuityRecoveryCard } from "./ChatContinuityRecoveryCard";

const originalAde = globalThis.window.ade;
let recoverContinuity: ReturnType<typeof vi.fn>;

const requiredDetail: AgentChatNoticeDetail = {
  kind: "continuity_recovery",
  state: "required",
  reason: "thread_missing",
  originalThreadId: "codex-thread-abc",
};

const reconstructedDetail: AgentChatNoticeDetail = {
  kind: "continuity_recovery",
  state: "reconstructed",
  reason: "thread_missing",
  originalThreadId: "codex-thread-abc",
  reconstructedThreadId: "codex-thread-xyz",
};

const supersededDetail: AgentChatNoticeDetail = {
  kind: "continuity_recovery",
  state: "required",
  reason: "unknown",
  originalThreadId: "codex-thread-abc",
  supersededBySessionId: "session-new",
};

function installAdeStub() {
  recoverContinuity = vi.fn().mockResolvedValue({ ok: true, mode: "retry_original", threadId: "codex-thread-abc" });
  globalThis.window.ade = {
    agentChat: { recoverContinuity },
  } as any;
}

describe("ChatContinuityRecoveryCard", () => {
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

  it("renders the required state with all three recovery actions and a reason line", () => {
    render(<ChatContinuityRecoveryCard detail={requiredDetail} sessionId="chat-1" turnActive={false} />);

    expect(screen.getByText("This chat's original AI thread could not be resumed.")).toBeTruthy();
    expect(screen.getByText("Your chat history and project files are still here.")).toBeTruthy();
    expect(screen.getByText("The AI provider no longer has this chat's session record.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry original thread/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /recover from ade history/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /start a new chat/i })).toBeTruthy();
  });

  it("uses the unknown-reason copy when the failure reason is unknown", () => {
    render(
      <ChatContinuityRecoveryCard
        detail={{ ...requiredDetail, reason: "unknown" }}
        sessionId="chat-1"
        turnActive={false}
      />,
    );
    expect(screen.getByText("Something interrupted this chat's connection to its AI session.")).toBeTruthy();
  });

  it("calls recoverContinuity with retry_original for the retry action", async () => {
    render(<ChatContinuityRecoveryCard detail={requiredDetail} sessionId="chat-1" turnActive={false} />);

    fireEvent.click(screen.getByRole("button", { name: /retry original thread/i }));

    await waitFor(() => {
      expect(recoverContinuity).toHaveBeenCalledWith({ sessionId: "chat-1", mode: "retry_original" });
    });
  });

  it("disables every action while a turn is active", () => {
    render(<ChatContinuityRecoveryCard detail={requiredDetail} sessionId="chat-1" turnActive={true} />);

    expect(screen.getByRole("button", { name: /retry original thread/i })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /recover from ade history/i })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /start a new chat/i })).toHaveProperty("disabled", true);
  });

  it("confirms before recovering from history, then runs recover_from_history on confirm", async () => {
    render(<ChatContinuityRecoveryCard detail={requiredDetail} sessionId="chat-1" turnActive={false} />);

    fireEvent.click(screen.getByRole("button", { name: /recover from ade history/i }));

    // Nothing runs until the user confirms.
    expect(recoverContinuity).not.toHaveBeenCalled();
    expect(screen.getByText(/ADE will start a fresh AI session/i)).toBeTruthy();
    expect(screen.getByText(/stays saved on this Mac/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /confirm recover/i }));

    await waitFor(() => {
      expect(recoverContinuity).toHaveBeenCalledWith({ sessionId: "chat-1", mode: "recover_from_history" });
    });
  });

  it("cancels the recover confirm without calling recoverContinuity", () => {
    render(<ChatContinuityRecoveryCard detail={requiredDetail} sessionId="chat-1" turnActive={false} />);

    fireEvent.click(screen.getByRole("button", { name: /recover from ade history/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(recoverContinuity).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /retry original thread/i })).toBeTruthy();
  });

  it("shows the returned capsule preview after a successful recover_from_history", async () => {
    recoverContinuity.mockResolvedValueOnce({
      ok: true,
      mode: "recover_from_history",
      threadId: "codex-thread-xyz",
      capsulePreview: "# ADE continuity capsule\n\nContinue from this bounded ADE history.",
    });
    render(<ChatContinuityRecoveryCard detail={requiredDetail} sessionId="chat-1" turnActive={false} />);

    fireEvent.click(screen.getByRole("button", { name: /recover from ade history/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm recover/i }));

    await waitFor(() => {
      expect(screen.getByText("Rebuilt from ADE history")).toBeTruthy();
    });
    expect(screen.getByText(/What the new session was told/i)).toBeTruthy();
    expect(screen.getByText(/Continue from this bounded ADE history/i)).toBeTruthy();
  });

  it("re-enables the actions and surfaces plain-language copy when recovery fails", async () => {
    recoverContinuity.mockResolvedValueOnce({ ok: false, mode: "retry_original", reason: "thread_missing" });
    render(<ChatContinuityRecoveryCard detail={requiredDetail} sessionId="chat-1" turnActive={false} />);

    fireEvent.click(screen.getByRole("button", { name: /retry original thread/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/original session is no longer available/i);
    // The failure line stays amber and actionable — the buttons come back.
    expect(screen.getByRole("button", { name: /retry original thread/i })).toHaveProperty("disabled", false);
  });

  it("navigates via ade:work:select-session after starting a new chat", async () => {
    recoverContinuity.mockResolvedValueOnce({ ok: true, mode: "start_new_chat", newSessionId: "session-new" });
    const onSelect = vi.fn();
    window.addEventListener("ade:work:select-session", onSelect);
    try {
      render(<ChatContinuityRecoveryCard detail={requiredDetail} sessionId="chat-1" turnActive={false} />);

      fireEvent.click(screen.getByRole("button", { name: /start a new chat/i }));

      await waitFor(() => {
        expect(onSelect).toHaveBeenCalledTimes(1);
      });
      const event = onSelect.mock.calls[0][0] as CustomEvent<{ sessionId?: string }>;
      expect(event.detail.sessionId).toBe("session-new");
    } finally {
      window.removeEventListener("ade:work:select-session", onSelect);
    }
  });

  it("renders the reconstructed state as a calm pill with thread linkage behind Details and no actions", () => {
    render(<ChatContinuityRecoveryCard detail={reconstructedDetail} sessionId="chat-1" turnActive={false} />);

    expect(screen.getByText("Rebuilt from ADE history")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry original thread/i })).toBeNull();
    expect(screen.getByText("Details")).toBeTruthy();
    // The raw identifiers live inside the Details disclosure.
    expect(screen.getByText(/codex-thread-xyz/)).toBeTruthy();
  });

  it("renders a superseded notice as a Continued-in-a-new-chat pill that navigates", async () => {
    const onSelect = vi.fn();
    window.addEventListener("ade:work:select-session", onSelect);
    try {
      render(<ChatContinuityRecoveryCard detail={supersededDetail} sessionId="chat-1" turnActive={false} />);

      expect(screen.getByText("Continued in a new chat")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /open chat/i }));

      await waitFor(() => {
        expect(onSelect).toHaveBeenCalledTimes(1);
      });
      const event = onSelect.mock.calls[0][0] as CustomEvent<{ sessionId?: string }>;
      expect(event.detail.sessionId).toBe("session-new");
    } finally {
      window.removeEventListener("ade:work:select-session", onSelect);
    }
  });

  it("keeps technical jargon out of the visible required-state copy", () => {
    const { container } = render(
      <ChatContinuityRecoveryCard detail={requiredDetail} sessionId="chat-1" turnActive={false} />,
    );
    const text = container.textContent ?? "";
    expectNoJargon(text);
    expect(text).not.toMatch(/jsonl/i);
    expect(text).not.toMatch(/thread id/i);
    // The raw original thread identifier is not surfaced in the required state.
    expect(text).not.toContain("codex-thread-abc");
  });

  it("does nothing when there is no session to recover into", () => {
    render(<ChatContinuityRecoveryCard detail={requiredDetail} sessionId={null} turnActive={false} />);

    expect(screen.getByRole("button", { name: /retry original thread/i })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: /retry original thread/i }));
    expect(recoverContinuity).not.toHaveBeenCalled();
  });
});
