/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import {
  advanceSplitScan,
  beginReveal,
  clampToGraphemeBoundary,
  completeReveal,
  DEFAULT_TEXT_REVEAL_HORIZON_MS,
  isTextRevealEnabled,
  readTextRevealHorizonMs,
  resetTextRevealHorizonCacheForTests,
  retargetReveal,
  revealedText,
  splitRevealed,
  stepReveal,
  TEXT_REVEAL_HORIZON_STORAGE_KEY,
  TEXT_REVEAL_MIN_COMMIT_INTERVAL_MS,
  type RevealState,
} from "./textReveal";

const HORIZON = DEFAULT_TEXT_REVEAL_HORIZON_MS;
const FRAME = 1000 / 60;

/** Drive `n` 60 Hz frames, returning the state after the last one. */
function runFrames(state: RevealState, frames: number, startMs = 1000): RevealState {
  let current = state;
  for (let index = 0; index < frames; index += 1) {
    current = stepReveal(current, startMs + index * FRAME, HORIZON);
  }
  return current;
}

afterEach(() => {
  resetTextRevealHorizonCacheForTests();
});

describe("reveal state machine", () => {
  it("paints a message that arrives complete without pacing it", () => {
    const state = beginReveal("already finished text");
    expect(revealedText(state)).toBe("already finished text");
  });

  it("paces only the growth that arrives after the first sight", () => {
    const first = beginReveal("hello");
    const grown = retargetReveal(first, `hello${"x".repeat(500)}`);
    expect(grown.revealed).toBe(5);
    // The first frame only starts the clock — nothing is committed on zero
    // elapsed time.
    const started = stepReveal(grown, 1000, HORIZON);
    expect(started.revealed).toBe(5);
    const next = stepReveal(started, 1000 + FRAME, HORIZON);
    expect(next.revealed).toBeGreaterThan(5);
  });

  it("drains most of a burst backlog within one horizon", () => {
    const burst = retargetReveal(beginReveal(""), "y".repeat(2000));
    // The horizon is a time constant, not a deadline: the backlog decays
    // geometrically, so one horizon of 60Hz frames clears the bulk of it...
    const oneHorizon = runFrames(burst, 1 + Math.ceil(HORIZON / FRAME));
    expect(oneHorizon.revealed).toBeGreaterThan(1200);
    // ...and a few horizons finish it, thanks to the one-character floor.
    expect(runFrames(burst, 200).revealed).toBe(2000);
  });

  it("never advances by less than one character while a backlog exists", () => {
    // One character of backlog and a huge horizon: the proportional step
    // rounds to zero, and the floor is what keeps the text from freezing.
    const state = retargetReveal(beginReveal("ab"), "abc");
    const started = stepReveal(state, 0, 10_000);
    const next = stepReveal(started, FRAME, 10_000);
    expect(next.revealed).toBe(3);
  });

  it("does not commit more than 60 times a second on a high-refresh display", () => {
    // 240Hz: frames every ~4.17ms. Only every fourth one may commit.
    const state = retargetReveal(beginReveal(""), "z".repeat(1000));
    let current = stepReveal(state, 0, HORIZON);
    let commits = 0;
    for (let index = 1; index <= 4; index += 1) {
      const next = stepReveal(current, index * (1000 / 240), HORIZON);
      if (next.revealed !== current.revealed) commits += 1;
      current = next;
    }
    expect(commits).toBe(1);
    // Just under one 60Hz frame: a true 60Hz display must never skip a commit
    // to floating-point drift, and 120Hz must still be halved.
    expect(TEXT_REVEAL_MIN_COMMIT_INTERVAL_MS).toBeLessThan(1000 / 60);
    expect(TEXT_REVEAL_MIN_COMMIT_INTERVAL_MS).toBeGreaterThan(1000 / 120);
  });

  it("carries unspent frame time forward instead of dropping it", () => {
    const base = retargetReveal(beginReveal(""), "q".repeat(1000));
    const paced = stepReveal(base, 0, HORIZON);
    // Four 240Hz frames -> one commit whose step matches a single 60Hz frame.
    let highRefresh = paced;
    for (let index = 1; index <= 4; index += 1) {
      highRefresh = stepReveal(highRefresh, index * (1000 / 240), HORIZON);
    }
    const sixtyHz = stepReveal(paced, FRAME, HORIZON);
    expect(highRefresh.revealed).toBe(sixtyHz.revealed);
  });

  it("restarts the clock when a delta lands on a caught-up row", () => {
    // The frame loop stops once the backlog empties, so the next delta arrives
    // hundreds of ms after the last frame. Spending that gap would paint the
    // whole delta at once — the lump pacing exists to remove.
    const caughtUp = stepReveal(beginReveal("done."), 1000, HORIZON);
    const delta = retargetReveal(caughtUp, `done.${"n".repeat(900)}`);
    const firstFrameBack = stepReveal(delta, 1700, HORIZON);
    expect(firstFrameBack.revealed).toBe(5);
    const second = stepReveal(firstFrameBack, 1700 + FRAME, HORIZON);
    expect(second.revealed).toBeGreaterThan(5);
    expect(second.revealed).toBeLessThan(300);
  });

  it("reveals everything immediately when the horizon is disabled", () => {
    const state = retargetReveal(beginReveal(""), "instant");
    expect(stepReveal(state, 0, 0).revealed).toBe("instant".length);
    expect(stepReveal(state, 0, -1).revealed).toBe("instant".length);
  });

  it("snaps when the text is replaced rather than grown", () => {
    const state = { ...retargetReveal(beginReveal(""), "abcdefghij"), revealed: 3 };
    const shrunk = retargetReveal(state, "abcd");
    expect(shrunk.revealed).toBe(4);
    const rewritten = retargetReveal(state, "zzzzzzzzzzzz");
    expect(rewritten.revealed).toBe(12);
  });

  it("completes on demand", () => {
    const state = { ...retargetReveal(beginReveal(""), "abcdef"), revealed: 2 };
    expect(revealedText(completeReveal(state))).toBe("abcdef");
  });

  describe("grapheme safety", () => {
    it("never cuts a surrogate pair in half", () => {
      const text = "ab😀cd";
      for (let cut = 0; cut <= text.length; cut += 1) {
        const clamped = clampToGraphemeBoundary(text, 0, cut);
        expect(clamped).not.toBe(3); // mid-surrogate
        expect(text.slice(0, clamped)).not.toMatch(/[\uD800-\uDBFF]$/);
      }
    });

    it("never cuts inside a ZWJ emoji sequence", () => {
      const family = "👨‍👩‍👧‍👦";
      const text = `hi ${family} there`;
      const start = text.indexOf(family);
      for (let cut = start; cut <= start + family.length; cut += 1) {
        const clamped = clampToGraphemeBoundary(text, 0, cut);
        expect(clamped === start || clamped === start + family.length).toBe(true);
      }
    });

    it("never shows half a flag", () => {
      const flag = "🇺🇸";
      const text = `${flag}${flag}`;
      for (let cut = 0; cut <= text.length; cut += 1) {
        const clamped = clampToGraphemeBoundary(text, 0, cut);
        expect(clamped % flag.length).toBe(0);
      }
    });

    it("holds back a trailing cluster that is still arriving", () => {
      // Store text ends on a dangling high surrogate: the low half is in the
      // next delta. Painting it would show a replacement glyph.
      const partial = `done ${"😀".slice(0, 1)}`;
      const state = retargetReveal(beginReveal(""), partial);
      const started = stepReveal(state, 0, HORIZON);
      const next = stepReveal(started, 1000, HORIZON);
      expect(revealedText(next)).toBe("done ");
    });

    it("stops holding back once the cluster completes", () => {
      const state = retargetReveal(beginReveal(""), "done 😀");
      const started = stepReveal(state, 0, HORIZON);
      const next = stepReveal(started, 1000, HORIZON);
      expect(revealedText(next)).toBe("done 😀");
    });
  });
});

describe("horizon configuration", () => {
  it("defaults to 150ms and honors a localStorage override", () => {
    expect(readTextRevealHorizonMs()).toBe(DEFAULT_TEXT_REVEAL_HORIZON_MS);
    localStorage.setItem(TEXT_REVEAL_HORIZON_STORAGE_KEY, "0");
    // Still memoized from the first read — the override needs a fresh session.
    expect(readTextRevealHorizonMs()).toBe(DEFAULT_TEXT_REVEAL_HORIZON_MS);
    resetTextRevealHorizonCacheForTests();
    expect(readTextRevealHorizonMs()).toBe(0);
    expect(isTextRevealEnabled()).toBe(false);
    localStorage.removeItem(TEXT_REVEAL_HORIZON_STORAGE_KEY);
    resetTextRevealHorizonCacheForTests();
    expect(isTextRevealEnabled()).toBe(true);
  });

  it("ignores a malformed override rather than disabling itself", () => {
    localStorage.setItem(TEXT_REVEAL_HORIZON_STORAGE_KEY, "fast please");
    resetTextRevealHorizonCacheForTests();
    expect(readTextRevealHorizonMs()).toBe(DEFAULT_TEXT_REVEAL_HORIZON_MS);
    localStorage.removeItem(TEXT_REVEAL_HORIZON_STORAGE_KEY);
  });
});

describe("settled / growing-tail split", () => {
  function split(text: string, end = text.length) {
    return splitRevealed(text, end, advanceSplitScan(null, text, end));
  }

  it("cuts at the last blank line so only the tail re-parses", () => {
    const text = "First para.\n\nSecond para.\n\nthird and gr";
    const { settled, tail } = split(text);
    expect(settled).toBe("First para.\n\nSecond para.\n\n");
    expect(tail).toBe("third and gr");
  });

  it("keeps the settled string identical while the tail grows", () => {
    const base = "Intro.\n\npartial";
    const grown = `${base} more words`;
    const scanA = advanceSplitScan(null, base, base.length);
    const scanB = advanceSplitScan(scanA, grown, grown.length);
    expect(splitRevealed(grown, grown.length, scanB).settled)
      .toBe(splitRevealed(base, base.length, scanA).settled);
    expect(scanB.settledEnd).toBe(scanA.settledEnd);
  });

  it("never splits inside an unterminated code fence", () => {
    const text = "Prose.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n";
    const { settled, tail } = split(text);
    expect(settled).toBe("Prose.\n\n");
    expect(tail.startsWith("```ts")).toBe(true);
    // The settled half must not contain a fence opener at all, or it would
    // swallow the rest of the message into a code block.
    expect(settled.includes("```")).toBe(false);
  });

  it("resumes splitting after the fence closes", () => {
    const text = "Prose.\n\n```ts\nconst a = 1;\n```\n\nafter";
    const { settled, tail } = split(text);
    expect(settled).toBe("Prose.\n\n```ts\nconst a = 1;\n```\n\n");
    expect(tail).toBe("after");
  });

  it("handles tilde fences and indented fences", () => {
    const text = "A.\n\n  ~~~\nnot a break\n\nstill code\n";
    expect(split(text).settled).toBe("A.\n\n");
  });

  it("puts everything in the tail when no boundary exists yet", () => {
    const { settled, tail } = split("one growing paragraph");
    expect(settled).toBe("");
    expect(tail).toBe("one growing paragraph");
  });

  it("only scans complete lines so a half-arrived fence marker is not trusted", () => {
    const text = "A.\n\nB.\n\n``";
    const { settled, tail } = split(text);
    expect(settled).toBe("A.\n\nB.\n\n");
    expect(tail).toBe("``");
  });

  it("splits the revealed prefix, never the unrevealed store text", () => {
    const text = "A.\n\nB.\n\nC.\n\nD";
    const { settled, tail } = split(text, 6);
    expect(settled).toBe("A.\n\n");
    expect(tail).toBe("B.");
  });

  it("never cuts inside a loose ordered list, so numbering stays 1, 2, 3", () => {
    // A loose list is written as repeated `1.` markers separated by blank
    // lines. Cutting on one of those blank lines makes two documents, and the
    // second restarts its numbering — the user watches "1, 1, 1" until the
    // turn settles. The cut must survive every streaming prefix.
    const text = "1. a\n\n1. b\n\n1. c";
    for (let end = 0; end <= text.length; end += 1) {
      const scan = advanceSplitScan(null, text, end);
      expect(scan.settledEnd).toBe(0);
      expect(splitRevealed(text, end, scan).settled).toBe("");
    }
    // Unordered and paren-delimited markers are the same block.
    for (const list of ["- a\n\n- b\n\nc", "1) a\n\n1) b\n\n1) c"]) {
      expect(advanceSplitScan(null, list, list.length - 1).settledEnd).toBe(0);
    }
  });

  it("does not split an indented code block on its internal blank lines", () => {
    const text = "Intro:\n\n    line one\n\n    line two\n\nDone.\n";
    const afterList = text.indexOf("Done.");
    for (let end = 0; end <= text.length; end += 1) {
      const settledEnd = advanceSplitScan(null, text, end).settledEnd;
      // Only two answers are safe: nothing settled yet, or everything up to the
      // blank line that precedes the first line at column 0.
      expect([0, afterList]).toContain(settledEnd);
    }
    expect(advanceSplitScan(null, text, text.length).settledEnd).toBe(afterList);
  });

  it("still settles a plain paragraph boundary while the next paragraph streams", () => {
    // The guard must not cost the ordinary cut: the moment a non-list,
    // non-indented line starts arriving, the blank before it settles.
    const text = "First.\n\nSecond.\n\nthird para stil";
    expect(split(text).settled).toBe("First.\n\nSecond.\n\n");
    // A `---` rule and `**bold**` open a block; they are not list markers.
    expect(split("A.\n\n---\n\n**bo").settled).toBe("A.\n\n---\n\n");
    expect(split("A.\n\n**bold** start").settled).toBe("A.\n\n");
  });

  it("resolves a pending cut only once the next line is unambiguous", () => {
    // "1" is a paragraph, "1." is a list marker. While only "1" has arrived the
    // cut must wait rather than guess and be wrong half the time.
    const base = "Para.\n\n";
    expect(advanceSplitScan(null, `${base}1`, base.length + 1).settledEnd).toBe(0);
    expect(advanceSplitScan(null, `${base}1.`, base.length + 2).settledEnd).toBe(0);
    expect(advanceSplitScan(null, `${base}1. x`, base.length + 4).settledEnd).toBe(0);
    // A digit that turns out to be prose settles normally.
    expect(advanceSplitScan(null, `${base}1999 was`, base.length + 8).settledEnd)
      .toBe(base.length);
  });

  it("recomputes identically from scratch and incrementally", () => {
    const text = "A.\n\n```\nx\n```\n\nB.\n\ntail";
    let incremental = advanceSplitScan(null, text, 0);
    for (let end = 1; end <= text.length; end += 1) {
      incremental = advanceSplitScan(incremental, text, end);
    }
    const scratch = advanceSplitScan(null, text, text.length);
    expect(incremental.settledEnd).toBe(scratch.settledEnd);
    expect(incremental.fence).toBe(scratch.fence);
  });
});
