import { describe, expect, it } from "vitest";
import {
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
