import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import {
  extractMissionControlTextToolCalls,
  rewriteMissionControlTextToolEvents,
} from "./missionControlTextTools";

describe("mission control text tool rewriting", () => {
  it("extracts fenced mission tool calls", () => {
    const calls = extractMissionControlTextToolCalls([
      "```json",
      "// ade_spawn_worker",
      "{\"name\":\"planner\",\"prompt\":\"Plan the work\"}",
      "```",
    ].join("\n"));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      toolName: "spawn_worker",
      args: { name: "planner", prompt: "Plan the work" },
    });
  });

  it("extracts bare mission tool calls from legacy transcripts", () => {
    const calls = extractMissionControlTextToolCalls([
      "// get_project_context",
      "{\"runId\":\"run-1\",\"missionId\":\"mission-1\"}",
      "",
      "// spawn_worker",
      "{\"name\":\"planner\",\"prompt\":\"Plan the work\",\"readOnly\":true}",
    ].join("\n"));

    expect(calls.map((call) => call.toolName)).toEqual(["get_project_context", "spawn_worker"]);
    expect(calls[1]?.args).toMatchObject({ name: "planner", readOnly: true });
  });

  it("replaces transport-only text with normal tool-call events", () => {
    const events: AgentChatEventEnvelope[] = [{
      sessionId: "chat-1",
      timestamp: "2026-05-06T20:00:00.000Z",
      event: {
        type: "text",
        text: [
          "```json",
          "// get_project_context",
          "{\"runId\":\"run-1\"}",
          "```",
        ].join("\n"),
        turnId: "turn-1",
        itemId: "item-1",
      },
    }];

    const rewritten = rewriteMissionControlTextToolEvents(events);

    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]?.event).toMatchObject({
      type: "tool_call",
      tool: "get_project_context",
      args: { runId: "run-1" },
      itemId: "mission-control-text:item-1:0",
      turnId: "turn-1",
    });
  });

  it("preserves prose around a recovered tool call", () => {
    const events: AgentChatEventEnvelope[] = [{
      sessionId: "chat-1",
      timestamp: "2026-05-06T20:00:00.000Z",
      event: {
        type: "text",
        text: [
          "I will start by reading context.",
          "",
          "```json",
          "// get_project_context",
          "{\"runId\":\"run-1\"}",
          "```",
        ].join("\n"),
        turnId: "turn-1",
      },
    }];

    const rewritten = rewriteMissionControlTextToolEvents(events);

    expect(rewritten).toHaveLength(2);
    expect(rewritten[0]?.event).toMatchObject({
      type: "text",
      text: "I will start by reading context.",
    });
    expect(rewritten[1]?.event).toMatchObject({
      type: "tool_call",
      tool: "get_project_context",
    });
  });

  it("recovers mission tool calls split across text chunks in the same turn", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "chat-1",
        timestamp: "2026-05-06T20:00:00.000Z",
        event: {
          type: "text",
          text: "// mark_step_complete\n",
          turnId: "turn-1",
          itemId: "item-1",
        },
      },
      {
        sessionId: "chat-1",
        timestamp: "2026-05-06T20:00:00.001Z",
        event: {
          type: "text",
          text: "{\"stepId\":\"step-1\",\"summary\":\"Done\"}",
          turnId: "turn-1",
          itemId: "item-2",
        },
      },
    ];

    const rewritten = rewriteMissionControlTextToolEvents(events);

    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]?.event).toMatchObject({
      type: "tool_call",
      tool: "mark_step_complete",
      args: { stepId: "step-1", summary: "Done" },
      turnId: "turn-1",
    });
  });
});
