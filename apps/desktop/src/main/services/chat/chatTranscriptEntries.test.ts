import { describe, expect, it } from "vitest";
import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types/chat";
import { transcriptEntriesFromEnvelopes } from "./chatTranscriptEntries";

const SESSION = "session-1";

let sequence = 0;
function envelope(event: AgentChatEvent): AgentChatEventEnvelope {
  sequence += 1;
  return {
    sessionId: SESSION,
    timestamp: new Date(Date.parse("2026-07-26T10:00:00.000Z") + sequence * 1000).toISOString(),
    sequence,
    event,
  };
}

function textsOf(envelopes: AgentChatEventEnvelope[]): string[] {
  return transcriptEntriesFromEnvelopes(SESSION, envelopes).map((entry) => entry.text);
}

describe("transcriptEntriesFromEnvelopes", () => {
  it("concatenates same-message deltas verbatim across an interleaved activity hint", () => {
    // Regression: an `activity` envelope between two deltas of one Claude
    // message used to splice "\n\n" into the middle of a word, so the canonical
    // transcript read "no new mod\n\nifier chain needed:".
    const entries = textsOf([
      envelope({
        type: "text",
        text: "Better approach — the surface height is already derivable from two existing measurements, no new mod",
        messageId: "msg_011CdQ6h",
        turnId: "turn-1",
      }),
      envelope({ type: "activity", activity: "thinking", turnId: "turn-1" }),
      envelope({ type: "text", text: "ifier chain needed:", messageId: "msg_011CdQ6h", turnId: "turn-1" }),
    ]);

    expect(entries).toEqual([
      "Better approach — the surface height is already derivable from two existing measurements, no new modifier chain needed:",
    ]);
  });

  it("concatenates same-message deltas verbatim even across rendered content", () => {
    // A provider message id proves both fragments belong to one message, so no
    // interleaving event may invent a boundary inside it.
    const entries = textsOf([
      envelope({ type: "text", text: "Running the impl", messageId: "msg-a", turnId: "turn-1" }),
      envelope({ type: "command", command: "npm test", cwd: "/tmp", output: "ok", itemId: "cmd-1", status: "completed", turnId: "turn-1" }),
      envelope({ type: "text", text: "ementers now.", messageId: "msg-a", turnId: "turn-1" }),
    ]);

    expect(entries).toEqual(["Running the implementers now."]);
  });

  it("keeps ephemeral chrome from splitting a turn-keyed assistant run", () => {
    const entries = textsOf([
      envelope({ type: "text", text: "Checking the pairing", turnId: "turn-1" }),
      envelope({ type: "activity", activity: "thinking", turnId: "turn-1" }),
      envelope({ type: "text", text: " connect info now.", turnId: "turn-1" }),
    ]);

    expect(entries).toEqual(["Checking the pairing connect info now."]);
  });

  it("separates turn-keyed runs split by a rendered subagent or todo row", () => {
    // These render as their own transcript rows, so a run resuming after one is
    // a different assistant message and must not run on from the previous one.
    for (const between of [
      { type: "todo_update", items: [] },
      { type: "subagent_result", taskId: "task-1", summary: "done" },
    ] as const) {
      const entries = textsOf([
        envelope({ type: "text", text: "Applied the change.", turnId: "turn-1" }),
        envelope(between as AgentChatEvent),
        envelope({ type: "text", text: "Now running the tests.", turnId: "turn-1" }),
      ]);

      expect(entries).toEqual(["Applied the change.\n\nNow running the tests."]);
    }
  });

  it("keeps id pairs distinct when a plain separator would collide them", () => {
    // The pair key joins the two ids with a NUL precisely so no id content can
    // forge a collision. With a space, ("a b","c") and ("a","b c") key the same
    // and two unrelated messages concatenate.
    const entries = textsOf([
      envelope({ type: "text", text: "Alpha.", messageId: "a b", itemId: "c", turnId: "turn-1" }),
      envelope({ type: "text", text: "Beta.", messageId: "a", itemId: "b c", turnId: "turn-1" }),
    ]);

    expect(entries).toEqual(["Alpha.", "Beta."]);
  });

  it("breaks the paragraph when the runtime advances its finer id", () => {
    // Codex sets messageId to a per-turn UUID and itemId to the provider message
    // id, so an itemId change is a real message boundary. The entry stays keyed
    // on messageId — the identity clients key bubbles on — and takes a paragraph
    // break rather than running the two messages together.
    const entries = textsOf([
      envelope({ type: "text", text: "First message.", messageId: "turn-uuid", itemId: "msg_aaa", turnId: "turn-1" }),
      envelope({ type: "text", text: "Second message.", messageId: "turn-uuid", itemId: "msg_bbb", turnId: "turn-1" }),
    ]);

    expect(entries).toEqual(["First message.\n\nSecond message."]);
  });

  it("still separates turn-keyed runs that a rendered tool call splits", () => {
    // Without message identity, two runs around a tool call are genuinely two
    // assistant messages, so the paragraph break is correct.
    const entries = textsOf([
      envelope({ type: "text", text: "The fake bottom row is now a 1-point sentinel.", turnId: "turn-1" }),
      envelope({ type: "tool_call", tool: "Read", args: {}, itemId: "tool-1", turnId: "turn-1" }),
      envelope({ type: "text", text: "Next I am threading status through the end marker.", turnId: "turn-1" }),
    ]);

    expect(entries).toEqual([
      "The fake bottom row is now a 1-point sentinel.\n\nNext I am threading status through the end marker.",
    ]);
  });

  it("interleaves two concurrent messages without cross-contaminating their text", () => {
    const entries = textsOf([
      envelope({ type: "text", text: "Main agent part one", messageId: "msg-a", turnId: "turn-1" }),
      envelope({ type: "text", text: "Other message", messageId: "msg-b", turnId: "turn-1" }),
      envelope({ type: "text", text: " and part two.", messageId: "msg-a", turnId: "turn-1" }),
    ]);

    expect(entries).toEqual(["Main agent part one and part two.", "Other message"]);
  });

  it("never glues an assistant stream across a user message", () => {
    // A user turn ends every assistant stream. If a key recurred, keeping the
    // draft open would concatenate verbatim and file the text before the user.
    const entries = transcriptEntriesFromEnvelopes(SESSION, [
      envelope({ type: "text", text: "wor", messageId: "msg-a", turnId: "turn-1" }),
      envelope({ type: "user_message", text: "stop", turnId: "turn-2" }),
      envelope({ type: "text", text: "ld", messageId: "msg-a", turnId: "turn-2" }),
    ]);

    expect(entries.map((entry) => [entry.role, entry.text])).toEqual([
      ["assistant", "wor"],
      ["user", "stop"],
      ["assistant", "ld"],
    ]);
  });

  it("preserves message and item identity on entries", () => {
    const entries = transcriptEntriesFromEnvelopes(SESSION, [
      envelope({ type: "text", text: "Stable identified message.", messageId: "message-1", itemId: "item-1", turnId: "turn-ids" }),
    ]);

    expect(entries[0]).toMatchObject({
      role: "assistant",
      text: "Stable identified message.",
      messageId: "message-1",
      itemId: "item-1",
      turnId: "turn-ids",
    });
  });

  it("ignores envelopes belonging to another session", () => {
    const foreign: AgentChatEventEnvelope = {
      ...envelope({ type: "text", text: "not ours", messageId: "msg-x" }),
      sessionId: "other-session",
    };
    expect(textsOf([foreign])).toEqual([]);
  });

  it("treats unknown future event types as non-breaking chrome", () => {
    // Fail-safe direction: a new event type must never be able to splice a
    // separator into a word. Losing a paragraph break is the safe failure.
    const unknown = { type: "some_future_event" } as unknown as AgentChatEvent;
    const entries = textsOf([
      envelope({ type: "text", text: "Half a wo", turnId: "turn-1" }),
      envelope(unknown),
      envelope({ type: "text", text: "rd.", turnId: "turn-1" }),
    ]);

    expect(entries).toEqual(["Half a word."]);
  });

  it("keeps a whitespace-only delta that separates two words", () => {
    // Regression: blank fragments were dropped outright, so "chain" + " " +
    // "needed" rebuilt as "chainneeded".
    const entries = textsOf([
      envelope({ type: "text", text: "no new modifier chain", messageId: "msg-a", turnId: "turn-1" }),
      envelope({ type: "text", text: " ", messageId: "msg-a", turnId: "turn-1" }),
      envelope({ type: "text", text: "needed.", messageId: "msg-a", turnId: "turn-1" }),
    ]);

    expect(entries).toEqual(["no new modifier chain needed."]);
  });

  it("keeps a markdown hard break delivered as its own fragment", () => {
    const entries = textsOf([
      envelope({ type: "text", text: "- Severity: Medium", messageId: "msg-a", turnId: "turn-1" }),
      envelope({ type: "text", text: "  \n", messageId: "msg-a", turnId: "turn-1" }),
      envelope({ type: "text", text: "  File: `chat.ts`", messageId: "msg-a", turnId: "turn-1" }),
    ]);

    expect(entries).toEqual(["- Severity: Medium  \n  File: `chat.ts`"]);
  });

  it("drops leading whitespace that has no run to continue", () => {
    const entries = textsOf([
      envelope({ type: "text", text: "   ", messageId: "msg-a", turnId: "turn-1" }),
      envelope({ type: "text", text: "Answer.", messageId: "msg-a", turnId: "turn-1" }),
    ]);

    expect(entries).toEqual(["Answer."]);
  });

  it("rebuilds a delta-split message byte-exactly whatever chrome interleaves", () => {
    // The invariant clients depend on: canonical text === the verbatim
    // concatenation of the message's fragments. Anything else desynchronises a
    // client that holds both the live fragments and this text.
    const source = "Better approach — the surface height is derivable from two existing "
      + "measurements, no new modifier chain needed. I will thread it through instead.";
    const chrome: AgentChatEvent[] = [
      { type: "activity", activity: "thinking", turnId: "turn-1" },
      { type: "subagent_progress", taskId: "task-1", summary: "working" },
      { type: "todo_update", items: [] },
      { type: "context_usage", usage: { categories: [], totalTokens: 10, maxTokens: 100, percentage: 10 }, origin: "live" },
    ];

    // Deterministic pseudo-random splits so a failure always reproduces.
    let seed = 12345;
    const nextInt = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };

    for (let trial = 0; trial < 200; trial += 1) {
      const stream: AgentChatEventEnvelope[] = [];
      let cursor = 0;
      while (cursor < source.length) {
        const width = 1 + nextInt(12);
        stream.push(envelope({
          type: "text",
          text: source.slice(cursor, cursor + width),
          messageId: "msg-stable",
          turnId: "turn-1",
        }));
        cursor += width;
        if (nextInt(2) === 0) stream.push(envelope(chrome[nextInt(chrome.length)]!));
      }

      const entries = transcriptEntriesFromEnvelopes(SESSION, stream);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.text).toBe(source);
    }
  });
});
