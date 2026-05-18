import { describe, expect, it } from "vitest";
import {
  buildSubagentPaneRows,
  buildSubagentTranscriptEvents,
  selectedSubagentSnapshot,
  subagentIndexForPaneLine,
  subagentPaneSelectableLineOffsets,
} from "../subagentPane";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { RightPaneContent } from "../types";

const session: AgentChatSessionSummary = {
  sessionId: "s1",
  laneId: "lane-1",
  provider: "codex",
  model: "gpt-5.5",
  status: "idle",
  startedAt: "2026-01-01T12:00:00.000Z",
  endedAt: null,
  lastActivityAt: "2026-01-01T12:00:00.000Z",
  lastOutputPreview: null,
  summary: null,
};

function rosterContent(): Extract<RightPaneContent, { kind: "chat-info" }> {
  return {
    kind: "chat-info",
    info: {
      provider: "codex",
      modelLabel: "gpt-5.5",
      laneLabel: "lane-1",
      contextPercent: null,
      tokenSummary: null,
      goal: null,
      plan: null,
      streaming: false,
      inspectedSubagentId: null,
      snapshots: [
        { id: "run-1", name: "running", kind: "subagent", status: "running", summary: "checking files" },
        { id: "team-1", name: "review", kind: "teammate", status: "completed", summary: "done" },
        { id: "bg-1", name: "lane pack", kind: "subagent", status: "running", background: true, summary: "refreshing" },
        { id: "done-1", name: "tests", kind: "subagent", status: "completed", summary: "passed" },
      ],
    },
  };
}

function rosterPaneContent() {
  const content = rosterContent();
  return {
    provider: content.info.provider,
    snapshots: content.info.snapshots,
  };
}

describe("subagent pane helpers", () => {
  it("keeps main first and groups selectable agent rows by section", () => {
    const rows = buildSubagentPaneRows(rosterPaneContent());

    expect(rows.map((row) => row.key)).toEqual(["main", "run-1", "done-1", "team-1", "bg-1"]);
    expect(rows.map((row) => row.section)).toEqual(["main", "subagents", "subagents", "teammates", "background"]);
    expect(selectedSubagentSnapshot(rosterPaneContent(), 0)).toBeNull();
    expect(selectedSubagentSnapshot(rosterPaneContent(), 1)?.id).toBe("run-1");
  });

  it("maps visual table lines back to selectable rows for mouse clicks", () => {
    const content = rosterPaneContent();
    const offsets = subagentPaneSelectableLineOffsets(content, 1);

    expect(offsets.length).toBe(5);
    expect(subagentIndexForPaneLine(content, offsets[0]!, 1)).toBe(0);
    expect(subagentIndexForPaneLine(content, offsets[1]!, 1)).toBe(1);
    expect(subagentIndexForPaneLine(content, offsets[3]!, 1)).toBe(3);
    expect(subagentIndexForPaneLine(content, offsets[4]! + 1, 1)).toBe(4);
    expect(subagentIndexForPaneLine(content, offsets[0]! - 2, 1)).toBeNull();
  });

  it("only accounts for detail lines on the selected subagent row", () => {
    const content = rosterPaneContent();
    expect(subagentPaneSelectableLineOffsets(content, 1)).toEqual([4, 8, 10, 13, 16]);
    expect(subagentPaneSelectableLineOffsets(content, 2)).toEqual([4, 8, 9, 13, 16]);
  });

  it("builds a focused transcript without unrelated subagent output", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "subagent_started", taskId: "run-1", parentToolUseId: "spawn-1", description: "running" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: { type: "subagent_started", taskId: "other", parentToolUseId: "spawn-1", description: "sibling agent" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.500Z",
        sequence: 3,
        event: { type: "tool_call", itemId: "tool-1", parentItemId: "spawn-1", tool: "read_file", args: { path: "src/app.tsx" } },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:02.000Z",
        sequence: 4,
        event: { type: "subagent_result", taskId: "other", parentToolUseId: "spawn-2", status: "completed", summary: "wrong transcript" },
      },
    ];

    const transcript = buildSubagentTranscriptEvents({
      events,
      activeSession: session,
      snapshot: {
        id: "run-1",
        name: "running",
        kind: "subagent",
        status: "running",
        summary: "checking files",
        parentToolUseId: "spawn-1",
      },
    });

    expect(transcript.map((entry) => entry.event.type)).toEqual(["text", "text", "tool_call"]);
    expect(transcript.map((entry) => JSON.stringify(entry.event)).join("\n")).toContain("read_file");
    expect(transcript.map((entry) => JSON.stringify(entry.event)).join("\n")).not.toContain("sibling agent");
    expect(transcript.map((entry) => JSON.stringify(entry.event)).join("\n")).not.toContain("wrong transcript");
  });

  it("matches lifecycle events by agentId when no parent tool id is available", () => {
    const transcript = buildSubagentTranscriptEvents({
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: {
            type: "subagent_started",
            taskId: "task-1",
            agentId: "agent-1",
            parentToolUseId: null,
            description: "Investigate issue",
          },
        },
      ],
      activeSession: session,
      snapshot: {
        id: "agent-1",
        name: "Investigate issue",
        kind: "subagent",
        status: "running",
        summary: "",
        parentToolUseId: null,
      },
    });

    expect(transcript.map((entry) => JSON.stringify(entry.event)).join("\n")).toContain("Started.");
  });
});
