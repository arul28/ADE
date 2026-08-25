import { describe, expect, it } from "vitest";
import {
  mapCursorAgentUsage,
  mapCursorAgentUsageToTokenEntry,
  mapCursorAgentUsageToTokensEvent,
  selectCursorAgentTurnUsage,
} from "./cursorUsageMapping";

describe("cursor usage mapping", () => {
  it("maps getUsage cents to Settings billed dollars and omits cost from the chat tokens event", () => {
    const snapshot = mapCursorAgentUsage({
      totalInputTokens: 100,
      totalOutputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 2,
      cost: { rawCostCents: 12.5, chargedCents: 8 },
    }, { agentId: "bc-1", runId: "run-1" });

    expect(snapshot.cost).toEqual({ rawCostCents: 12.5, chargedCents: 8 });

    const entry = mapCursorAgentUsageToTokenEntry(snapshot, { timestamp: 1_700_000_000_000 });
    expect(entry).toEqual(expect.objectContaining({
      messageId: "cursor:getUsage:run-1",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 10,
      cacheWriteTokens: 2,
      costOverrideUsd: 0.08,
    }));

    const tokens = mapCursorAgentUsageToTokensEvent(snapshot, { turnId: "turn-1", runtime: "cloud" });
    expect(tokens).toEqual(expect.objectContaining({
      type: "tokens",
      turnId: "turn-1",
      inputTokens: 100,
      outputTokens: 50,
    }));
    expect(tokens).not.toHaveProperty("costUsd");
    expect(JSON.stringify(tokens)).not.toContain("costUsd");
  });

  it("selects the matching per-run entry instead of agent totals", () => {
    const snapshot = selectCursorAgentTurnUsage({
      usage: { inputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1998 },
      cost: { rawCostCents: 99, chargedCents: 80 },
      runs: [
        {
          runId: "run-old",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
          cost: { rawCostCents: 1, chargedCents: 1 },
        },
        {
          runId: "run-1",
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 2, totalTokens: 162 },
          cost: { rawCostCents: 12.5, chargedCents: 8 },
        },
      ],
    }, { agentId: "bc-1", runId: "run-1" });
    expect(snapshot).toEqual(expect.objectContaining({
      agentId: "bc-1",
      runId: "run-1",
      inputTokens: 100,
      outputTokens: 50,
      cost: { rawCostCents: 12.5, chargedCents: 8 },
    }));
  });
});
