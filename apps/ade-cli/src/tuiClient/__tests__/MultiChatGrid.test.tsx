import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MultiChatGrid } from "../components/MultiChatGrid";
import { HitTestProvider, createHitTestRegistry } from "../hitTestRegistry";
import { computeTileRects } from "../multiChatLayout";
import type { LocalNotice } from "../types";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";

function makeSession(sessionId: string, laneId: string, title: string): AgentChatSessionSummary {
  return {
    sessionId,
    laneId,
    provider: "codex",
    model: "gpt-5.5",
    status: "idle",
    startedAt: "2026-01-01T12:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-01-01T12:00:00.000Z",
    lastOutputPreview: null,
    summary: null,
    title,
  } as AgentChatSessionSummary;
}

const notices: LocalNotice[] = [
  { id: "n1", timestamp: "2026-01-01T12:00:01.000Z", tone: "success", text: "Created lane test." },
];

function stripAnsi(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

function userMessage(sessionId: string, text: string) {
  return {
    sessionId,
    timestamp: "2026-01-01T12:00:00.000Z",
    sequence: 1,
    event: { type: "user_message" as const, text, turnId: "turn-1" },
  };
}

async function renderGrid(options: { width: number; height: number; baseX?: number; baseY?: number; registry?: ReturnType<typeof createHitTestRegistry> }) {
  const tiles = [
    { sessionId: "s1", laneId: "lane-1" },
    { sessionId: "s2", laneId: "lane-2" },
  ];
  const result = render(
    <HitTestProvider registry={options.registry}>
      <MultiChatGrid
        tiles={tiles}
        focusedIndex={0}
        width={options.width}
        height={options.height}
        baseX={options.baseX ?? 0}
        baseY={options.baseY ?? 0}
        projectName="ADE"
        provider="codex"
        modelDisplay="gpt-5.5"
        lanesById={{}}
        sessionBySessionId={{
          s1: makeSession("s1", "lane-1", "alpha chat"),
          s2: makeSession("s2", "lane-2", "beta chat"),
        }}
        eventsBySessionId={{
          s1: [userMessage("s1", "hello from alpha")],
          s2: [userMessage("s2", "hello from beta")],
        }}
        notices={notices}
        streamingBySessionId={{}}
        interruptedBySessionId={{}}
        scrollBySessionId={{}}
        selectionBySessionId={{}}
        onFocusTile={() => {}}
        onRemoveTile={() => {}}
      />
    </HitTestProvider>,
  );
  // Let effects flush so useHitTestTarget registrations land in the registry.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return stripAnsi(result.lastFrame() ?? "");
}

describe("MultiChatGrid", () => {
  it("renders global notices only inside the focused tile", async () => {
    const frame = await renderGrid({ width: 120, height: 20 });
    // Both tiles have transcripts, but the session-agnostic notice may only
    // appear once — inside the focused tile.
    expect(frame).toContain("hello from alpha");
    expect(frame).toContain("hello from beta");
    const occurrences = frame.split("Created lane test.").length - 1;
    expect(occurrences).toBe(1);
  });

  it("fills the full height it is given, bottom borders on the last row", async () => {
    const height = 20;
    const frame = await renderGrid({ width: 120, height });
    const lines = frame.split("\n");
    expect(lines.length).toBe(height);
    // Tile bottom borders land on the final row (round/double corners).
    expect(lines[height - 1]).toMatch(/[╰└╚]/);
  });

  it("registers the remove hit-target on each tile's title row", async () => {
    const registry = createHitTestRegistry();
    const baseX = 21;
    const baseY = 3;
    const width = 120;
    const height = 20;
    const frame = await renderGrid({ width, height, baseX, baseY, registry });
    const lines = frame.split("\n");
    const rects = computeTileRects(2, width, height);
    for (const [index, sessionId] of (["s1", "s2"] as const).entries()) {
      const rect = rects[index]!;
      const titleRowY = baseY + rect.y + 1;
      const removeX = baseX + rect.x + Math.max(0, rect.w - 3);
      const target = registry.hitTest(removeX, titleRowY);
      expect(target?.id).toBe(`multi-chat:remove:${sessionId}`);
      // The on-screen row at that y (relative to the grid origin) is the
      // header row: it carries the remove glyph at the tile's right edge.
      const screenRow = lines[titleRowY - baseY]!;
      expect(screenRow).toContain("×");
    }
  });
});
