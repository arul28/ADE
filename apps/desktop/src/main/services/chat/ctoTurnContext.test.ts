import { describe, expect, it } from "vitest";
import {
  shouldInjectLaneMemoryContext,
  truncateTailToLineBoundary,
} from "./ctoTurnContext";

/**
 * A reconstruction context shaped like the real one: the CTO role prompt at the
 * top, the live state block at the bottom. The budgeted send keeps the TAIL, so
 * the role prompt is exactly what a naive `slice(-n)` would cut in half.
 */
const ROLE_PROMPT_LINE =
  "You are the CTO for the current project inside ADE. Answer identity questions as the project's CTO.";
const RECONSTRUCTION = [
  "CTO Runtime Identity",
  ROLE_PROMPT_LINE,
  "- Own architecture, execution quality, engineering continuity, and technical direction",
  "",
  "Live project state (captured 2026-09-11T00:00:00.000Z)",
  "- lane-7 — dirty, 2 ahead",
  "- #1229 ship the browser lane — checks pending, review approved",
].join("\n");

describe("truncateTailToLineBoundary", () => {
  it("returns the text untouched when it already fits", () => {
    expect(truncateTailToLineBoundary(RECONSTRUCTION, RECONSTRUCTION.length)).toBe(RECONSTRUCTION);
    expect(truncateTailToLineBoundary(RECONSTRUCTION, RECONSTRUCTION.length + 500)).toBe(RECONSTRUCTION);
  });

  it("never cuts the role prompt mid-line", () => {
    // A budget that lands INSIDE the role prompt line: a raw tail slice would
    // hand the model "...the current project inside ADE. Answer identity
    // questions as the project's CTO." with the subject removed, which still
    // reads as a complete instruction.
    const naiveCut = RECONSTRUCTION.length - "CTO Runtime Identity\n".length - 40;
    const naive = RECONSTRUCTION.slice(-naiveCut);
    expect(naive.startsWith(ROLE_PROMPT_LINE)).toBe(false);
    expect(ROLE_PROMPT_LINE).toContain(naive.split("\n")[0]);

    const aligned = truncateTailToLineBoundary(RECONSTRUCTION, naiveCut);
    expect(aligned.length).toBeLessThanOrEqual(naiveCut);
    // The partial role-prompt line was dropped whole, not kept as a fragment.
    expect(aligned).not.toContain(naive.split("\n")[0]);
    for (const line of aligned.split("\n")) {
      expect(RECONSTRUCTION.split("\n")).toContain(line);
    }
  });

  it("keeps every surviving line whole at any budget", () => {
    const sourceLines = RECONSTRUCTION.split("\n");
    for (let budget = 1; budget <= RECONSTRUCTION.length; budget += 1) {
      const result = truncateTailToLineBoundary(RECONSTRUCTION, budget);
      if (!result.length) continue;
      expect(result.length).toBeLessThanOrEqual(budget);
      for (const line of result.split("\n")) {
        expect(sourceLines).toContain(line);
      }
      // Whatever survives is a suffix of the original, so the tail-keeping
      // contract is preserved.
      expect(RECONSTRUCTION.endsWith(result)).toBe(true);
    }
  });

  it("yields nothing rather than a fragment when no whole line fits", () => {
    expect(truncateTailToLineBoundary("one unbroken line of context", 10)).toBe("");
    expect(truncateTailToLineBoundary(RECONSTRUCTION, 0)).toBe("");
    expect(truncateTailToLineBoundary(RECONSTRUCTION, -5)).toBe("");
  });
});

describe("shouldInjectLaneMemoryContext", () => {
  const base = {
    isCto: false,
    isPersonal: false,
    laneDirectiveKey: "lane-7:/work/lane-7",
    lastLaneDirectiveKey: null as string | null,
  };

  it("delivers once per lane change, not once per turn", () => {
    // First turn on the lane: the key has not been stamped yet.
    expect(shouldInjectLaneMemoryContext(base)).toBe(true);

    // The send path stamps the key after delivery; every later turn on the same
    // lane is deduped away.
    const afterDelivery = { ...base, lastLaneDirectiveKey: base.laneDirectiveKey };
    expect(shouldInjectLaneMemoryContext(afterDelivery)).toBe(false);
    expect(shouldInjectLaneMemoryContext(afterDelivery)).toBe(false);

    // Moving the chat to another lane makes it due again.
    expect(shouldInjectLaneMemoryContext({
      ...afterDelivery,
      laneDirectiveKey: "lane-8:/work/lane-8",
    })).toBe(true);

    // So does the same lane relocating to a different worktree, because the key
    // carries both.
    expect(shouldInjectLaneMemoryContext({
      ...afterDelivery,
      laneDirectiveKey: "lane-7:/work/lane-7-moved",
    })).toBe(true);
  });

  it("is for workers, not for the CTO or personal chats", () => {
    // The CTO already receives the whole of durable memory.
    expect(shouldInjectLaneMemoryContext({ ...base, isCto: true })).toBe(false);
    // A personal chat has no project lane to be scoped to.
    expect(shouldInjectLaneMemoryContext({ ...base, isPersonal: true })).toBe(false);
    // No resolvable lane means nothing to scope to either.
    expect(shouldInjectLaneMemoryContext({ ...base, laneDirectiveKey: null })).toBe(false);
  });
});
