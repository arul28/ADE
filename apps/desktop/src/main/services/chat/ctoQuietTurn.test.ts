import { describe, expect, it } from "vitest";
import type { AgentChatEvent, AgentChatProvider } from "../../../shared/types/chat";
import { stepCtoQuietTurn, type CtoQuietTurnState } from "./ctoQuietTurn";

const said = (text: string, turnId?: string): AgentChatEvent => ({ type: "text", text, ...(turnId ? { turnId } : {}) });
const done = (turnId: string): AgentChatEvent => ({ type: "done", turnId, status: "completed" });
const person = (
  messageId: string,
  extra: Partial<Extract<AgentChatEvent, { type: "user_message" }>> = {},
): AgentChatEvent => ({ type: "user_message", text: "hi", messageId, ...extra });

/** Steps every event; returns the text the chat would show and the end state. */
function run(start: CtoQuietTurnState, events: AgentChatEvent[], provider: AgentChatProvider = "claude") {
  const state = { ...start };
  const shown = events.flatMap((event) => (
    !stepCtoQuietTurn(state, event, provider) && event.type === "text" ? [event.text] : []
  ));
  return { shown, state };
}

const quietIn = (turnId: string | null): CtoQuietTurnState => ({ quiet: { turnId }, reactTarget: null });

describe("stepCtoQuietTurn", () => {
  it.each([
    {
      name: "drops the quiet turn's text, untagged text too, and keeps another turn's",
      start: quietIn("t-1"),
      events: [said("Ok.", "t-1"), said("stray"), said("late", "t-0")],
      shown: ["late"],
      end: { quiet: { turnId: "t-1" }, reactTarget: null },
    },
    {
      name: "ends quiet only at its own turn's done",
      start: quietIn("t-1"),
      events: [done("t-0"), said("still quiet", "t-1"), done("t-1"), said("next turn", "t-2")],
      shown: ["next turn"],
      end: { quiet: null, reactTarget: null },
    },
    {
      name: "a message the turn never reads lifts nothing and takes no reaction",
      start: quietIn("t-1"),
      events: [
        person("m-q", { steerId: "s-1", deliveryState: "queued" }),
        person("m-u", { deliveryState: "unprocessed" }),
        person("m-f", { deliveryState: "failed" }),
        person("m-ade", { metadata: { hostContinuation: { reason: "cto_child_report" } } }),
        said("hidden", "t-1"),
      ],
      shown: [],
      end: { quiet: { turnId: "t-1" }, reactTarget: null },
    },
    {
      name: "the person's delivered message lifts quiet and becomes the reaction target",
      start: quietIn("t-1"),
      events: [person("m-1", { deliveryState: "delivered" }), said("answer", "t-1")],
      shown: ["answer"],
      end: { quiet: null, reactTarget: "message:m-1" },
    },
    {
      name: "a steer that comes back unread stops being the reaction target",
      start: { quiet: null, reactTarget: "steer:s-1" },
      events: [person("m-1", { steerId: "s-1", deliveryState: "unprocessed" })],
      shown: [],
      end: { quiet: null, reactTarget: null },
    },
  ])("$name", ({ start, events, shown, end }) => {
    const result = run(start, events);
    expect(result.shown).toEqual(shown);
    expect(result.state).toEqual(end);
  });

  it.each([
    ["codex", "steer:s-1"],
    ["cursor", null],
    ["opencode", null],
  ] as const)("an accepted steer is read on %s only once its provider takes it", (provider, target) => {
    const { state } = run(
      { quiet: null, reactTarget: null },
      [person("m-1", { steerId: "s-1", deliveryState: "accepted" })],
      provider,
    );
    expect(state.reactTarget).toBe(target);
  });
});
