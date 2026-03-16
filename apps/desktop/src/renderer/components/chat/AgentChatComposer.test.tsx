/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { createDefaultComputerUsePolicy } from "../../../shared/types";
import { AgentChatComposer } from "./AgentChatComposer";

function renderComposer(overrides: Partial<ComponentProps<typeof AgentChatComposer>> = {}) {
  const props: ComponentProps<typeof AgentChatComposer> = {
    modelId: "openai/gpt-5-chat-latest",
    availableModelIds: ["openai/gpt-5-chat-latest"],
    reasoningEffort: null,
    draft: "Need a steer message",
    attachments: [],
    pendingApproval: null,
    turnActive: true,
    sendOnEnter: true,
    busy: false,
    selectedContextPacks: [],
    permissionMode: "full-auto",
    sessionProvider: "codex",
    sessionIsCliWrapped: true,
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
    onContextPacksChange: vi.fn(),
    onExecutionModeChange: vi.fn(),
    onPermissionModeChange: vi.fn(),
    onComputerUsePolicyChange: vi.fn(),
    ...overrides,
  };

  render(<AgentChatComposer {...props} />);
  return props;
}

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
});
