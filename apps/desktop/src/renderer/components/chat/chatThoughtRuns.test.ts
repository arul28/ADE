import { describe, expect, it } from "vitest";
import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";
import {
  collectMergedThoughtRows,
  drawsNothingBetweenThoughts,
  mergeAdjacentThoughtRows,
  thoughtRunKeyByMemberKey,
} from "./chatThoughtRuns";

const at = (second: number) => new Date(Date.UTC(2026, 8, 23, 12, 0, second)).toISOString();

function thought(
  key: string,
  text: string,
  endSecond: number,
  options: { startSecond?: number; turnId?: string; latestStartSecond?: number } = {},
): ChatTranscriptGroupedEnvelope {
  return {
    key,
    timestamp: at(endSecond),
    event: {
      type: "reasoning",
      text,
      turnId: options.turnId ?? "turn-1",
      ...(options.startSecond != null ? { startTimestamp: at(options.startSecond) } : {}),
      ...(options.latestStartSecond != null ? { latestStartTimestamp: at(options.latestStartSecond) } : {}),
    },
  };
}

const text = (key: string, second: number): ChatTranscriptGroupedEnvelope => ({
  key,
  timestamp: at(second),
  event: { type: "text", text: "Interim note.", turnId: "turn-1" },
});

const spawnNotice = (key: string, second: number): ChatTranscriptGroupedEnvelope => ({
  key,
  timestamp: at(second),
  event: {
    type: "system_notice",
    noticeKind: "info",
    message: "Subagent spawned: scout",
    status: "subagent_spawned",
    detail: { hasInlineCard: true },
    turnId: "turn-1",
  },
});

const reasoningEvent = (row: ChatTranscriptGroupedEnvelope) => {
  if (row.event.type !== "reasoning") throw new Error(`expected a reasoning row, got ${row.event.type}`);
  return row.event;
};

describe("mergeAdjacentThoughtRows", () => {
  it("merges adjacent Thought rows into one row keyed by the first, with member keys mapped", () => {
    const rows = [thought("r-a", "Look first.", 3, { startSecond: 1 }), thought("r-b", "Now decide.", 9, { startSecond: 5 })];
    const merged = mergeAdjacentThoughtRows(rows);

    expect(merged.map((row) => row.key)).toEqual(["r-a"]);
    const event = reasoningEvent(merged[0]!);
    expect(event.thoughtMemberKeys).toEqual(["r-a", "r-b"]);
    expect(event.text).toContain("Look first.");
    expect(event.text).toContain("Now decide.");
    // The merged row spans first fragment to last fragment.
    expect(event.startTimestamp).toBe(at(1));
    expect(merged[0]!.timestamp).toBe(at(9));
    expect(thoughtRunKeyByMemberKey(merged)).toEqual(new Map([["r-a", "r-a"], ["r-b", "r-a"]]));
  });

  it("sums member durations only when every member has one", () => {
    const timed = mergeAdjacentThoughtRows([
      thought("r-a", "One.", 3, { startSecond: 1 }),
      thought("r-b", "Two.", 9, { startSecond: 5 }),
    ]);
    expect(reasoningEvent(timed[0]!).thoughtRunDurationSeconds).toBe(6);

    // One chunk has no measured span, so the merged row shows no duration.
    const oneChunk = mergeAdjacentThoughtRows([
      thought("r-a", "One.", 3, { startSecond: 1 }),
      thought("r-b", "Two.", 9),
    ]);
    expect(reasoningEvent(oneChunk[0]!).thoughtRunDurationSeconds).toBeNull();

    // An activity-phase merge's span also covers tool work: no duration either.
    const phaseMerged = mergeAdjacentThoughtRows([
      thought("r-a", "One.", 3, { startSecond: 1 }),
      thought("r-b", "Two.", 9, { startSecond: 4, latestStartSecond: 8 }),
    ]);
    expect(reasoningEvent(phaseMerged[0]!).thoughtRunDurationSeconds).toBeNull();
  });

  it("never merges across a drawn row or across turns", () => {
    const acrossText = [thought("r-a", "A.", 1), text("t-1", 2), thought("r-b", "B.", 3)];
    expect(mergeAdjacentThoughtRows(acrossText)).toBe(acrossText);

    const acrossTurns = [thought("r-a", "A.", 1), thought("r-b", "B.", 3, { turnId: "turn-2" })];
    expect(mergeAdjacentThoughtRows(acrossTurns)).toBe(acrossTurns);
  });

  it("steps over rows that draw nothing and moves them ahead of the merged row", () => {
    const rows = [thought("r-a", "A.", 1), spawnNotice("n-1", 2), thought("r-b", "B.", 3), spawnNotice("n-2", 4)];
    expect(drawsNothingBetweenThoughts(rows[1]!)).toBe(true);

    const merged = mergeAdjacentThoughtRows(rows);
    // The trailing notice was not inside the run and keeps its place.
    expect(merged.map((row) => row.key)).toEqual(["n-1", "r-a", "n-2"]);
  });

  it("keeps the live streaming thought out of an earlier run so its key never changes", () => {
    const rows = [thought("r-a", "Done thinking.", 2), thought("r-live", "Still", 5)];
    expect(mergeAdjacentThoughtRows(rows, "r-live")).toBe(rows);
    // Once it stops being live it joins the run.
    expect(mergeAdjacentThoughtRows(rows, null).map((row) => row.key)).toEqual(["r-a"]);
  });

  it("reuses the previous merged envelope when nothing about the run changed", () => {
    const rows = [thought("r-a", "A.", 1), thought("r-b", "B.", 3), text("t-1", 4)];
    const first = mergeAdjacentThoughtRows(rows);
    const previous = collectMergedThoughtRows(first);

    // Same member envelopes (a delta elsewhere): same merged envelope.
    const again = mergeAdjacentThoughtRows([...rows], null, previous);
    expect(again[0]).toBe(first[0]);

    // Rebuilt but equal members (a regrouping pass): still the same envelope.
    const rebuilt = mergeAdjacentThoughtRows([thought("r-a", "A.", 1), thought("r-b", "B.", 3), text("t-1", 4)], null, previous);
    expect(rebuilt[0]).toBe(first[0]);

    // A member that changed: a new envelope.
    const changed = mergeAdjacentThoughtRows([thought("r-a", "A.", 1), thought("r-b", "B, more.", 3)], null, previous);
    expect(changed[0]).not.toBe(first[0]);
    expect(reasoningEvent(changed[0]!).text).toContain("B, more.");
  });
});
