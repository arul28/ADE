import { describe, expect, it } from "vitest";
import {
  collapseActivityPhaseRows,
  mergeReasoningTextFragments,
  shouldCollapseActivityPhase,
} from "./chatActivityPhase";

type TestRow = {
  id: string;
  kind: "reasoning" | "work" | "text";
  turnId: string | null;
  text?: string;
};

describe("chatActivityPhase", () => {
  it("does not collapse a simple thought + tool pair", () => {
    const rows: TestRow[] = [
      { id: "r1", kind: "reasoning", turnId: "turn-1", text: "First" },
      { id: "w1", kind: "work", turnId: "turn-1" },
    ];
    const collapsed = collapseActivityPhaseRows(
      rows,
      (row) => (row.kind === "text" ? null : { kind: row.kind === "work" ? "work" : "reasoning", turnId: row.turnId }),
      (phase, meta): TestRow[] => {
        expect(meta.workFirst).toBe(false);
        return [
          { id: "merged-reasoning", kind: "reasoning", turnId: "turn-1", text: "merged" },
          { id: "merged-work", kind: "work", turnId: "turn-1" },
        ];
      },
    );
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]!.id).toBe("r1");
    expect(collapsed[1]!.id).toBe("w1");
  });

  it("collapses cursor-style alternating thought and tool bursts", () => {
    const rows: TestRow[] = [
      { id: "r1", kind: "reasoning", turnId: "turn-1", text: "One" },
      { id: "w1", kind: "work", turnId: "turn-1" },
      { id: "r2", kind: "reasoning", turnId: "turn-1", text: "Two" },
      { id: "w2", kind: "work", turnId: "turn-1" },
      { id: "r3", kind: "reasoning", turnId: "turn-1", text: "Three" },
      { id: "w3", kind: "work", turnId: "turn-1" },
    ];
    const collapsed = collapseActivityPhaseRows(
      rows,
      (row) => (row.kind === "text" ? null : { kind: row.kind === "work" ? "work" : "reasoning", turnId: row.turnId }),
      (phase, meta): TestRow[] => {
        expect(phase).toHaveLength(6);
        expect(meta.workFirst).toBe(false);
        return [
          {
            id: "merged-reasoning",
            kind: "reasoning",
            turnId: "turn-1",
            text: mergeReasoningTextFragments(phase.filter((row) => row.kind === "reasoning").map((row) => row.text ?? "")),
          },
          { id: "merged-work", kind: "work", turnId: "turn-1" },
        ];
      },
    );
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]!.text).toBe("One\n\n---\n\nTwo\n\n---\n\nThree");
    expect(collapsed[1]!.kind).toBe("work");
  });

  it("breaks phases on assistant text and turn boundaries", () => {
    const rows: TestRow[] = [
      { id: "r1", kind: "reasoning", turnId: "turn-1", text: "A" },
      { id: "w1", kind: "work", turnId: "turn-1" },
      { id: "t1", kind: "text", turnId: "turn-1", text: "Answer" },
      { id: "r2", kind: "reasoning", turnId: "turn-1", text: "B" },
      { id: "w2", kind: "work", turnId: "turn-1" },
      { id: "r3", kind: "reasoning", turnId: "turn-1", text: "C" },
      { id: "w3", kind: "work", turnId: "turn-1" },
    ];
    const collapsed = collapseActivityPhaseRows(
      rows,
      (row) => (row.kind === "text" ? null : { kind: row.kind === "work" ? "work" : "reasoning", turnId: row.turnId }),
      (): TestRow[] => [{ id: "merged", kind: "reasoning", turnId: "turn-1" }],
    );
    expect(collapsed.map((row) => row.id)).toEqual(["r1", "w1", "t1", "merged"]);
  });

  it("respects the spam threshold helper", () => {
    expect(shouldCollapseActivityPhase({ totalRows: 2, reasoningRows: 1, workRows: 1 })).toBe(false);
    expect(shouldCollapseActivityPhase({ totalRows: 3, reasoningRows: 2, workRows: 1 })).toBe(true);
    expect(shouldCollapseActivityPhase({ totalRows: 2, reasoningRows: 1, workRows: 2 })).toBe(true);
  });
});
