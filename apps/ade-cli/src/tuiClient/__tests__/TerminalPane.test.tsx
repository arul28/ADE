import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { TerminalPane, styledRowsFromSnapshotRows } from "../components/TerminalPane";
import type { ChatTerminalPreviewResult, TerminalSnapshotRow } from "../../../../desktop/src/shared/types";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
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
    status?: "running" | "completed" | "failed" | "disposed";
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
});
