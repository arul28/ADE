import { describe, expect, it } from "vitest";
import {
  addCtoReactionFeedback,
  parseCtoReactionFeedback,
  settleCtoReactionFeedback,
  stageCtoReactionFeedback,
  type CtoReactionFeedbackQueue,
} from "./ctoReactionFeedback";

describe("the CTO's untold reactions", () => {
  it("a send clears only what it told, and the saved list survives a restart", () => {
    const queue: CtoReactionFeedbackQueue = { pending: [], staged: null };
    addCtoReactionFeedback(queue.pending, { targetKey: "message:m-1", emoji: "👍", quote: "Intro" });

    // The context is built, then the person reacts again while it is sent:
    // a new message, and a newer emoji on the message already told.
    const section = stageCtoReactionFeedback(queue);
    expect(section).toContain('👍 (got it) on: "Intro"');
    addCtoReactionFeedback(queue.pending, { targetKey: "message:m-2", emoji: "👎", quote: "Plan" });
    addCtoReactionFeedback(queue.pending, { targetKey: "message:m-1", emoji: "❤️", quote: "Intro" });

    // A send that did not deliver the section keeps everything.
    settleCtoReactionFeedback(queue, false);
    expect(queue.pending.map((item) => `${item.targetKey} ${item.emoji}`)).toEqual([
      "message:m-2 👎",
      "message:m-1 ❤️",
    ]);
    expect(queue.staged).toBeNull();

    // A delivered send clears what it told, never what came in after.
    stageCtoReactionFeedback(queue);
    addCtoReactionFeedback(queue.pending, { targetKey: "message:m-3", emoji: "🎉", quote: "Done" });
    settleCtoReactionFeedback(queue, true);
    expect(queue.pending).toEqual([{ targetKey: "message:m-3", emoji: "🎉", quote: "Done" }]);

    // The chat state saves `pending` as JSON; a restart reads it back.
    const saved = JSON.parse(JSON.stringify([
      ...queue.pending,
      { targetKey: "message:m-4", emoji: "❤", quote: "Thanks" },
      { targetKey: "message:m-5", emoji: "🦄", quote: "x" },
      { targetKey: "", emoji: "👍", quote: "x" },
      "junk",
    ])) as unknown[];
    expect(parseCtoReactionFeedback(saved)).toEqual([
      { targetKey: "message:m-3", emoji: "🎉", quote: "Done" },
      { targetKey: "message:m-4", emoji: "❤️", quote: "Thanks" },
    ]);
  });
});
