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

  it("shows a single Claude mode row with hover details", () => {
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
    expect(screen.getByText("Claude uses the normal approval flow for reads, edits, and tools.")).toBeTruthy();

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Plan" }));
    expect(screen.getByText("Read-only Claude turns for analysis and implementation planning.")).toBeTruthy();
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

  it("shows preset-first Codex controls and a custom summary without raw selects", () => {
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
    expect(screen.getByText("Custom Codex mode: ADE flags · On request · Workspace write")).toBeTruthy();

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Full auto" }));
    expect(screen.getByText(/Danger-full-access sandbox, approval policy: never/i)).toBeTruthy();
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

  it("opens the advanced popover and wires the advanced controls", () => {
    const onExecutionModeChange = vi.fn();
    const onComputerUsePolicyChange = vi.fn();
    const onToggleProof = vi.fn();
    const onIncludeProjectDocsChange = vi.fn();
    renderComposer({
      executionMode: "focused",
      executionModeOptions,
      onExecutionModeChange,
      onComputerUsePolicyChange,
      onToggleProof,
      includeProjectDocs: false,
      onIncludeProjectDocsChange,
    });

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));

    fireEvent.click(screen.getByRole("button", { name: /^Parallel/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Proof\b/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Project Context\b/i }));

    expect(onExecutionModeChange).toHaveBeenCalledWith("parallel");
    expect(onToggleProof).toHaveBeenCalledTimes(1);
    expect(onIncludeProjectDocsChange).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.queryByText("Advanced settings")).toBeNull();
  });
});
