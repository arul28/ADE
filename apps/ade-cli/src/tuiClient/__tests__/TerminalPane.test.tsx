import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { TerminalPane, styledRowsFromSnapshotRows } from "../components/TerminalPane";
import type { ChatTerminalPreviewResult, TerminalSnapshotRow } from "../../../../desktop/src/shared/types";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

/** Poll until `check()` is truthy (xterm write callbacks are async). */
async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function row(text: string): TerminalSnapshotRow {
  return {
    text,
    wrapped: false,
    cells: text.split("").map((char) => ({
      text: char,
      fg: null,
      bg: null,
      fgMode: "default",
      bgMode: "default",
    })),
  };
}

function preview(
  rows: TerminalSnapshotRow[],
  overrides: Partial<Pick<ChatTerminalPreviewResult, "transcript">> & {
    status?: "running" | "completed" | "failed" | "disposed" | "detached";
    runtimeState?: "running" | "waiting-input" | "idle" | "exited" | "killed";
    resumeCommand?: string | null;
  } = {},
): ChatTerminalPreviewResult {
  return {
    terminalId: "terminal-1",
    source: "snapshot",
    snapshot: {
      version: 1,
      terminalId: "terminal-1",
      cols: 80,
      rows: rows.length,
      capturedAt: "2026-05-13T12:00:00.000Z",
      status: "running",
      runtimeState: "running",
      bufferType: "normal",
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      viewportY: 0,
      serialized: "",
      visibleRows: rows,
    },
    transcript: overrides.transcript ?? null,
    capturedAt: "2026-05-13T12:00:00.000Z",
    session: {
      terminalId: "terminal-1",
      ptyId: "pty-1",
      chatSessionId: null,
      laneId: "lane-1",
      laneName: "Lane 1",
      title: "Claude Code",
      toolType: "claude",
      goal: null,
      status: overrides.status ?? "running",
      runtimeState: overrides.runtimeState ?? "running",
      active: (overrides.status ?? "running") === "running",
      startedAt: "2026-05-13T12:00:00.000Z",
      endedAt: overrides.status && overrides.status !== "running" ? "2026-05-13T12:01:00.000Z" : null,
      exitCode: null,
      pid: 123,
      resumeCommand: overrides.resumeCommand ?? null,
      lastOutputPreview: null,
      summary: null,
    },
  };
}

describe("TerminalPane", () => {
  it("renders the visible snapshot rows instead of Claude's hidden prompt rows", () => {
    const result = render(
      <TerminalPane
        title="Claude Code"
        preview={preview([
          row("visible one"),
          row("visible two"),
          row("visible three"),
          row("visible four"),
          row("> stuck prompt"),
          row("auto mode on"),
        ])}
        liveChunks={[]}
        attached={false}
        width={80}
        height={4}
        hiddenBottomRows={2}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("visible one");
    expect(frame).toContain("visible four");
    expect(frame).not.toContain("> stuck prompt");
    expect(frame).not.toContain("auto mode on");
  });

  it("groups snapshot cells by color and style", () => {
    const rows = styledRowsFromSnapshotRows([
      {
        text: "go",
        wrapped: false,
        cells: [
          { text: "g", fg: 1, bg: null, fgMode: "palette", bgMode: "default", bold: true },
          { text: "o", fg: 1, bg: null, fgMode: "palette", bgMode: "default", bold: true },
        ],
      },
    ], 1);

    expect(rows[0]?.runs).toHaveLength(1);
    expect(rows[0]?.runs[0]?.text).toBe("go");
    expect(rows[0]?.runs[0]?.style.color).toBe("#cd3131");
    expect(rows[0]?.runs[0]?.style.bold).toBe(true);
  });

  it("marks direct Claude terminal control with the escape hints", () => {
    const result = render(
      <TerminalPane
        title="Claude Code"
        preview={preview([row("permission prompt"), row("1. Yes")])}
        liveChunks={[]}
        attached
        width={80}
        height={5}
        hiddenBottomRows={2}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("CLAUDE CONTROL");
    expect(frame).toContain("Ctrl+T returns to ADE");
    expect(frame).toContain("Ctrl+] escape");
    expect(frame).toContain("permission prompt");
  });

  it("uses transcript history for closed terminal sessions instead of the final resume-only snapshot", async () => {
    const result = render(
      <TerminalPane
        title="Claude Code"
        preview={preview([row("Resume this session with:"), row("claude --resume abc")], {
          transcript: "older output\nfinal answer\nResume this session with:\nclaude --resume abc\n",
          status: "completed",
          runtimeState: "exited",
          resumeCommand: "claude --resume abc",
        })}
        liveChunks={[]}
        attached={false}
        width={80}
        height={4}
        hiddenBottomRows={2}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("older output");
    expect(frame).toContain("final answer");
  });

  it("surfaces the blank-enter resume affordance for closed resumable sessions", () => {
    const result = render(
      <TerminalPane
        title="Claude Code"
        preview={preview([row("final answer")], {
          status: "completed",
          runtimeState: "exited",
          resumeCommand: "claude --resume abc",
        })}
        liveChunks={[]}
        attached={false}
        width={80}
        height={4}
        hiddenBottomRows={2}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("closed, resumable");
    expect(frame).toContain("Enter resumes");
  });

  it("strips short terminal save and restore escapes from transcript fallback", async () => {
    const result = render(
      <TerminalPane
        title="Claude Code"
        preview={preview([], {
          transcript: "\u001b7older output\rfinal answer\u001b8\n",
          status: "completed",
          runtimeState: "exited",
        })}
        liveChunks={[]}
        attached={false}
        width={80}
        height={4}
        hiddenBottomRows={2}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("older output");
    expect(frame).toContain("final answer");
    expect(frame).not.toContain("\u001b7");
    expect(frame).not.toContain("\u001b8");
  });

  it("filters Claude spinner residue from closed transcript previews", async () => {
    const result = render(
      <TerminalPane
        title="Claude Code"
        preview={preview([], {
          transcript: "✻\n✶8\n✳ Cogitated for a bit\n10s · ↓ 2.2k tokens)\nfinal answer\n",
          status: "completed",
          runtimeState: "exited",
        })}
        liveChunks={[]}
        attached={false}
        width={80}
        height={6}
        hiddenBottomRows={2}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("final answer");
    expect(frame).not.toContain("✻");
    expect(frame).not.toContain("✶8");
    expect(frame).not.toContain("Cogitated");
    expect(frame).not.toContain("2.2k tokens");
  });

  it("filters numeric Claude spinner residue bursts from closed transcript previews", async () => {
    const result = render(
      <TerminalPane
        title="Claude Code"
        preview={preview([], {
          transcript: "final answer\n8\n1\n3\n4\n40\nfollow-up detail\n",
          status: "completed",
          runtimeState: "exited",
        })}
        liveChunks={[]}
        attached={false}
        width={80}
        height={8}
        hiddenBottomRows={2}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("final answer");
    expect(frame).toContain("follow-up detail");
    expect(frame).not.toContain("\n8");
    expect(frame).not.toContain("\n40");
  });

  it("filters Claude input box chrome from closed transcript previews", async () => {
    const result = render(
      <TerminalPane
        title="Claude Code"
        preview={preview([], {
          transcript: [
            "╭────────────────────────╮",
            "│ > summarize this lane  │",
            "╰────────────────────────╯",
            "final answer",
            "╭────────────────────────╮",
            "│                        │",
            "╰────────────────────────╯",
            "esc to interrupt",
          ].join("\n"),
          status: "completed",
          runtimeState: "exited",
        })}
        liveChunks={[]}
        attached={false}
        width={80}
        height={8}
        hiddenBottomRows={2}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("final answer");
    expect(frame).not.toContain("╭");
    expect(frame).not.toContain("summarize this lane");
    expect(frame).not.toContain("esc to interrupt");
  });

  it("filters Claude startup chrome and spinner fragments from closed transcripts", async () => {
    const result = render(
      <TerminalPane
        title="Scratch Claude pane audit"
        preview={preview([], {
          transcript: [
            "say ok then stop",
            "╭───Claude Code v2.1.145────────────────────────╮",
            "││What's new│",
            "│Welcome back Arul!│Added `claude agents --json` to list live Claude sessions",
            "│ ▐▛███▜▌│Statusline JSON input now includes GitHub repo and PR information",
            "│Sonnet 4.6 with low effort · Claude Max · ││",
            "│~/Projects/ADE/.ade/worktrees/scratch-tui-claude-audit││",
            "○ low · /effort",
            "❯ sayokthenstop",
            "❯ say ok then stop",
            "·Orbiting…",
            "❯",
            "✻O",
            "r",
            "✽b",
            "Orit",
            "bi",
            "in",
            "✻tig…",
            "n",
            "✶g",
            "…",
            "ing",
            "⏺ok",
            "✻Churned for 1s",
            "? for shortcuts · ← for agents",
            "1 MCP server failed · /mcp",
            "1 claude.ai connector needs auth",
            "Claude in Chrome enabled · /chrome",
            "Resume this session with:",
            "claude --resume 5ae8dfcf-13be-45d7-b672-026fe90f9dea",
          ].join("\n"),
          status: "completed",
          runtimeState: "exited",
          resumeCommand: "claude --resume 5ae8dfcf-13be-45d7-b672-026fe90f9dea",
        })}
        liveChunks={[]}
        attached={false}
        width={120}
        height={8}
        hiddenBottomRows={2}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("say ok then stop");
    expect(frame).toContain("ok");
    expect(frame).not.toContain("Claude Code v");
    expect(frame).not.toContain("What's new");
    expect(frame).not.toContain("Welcome back");
    expect(frame).not.toContain("Statusline JSON");
    expect(frame).not.toContain("Claude Max");
    expect(frame).not.toContain("sayokthenstop");
    expect(frame).not.toContain("Orbiting");
    expect(frame).not.toContain("Orit");
    expect(frame).not.toContain("Churned");
    expect(frame).not.toContain("MCP server failed");
    expect(frame).not.toContain("Resume this session");
  });

  it("shows the amber '↓ N new' jump chip when scrolled up and new output is pending", () => {
    const result = render(
      <TerminalPane
        title="Claude Code"
        preview={preview([row("visible one"), row("visible two")])}
        liveChunks={[]}
        attached={false}
        width={80}
        height={4}
        hiddenBottomRows={2}
        scrollOffset={5}
        pendingNewCount={3}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");
    expect(frame).toContain("↓ 3 new");
  });

  it("shows a muted scrollback hint (no chip) when scrolled up with no new output", () => {
    const result = render(
      <TerminalPane
        title="Claude Code"
        preview={preview([row("visible one"), row("visible two")])}
        liveChunks={[]}
        attached={false}
        width={80}
        height={4}
        hiddenBottomRows={2}
        scrollOffset={5}
        pendingNewCount={0}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");
    expect(frame).not.toContain("new");
    expect(frame).toContain("scrollback");
  });

  it("hides the new-output chip when attached (Claude owns the terminal, always follows bottom)", () => {
    const result = render(
      <TerminalPane
        title="Claude Code"
        preview={preview([row("permission prompt"), row("1. Yes")])}
        liveChunks={[]}
        attached
        width={80}
        height={5}
        hiddenBottomRows={2}
        scrollOffset={5}
        pendingNewCount={9}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");
    expect(frame).not.toContain("9 new");
    expect(frame).toContain("CLAUDE CONTROL");
  });

  it("reports viewport metrics (max scrollable rows + visible text) for keyboard scroll + copy", async () => {
    const metrics: { maxScrollable: number; visibleText: string }[] = [];
    render(
      <TerminalPane
        title="Claude Code"
        preview={null}
        liveChunks={["line one\r\nline two\r\nline three\r\n"]}
        attached={false}
        width={80}
        height={6}
        hiddenBottomRows={0}
        onViewportMetrics={(m) => metrics.push(m)}
      />,
    );
    // xterm's write() callback is async; poll until the visible text settles.
    await waitFor(() => metrics.some((m) => m.visibleText.includes("line three")));
    const last = metrics[metrics.length - 1];
    expect(last).toBeDefined();
    expect(typeof last?.maxScrollable).toBe("number");
    expect(metrics.some((m) => m.visibleText.includes("line one"))).toBe(true);
    expect(metrics.some((m) => m.visibleText.includes("line three"))).toBe(true);
  });

  it("advances the write cursor past 500 chunks (desync regression) without dropping later output", async () => {
    // Feed > 500 incremental chunks; every chunk must land in the xterm buffer.
    // The old slice(-500) on every chunk pinned the buffer and froze the write
    // cursor at 500, so later rows were silently dropped.
    //
    // We assert the REAL invariant — that all 540 rows were written to the
    // terminal buffer/scrollback — rather than that row539 happens to sit in the
    // ~6-row viewport at the instant we sample lastFrame() (that capture is
    // viewport-bound and timing-dependent, which flaked in CI). The component
    // reports `maxScrollable` = the buffer's scrollback extent (viewportY), which
    // is a deterministic, monotonic measure of how far the write cursor advanced.
    const CHUNK_COUNT = 540;
    const HEIGHT = 6;
    const chunks = Array.from({ length: CHUNK_COUNT }, (_unused, index) => `row${index}\r\n`);
    // Each "rowN\r\n" writes one line; with HEIGHT visible rows the scrollback
    // extent (maxScrollable) settles at (linesWritten - HEIGHT). If the >500
    // desync regression returns, the cursor stalls near 500 and maxScrollable
    // can never reach this threshold, so the test still fails on regression.
    const EXPECTED_MIN_SCROLLBACK = CHUNK_COUNT - HEIGHT; // 534

    const metrics: { maxScrollable: number; visibleText: string }[] = [];
    render(
      <TerminalPane
        title="Claude Code"
        preview={null}
        liveChunks={chunks}
        attached={false}
        width={80}
        height={HEIGHT}
        hiddenBottomRows={0}
        onViewportMetrics={(m) => metrics.push(m)}
      />,
    );

    // xterm's write() callback is async; poll until the scrollback extent reports
    // the full 540 rows landed. Generous timeout so a slow CI render still settles.
    await waitFor(
      () => metrics.some((m) => m.maxScrollable >= EXPECTED_MIN_SCROLLBACK),
      5_000,
    );
    const maxReported = Math.max(0, ...metrics.map((m) => m.maxScrollable));
    expect(maxReported).toBeGreaterThanOrEqual(EXPECTED_MIN_SCROLLBACK);
  });
});
