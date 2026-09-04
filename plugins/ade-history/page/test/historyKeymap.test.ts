/**
 * The keyboard map: G H, Escape, Mod+[.
 *
 * Each of the three is a compiled behaviour the guest lost, so each is asserted
 * on its own, along with the two ways a chord map goes wrong in a real product:
 * firing mid-sentence, and staying armed across an unrelated keystroke.
 */

import { describe, expect, it } from "vitest";

import {
  HISTORY_CHORD_WINDOW_MS,
  resolveHistoryKey,
  type HistoryKeyState,
  type HistoryKeyStroke,
} from "../src/history/historyKeymap";

function stroke(overrides: Partial<HistoryKeyStroke> & Pick<HistoryKeyStroke, "key">): HistoryKeyStroke {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isTyping: false,
    ...overrides,
  };
}

const IDLE: HistoryKeyState = { chordArmedAt: null };

describe("the History keyboard map", () => {
  it("answers G then H with History's home", () => {
    const armed = resolveHistoryKey(stroke({ key: "g" }), IDLE, 1_000);
    expect(armed.action).toBeNull();
    expect(armed.state.chordArmedAt).toBe(1_000);

    const fired = resolveHistoryKey(stroke({ key: "h" }), armed.state, 1_200);
    expect(fired.action).toBe("history-home");
    expect(fired.handled).toBe(true);
    expect(fired.state.chordArmedAt).toBeNull();
  });

  it("lets the chord expire rather than firing later", () => {
    const armed = resolveHistoryKey(stroke({ key: "g" }), IDLE, 1_000);
    const late = resolveHistoryKey(
      stroke({ key: "h" }),
      armed.state,
      1_000 + HISTORY_CHORD_WINDOW_MS + 1,
    );
    expect(late.action).toBeNull();
    expect(late.state.chordArmedAt).toBeNull();
  });

  it("disarms the chord on an unrelated key, so H alone does nothing", () => {
    const armed = resolveHistoryKey(stroke({ key: "g" }), IDLE, 1_000);
    const other = resolveHistoryKey(stroke({ key: "x" }), armed.state, 1_010);
    expect(other.state.chordArmedAt).toBeNull();

    const alone = resolveHistoryKey(stroke({ key: "h" }), other.state, 1_020);
    expect(alone.action).toBeNull();
  });

  it("never fires while the reader is typing, and does not arm from a field", () => {
    const typed = resolveHistoryKey(stroke({ key: "g", isTyping: true }), IDLE, 1_000);
    expect(typed.state.chordArmedAt).toBeNull();
    expect(typed.handled).toBe(false);

    const next = resolveHistoryKey(stroke({ key: "h", isTyping: true }), typed.state, 1_010);
    expect(next.action).toBeNull();

    // Escape in a field belongs to the field, not to the detail pane.
    expect(resolveHistoryKey(stroke({ key: "Escape", isTyping: true }), IDLE, 1_000).action)
      .toBeNull();
  });

  it("closes the detail on Escape", () => {
    const result = resolveHistoryKey(stroke({ key: "Escape" }), IDLE, 1_000);
    expect(result.action).toBe("close-detail");
    expect(result.handled).toBe(true);
  });

  it("closes the detail on Mod+[ under either spelling of Mod", () => {
    expect(resolveHistoryKey(stroke({ key: "[", metaKey: true }), IDLE, 1_000).action)
      .toBe("close-detail");
    expect(resolveHistoryKey(stroke({ key: "[", ctrlKey: true }), IDLE, 1_000).action)
      .toBe("close-detail");
    // A bare bracket is the Lanes tab's previous-tab key, not History's Back.
    expect(resolveHistoryKey(stroke({ key: "[" }), IDLE, 1_000).action).toBeNull();
  });

  it("leaves a modified G or H to whoever else wants it", () => {
    expect(resolveHistoryKey(stroke({ key: "g", metaKey: true }), IDLE, 1_000).state.chordArmedAt)
      .toBeNull();
    const armed = resolveHistoryKey(stroke({ key: "g" }), IDLE, 1_000);
    expect(resolveHistoryKey(stroke({ key: "h", ctrlKey: true }), armed.state, 1_050).action)
      .toBeNull();
  });
});
