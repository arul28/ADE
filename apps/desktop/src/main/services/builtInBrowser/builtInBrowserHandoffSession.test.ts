import { describe, expect, it, vi } from "vitest";
import type { AdeCardPayload } from "../../../shared/adeCard";
import type { BuiltInBrowserHandoffLifecycleEvent } from "./builtInBrowserService";
import { createBuiltInBrowserHandoffSessionListener } from "./builtInBrowserHandoffSession";

/**
 * The hand goes up when the agent asks, and it comes down on EVERY ending —
 * including the ones no `ade browser handoff` process is waiting on. A row left
 * raised against a finished handoff is worse than never raising it: it teaches
 * the user that ADE's hand-raise means nothing.
 */

const HANDOFF = {
  reason: "sign in to staging",
  startedAt: "2026-05-12T00:00:00.000Z",
  expiresAt: "2026-05-12T00:15:00.000Z",
  requestedByChatSessionId: "chat-1",
  requestedByLaneId: "lane-1",
  startedAtOrigin: "https://login.example.test",
  previousOwner: { laneId: "lane-1", chatSessionId: "chat-1" },
};

function harness() {
  const requestAttention = vi.fn(() => true);
  const clearAttentionRequest = vi.fn(() => true);
  const emitAdeCard =
    vi.fn<[{ sessionId: string; card: AdeCardPayload }], Promise<void>>(async () => undefined);
  const listener = createBuiltInBrowserHandoffSessionListener({
    getLogger: () => null,
    resolveServices: () => ({
      sessionService: { requestAttention, clearAttentionRequest },
      agentChatService: { emitAdeCard },
    }),
  });
  return { listener, requestAttention, clearAttentionRequest, emitAdeCard };
}

describe("built-in browser handoff session listener", () => {
  it("raises the requesting chat's hand with the question the Work row shows", () => {
    const { listener, requestAttention } = harness();

    listener({ kind: "started", tabId: "tab-1", handoff: HANDOFF });

    expect(requestAttention).toHaveBeenCalledWith("chat-1", "Sign in for me: sign in to staging");
  });

  it("clears the hand and leaves a transcript line on hand back", async () => {
    const { listener, clearAttentionRequest, emitAdeCard } = harness();

    listener({
      kind: "ended",
      tabId: "tab-1",
      handoff: HANDOFF,
      endedBy: "human",
      durationMs: 42_000,
    } satisfies BuiltInBrowserHandoffLifecycleEvent);

    expect(clearAttentionRequest).toHaveBeenCalledWith("chat-1");
    await vi.waitFor(() => expect(emitAdeCard).toHaveBeenCalled());
    expect(emitAdeCard.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "chat-1",
      card: {
        variant: "browser_login_handoff",
        state: "terminal",
        title: "Handed back to the agent",
        fallbackText: "Handed back to the agent",
        durationMs: 42_000,
      },
    });
  });

  it("says what actually happened when nobody signed in", async () => {
    const { listener, clearAttentionRequest, emitAdeCard } = harness();

    listener({
      kind: "ended",
      tabId: "tab-1",
      handoff: HANDOFF,
      endedBy: "timeout",
      durationMs: 900_000,
    });

    expect(clearAttentionRequest).toHaveBeenCalledWith("chat-1");
    await vi.waitFor(() => expect(emitAdeCard).toHaveBeenCalled());
    expect(emitAdeCard.mock.calls[0]?.[0]?.card.fallbackText).toContain("timed out");
  });

  it("does nothing for a handoff no chat asked for", () => {
    const { listener, requestAttention, clearAttentionRequest } = harness();

    listener({
      kind: "started",
      tabId: "tab-1",
      handoff: { ...HANDOFF, requestedByChatSessionId: null },
    });

    expect(requestAttention).not.toHaveBeenCalled();
    expect(clearAttentionRequest).not.toHaveBeenCalled();
  });
});
