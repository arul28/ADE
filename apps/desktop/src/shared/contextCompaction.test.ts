import { describe, expect, it } from "vitest";
import {
  buildContextCompactMetadataChips,
  compactionFailLabel,
  contextCompactMergeKey,
  detectCompactionSignalText,
  formatCompactDuration,
  formatCompactTokenCount,
  mergeNormalizedContextCompact,
  normalizeContextCompactEvent,
  providerSupportsManualCompact,
  resolveContextCompactControl,
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

  it("labels failed compaction from failReason", () => {
    const timedOut = normalizeContextCompactEvent({
      type: "codex_context_compaction",
      state: "failed",
      trigger: "auto",
      turnId: "turn-1",
      failReason: "timed_out",
    })!;
    expect(compactionFailLabel(timedOut.failReason)).toBe("Compaction timed out");
    expect(compactionFailLabel("interrupted")).toBe("Compaction failed");
  });

  it("uses compactionId as the merge key when present", () => {
    expect(contextCompactMergeKey({ compactionId: "item-1", turnId: "turn-2" })).toBe("item-1");
  });

  it("limits manual compact to Claude, Codex, and Pi", () => {
    expect(providerSupportsManualCompact("claude")).toBe(true);
    expect(providerSupportsManualCompact("codex")).toBe(true);
    expect(providerSupportsManualCompact("pi")).toBe(true);
    expect(providerSupportsManualCompact("opencode")).toBe(false);
    expect(providerSupportsManualCompact("cursor")).toBe(false);
    expect(providerSupportsManualCompact("droid")).toBe(false);
    expect(providerSupportsManualCompact(null)).toBe(false);
  });

  it("hides compact when the composer is locked or the provider cannot compact", () => {
    expect(resolveContextCompactControl({
      provider: "claude",
      state: "measured",
      enabled: true,
      inputLocked: true,
    })).toEqual({ status: "hidden" });
    expect(resolveContextCompactControl({
      provider: "cursor",
      state: "measured",
      enabled: true,
    })).toEqual({ status: "hidden" });
  });

  it("disables compact during a turn or pending input, and is ready when idle", () => {
    expect(resolveContextCompactControl({
      provider: "codex",
      state: "measured",
      enabled: true,
      pendingInput: true,
    })).toEqual({
      status: "disabled",
      reason: "Answer or decline the pending request before compacting.",
    });
    expect(resolveContextCompactControl({
      provider: "pi",
      state: "measured",
      enabled: true,
      turnActive: true,
    })).toEqual({
      status: "disabled",
      reason: "Wait for this turn to finish before compacting.",
    });
    expect(resolveContextCompactControl({
      provider: "claude",
      state: "measured",
      enabled: true,
    })).toEqual({ status: "ready" });
  });
});
