import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { dedentUserText } from "./common";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope, ExternalSessionProvider } from "../../../../shared/types";
import type { ExternalSessionDiscoveryRecord } from "../discoveryUtils";
import { CURSOR_STORE_MAX_MESSAGE_BYTES } from "../discoverCursor";
import { loadCursorStorePage } from "./cursor";
import { decodeEventsCursor, loadExternalSessionEvents } from "./index";
import { openCodeExportToEvents } from "./opencode";
import { readJsonlWindow } from "./paging";

// Loaded at run time: Vite cannot resolve a static `node:sqlite` import.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(name: string, rows: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ext-events-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return filePath;
}

function record(
  provider: ExternalSessionProvider,
  sourcePath: string | null,
  extra: Partial<ExternalSessionDiscoveryRecord> = {},
): ExternalSessionDiscoveryRecord {
  return {
    provider,
    id: "sess-1",
    cwd: "/Users/dev/project",
    title: null,
    preview: null,
    createdAt: Date.parse("2026-09-01T00:00:00.000Z"),
    updatedAt: Date.parse("2026-09-01T01:00:00.000Z"),
    messageCount: null,
    launch: null,
    sourcePath,
    ...extra,
  };
}

async function load(
  provider: ExternalSessionProvider,
  sourcePath: string | null,
  extra: { purpose?: "preview" | "import"; before?: string | null; maxEvents?: number; record?: Partial<ExternalSessionDiscoveryRecord> } = {},
) {
  return loadExternalSessionEvents({
    provider,
    sessionId: "sess-1",
    record: record(provider, sourcePath, extra.record),
    chatSessionId: `external-preview:${provider}:sess-1`,
    laneId: "lane-1",
    purpose: extra.purpose ?? "preview",
    importedAt: Date.parse("2026-09-23T12:00:00.000Z"),
    ...(extra.before !== undefined ? { before: extra.before } : {}),
    ...(extra.maxEvents !== undefined ? { maxEvents: extra.maxEvents } : {}),
  });
}

/** `type` plus the one field that identifies each event, in order. */
function shape(events: AgentChatEventEnvelope[]): string[] {
  return events.map(({ event }) => {
    switch (event.type) {
      case "user_message":
      case "text":
      case "reasoning":
        return `${event.type}:${event.text}`;
      case "tool_call":
        return `tool_call:${event.tool}#${event.itemId}`;
      case "tool_result":
        return `tool_result:${event.status}#${event.itemId}`;
      case "command":
        return `command:${event.command}`;
      case "file_change":
        return `file_change:${event.kind}:${event.path}`;
      case "system_notice":
        return `notice:${event.message}`;
      default:
        return event.type;
    }
  });
}

function toolArgs(events: AgentChatEventEnvelope[], itemId: string): unknown {
  const found = events.find(({ event }) => event.type === "tool_call" && event.itemId === itemId);
  return found?.event.type === "tool_call" ? found.event.args : undefined;
}

function toolResult(events: AgentChatEventEnvelope[], itemId: string): unknown {
  const found = events.find(({ event }) => event.type === "tool_result" && event.itemId === itemId);
  return found?.event.type === "tool_result" ? found.event.result : undefined;
}

const claudeRows = [
  {
    type: "user",
    uuid: "u1",
    timestamp: "2026-09-01T10:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "Why is the build red?" }] },
  },
  {
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-09-01T10:00:01.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "Checking the log." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } },
      ],
    },
  },
  {
    type: "user",
    uuid: "u2",
    timestamp: "2026-09-01T10:00:02.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "1 failing", is_error: true }] },
  },
  {
    type: "assistant",
    uuid: "a2",
    timestamp: "2026-09-01T10:00:03.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "One test fails." }] },
  },
];

describe("loadExternalSessionEvents — Claude", () => {
  it("pairs tool calls with results in order and stamps source timestamps", async () => {
    const page = await load("claude", tempFile("claude.jsonl", claudeRows));
    expect(shape(page.events)).toEqual([
      "user_message:Why is the build red?",
      "text:Checking the log.",
      "tool_call:Bash#toolu_1",
      "tool_result:failed#toolu_1",
      "text:One test fails.",
    ]);
    expect(toolArgs(page.events, "toolu_1")).toEqual({ command: "npm test" });
    expect(page.events[0]!.timestamp).toBe("2026-09-01T10:00:00.000Z");
    expect(page.events.every((envelope) => envelope.sessionId === "external-preview:claude:sess-1")).toBe(true);
    expect(page.events[0]!.provenance?.laneId).toBe("lane-1");
    expect(page).toMatchObject({ hasOlder: false, olderCursor: null, truncated: false });
  });

  it("adds the import notice only for an import", async () => {
    const filePath = tempFile("claude.jsonl", claudeRows);
    const preview = await load("claude", filePath);
    expect(preview.events.some(({ event }) => event.type === "system_notice")).toBe(false);

    const imported = await load("claude", filePath, { purpose: "import" });
    expect(shape(imported.events)[0]).toBe("notice:Session imported from claude CLI (sess-1)");
    expect(imported.events.slice(1)).toHaveLength(preview.events.length);
  });
});

describe("loadExternalSessionEvents — Codex rollout", () => {
  const ts = (second: number) => `2026-09-23T17:00:${String(second).padStart(2, "0")}.000Z`;
  const current = [
    { timestamp: ts(0), type: "session_meta", payload: { id: "sess-1", cwd: "/repo" } },
    { timestamp: ts(1), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { timestamp: ts(2), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } },
    { timestamp: ts(2), type: "event_msg", payload: { type: "item_completed", turn_id: "turn-1", item: { type: "UserMessage", id: "um-1", content: [{ type: "text", text: "Run the tests" }] } } },
    { timestamp: ts(3), type: "response_item", payload: { type: "custom_tool_call", call_id: "call-exec", name: "exec", input: "await tools.exec_command({cmd:'npm test'})" } },
    { timestamp: ts(4), type: "event_msg", payload: { type: "item_completed", turn_id: "turn-1", item: { type: "CommandExecution", id: "exec-1", command: ["/bin/zsh", "-lc", "npm test"], cwd: "file:///repo", aggregated_output: "ok\n", exit_code: 0, duration: { secs: 1, nanos: 500_000_000 }, status: "completed" } } },
    { timestamp: ts(5), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-exec", output: [{ type: "input_text", text: "ok" }] } },
    { timestamp: ts(5), type: "response_item", payload: { type: "function_call", call_id: "call-wait", name: "wait", arguments: "{\"cell_id\":\"1\"}" } },
    { timestamp: ts(6), type: "response_item", payload: { type: "function_call_output", call_id: "call-wait", output: "done" } },
    { timestamp: ts(7), type: "event_msg", payload: { type: "item_completed", turn_id: "turn-1", item: { type: "FileChange", id: "patch-1", changes: { "/repo/a.ts": { type: "update", unified_diff: "@@ -1 +1 @@" } }, status: "completed" } } },
    { timestamp: ts(8), type: "response_item", payload: { type: "function_call", call_id: "call-spawn", name: "spawn_agent", namespace: "collaboration", arguments: "{\"task_name\":\"scan\"}" } },
    { timestamp: ts(8), type: "event_msg", payload: { type: "item_completed", turn_id: "turn-1", item: { type: "SubAgentActivity", id: "call-spawn", kind: "started" } } },
    { timestamp: ts(9), type: "response_item", payload: { type: "function_call_output", call_id: "call-spawn", output: "{\"task_name\":\"/root/scan\"}" } },
    { timestamp: ts(10), type: "response_item", payload: { type: "function_call", call_id: "call-mcp", name: "js", namespace: "mcp__cua", arguments: "{}" } },
    { timestamp: ts(11), type: "event_msg", payload: { type: "item_completed", turn_id: "turn-1", item: { type: "McpToolCall", id: "call-mcp", server: "cua", tool: "js", arguments: { code: "1" }, status: "completed", result: { content: [{ type: "text", text: "state" }] } } } },
    { timestamp: ts(12), type: "event_msg", payload: { type: "item_completed", turn_id: "turn-1", item: { type: "AgentMessage", id: "msg-1", content: [{ type: "Text", text: "All green." }] } } },
    { timestamp: ts(12), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "All green." }] } },
  ];

  it("reads current rollouts from item_completed and keeps uncovered function calls", async () => {
    const page = await load("codex", tempFile("rollout.jsonl", current));
    expect(shape(page.events)).toEqual([
      "user_message:Run the tests",
      "command:npm test",
      "file_change:modify:/repo/a.ts",
      "tool_call:collaboration:spawn_agent#call-spawn",
      "tool_result:completed#call-spawn",
      "tool_call:cua:js#call-mcp",
      "tool_result:completed#call-mcp",
      "text:All green.",
    ]);
    const command = page.events[1]!.event;
    expect(command).toMatchObject({ type: "command", cwd: path.resolve("/repo"), output: "ok\n", exitCode: 0, durationMs: 1500, turnId: "turn-1" });
    expect(toolArgs(page.events, "call-spawn")).toEqual({ task_name: "scan" });
    expect(toolResult(page.events, "call-mcp")).toBe("state");
  });

  it("keeps legacy function calls and drops only mirrored response messages", async () => {
    const legacy = [
      { timestamp: ts(0), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix it" }] } },
      { timestamp: ts(0), type: "event_msg", payload: { type: "user_message", message: "Fix it" } },
      { timestamp: ts(1), type: "event_msg", payload: { type: "agent_reasoning", text: "Looking at the file" } },
      { timestamp: ts(2), type: "response_item", payload: { type: "function_call", id: "fc_1", call_id: "call-1", name: "shell", arguments: "{\"command\":[\"ls\"]}" } },
      { timestamp: ts(3), type: "response_item", payload: { type: "function_call_output", id: "fco_1", call_id: "call-1", output: "a.ts" } },
      { timestamp: ts(4), type: "response_item", payload: { type: "local_shell_call", call_id: "call-2", status: "completed", action: { type: "exec", command: ["cat", "a.ts"] } } },
      { timestamp: ts(5), type: "response_item", payload: { type: "function_call_output", call_id: "call-2", output: "x" } },
      { timestamp: ts(6), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
      { timestamp: ts(6), type: "event_msg", payload: { type: "agent_message", message: "Done" } },
    ];
    const page = await load("codex", tempFile("rollout.jsonl", legacy));
    expect(shape(page.events)).toEqual([
      "user_message:Fix it",
      "reasoning:Looking at the file",
      "tool_call:shell#call-1",
      "tool_result:completed#call-1",
      "tool_call:shell#call-2",
      "tool_result:completed#call-2",
      "text:Done",
    ]);
    expect(toolArgs(page.events, "call-1")).toEqual({ command: ["ls"] });
    expect(toolResult(page.events, "call-1")).toBe("a.ts");
  });
});

describe("loadExternalSessionEvents — other providers", () => {
  it("reads Droid sessions like Claude", async () => {
    const rows = [
      { type: "session_start", id: "sess-1", cwd: "/repo" },
      { type: "message", id: "m1", timestamp: "2026-05-10T02:19:22.000Z", message: { role: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>\nAdd tests" }] } },
      { type: "message", id: "m2", timestamp: "2026-05-10T02:19:26.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "tool_use", id: "call_1", name: "Execute", input: { command: "ls" } }] } },
      { type: "message", id: "m3", timestamp: "2026-05-10T02:19:27.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "a.ts" }] } },
      { type: "todo_state", id: "t1", todos: { todos: "1. x" } },
      { type: "message", id: "m4", timestamp: "2026-05-10T02:19:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "Added." }] } },
    ];
    const page = await load("droid", tempFile("droid.jsonl", rows));
    expect(shape(page.events)).toEqual([
      "user_message:Add tests",
      "tool_call:Execute#call_1",
      "tool_result:completed#call_1",
      "text:Added.",
    ]);
  });

  it("reads Pi toolCall / toolResult rows and thinking", async () => {
    const rows = [
      { type: "session", version: 3, id: "sess-1", cwd: "/repo" },
      { type: "model_change", id: "mc", provider: "openai", modelId: "gpt" },
      { type: "message", id: "p1", timestamp: "2026-08-06T17:58:47.624Z", message: { role: "user", content: [{ type: "text", text: "Review this" }] } },
      { type: "message", id: "p2", timestamp: "2026-08-06T17:58:55.171Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Plan the review" }, { type: "toolCall", id: "call_A|fc_1", name: "read", arguments: { path: "a.ts" } }] } },
      { type: "message", id: "p3", timestamp: "2026-08-06T17:58:55.172Z", message: { role: "toolResult", toolCallId: "call_A|fc_1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false } },
      { type: "message", id: "p4", timestamp: "2026-08-06T17:59:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Looks fine." }] } },
    ];
    const page = await load("pi", tempFile("pi.jsonl", rows));
    expect(shape(page.events)).toEqual([
      "user_message:Review this",
      "reasoning:Plan the review",
      "tool_call:read#call_A|fc_1",
      "tool_result:completed#call_A|fc_1",
      "text:Looks fine.",
    ]);
    expect(toolResult(page.events, "call_A|fc_1")).toBe("file body");
  });

  it("closes Cursor tool calls that have no stored result", async () => {
    const rows = [
      { role: "user", message: { content: [{ type: "text", text: "<timestamp>Monday, Sep 21, 2026</timestamp>\n<user_query>\nFix the banner\n</user_query>" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "Shell", input: { command: "git status" } }] } },
      { type: "turn_ended", status: "success" },
    ];
    const page = await load("cursor", tempFile("agent.jsonl", rows));
    const kinds = shape(page.events);
    expect(kinds[0]).toBe("user_message:Fix the banner");
    expect(kinds[1]).toBe("text:Looking.");
    expect(kinds[2]).toMatch(/^tool_call:Shell#cursor:\d+:tool:1$/u);
    expect(kinds[3]).toBe(kinds[2]!.replace("tool_call:Shell", "tool_result:completed"));
  });

  it("falls back to sampled text for a Cursor store.db session", async () => {
    const page = await load("cursor", "/nowhere/store.db", {
      record: { messages: [{ role: "user", text: "hi", at: 1 }, { role: "assistant", text: "hello", at: 2 }] },
    });
    expect(shape(page.events)).toEqual(["user_message:hi", "text:hello"]);
  });

  it("reads Qwen functionCall parts and tool_result rows", async () => {
    const rows = [
      { uuid: "q1", timestamp: "2026-09-01T01:37:30.000Z", type: "user", message: { role: "user", parts: [{ text: "List files" }] } },
      { uuid: "q2", timestamp: "2026-09-01T01:37:31.000Z", type: "assistant", message: { role: "model", parts: [{ text: "thinking…", thought: true }, { text: "Listing." }, { functionCall: { id: "fc-1", name: "list_directory", args: { path: "." } } }] } },
      { uuid: "q3", timestamp: "2026-09-01T01:37:32.000Z", type: "tool_result", message: { role: "user", parts: [{ functionResponse: { id: "fc-1", name: "list_directory", response: { output: "a.ts" } } }] }, toolCallResult: { callId: "fc-1", status: "success" } },
      { uuid: "q4", timestamp: "2026-09-01T01:37:33.000Z", type: "system", subtype: "ui_telemetry", systemPayload: {} },
      { uuid: "q5", timestamp: "2026-09-01T01:37:34.000Z", type: "assistant", message: { role: "model", parts: [{ text: "One file." }] } },
    ];
    const page = await load("qwen", tempFile("qwen.jsonl", rows));
    expect(shape(page.events)).toEqual([
      "user_message:List files",
      "reasoning:thinking…",
      "text:Listing.",
      "tool_call:list_directory#fc-1",
      "tool_result:completed#fc-1",
      "text:One file.",
    ]);
    expect(toolResult(page.events, "fc-1")).toBe("a.ts");
  });

  it("converts only Qwen user rows that discovery counts as prompts", async () => {
    const rows = [
      { uuid: "q0", type: "user", provenance: "injected", message: { parts: [{ text: "Injected context" }] } },
      { uuid: "q1", type: "user", message: { parts: [{ text: "Typed without provenance" }] } },
      { uuid: "q2", type: "user", provenance: "real_user", message: { parts: [{ text: "Typed explicitly" }] } },
    ];
    const page = await load("qwen", tempFile("qwen.jsonl", rows));
    expect(shape(page.events)).toEqual([
      "user_message:Typed without provenance",
      "user_message:Typed explicitly",
    ]);
  });

  it("reads Grok chat history and skips injected user context", async () => {
    const rows = [
      { type: "system", content: "You are Grok" },
      { type: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>" }], synthetic_reason: "context" },
      { type: "user", content: [{ type: "text", text: "Review the diff" }], prompt_index: 0 },
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Reading the diff" }] },
      { type: "assistant", content: "On it.", tool_calls: [{ id: "call-1", name: "grep", arguments: "{\"pattern\":\"x\"}" }] },
      { type: "tool_result", tool_call_id: "call-1", content: "a.ts:1" },
      { type: "assistant", content: "Nothing to change." },
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ext-grok-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "chat_history.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "summary.json"), "{}");
    // Discovery may point at a sibling file; the history file is found next to it.
    const page = await load("grok", path.join(dir, "summary.json"));
    expect(shape(page.events)).toEqual([
      "user_message:Review the diff",
      "reasoning:Reading the diff",
      "text:On it.",
      "tool_call:grep#call-1",
      "tool_result:completed#call-1",
      "text:Nothing to change.",
    ]);
    expect(toolArgs(page.events, "call-1")).toEqual({ pattern: "x" });
  });

  it("reads Copilot events and leaves subagent internals out", async () => {
    const rows = [
      { type: "session.start", id: "e0", timestamp: "2026-03-11T02:43:00.000Z", data: {} },
      { type: "user.message", id: "e1", timestamp: "2026-03-11T02:43:16.901Z", data: { content: "Unify the model picker", transformedContent: "<current_datetime/>Unify" } },
      { type: "user.message", id: "e1a", timestamp: "2026-03-11T02:43:17.000Z", data: { source: "autopilot", content: "Continue working on the task." } },
      { type: "assistant.message", id: "e2", timestamp: "2026-03-11T02:43:27.930Z", data: { messageId: "m1", content: "Reading.", reasoningText: "Plan", toolRequests: [{ toolCallId: "call_1", name: "view", arguments: { path: "a.ts" } }] } },
      { type: "tool.execution_start", id: "e3", timestamp: "2026-03-11T02:43:27.931Z", data: { toolCallId: "call_1", toolName: "view", arguments: { path: "a.ts" } } },
      { type: "tool.execution_start", id: "e4", timestamp: "2026-03-11T02:43:28.000Z", data: { toolCallId: "call_sub", toolName: "grep", arguments: {}, parentToolCallId: "call_task" } },
      { type: "tool.execution_complete", id: "e5", timestamp: "2026-03-11T02:43:28.938Z", data: { toolCallId: "call_1", success: true, result: { content: "body", detailedContent: "long body" } } },
      { type: "tool.execution_complete", id: "e6", timestamp: "2026-03-11T02:43:29.000Z", data: { toolCallId: "call_2", success: false, error: { message: "denied" } } },
      { type: "assistant.message", id: "e7", timestamp: "2026-03-11T02:43:30.000Z", data: { messageId: "m2", content: "Done.", toolRequests: [] } },
    ];
    const page = await load("copilot", tempFile("events.jsonl", rows));
    expect(shape(page.events)).toEqual([
      "user_message:Unify the model picker",
      "reasoning:Plan",
      "text:Reading.",
      "tool_call:view#call_1",
      "tool_result:completed#call_1",
      "tool_result:failed#call_2",
      "text:Done.",
    ]);
    expect(toolResult(page.events, "call_1")).toBe("body");
  });

  it("merges streamed Kimi wire parts into whole events", async () => {
    const rows = [
      { timestamp: 1_757_000_000, message: { type: "TurnBegin", payload: { user_input: "Explain main.ts" } } },
      { timestamp: 1_757_000_001, message: { type: "StepBegin", payload: { n: 1 } } },
      { timestamp: 1_757_000_001, message: { type: "ContentPart", payload: { type: "think", think: "Let me " } } },
      { timestamp: 1_757_000_001, message: { type: "ContentPart", payload: { type: "think", think: "read it" } } },
      { timestamp: 1_757_000_002, message: { type: "ContentPart", payload: { type: "text", text: "Reading " } } },
      { timestamp: 1_757_000_002, message: { type: "ContentPart", payload: { type: "text", text: "now." } } },
      { timestamp: 1_757_000_003, message: { type: "ToolCall", payload: { type: "function", id: "tc-1", function: { name: "ReadFile", arguments: "{\"path\":" } } } },
      { timestamp: 1_757_000_003, message: { type: "ToolCallPart", payload: { arguments_part: "\"main.ts\"}" } } },
      { timestamp: 1_757_000_004, message: { type: "ToolResult", payload: { tool_call_id: "tc-1", return_value: { is_error: false, output: "code" } } } },
    ];
    const page = await load("kimi", tempFile("wire.jsonl", rows));
    expect(shape(page.events)).toEqual([
      "user_message:Explain main.ts",
      "reasoning:Let me read it",
      "text:Reading now.",
      "tool_call:ReadFile#tc-1",
      "tool_result:completed#tc-1",
    ]);
    expect(toolArgs(page.events, "tc-1")).toEqual({ path: "main.ts" });
  });

  it("converts persisted Kimi messages, filters origins, and drops duplicate turn begins", async () => {
    const rows = [
      { type: "turn_begin", time: 1_757_000_000, userInput: "Add a README" },
      { type: "context.append_message", time: 1_757_000_001, message: { role: "user", content: [{ type: "text", text: "Add a README" }], origin: { kind: "user" } } },
      {
        type: "context.append_message",
        time: 1_757_000_002,
        message: {
          role: "assistant",
          content: [{ type: "think", think: "Inspect the project." }, { type: "text", text: "Reading the files." }],
          tool_calls: [{ id: "call-1", function: { name: "ReadFile", arguments: "{\"path\":\"README.md\"}" } }],
        },
      },
      { type: "context.append_message", time: 1_757_000_003, message: { role: "tool", name: "ReadFile", tool_call_id: "call-1", content: [{ type: "text", text: "README contents" }] } },
      { type: "context.append_message", time: 1_757_000_004, message: { role: "assistant", content: [{ type: "text", text: "README added." }] } },
      { type: "context.append_message", time: 1_757_000_005, message: { role: "user", content: [{ type: "text", text: "cron tick" }], origin: { kind: "cron_job" } } },
    ];
    const page = await load("kimi", tempFile("wire.jsonl", rows));
    expect(shape(page.events)).toEqual([
      "user_message:Add a README",
      "reasoning:Inspect the project.",
      "text:Reading the files.",
      "tool_call:ReadFile#call-1",
      "tool_result:completed#call-1",
      "text:README added.",
    ]);
    expect(page.events[0]!.timestamp).toBe(new Date(1_757_000_001 * 1000).toISOString());
    expect(toolArgs(page.events, "call-1")).toEqual({ path: "README.md" });

    const fallback = await load("kimi", tempFile("turn.jsonl", [
      { type: "turn_begin", time: 1_757_000_000, userInput: "A turn without append_message" },
    ]));
    expect(shape(fallback.events)).toEqual(["user_message:A turn without append_message"]);
  });

  it("maps an OpenCode export's text, reasoning and tool parts", () => {
    const exported = {
      info: { id: "ses_1" },
      messages: [
        { info: { id: "msg_u", role: "user", time: { created: 1_790_044_896_151 } }, parts: [{ type: "text", text: "Remove the banner" }, { type: "text", text: "ctx", synthetic: true }] },
        {
          info: { id: "msg_a", role: "assistant", time: { created: 1_790_044_900_000 } },
          parts: [
            { type: "step-start", id: "s1" },
            { type: "reasoning", id: "r1", text: "Find the view", time: { start: 1_790_044_900_366 } },
            { type: "text", id: "t1", text: "Searching.", time: { start: 1_790_044_900_524 } },
            { type: "tool", id: "tp1", callID: "call_1", tool: "bash", state: { status: "completed", input: { command: "rg banner" }, output: "Work.swift" } },
            { type: "tool", id: "tp2", callID: "call_2", tool: "question", state: { status: "error", input: {}, error: "dismissed" } },
            { type: "patch", id: "pa", files: ["a"] },
            { type: "step-finish", id: "s2" },
          ],
        },
      ],
    };
    const events = openCodeExportToEvents(exported, { sessionId: "p", provider: "opencode", externalSessionId: "ses_1" }, 0);
    expect(shape(events ?? [])).toEqual([
      "user_message:Remove the banner",
      "reasoning:Find the view",
      "text:Searching.",
      "tool_call:bash#call_1",
      "tool_result:completed#call_1",
      "tool_call:question#call_2",
      "tool_result:failed#call_2",
    ]);
    expect(toolResult(events ?? [], "call_2")).toBe("dismissed");
    expect(openCodeExportToEvents({ nope: true }, { sessionId: "p", provider: "opencode", externalSessionId: "x" }, 0)).toBeNull();
  });

  it("falls back to the sampled messages when the store yields nothing", async () => {
    const sampled = { messages: [{ role: "user" as const, text: "only sample", at: 5 }] };
    const preview = await load("claude", tempFile("empty.jsonl", [{ type: "summary" }]), { record: sampled });
    expect(shape(preview.events)).toEqual(["user_message:only sample"]);
    const imported = await load("qwen", null, { purpose: "import", record: sampled });
    expect(shape(imported.events)).toEqual([
      "notice:Session imported from qwen CLI (sess-1)",
      "user_message:only sample",
    ]);
  });
});

describe("loadExternalSessionEvents — Cursor store.db", () => {
  /** A 32-byte blob reference in protobuf field `field` (wire type 2). */
  function blobRef(field: number, id: string): Buffer {
    return Buffer.concat([Buffer.from([(field << 3) | 2, 32]), Buffer.from(id, "hex")]);
  }

  /**
   * A store laid out as Cursor writes it: content-addressed blobs inserted
   * newest first (row order is not conversation order), a protobuf root that
   * lists the messages, and `meta['0']` as hex JSON naming the root.
   */
  function writeCursorStore(
    messages: unknown[],
    summary?: { replaced: unknown[]; summaryMessage: unknown },
  ): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-store-events-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "store.db");
    const db = new DatabaseSync(storePath);
    db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
    const insert = db.prepare("INSERT OR IGNORE INTO blobs (id, data) VALUES (?, ?)");
    const put = (data: Buffer): string => {
      const id = createHash("sha256").update(data).digest("hex");
      insert.run(id, data);
      return id;
    };
    const messageIds = [...messages].reverse().map((message) => put(Buffer.from(JSON.stringify(message)))).reverse();
    const rootParts = messageIds.map((id) => blobRef(1, id));
    if (summary) {
      const replacedIds = summary.replaced.map((message) => put(Buffer.from(JSON.stringify(message))));
      const summaryMessageId = put(Buffer.from(JSON.stringify(summary.summaryMessage)));
      const summaryBlob = put(Buffer.concat([
        ...replacedIds.map((id) => blobRef(1, id)),
        Buffer.from([0x12, 5]), Buffer.from("notes"),
        blobRef(4, summaryMessageId),
      ]));
      // The summary message follows the root's context messages.
      rootParts.splice(1, 0, blobRef(1, summaryMessageId));
      rootParts.push(blobRef(13, summaryBlob));
    }
    rootParts.push(Buffer.from([0x50, 0x01]));
    const rootId = put(Buffer.concat(rootParts));
    const meta = { agentId: "sess-1", latestRootBlobId: rootId, name: "New Agent", createdAt: 1 };
    db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(Buffer.from(JSON.stringify(meta)).toString("hex"));
    db.close();
    return storePath;
  }

  const conversation = [
    { role: "system", content: "You are an AI coding assistant." },
    { role: "user", content: "<user_info>\nOS Version: darwin\n</user_info>\n\n<git_status>\nGit repo: /Users/dev/project\n</git_status>" },
    { role: "user", content: [{ type: "text", text: "<system_reminder>\nAsk mode is active.\n</system_reminder>" }, { type: "text", text: "<user_query>\nWhy does the build fail?\n</user_query>" }] },
    {
      role: "assistant",
      id: "1",
      content: [
        { type: "redacted-reasoning", data: "opaque" },
        { type: "reasoning", text: "Check the log." },
        { type: "text", text: "Reading the log." },
        { type: "tool-call", toolCallId: "call_A\nfc_1", toolName: "Shell", args: { command: "npm run build" } },
      ],
    },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call_A\nfc_1", toolName: "Shell", result: "Exit code: 1" }] },
    { role: "assistant", id: "2", content: [{ type: "text", text: "A type error." }] },
    { role: "user", content: [{ type: "text", text: "<user_query>\ncontinue\n</user_query>" }] },
    { role: "assistant", id: "3", content: [{ type: "text", text: "Fixed." }] },
    // Byte-identical to the earlier one: the same blob, listed twice.
    { role: "user", content: [{ type: "text", text: "<user_query>\ncontinue\n</user_query>" }] },
  ];

  const expected = [
    "user_message:Why does the build fail?",
    "reasoning:Check the log.",
    "text:Reading the log.",
    "tool_call:Shell#call_A|fc_1",
    "tool_result:completed#call_A|fc_1",
    "text:A type error.",
    "user_message:continue",
    "text:Fixed.",
    "user_message:continue",
  ];

  it("previews a store-only chat in conversation order", async () => {
    // 2026-09-24: 11 of 27 Cursor rows had only store.db and previewed empty.
    const page = await load("cursor", writeCursorStore(conversation));
    expect(shape(page.events)).toEqual(expected);
    expect(toolArgs(page.events, "call_A|fc_1")).toEqual({ command: "npm run build" });
    expect(toolResult(page.events, "call_A|fc_1")).toBe("Exit code: 1");
    expect(page).toMatchObject({ hasOlder: false, olderCursor: null, truncated: false });
  });

  it("gives the replay copy the whole conversation", async () => {
    const page = await load("cursor", writeCursorStore(conversation), { purpose: "import" });
    const content = page.events.filter(({ event }) => event.type !== "system_notice");
    expect(shape(content)).toEqual(expected);
    expect(page.events.every(({ sessionId }) => sessionId === "external-preview:cursor:sess-1")).toBe(true);
  });

  it("pages back through the store to the first message", async () => {
    const storePath = writeCursorStore(conversation);
    const pages: string[][] = [];
    let before: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const page = await load("cursor", storePath, { maxEvents: 2, before });
      pages.unshift(shape(page.events));
      expect(page.events.length).toBeLessThanOrEqual(2);
      if (!page.hasOlder) break;
      before = page.olderCursor;
    }
    expect(pages.flat()).toEqual(expected);
  });

  it("restores the turns a summarization replaced", async () => {
    const storePath = writeCursorStore(
      [
        { role: "system", content: "You are an AI coding assistant." },
        { role: "user", content: [{ type: "text", text: "<user_query>\nnow ship it\n</user_query>" }] },
        { role: "assistant", content: [{ type: "text", text: "Shipped." }] },
      ],
      {
        replaced: [
          { role: "user", content: [{ type: "text", text: "<user_query>\nfix the banner\n</user_query>" }] },
          { role: "assistant", content: [{ type: "text", text: "Fixed the banner." }] },
        ],
        summaryMessage: { role: "user", content: "Your conversation was summarized due to context constraints." },
      },
    );
    const page = await load("cursor", storePath);
    expect(shape(page.events)).toEqual([
      "user_message:fix the banner",
      "text:Fixed the banner.",
      "context_compact",
      "user_message:now ship it",
      "text:Shipped.",
    ]);
  });

  it("does not let a skipped oversized blob spend the page's byte budget", () => {
    const storePath = writeCursorStore([
      { role: "user", content: [{ type: "text", text: "<user_query>\ndump the log\n</user_query>" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "Shell", result: "x".repeat(CURSOR_STORE_MAX_MESSAGE_BYTES) }] },
      { role: "assistant", content: [{ type: "text", text: "Too long to show." }] },
    ]);
    const page = loadCursorStorePage({
      storePath,
      options: {
        sessionId: "external-preview:cursor:sess-1",
        provider: "cursor",
        externalSessionId: "sess-1",
        importedAt: 1,
        laneId: null,
        maxEvents: 50,
      },
      cursor: null,
      maxEvents: 50,
      maxBytes: 4096,
      fallbackBaseMs: 0,
    });
    expect(shape([...(page?.earlier ?? []), ...(page?.page ?? [])])).toEqual([
      "user_message:dump the log",
      "text:Too long to show.",
    ]);
    expect(page?.bytesTruncated).toBe(false);
  });

  it("falls back to sampled text when the store has no readable conversation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-store-events-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "store.db");
    const db = new DatabaseSync(storePath);
    db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
    db.close();
    const page = await load("cursor", storePath, {
      record: { messages: [{ role: "user", text: "hi", at: 1 }] },
    });
    expect(shape(page.events)).toEqual(["user_message:hi"]);
  });
});

describe("paging", () => {
  function claudeTurns(count: number, pad = 0): unknown[] {
    return Array.from({ length: count }, (_, index) => ({
      type: index % 2 === 0 ? "user" : "assistant",
      uuid: `row-${index}`,
      timestamp: new Date(Date.parse("2026-09-01T00:00:00.000Z") + index * 1000).toISOString(),
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `turn ${index}${pad ? ` ${"x".repeat(pad)}` : ""}` }],
      },
    }));
  }

  function turnNumbers(events: AgentChatEventEnvelope[]): number[] {
    return events.map(({ event }) => Number(/turn (\d+)/u.exec((event as { text: string }).text)?.[1]));
  }

  it("pages newest first by event index, and appends never shift an older page", async () => {
    const filePath = tempFile("paged.jsonl", claudeTurns(450));
    const first = await load("claude", filePath);
    expect(turnNumbers(first.events)).toEqual(Array.from({ length: 200 }, (_, i) => 250 + i));
    expect(first.hasOlder).toBe(true);
    expect(first.truncated).toBe(true);

    fs.appendFileSync(filePath, `${JSON.stringify(claudeTurns(451)[450])}\n`);
    const second = await load("claude", filePath, { before: first.olderCursor });
    expect(turnNumbers(second.events)).toEqual(Array.from({ length: 200 }, (_, i) => 50 + i));
    const third = await load("claude", filePath, { before: second.olderCursor });
    expect(turnNumbers(third.events)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(third).toMatchObject({ hasOlder: false, olderCursor: null });

    const refreshed = await load("claude", filePath);
    expect(turnNumbers(refreshed.events).at(-1)).toBe(450);
  });

  it("steps back across byte windows when the file is past the window cap", async () => {
    // 40 rows of ~0.5 MB: more than the 16 MB preview window.
    const filePath = tempFile("big.jsonl", claudeTurns(40, 512 * 1024));
    const seen: number[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const page = await load("claude", filePath, { before });
      seen.unshift(...turnNumbers(page.events));
      before = page.olderCursor;
      pages += 1;
      expect(page.hasOlder).toBe(before !== null);
    } while (before && pages < 10);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it("ignores a malformed cursor", async () => {
    const filePath = tempFile("paged.jsonl", claudeTurns(3));
    expect(decodeEventsCursor("not-a-cursor")).toBeNull();
    const page = await load("claude", filePath, { before: "not-a-cursor" });
    expect(turnNumbers(page.events)).toEqual([0, 1, 2]);
  });

  it("reads whole lines only at window edges", async () => {
    const rows = [{ n: 1 }, { n: 2 }, { n: 3 }];
    const filePath = tempFile("lines.jsonl", rows);
    const size = fs.statSync(filePath).size;
    const lineLength = Buffer.byteLength(`${JSON.stringify({ n: 3 })}\n`);

    // A window that starts exactly on a line keeps that line.
    const exact = await readJsonlWindow(filePath, { maxBytes: lineLength });
    expect(exact?.records).toEqual([{ n: 3 }]);
    expect(exact?.start).toBe(size - lineLength);

    // One byte short drops the cut line.
    const cut = await readJsonlWindow(filePath, { maxBytes: lineLength * 2 - 1 });
    expect(cut?.records).toEqual([{ n: 3 }]);

    // A trailing line still being written is left out.
    fs.appendFileSync(filePath, "{\"n\":");
    const partial = await readJsonlWindow(filePath, { maxBytes: 1024 });
    expect(partial?.records).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(partial?.end).toBe(size);
  });
});

describe("dedentUserText", () => {
  it("removes an indent every line shares so a prompt is not read as code", () => {
    expect(dedentUserText("    first line\n      nested\n\n    last")).toBe("first line\n  nested\n\nlast");
    expect(dedentUserText("no indent\n    code-ish")).toBe("no indent\n    code-ish");
  });
});
