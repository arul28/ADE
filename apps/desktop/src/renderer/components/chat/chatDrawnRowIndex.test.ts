import { describe, expect, it } from "vitest";
import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";
import { buildDrawnRowKeyIndex, resolveDrawnRowKey } from "./chatDrawnRowIndex";

describe("drawn transcript row index", () => {
  it("resolves a nested row member to its canonical group before fold lookup", () => {
    const aliases = [
      new Map([["subagent-result:agent-1", "subagent-spawn:agent-1"]]),
      new Map([["subagent-spawn:agent-1", "subagent-grid:0"]]),
    ];

    expect(resolveDrawnRowKey("subagent-result:agent-1", aliases)).toBe("subagent-grid:0");
  });

  it("indexes aliases through the row they resolve to", () => {
    const row = { key: "turn-fold:turn-1", event: { type: "turn_fold" } } as unknown as ChatTranscriptGroupedEnvelope;
    const aliases = [
      new Map([["subagent-result:agent-1", "subagent-spawn:agent-1"]]),
      new Map([["subagent-spawn:agent-1", "turn-fold:turn-1"]]),
    ];

    expect(buildDrawnRowKeyIndex([row], aliases).get("subagent-result:agent-1")).toBe(0);
  });
});
