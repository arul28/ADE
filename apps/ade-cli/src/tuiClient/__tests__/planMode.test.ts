import { describe, expect, it } from "vitest";
import { paletteCommands, parseCommand } from "../commands";
import { hasFirstUserMessage, isPlanMode } from "../planMode";
import type { AdeCodeModelState } from "../types";

function baseModelState(overrides: Partial<AdeCodeModelState>): AdeCodeModelState {
  return {
    provider: "codex",
    model: "gpt-5.5",
    modelId: null,
    displayName: "GPT-5.5",
    reasoningEffort: "medium",
    codexFastMode: false,
    permissionMode: "default",
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    opencodePermissionMode: "edit",
    droidPermissionMode: "auto-low",
    cursorModeId: "agent",
    cursorConfigValues: {},
    ...overrides,
  };
}

describe("parseCommand /model", () => {
  it("returns right placement with no args", () => {
    const parsed = parseCommand("/model");
    expect(parsed?.spec?.name).toBe("/model");
    expect(parsed?.spec?.placement).toBe("right");
    expect(parsed?.args).toBe("");
  });

  it("wins over a user/SDK /model command", () => {
    const parsed = parseCommand("/model", [
      { name: "/model", description: "Select or change the AI model.", source: "sdk", argumentHint: "[model]" },
    ]);
    expect(parsed?.spec?.name).toBe("/model");
    expect(parsed?.spec?.placement).toBe("right");
    expect(parsed?.userCommand).toBeNull();
  });
});

describe("paletteCommands SDK overrides", () => {
  it("/model dedupes user/SDK /model out of the palette", () => {
    const results = paletteCommands("/model", [
      { name: "/model", description: "Select or change the AI model.", source: "sdk", argumentHint: "[model]" },
    ]);
    const modelEntries = results.filter((entry) => entry.name === "/model");
    expect(modelEntries).toHaveLength(1);
    expect(modelEntries[0]?.source).toBe("ade");
  });
});

describe("paletteCommands placement", () => {
  it("includes /model with right placement when filtering by /m", () => {
    const results = paletteCommands("/m");
    const model = results.find((entry) => entry.name === "/model");
    expect(model).toBeDefined();
    expect(model?.placement).toBe("right");
  });
});

describe("isPlanMode", () => {
  it("returns true for Claude with claudePermissionMode plan", () => {
    expect(isPlanMode(baseModelState({ provider: "claude", claudePermissionMode: "plan" }))).toBe(true);
  });

  it("returns false for Claude with claudePermissionMode default", () => {
    expect(isPlanMode(baseModelState({ provider: "claude", claudePermissionMode: "default" }))).toBe(false);
  });

  it("returns true for Codex on-request + read-only", () => {
    expect(isPlanMode(baseModelState({
      provider: "codex",
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
    }))).toBe(true);
  });

  it("returns false for Codex on-request + workspace-write", () => {
    expect(isPlanMode(baseModelState({
      provider: "codex",
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
    }))).toBe(false);
  });

  it("returns true for OpenCode with opencodePermissionMode plan", () => {
    expect(isPlanMode(baseModelState({ provider: "opencode", opencodePermissionMode: "plan" }))).toBe(true);
  });

  it("returns true for Cursor cursorModeId plan", () => {
    expect(isPlanMode(baseModelState({ provider: "cursor", cursorModeId: "plan" }))).toBe(true);
  });

  it("returns true for Droid read-only", () => {
    expect(isPlanMode(baseModelState({ provider: "droid", droidPermissionMode: "read-only" }))).toBe(true);
  });

  it("returns false for Droid auto-medium", () => {
    expect(isPlanMode(baseModelState({ provider: "droid", droidPermissionMode: "auto-medium" }))).toBe(false);
  });
});

describe("hasFirstUserMessage", () => {
  it("is false when there are no events", () => {
    expect(hasFirstUserMessage([])).toBe(false);
  });

  it("is false when no envelope carries a user_message", () => {
    expect(hasFirstUserMessage([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "hi" },
      },
    ])).toBe(false);
  });

  it("is true once a user_message event appears", () => {
    expect(hasFirstUserMessage([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "hi" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: { type: "user_message", text: "hello" },
      },
    ])).toBe(true);
  });
});
