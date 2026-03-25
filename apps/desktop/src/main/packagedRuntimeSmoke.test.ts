import { describe, expect, it } from "vitest";
import { classifyClaudeStartupFailure } from "./packagedRuntimeSmokeShared";

describe("packagedRuntimeSmoke", () => {
  it("treats a missing native Claude binary as non-fatal for fallback command resolution", () => {
    expect(
      classifyClaudeStartupFailure(
        "Claude Code native binary not found at claude. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.",
        "fallback-command",
      ),
    ).toEqual({
      state: "binary-missing",
      message:
        "Claude Code native binary not found at claude. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.",
    });
  });

  it("keeps explicit Claude path failures fatal", () => {
    expect(
      classifyClaudeStartupFailure(
        "Claude Code native binary not found at /custom/bin/claude. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.",
        "env",
      ),
    ).toEqual({
      state: "runtime-failed",
      message:
        "Claude Code native binary not found at /custom/bin/claude. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.",
    });
  });

  it("still classifies auth failures distinctly", () => {
    expect(
      classifyClaudeStartupFailure("API Error: 401 invalid authentication credentials", "fallback-command"),
    ).toEqual({
      state: "auth-failed",
      message: "API Error: 401 invalid authentication credentials",
    });
  });
});
