import { describe, expect, it } from "vitest";
import {
  isAdeProviderHomePath,
  stripInheritedProviderHomeEnv,
  stripParentClaudeSessionEnv,
} from "./parentAgentEnv";

describe("stripParentClaudeSessionEnv", () => {
  it("removes parent Claude session markers and keeps user settings", () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "4",
      ADE_HOME: "/Users/me/.ade-alpha",
      CLAUDE_CONFIG_DIR: "/Users/me/.ade-alpha/provider-homes/claude/work",
      CODEX_HOME: "/Users/me/.codex-work",
      PATH: "/usr/bin",
    };
    expect(stripParentClaudeSessionEnv(env).sort()).toEqual(["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT"]);
    expect(stripInheritedProviderHomeEnv(env)).toEqual(["CLAUDE_CONFIG_DIR"]);
    expect(env).toEqual({
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "4",
      ADE_HOME: "/Users/me/.ade-alpha",
      CODEX_HOME: "/Users/me/.codex-work",
      PATH: "/usr/bin",
    });

    expect(isAdeProviderHomePath(
      "C:\\Users\\Me\\.ade\\provider-homes\\claude\\work",
      "c:\\users\\me\\.ade",
      "win32",
    )).toBe(true);
    expect(isAdeProviderHomePath(
      "C:\\Users\\Me\\.ade\\other\\work",
      "c:\\users\\me\\.ade",
      "win32",
    )).toBe(false);
  });
});
