import { describe, expect, it } from "vitest";
import {
  defaultResumeCommandForTool,
  extractResumeCommandFromOutput,
  runtimeStateFromOsc133Chunk
} from "./terminalSessionSignals";

describe("terminalSessionSignals", () => {
  it("extracts concrete resume command from backticks", () => {
    const chunk = "Resume with `claude resume 01HF4F5J1A3R8NBV3K` whenever needed.";
    expect(extractResumeCommandFromOutput(chunk, "claude")).toBe("claude resume 01HF4F5J1A3R8NBV3K");
  });

  it("extracts plain resume command lines", () => {
    const chunk = "codex resume session_abc123 --last";
    expect(extractResumeCommandFromOutput(chunk, "codex")).toBe("codex resume session_abc123 --last");
  });

  it("respects preferred tool when both tools appear", () => {
    const chunk = [
      "claude resume abc",
      "codex resume def"
    ].join("\n");
    expect(extractResumeCommandFromOutput(chunk, "codex")).toBe("codex resume def");
  });

  it("maps OSC 133 prompt markers to waiting-input", () => {
    const marker = "\u001b]133;A\u0007";
    expect(runtimeStateFromOsc133Chunk(marker, "running")).toBe("waiting-input");
  });

  it("maps OSC 133 command markers to running", () => {
    const marker = "\u001b]133;B\u001b\\";
    expect(runtimeStateFromOsc133Chunk(marker, "waiting-input")).toBe("running");
  });

  it("returns default resume command for known tools", () => {
    expect(defaultResumeCommandForTool("claude")).toBe("claude resume");
    expect(defaultResumeCommandForTool("codex")).toBe("codex resume");
    expect(defaultResumeCommandForTool("shell")).toBeNull();
  });
});
