import { describe, expect, it } from "vitest";
import { stripParentClaudeSessionEnv } from "./parentAgentEnv";

describe("stripParentClaudeSessionEnv", () => {
  it("removes parent Claude session markers and keeps user settings", () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "4",
      PATH: "/usr/bin",
    };
    expect(stripParentClaudeSessionEnv(env).sort()).toEqual(["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT"]);
    expect(env).toEqual({ CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "4", PATH: "/usr/bin" });
  });
});
