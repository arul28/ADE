import { describe, expect, it } from "vitest";
import { classifyClaudeStartupFailure } from "./packagedRuntimeSmokeShared";

describe("packagedRuntimeSmoke", () => {
  it("classifies a missing bundled Claude binary distinctly", () => {
    expect(
      classifyClaudeStartupFailure(
        "Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional.",
      ),
    ).toEqual({
      state: "binary-missing",
      message:
        "Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional.",
    });
  });

  it("keeps non-binary startup failures fatal", () => {
    expect(
      classifyClaudeStartupFailure(
        "Claude startup probe returned an error result.",
      ),
    ).toEqual({
      state: "runtime-failed",
      message: "Claude startup probe returned an error result.",
    });
  });

  it("still classifies auth failures distinctly", () => {
    expect(
      classifyClaudeStartupFailure("API Error: 401 invalid authentication credentials"),
    ).toEqual({
      state: "auth-failed",
      message: "API Error: 401 invalid authentication credentials",
    });
  });
});
