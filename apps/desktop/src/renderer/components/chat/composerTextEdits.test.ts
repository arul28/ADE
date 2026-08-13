import { describe, expect, it } from "vitest";

import { insertAtComposerCaret } from "./composerTextEdits";

/**
 * The splice two long-running paths depend on: dictation, and a plugin
 * `composer-action` whose handler records or transcribes for minutes before it
 * answers. Both hand this the draft and caret as they read at RESPONSE time,
 * which is why the cases below are mostly about a draft that moved.
 */

describe("inserting at the composer caret", () => {
  // The caret lands after the whole inserted piece, separator included, so the
  // user carries on typing in the gap rather than in front of it.
  it("splices at the caret and reports where the caret lands", () => {
    expect(insertAtComposerCaret("hello world", "brave", 6))
      .toEqual({ text: "hello brave world", caret: 12 });
  });

  it("appends when there is no live caret", () => {
    expect(insertAtComposerCaret("hello", "there", null))
      .toEqual({ text: "hello there", caret: 11 });
  });

  it("keeps words apart without doubling existing whitespace", () => {
    expect(insertAtComposerCaret("", "solo", null)).toEqual({ text: "solo", caret: 4 });
    expect(insertAtComposerCaret("a ", "b", 2)).toEqual({ text: "a b", caret: 3 });
    expect(insertAtComposerCaret(" tail", "b", 0)).toEqual({ text: "b tail", caret: 1 });
    expect(insertAtComposerCaret("a\n", "b", 2)).toEqual({ text: "a\nb", caret: 3 });
  });

  // Whitespace in, nothing out: moving the caret for an empty transcript would
  // be a visible no-op the user cannot explain.
  it("refuses an insertion that is only whitespace", () => {
    expect(insertAtComposerCaret("draft", "   ", 2)).toBeNull();
    expect(insertAtComposerCaret("draft", "", 2)).toBeNull();
    expect(insertAtComposerCaret("draft", "\n\t", 2)).toBeNull();
  });

  it("trims the insertion but never the draft around it", () => {
    expect(insertAtComposerCaret("  keep  ", "  x  ", 8))
      .toEqual({ text: "  keep  x", caret: 9 });
  });

  /**
   * The case the whole extraction exists for.
   *
   * A dictation or plugin action started against one draft and answered against
   * another. Splicing at the caret captured at click time would drop everything
   * typed since; the caller reads both live, and the result must reflect the
   * draft as it is NOW.
   */
  it("inserts against the draft as it reads now, not the one the action started with", () => {
    const atClickTime = "fix the";
    const atResponseTime = "fix the login bug in checkout";

    // Same insertion, same intent — the answer differs entirely, which is why
    // the caller must not hold the old values.
    expect(insertAtComposerCaret(atClickTime, "urgent", 7))
      .toEqual({ text: "fix the urgent", caret: 14 });
    expect(insertAtComposerCaret(atResponseTime, "urgent", 13))
      .toEqual({ text: "fix the login urgent bug in checkout", caret: 20 });
  });

  // A caret captured before a long action routinely points past a draft the
  // user has since shortened. Appending never loses text; throwing or slicing
  // out of range would.
  it("clamps a caret that no longer fits the draft", () => {
    expect(insertAtComposerCaret("short", "x", 999))
      .toEqual({ text: "short x", caret: 7 });
    expect(insertAtComposerCaret("short", "x", -4))
      .toEqual({ text: "x short", caret: 2 });
  });
});
