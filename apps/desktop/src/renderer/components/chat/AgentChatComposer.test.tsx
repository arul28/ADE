/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { createDefaultComputerUsePolicy } from "../../../shared/types";
import { AgentChatComposer } from "./AgentChatComposer";

afterEach(cleanup);

function renderComposer(overrides: Partial<ComponentProps<typeof AgentChatComposer>> = {}) {
  const props: ComponentProps<typeof AgentChatComposer> = {
    modelId: "openai/gpt-5.4-codex",
    availableModelIds: ["openai/gpt-5.4-codex"],
    reasoningEffort: null,
    draft: "Need a steer message",
    attachments: [],
    pendingInput: null,
    turnActive: true,
    sendOnEnter: true,
    busy: false,
    sessionProvider: "codex",
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    unifiedPermissionMode: "edit",
    executionMode: "focused",
    computerUsePolicy: createDefaultComputerUsePolicy(),
    onModelChange: vi.fn(),
    onReasoningEffortChange: vi.fn(),
    onDraftChange: vi.fn(),
    onClearDraft: vi.fn(),
    onSubmit: vi.fn(),
    onInterrupt: vi.fn(),
    onApproval: vi.fn(),
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onSearchAttachments: vi.fn().mockResolvedValue([]),
    onExecutionModeChange: vi.fn(),
    onInteractionModeChange: vi.fn(),
    onClaudePermissionModeChange: vi.fn(),
    onCodexPresetChange: vi.fn(),
    onCodexApprovalPolicyChange: vi.fn(),
    onCodexSandboxChange: vi.fn(),
    onCodexConfigSourceChange: vi.fn(),
    onUnifiedPermissionModeChange: vi.fn(),
    onComputerUsePolicyChange: vi.fn(),
    ...overrides,
  };

  render(<AgentChatComposer {...props} />);
  return props;
}

const executionModeOptions = [
  {
    value: "focused",
    label: "Focused",
    summary: "Single stream",
    helper: "Keep work in one stream.",
    accent: "#38bdf8",
  },
  {
    value: "parallel",
    label: "Parallel",
    summary: "Split work",
    helper: "Use parallel branches for independent tasks.",
    accent: "#c084fc",
  },
] as NonNullable<ComponentProps<typeof AgentChatComposer>["executionModeOptions"]>;

describe("AgentChatComposer", () => {
  it("clear draft only triggers the draft-clear action during an active turn", () => {
    const props = renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(props.onClearDraft).toHaveBeenCalledTimes(1);
    expect(props.onInterrupt).not.toHaveBeenCalled();
  });

  it("stop only interrupts the active turn", () => {
    const props = renderComposer();

    const stopButtons = screen.getAllByTitle("Stop the active turn only (Cmd+.)");
    fireEvent.click(stopButtons[stopButtons.length - 1]!);

    expect(props.onInterrupt).toHaveBeenCalledTimes(1);
    expect(props.onClearDraft).not.toHaveBeenCalled();
  });

  it("renders Claude mode buttons without a Chat toggle", () => {
    renderComposer({
      sessionProvider: "claude",
      modelId: "anthropic/claude-sonnet-4-6",
      availableModelIds: ["anthropic/claude-sonnet-4-6"],
    });

    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
    expect(screen.getByRole("button", { name: "Default" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept edits" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bypass" })).toBeTruthy();
  });

  it("routes Claude plan through both interaction and permission callbacks", () => {
    const onInteractionModeChange = vi.fn();
    const onClaudePermissionModeChange = vi.fn();
    renderComposer({
      sessionProvider: "claude",
      modelId: "anthropic/claude-sonnet-4-6",
      availableModelIds: ["anthropic/claude-sonnet-4-6"],
      onInteractionModeChange,
      onClaudePermissionModeChange,
    });

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));

    expect(onInteractionModeChange).toHaveBeenCalledWith("plan");
    expect(onClaudePermissionModeChange).toHaveBeenCalledWith("plan");
  });

  it("prefers the combined Claude mode callback when present", () => {
    const onClaudeModeChange = vi.fn();
    const onInteractionModeChange = vi.fn();
    const onClaudePermissionModeChange = vi.fn();
    renderComposer({
      sessionProvider: "claude",
      modelId: "anthropic/claude-sonnet-4-6",
      availableModelIds: ["anthropic/claude-sonnet-4-6"],
      onClaudeModeChange,
      onInteractionModeChange,
      onClaudePermissionModeChange,
    });

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));

    expect(onClaudeModeChange).toHaveBeenCalledWith("plan");
    expect(onInteractionModeChange).not.toHaveBeenCalled();
    expect(onClaudePermissionModeChange).not.toHaveBeenCalled();
  });

  it("shows preset-first Codex controls without raw selects", () => {
    renderComposer({
      sessionProvider: "codex",
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    });

    expect(screen.getByRole("button", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Guarded edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Full auto" })).toBeTruthy();
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(screen.queryByDisplayValue("ADE flags")).toBeNull();
    expect(screen.queryByDisplayValue("On request")).toBeNull();
    expect(screen.queryByDisplayValue("Workspace write")).toBeNull();
  });

  it("maps Codex preset buttons to the underlying approval and sandbox controls", () => {
    const onCodexPresetChange = vi.fn();
    renderComposer({ onCodexPresetChange });

    fireEvent.click(screen.getByRole("button", { name: "Full auto" }));

    expect(onCodexPresetChange).toHaveBeenCalledWith({
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
      codexConfigSource: "flags",
    });
  });

  it("disables attachments while steering an active turn", () => {
    renderComposer({ turnActive: true });

    expect((screen.getByTitle("Attach files or images (@)") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle("Upload file from disk") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows inline proof toggle and wires callback", () => {
    const onToggleProof = vi.fn();
    renderComposer({
      onToggleProof,
      proofOpen: false,
      proofArtifactCount: 3,
    });

    const proofButton = screen.getByTitle("Open proof drawer");
    fireEvent.click(proofButton);
    expect(onToggleProof).toHaveBeenCalledTimes(1);
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("shows inline context toggle only before first message", () => {
    const onIncludeProjectDocsChange = vi.fn();
    renderComposer({
      chatHasMessages: false,
      includeProjectDocs: false,
      onIncludeProjectDocsChange,
    });

    const contextButton = screen.getByTitle("Include project context (PRD + architecture) with first message");
    fireEvent.click(contextButton);
    expect(onIncludeProjectDocsChange).toHaveBeenCalledWith(true);
  });

  it("hides context toggle after first message is sent", () => {
    const onIncludeProjectDocsChange = vi.fn();
    renderComposer({
      chatHasMessages: true,
      includeProjectDocs: false,
      onIncludeProjectDocsChange,
    });

    expect(screen.queryByTitle("Include project context (PRD + architecture) with first message")).toBeNull();
  });

  it("uses a constrained resizable textarea in grid-tile mode", () => {
    renderComposer({
      layoutVariant: "grid-tile",
      composerMaxHeightPx: 128,
    });

    const textarea = screen.getByPlaceholderText("Steer the active turn...") as HTMLTextAreaElement;
    expect(textarea.dataset.chatLayoutVariant).toBe("grid-tile");
    expect(textarea.style.maxHeight).toBe("128px");
    expect(textarea.className).toContain("resize-y");
  });

  it("shows only the available session models when the chat catalog is restricted", () => {
    renderComposer({
      availableModelIds: ["openai/gpt-5.4-codex", "openai/gpt-5.2-codex"],
      restrictModelCatalogToAvailable: true,
      turnActive: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Select model" }));

    expect(screen.getByText("GPT-5.2-Codex")).toBeTruthy();
    expect(screen.queryByText("Claude Sonnet 4.6")).toBeNull();
  });
});
