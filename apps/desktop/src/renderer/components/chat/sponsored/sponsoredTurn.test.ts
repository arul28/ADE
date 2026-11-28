import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../../shared/types";
import { lastFinishedTurn } from "./sponsoredTurn";

const at = "2026-11-28T10:00:00.000Z";
const env = (event: Record<string, unknown>): AgentChatEventEnvelope =>
  ({ sessionId: "chat-1", timestamp: at, event }) as unknown as AgentChatEventEnvelope;

const ask = env({ type: "user_message", text: "Fix the login bug" });
const reply = env({ type: "text", text: "Fixed it.", turnId: "t1" });
const noCards = env({
  type: "error",
  turnId: "t1",
  message: "ADE Free Models are paid for by the sponsored cards in your chats. Open this chat in ADE and let a card show to keep going.",
  errorInfo: { category: "unknown", code: "free_models_no_cards" },
});
const otherError = env({ type: "error", turnId: "t1", message: "Connection reset" });
const done = (status: string) => env({ type: "done", turnId: "t1", status });

describe("lastFinishedTurn", () => {
  // A paused ADE Free Models chat must still ask for a card, or it never runs again.
  it.each([
    ["a finished reply", [ask, reply, done("completed")], false, ["user", "assistant"]],
    ["a no-cards refusal in a free-model chat", [ask, noCards, done("failed")], true, ["user"]],
    ["a no-cards refusal outside a free-model chat", [ask, noCards, done("failed")], false, null],
    ["another failure in a free-model chat", [ask, otherError, done("failed")], true, null],
    ["a new message after the refusal", [ask, noCards, done("failed"), ask], true, null],
  ])("%s", (_name, events, pausedRecovery, roles) => {
    const turn = lastFinishedTurn(events as AgentChatEventEnvelope[], { pausedRecovery: pausedRecovery as boolean });
    expect(turn?.messages.map((message) => message.role) ?? null).toEqual(roles);
    if (turn) expect(turn.turnId).toBe("t1");
  });
});
