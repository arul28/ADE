import { describe, expect, it } from "vitest";
import { buildSetupRows, cliProviderForModelStateProvider } from "../app";
import type { AdeCodeInterfaceMode, AdeCodeModelState } from "../types";

function baseModelState(overrides: Partial<AdeCodeModelState> = {}): AdeCodeModelState {
  return {
    provider: "codex",
    interfaceMode: "chat",
    model: "gpt-5.5",
    modelId: null,
    displayName: "GPT-5.5",
    reasoningEffort: "medium",
    fastMode: false,
    permissionMode: "default",
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    opencodePermissionMode: "edit",
    droidPermissionMode: "auto-low",
    cursorModeId: "agent",
    cursorAvailableModeIds: [],
    cursorConfigValues: {},
    ...overrides,
  };
}

function setupRows(interfaceMode: AdeCodeInterfaceMode, interfaceEditable: boolean) {
  return buildSetupRows({
    modelState: baseModelState({ interfaceMode }),
    models: [],
    includeRefresh: false,
    includeApply: true,
    interfaceMode,
    interfaceEditable,
  });
}

// Mirror of the toggle the setup-row handler applies (Chat ↔ CLI).
function toggleInterface(mode: AdeCodeInterfaceMode): AdeCodeInterfaceMode {
  return mode === "cli" ? "chat" : "cli";
}

describe("cliProviderForModelStateProvider", () => {
  it("maps each of the five CLI providers to itself", () => {
    for (const provider of ["claude", "codex", "cursor", "droid", "opencode"] as const) {
      expect(cliProviderForModelStateProvider(provider)).toBe(provider);
    }
  });

  it("returns null for providers with no tracked CLI (Ollama / LM Studio)", () => {
    expect(cliProviderForModelStateProvider("ollama")).toBeNull();
    expect(cliProviderForModelStateProvider("lmstudio")).toBeNull();
  });
});

describe("buildSetupRows interface row", () => {
  it("inserts the Interface row immediately after Provider", () => {
    const rows = setupRows("chat", true);
    const kinds = rows.map((row) => row.kind);
    expect(kinds[0]).toBe("provider");
    expect(kinds[1]).toBe("interface");
  });

  it("defaults to Chat and reflects the current interface value", () => {
    expect(setupRows("chat", true).find((row) => row.kind === "interface")?.value).toBe("Chat");
    expect(setupRows("cli", true).find((row) => row.kind === "interface")?.value).toBe("CLI");
  });

  it("is editable/cyclable for a draft and read-only once a session exists", () => {
    const draftRow = setupRows("chat", true).find((row) => row.kind === "interface")!;
    expect(draftRow.disabled).toBeFalsy();
    expect(draftRow.cyclable).toBe(true);
    expect(draftRow.detail).toBe("Chat · CLI");

    const committedRow = setupRows("cli", false).find((row) => row.kind === "interface")!;
    expect(committedRow.disabled).toBe(true);
    expect(committedRow.cyclable).toBe(false);
    expect(committedRow.detail).toBe("tracked CLI session");
  });

  it("toggles Chat ↔ CLI (two-value state machine)", () => {
    expect(toggleInterface("chat")).toBe("cli");
    expect(toggleInterface("cli")).toBe("chat");
  });
});
