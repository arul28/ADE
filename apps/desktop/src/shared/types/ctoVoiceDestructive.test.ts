import { describe, expect, it } from "vitest";

import { isDestructiveVoiceCommand, isDestructiveVoiceTool } from "./ctoVoiceDestructive";

describe("ctoVoiceDestructive", () => {
  it("treats any git push as tap-only, not just the force variants", () => {
    expect(isDestructiveVoiceCommand("Run command: git push origin main")).toBe(true);
    expect(isDestructiveVoiceCommand("git push")).toBe(true);
    expect(isDestructiveVoiceCommand("git push --force origin main")).toBe(true);
    expect(isDestructiveVoiceCommand("git push --force-with-lease")).toBe(true);
    // The equivalent ADE operation has always been tap-only; the shell form
    // must agree with it.
    expect(isDestructiveVoiceTool("gitPush")).toBe(true);
  });

  it("leaves read-only git commands speakable", () => {
    expect(isDestructiveVoiceCommand("git pull")).toBe(false);
    expect(isDestructiveVoiceCommand("git fetch --all")).toBe(false);
    expect(isDestructiveVoiceCommand("git status")).toBe(false);
    // Word-boundary anchored: a different command that merely starts the same.
    expect(isDestructiveVoiceCommand("git pushd")).toBe(false);
  });
});
