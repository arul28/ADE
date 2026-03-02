/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatComposer } from "./AgentChatComposer";

function renderComposer(overrides: Partial<React.ComponentProps<typeof AgentChatComposer>> = {}) {
  const onModelChange = vi.fn();
  const onReasoningEffortChange = vi.fn();
  const onDraftChange = vi.fn();
  const onSubmit = vi.fn();
  const onInterrupt = vi.fn();
  const onApproval = vi.fn();
  const onAddAttachment = vi.fn();
  const onRemoveAttachment = vi.fn();
  const onSearchAttachments = vi.fn(async () => []);
  const onContextPacksChange = vi.fn();
  const onClearEvents = vi.fn();

  const props: React.ComponentProps<typeof AgentChatComposer> = {
    modelId: "openai/gpt-5.3-codex",
    availableModelIds: ["openai/gpt-5.3-codex", "anthropic/claude-sonnet-4-6"],
    reasoningEffort: "medium",
    draft: "hello",
    attachments: [],
    pendingApproval: null,
    turnActive: false,
    sendOnEnter: true,
    busy: false,
    onModelChange,
    onReasoningEffortChange,
    onDraftChange,
    onSubmit,
    onInterrupt,
    onApproval,
    onAddAttachment,
    onRemoveAttachment,
    onSearchAttachments,
    selectedContextPacks: [],
    onContextPacksChange,
    onClearEvents,
    ...overrides
  };

  const utils = render(<AgentChatComposer {...props} />);
  return {
    ...utils,
    props,
    onModelChange,
    onReasoningEffortChange,
    onDraftChange,
    onSubmit,
    onInterrupt,
    onApproval,
    onAddAttachment,
    onRemoveAttachment,
    onSearchAttachments,
    onContextPacksChange,
    onClearEvents
  };
}

describe("AgentChatComposer", () => {
  afterEach(() => {
    cleanup();
  });

  it("sends message on Enter when send-on-Enter is enabled", () => {
    const { onSubmit } = renderComposer({ sendOnEnter: true, draft: "send me" });

    const textarea = screen.getByPlaceholderText("Message the agent...") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("sends message on Cmd/Ctrl+Enter when send-on-Enter is disabled", () => {
    const { onSubmit } = renderComposer({ sendOnEnter: false, draft: "send me" });

    const textarea = screen.getByPlaceholderText("Message the agent...") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("shows steer mode and interrupt controls when turn is active", () => {
    renderComposer({ turnActive: true, draft: "steer" });

    // Steer mode uses a different placeholder
    expect(screen.getByPlaceholderText("Steer the active turn...")).toBeTruthy();
    // Interrupt button has title="Interrupt (Cmd+.)"
    expect(screen.getByTitle("Interrupt (Cmd+.)")).toBeTruthy();
    // Send button shows "Steer" title when turn is active
    expect(screen.getByTitle("Steer")).toBeTruthy();
  });

  it("opens @ attachment picker when @ key is pressed", async () => {
    renderComposer();

    const textarea = screen.getByPlaceholderText("Message the agent...") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "@", shiftKey: true, code: "Digit2" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search files...")).toBeTruthy();
    });
  });

  it("shows approval actions when approval is pending", () => {
    const { onApproval } = renderComposer({
      pendingApproval: {
        itemId: "approval-1",
        kind: "command",
        description: "Run command"
      }
    });

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    expect(onApproval).toHaveBeenCalledWith("accept");
    expect(onApproval).toHaveBeenCalledWith("decline");
  });

  it("shows reasoning dropdown for Claude provider", () => {
    renderComposer({
      modelId: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "medium"
    });

    const reasoningSelect = screen.getByLabelText("Reasoning effort") as HTMLSelectElement;
    expect(reasoningSelect).toBeTruthy();

    // Verify all Claude effort options are rendered
    const options = Array.from(reasoningSelect.options).map((o) => o.value);
    expect(options).toContain("low");
    expect(options).toContain("medium");
    expect(options).toContain("high");
    expect(options).toContain("max");
  });

  it("opens slash picker when / is typed at start of empty draft", async () => {
    const { onDraftChange } = renderComposer({ draft: "" });

    const textarea = screen.getByPlaceholderText("Message the agent...") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "/" });

    await waitFor(() => {
      expect(screen.getByText("Commands")).toBeTruthy();
    });
  });

  it("opens context picker when # is typed", () => {
    renderComposer({ draft: "" });

    const textarea = screen.getByPlaceholderText("Message the agent...") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "#" });

    expect(screen.getByText("Context Packs")).toBeTruthy();
  });

  it("renders key legend with @, # quick actions and send hint", () => {
    renderComposer();

    // Toolbar has @ and # quick-action buttons and a send hint
    expect(screen.getByTitle("Attach files (@)")).toBeTruthy();
    expect(screen.getByTitle("Context packs (#)")).toBeTruthy();
    expect(screen.getByText("⏎ send")).toBeTruthy();
  });

  it("switches model and reasoning effort from dropdowns", () => {
    const { onModelChange, onReasoningEffortChange } = renderComposer();

    const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: "anthropic/claude-sonnet-4-6" } });

    const reasoningSelect = screen.getByLabelText("Reasoning effort") as HTMLSelectElement;
    fireEvent.change(reasoningSelect, { target: { value: "high" } });

    expect(onModelChange).toHaveBeenCalledWith("anthropic/claude-sonnet-4-6");
    expect(onReasoningEffortChange).toHaveBeenCalledWith("high");
  });
});
