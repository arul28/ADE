import { describe, expect, it } from "vitest";
import {
  codexUserShellChipRange,
  isCodexMemoryResetDraft,
  parseCodexMemorySlashCommand,
  parseCodexShellSlashCommand,
  parseCodexUserShellDraft,
  shouldCoalesceCodexCheckIn,
} from "./codexComposerCommands";

describe("parseCodexUserShellDraft", () => {
  it("parses a leading bang command", () => {
    expect(parseCodexUserShellDraft("!git status --short")).toEqual({
      command: "git status --short",
    });
  });

  it("ignores a bang with no command", () => {
    expect(parseCodexUserShellDraft("!")).toBeNull();
    expect(parseCodexUserShellDraft("hello")).toBeNull();
  });
});

describe("parseCodexShellSlashCommand", () => {
  it("parses /shell with a command", () => {
    expect(parseCodexShellSlashCommand("/shell git status --short")).toEqual({
      command: "git status --short",
    });
  });

  it("rejects /shell with no command", () => {
    expect(parseCodexShellSlashCommand("/shell")).toBeNull();
  });
});

describe("parseCodexMemorySlashCommand", () => {
  it("parses on/off/status", () => {
    expect(parseCodexMemorySlashCommand("/memory")).toEqual({ kind: "status" });
    expect(parseCodexMemorySlashCommand("/memory on")).toEqual({ kind: "set", enabled: true });
    expect(parseCodexMemorySlashCommand("/memory off")).toEqual({ kind: "set", enabled: false });
  });

  it("parses reset without confirming", () => {
    expect(parseCodexMemorySlashCommand("/memory-reset")).toEqual({ kind: "reset", confirm: false });
    expect(isCodexMemoryResetDraft("/memory-reset")).toBe(true);
    expect(parseCodexMemorySlashCommand("/memory-reset confirm")).toEqual({ kind: "reset", confirm: true });
  });
});

describe("shouldCoalesceCodexCheckIn", () => {
  it("coalesces identical text inside the window", () => {
    expect(shouldCoalesceCodexCheckIn({
      previousText: "are u still alive",
      previousAtMs: 1_000,
      nextText: "are u still alive",
      nowMs: 5_000,
    })).toBe(true);
  });

  it("does not coalesce different text or an expired window", () => {
    expect(shouldCoalesceCodexCheckIn({
      previousText: "are u still alive",
      previousAtMs: 1_000,
      nextText: "keep going",
      nowMs: 5_000,
    })).toBe(false);
    expect(shouldCoalesceCodexCheckIn({
      previousText: "are u still alive",
      previousAtMs: 1_000,
      nextText: "are u still alive",
      nowMs: 20_000,
    })).toBe(false);
  });
});

describe("codexUserShellChipRange", () => {
  it("covers the leading bang", () => {
    expect(codexUserShellChipRange("!git status")).toEqual({ start: 0, end: 1 });
    expect(codexUserShellChipRange("  !ls")).toEqual({ start: 2, end: 3 });
  });
});
