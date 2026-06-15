import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MultiChatGrid } from "../components/MultiChatGrid";
import { HitTestProvider, createHitTestRegistry } from "../hitTestRegistry";
import { computeTileRects } from "../multiChatLayout";
import type { LocalNotice } from "../types";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { ChatTerminalSession } from "../../../../desktop/src/shared/types/sessions";

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

async function renderGrid(options: { width: number; height: number; baseX?: number; baseY?: number; registry?: ReturnType<typeof createHitTestRegistry>; notices?: LocalNotice[] }) {
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
        notices={options.notices ?? notices}
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

  it("scopes session-tagged notices to their own tile, including unfocused tiles", async () => {
    // Layout: s1 (focused) is the left tile (cols 0-59), s2 (unfocused) the right
    // tile (cols 60-119). A notice tagged to s2 must render in s2's tile even though
    // it is unfocused (the old behaviour only fed notices to the focused tile), and
    // a notice tagged to s1 must not leak into s2's column range.
    const frame = await renderGrid({
      width: 120,
      height: 20,
      notices: [
        { id: "a", timestamp: "2026-01-01T12:00:01.000Z", tone: "success", text: "alpha-only notice", sessionId: "s1" },
        { id: "b", timestamp: "2026-01-01T12:00:02.000Z", tone: "success", text: "beta-only notice", sessionId: "s2" },
      ],
    });
    const columnOf = (needle: string): number => {
      for (const line of frame.split("\n")) {
        const at = line.indexOf(needle);
        if (at >= 0) return at;
      }
      return -1;
    };
    // Each notice appears exactly once, in its own tile's column range.
    expect(frame.split("alpha-only notice").length - 1).toBe(1);
    expect(frame.split("beta-only notice").length - 1).toBe(1);
    expect(columnOf("alpha-only notice")).toBeLessThan(60);
    expect(columnOf("beta-only notice")).toBeGreaterThanOrEqual(60);
  });

  it("fills the full height it is given, bottom borders on the last row", async () => {
    const height = 20;
    const frame = await renderGrid({ width: 120, height });
    const lines = frame.split("\n");
    expect(lines.length).toBe(height);
    // Tile bottom borders land on the final row (round/double corners).
    expect(lines[height - 1]).toMatch(/[╰└╚]/);
  });

  it("renders a Claude terminal tile (live pane + naming hint) instead of a chat transcript", async () => {
    const terminal: ChatTerminalSession = {
      terminalId: "t1",
      ptyId: "pty-1",
      chatSessionId: null,
      laneId: "lane-1",
      laneName: "Lane 1",
      title: "Claude Code",
      toolType: "claude",
      goal: null,
      status: "running",
      runtimeState: "running",
      active: true,
      startedAt: "2026-01-01T12:00:00.000Z",
      endedAt: null,
      exitCode: null,
      pid: null,
      resumeCommand: null,
      resumeMetadata: null,
      lastOutputPreview: null,
      summary: null,
    };
    const result = render(
      <HitTestProvider>
        <MultiChatGrid
          tiles={[{ sessionId: "s1", laneId: "lane-1" }, { sessionId: "t1", laneId: "lane-1" }]}
          focusedIndex={1}
          width={120}
          height={20}
          baseX={0}
          baseY={0}
          projectName="ADE"
          provider="codex"
          modelDisplay="gpt-5.5"
          lanesById={{}}
          sessionBySessionId={{ s1: makeSession("s1", "lane-1", "alpha chat") }}
          eventsBySessionId={{ s1: [userMessage("s1", "hello from alpha")] }}
          notices={[]}
          streamingBySessionId={{}}
          interruptedBySessionId={{}}
          scrollBySessionId={{}}
          selectionBySessionId={{}}
          terminalSessionById={{ t1: terminal }}
          terminalPreviewById={{}}
          terminalLiveChunksById={{ t1: ["claude tile output line"] }}
          terminalScrollBySessionId={{}}
          attachedTerminalId={null}
          onFocusTile={() => {}}
          onRemoveTile={() => {}}
        />
      </HitTestProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const frame = stripAnsi(result.lastFrame() ?? "");
    // The terminal tile shows the session title + the "naming…" loading hint (placeholder title),
    // and the chat tile still renders its transcript — proving the per-tile branch.
    expect(frame).toContain("Claude Code");
    expect(frame).toContain("naming…");
    expect(frame).toContain("hello from alpha");
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
