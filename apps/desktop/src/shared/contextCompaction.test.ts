import { describe, expect, it } from "vitest";
import {
  buildContextCompactMetadataChips,
  contextCompactMergeKey,
  detectCompactionSignalText,
  formatCompactDuration,
  formatCompactTokenCount,
  mergeNormalizedContextCompact,
  normalizeContextCompactEvent,
  toContextCompactChatEvent,
} from "./contextCompaction";

describe("contextCompaction", () => {
  it("normalizes codex compaction into the shared shape", () => {
    const normalized = normalizeContextCompactEvent({
      type: "codex_context_compaction",
      state: "started",
      trigger: "auto",
      turnId: "turn-1",
      compactionId: "item-1",
    });
    expect(normalized).toMatchObject({
      state: "started",
      trigger: "auto",
      turnId: "turn-1",
      compactionId: "item-1",
    });
  });

  it("builds metadata chips for completed compaction", () => {
    const chips = buildContextCompactMetadataChips({
      trigger: "auto",
      state: "completed",
      preTokens: 142_000,
      postTokens: 38_000,
      durationMs: 12_000,
    });
    expect(chips.map((chip) => chip.label)).toEqual(["AUTO", "142k → 38k", "12s"]);
  });

  it("merges started and completed events in place", () => {
    const started = normalizeContextCompactEvent({
      type: "context_compact",
      trigger: "auto",
      state: "started",
      turnId: "turn-1",
      provider: "claude",
    })!;
    const completed = normalizeContextCompactEvent({
      type: "context_compact",
      trigger: "auto",
      state: "completed",
      turnId: "turn-1",
      preTokens: 120_000,
      postTokens: 40_000,
      durationMs: 4_500,
      provider: "claude",
      sessionCompactionCount: 2,
    })!;
    const merged = mergeNormalizedContextCompact(started, completed);
    expect(toContextCompactChatEvent(merged)).toMatchObject({
      type: "context_compact",
      state: "completed",
      preTokens: 120_000,
      postTokens: 40_000,
      sessionCompactionCount: 2,
    });
  });

  it("formats token counts and durations", () => {
    expect(formatCompactTokenCount(142_000)).toBe("142k");
    expect(formatCompactDuration(12_000)).toBe("12s");
  });

  it("detects compaction signals in free-form status text", () => {
    expect(detectCompactionSignalText("Summarizing conversation history")).toBe(true);
    expect(detectCompactionSignalText("Running tests")).toBe(false);
  });

  it("uses compactionId as the merge key when present", () => {
    expect(contextCompactMergeKey({ compactionId: "item-1", turnId: "turn-2" })).toBe("item-1");
  });
});
