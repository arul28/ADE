/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { createDefaultComputerUsePolicy } from "../../../shared/types";
import { AgentChatComposer } from "./AgentChatComposer";

afterEach(cleanup);

function renderComposer(overrides: Partial<ComponentProps<typeof AgentChatComposer>> = {}) {
  const props: ComponentProps<typeof AgentChatComposer> = {
    modelId: "openai/gpt-5-chat-latest",
    availableModelIds: ["openai/gpt-5-chat-latest"],
    reasoningEffort: null,
    draft: "Need a steer message",
    attachments: [],
    pendingInput: null,
    turnActive: true,
    sendOnEnter: true,
    busy: false,
    sessionProvider: "codex",
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
    onClaudePermissionModeChange: vi.fn(),
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

  it("shows native Codex runtime controls", () => {
    renderComposer();

    expect(screen.getByDisplayValue("ADE flags")).toBeTruthy();
    expect(screen.getByDisplayValue("On request")).toBeTruthy();
    expect(screen.getByDisplayValue("Workspace write")).toBeTruthy();
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
