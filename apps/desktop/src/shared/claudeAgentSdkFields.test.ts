import { describe, expect, it } from "vitest";
import {
  isClaudeHousekeepingTask,
  parseClaudeResourceLinks,
  parseClaudeToolCallNotification,
  readClaudeSpawnDepth,
  resourceLinkCopyPaths,
} from "./claudeAgentSdkFields";

describe("claude Agent SDK field readers", () => {
  it("treats ambient the same as skip_transcript", () => {
    expect(isClaudeHousekeepingTask({ skip_transcript: true })).toBe(true);
    expect(isClaudeHousekeepingTask({ ambient: true })).toBe(true);
    expect(isClaudeHousekeepingTask({ skip_transcript: false, ambient: false })).toBe(false);
    expect(isClaudeHousekeepingTask({ task_id: "task-1" })).toBe(false);
  });

  it("reads spawn_depth when it is a non-negative integer", () => {
    expect(readClaudeSpawnDepth({ spawn_depth: 2 })).toBe(2);
    expect(readClaudeSpawnDepth({ spawnDepth: 0 })).toBe(0);
    expect(readClaudeSpawnDepth({ spawn_depth: 1, spawnDepth: 9 })).toBe(1);
    expect(readClaudeSpawnDepth({ spawn_depth: -1 })).toBeUndefined();
    expect(readClaudeSpawnDepth({})).toBeUndefined();
  });

  it("parses resource_links from the notification or the nested tool result", () => {
    expect(parseClaudeResourceLinks({
      resource_links: [
        { uri: "file:///tmp/a.ts", name: "a.ts" },
        { path: "apps/desktop/src/foo.ts" },
      ],
    })).toEqual([
      { uri: "file:///tmp/a.ts", name: "a.ts" },
      { path: "apps/desktop/src/foo.ts" },
    ]);
    expect(parseClaudeResourceLinks({
      tool_use_result: { resourceLinks: ["src/cli.ts"] },
    })).toEqual([{ path: "src/cli.ts", uri: "src/cli.ts" }]);
    expect(resourceLinkCopyPaths([
      { uri: "file:///tmp/a.ts" },
      { path: "apps/desktop/src/foo.ts" },
      { uri: "file:///tmp/a.ts" },
    ])).toEqual(["/tmp/a.ts", "apps/desktop/src/foo.ts"]);
    expect(resourceLinkCopyPaths([
      { uri: "file:///C:/Users/ade/src/foo.ts" },
    ])).toEqual(["C:/Users/ade/src/foo.ts"]);
    expect(resourceLinkCopyPaths([
      { name: "README" },
      { path: "apps/desktop/src/foo.ts" },
    ])).toEqual(["apps/desktop/src/foo.ts"]);
  });

  const notification = (taskType: string, status: string, result: string) => [
    "<task-notification>",
    "<tool-use-id>toolu_1</tool-use-id>",
    `<task-type>${taskType}</task-type>`,
    `<status>${status}</status>`,
    "<summary>The WebFetch call finished; its result follows.</summary>",
    `<result>\n${result}\n</result>`,
    "</task-notification>",
  ].join("\n");

  it.each([
    {
      name: "a fetched page that quotes the closing tag keeps its whole body",
      content: notification("tool_call", "completed", "page says </result> mid-text"),
      expected: { toolUseId: "toolu_1", status: "completed", result: "page says </result> mid-text" },
    },
    {
      name: "text blocks are read like a string",
      content: [{ type: "text", text: notification("tool_call", "failed", "HTTP 503") }],
      expected: { toolUseId: "toolu_1", status: "failed", result: "HTTP 503" },
    },
    {
      name: "a stopped call reads as interrupted",
      content: notification("tool_call", "stopped", ""),
      expected: { toolUseId: "toolu_1", status: "interrupted", result: "" },
    },
    { name: "a shell task's notification is not a tool call's", content: notification("local_bash", "completed", "ok"), expected: null },
    { name: "a plain prompt is not a notification", content: "<tool-use-id>toolu_1</tool-use-id>", expected: null },
  ])("reads a detached tool call's <task-notification>: $name", ({ content, expected }) => {
    expect(parseClaudeToolCallNotification(content)).toEqual(expected);
  });
});
