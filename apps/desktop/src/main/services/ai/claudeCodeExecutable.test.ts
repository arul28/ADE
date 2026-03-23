import { describe, expect, it } from "vitest";
import { resolveClaudeCodeExecutable } from "./claudeCodeExecutable";

describe("resolveClaudeCodeExecutable", () => {
  it("prefers the explicit env override", () => {
    expect(
      resolveClaudeCodeExecutable({
        env: {
          CLAUDE_CODE_EXECUTABLE_PATH: "/custom/bin/claude",
          PATH: "/usr/bin:/bin",
        },
      }),
    ).toEqual({
      path: "/custom/bin/claude",
      source: "env",
    });
  });

  it("uses the detected Claude auth path before falling back to PATH lookup", () => {
    expect(
      resolveClaudeCodeExecutable({
        auth: [
          {
            type: "cli-subscription",
            cli: "claude",
            path: "/opt/homebrew/bin/claude",
            authenticated: true,
            verified: true,
          },
        ],
        env: {
          PATH: "/usr/bin:/bin",
        },
      }),
    ).toEqual({
      path: "/opt/homebrew/bin/claude",
      source: "auth",
    });
  });
});
