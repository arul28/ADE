import { describe, expect, it } from "vitest";
import {
  buildSubagentPaneRows,
  buildSubagentTranscriptEvents,
  selectedSubagentSnapshot,
  subagentIndexForPaneLine,
  subagentPaneSelectableLineOffsets,
  subagentTranscriptMessagesToEvents,
} from "../subagentPane";
import type { AgentChatSubagentTranscriptMessage } from "../../../../desktop/src/shared/types/chat";
import { resolveSubagentCapability } from "../../../../desktop/src/shared/subagentCapabilities";
import { renderChatLines } from "../format";
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
      capability: resolveSubagentCapability("codex"),
      mission: null,
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

  it("converts a real daemon transcript into role-prefixed text envelopes", () => {
    const messages: AgentChatSubagentTranscriptMessage[] = [
      { type: "user", uuid: "u1", sessionId: "child-1", parentToolUseId: null, message: {}, text: "Investigate the renderer" },
      { type: "assistant", uuid: "a1", sessionId: "child-1", parentToolUseId: null, message: {}, text: "Found the path in app.tsx" },
      { type: "system", uuid: "s1", sessionId: "child-1", parentToolUseId: null, message: {}, text: "  " },
    ];
    const events = subagentTranscriptMessagesToEvents({
      messages,
      sessionId: "s1",
      snapshot: {
        id: "child-1",
        name: "Explore renderer",
        kind: "subagent",
        status: "completed",
        summary: "done",
        turnId: "turn-1",
      },
    });
    // Header + the two non-empty messages (the whitespace-only system row drops).
    expect(events.map((entry) => entry.event.type)).toEqual(["text", "text", "text"]);
    const body = events.map((entry) => JSON.stringify(entry.event)).join("\n");
    expect(body).toContain("user › Investigate the renderer");
    expect(body).toContain("Found the path in app.tsx");
    expect(body).not.toContain("assistant › ");
  });

  it("renders takeover transcript messages as SEPARATE lines (not one jammed blob)", () => {
    // Regression: synthetic transcript lines all share the snapshot turnId; without
    // distinct itemIds the render-line coalescer fused them into one separator-less
    // blob ("…Task: XInvestigate…Found the path"). Each line must stay distinct.
    const events = subagentTranscriptMessagesToEvents({
      messages: [
        { type: "user", uuid: "u1", sessionId: "c1", parentToolUseId: null, message: {}, text: "Investigate the renderer" },
        { type: "assistant", uuid: "a1", sessionId: "c1", parentToolUseId: null, message: {}, text: "Found the path in app.tsx" },
      ],
      sessionId: "s1",
      snapshot: { id: "c1", name: "Explore renderer", kind: "subagent", status: "completed", summary: "done", turnId: "turn-1" },
    });
    const lines = renderChatLines({ activeSession: session, notices: [], events });
    const assistantBodies = lines.filter((l) => l.tone === "assistant").map((l) => l.body);
    // Header, user message, and assistant message are three distinct lines.
    expect(assistantBodies.length).toBeGreaterThanOrEqual(3);
    // The two messages are never concatenated into a single line.
    for (const body of assistantBodies) {
      expect(body.includes("Investigate the renderer") && body.includes("Found the path")).toBe(false);
    }
    expect(assistantBodies.some((b) => b.includes("Investigate the renderer"))).toBe(true);
    expect(assistantBodies.some((b) => b.includes("Found the path in app.tsx"))).toBe(true);
  });

  it("falls back to a summary line when the real transcript has no text", () => {
    const events = subagentTranscriptMessagesToEvents({
      messages: [{ type: "assistant", uuid: "a1", sessionId: "c1", parentToolUseId: null, message: {}, text: null }],
      sessionId: "s1",
      snapshot: { id: "c1", name: "agent", kind: "subagent", status: "completed", summary: "wrapped up the task" },
    });
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events[1]!.event)).toContain("wrapped up the task");
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
