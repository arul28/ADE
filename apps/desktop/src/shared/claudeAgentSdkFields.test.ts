import { describe, expect, it } from "vitest";
import {
  isClaudeHousekeepingTask,
  parseClaudeResourceLinks,
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
  });
});
