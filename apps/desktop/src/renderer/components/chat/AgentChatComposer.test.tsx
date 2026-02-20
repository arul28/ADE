/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatComposer } from "./AgentChatComposer";

function renderComposer(overrides: Partial<React.ComponentProps<typeof AgentChatComposer>> = {}) {
  const onProviderChange = vi.fn();
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
    provider: "codex",
    providerOptions: [
      { value: "codex", label: "Codex", enabled: true },
      { value: "claude", label: "Claude", enabled: true }
    ],
    model: "gpt-5.3-codex",
    models: [
      {
        id: "gpt-5.3-codex",
        displayName: "gpt-5.3-codex",
        isDefault: true,
        reasoningEfforts: [
          { effort: "medium", description: "balanced" },
          { effort: "high", description: "deeper" }
        ]
      },
      { id: "gpt-5.2-codex", displayName: "gpt-5.2-codex", isDefault: false }
    ],
    reasoningEffort: "medium",
    draft: "hello",
    attachments: [],
    pendingApproval: null,
    turnActive: false,
    sendOnEnter: true,
    busy: false,
    onProviderChange,
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
    onProviderChange,
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

    const textarea = screen.getByPlaceholderText("Ask Codex or Claude to work in this lane...") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("sends message on Cmd/Ctrl+Enter when send-on-Enter is disabled", () => {
    const { onSubmit } = renderComposer({ sendOnEnter: false, draft: "send me" });

    const textarea = screen.getByPlaceholderText("Ask Codex or Claude to work in this lane...") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("shows steer mode and interrupt controls when turn is active", () => {
    renderComposer({ turnActive: true, draft: "steer" });

    expect(screen.getByText("Steering active turn")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Steer" })).toBeTruthy();
  });

  it("opens @ attachment picker when @ key is pressed", async () => {
    renderComposer();

    const textarea = screen.getByPlaceholderText("Ask Codex or Claude to work in this lane...") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "@", shiftKey: true, code: "Digit2" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search files in this lane...")).toBeTruthy();
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
      provider: "claude",
      model: "sonnet",
      models: [
        {
          id: "sonnet",
          displayName: "Sonnet",
          isDefault: true,
          reasoningEfforts: [
            { effort: "low", description: "Quick" },
            { effort: "medium", description: "Balanced" },
            { effort: "high", description: "Deep" },
            { effort: "max", description: "Maximum" }
          ]
        }
      ],
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

    const textarea = screen.getByPlaceholderText("Ask Codex or Claude to work in this lane...") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "/" });

    await waitFor(() => {
      expect(screen.getByText("Commands")).toBeTruthy();
    });
  });

  it("opens context picker when # is typed", () => {
    renderComposer({ draft: "" });

    const textarea = screen.getByPlaceholderText("Ask Codex or Claude to work in this lane...") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "#" });

    expect(screen.getByText("Context Packs")).toBeTruthy();
  });

  it("renders key legend with @, /, # shortcut hints", () => {
    renderComposer();

    expect(screen.getByText("files")).toBeTruthy();
    expect(screen.getByText("commands")).toBeTruthy();
    expect(screen.getByText("context")).toBeTruthy();
  });

  it("switches provider and model from dropdowns", () => {
    const { onProviderChange, onModelChange, onReasoningEffortChange } = renderComposer();

    const providerSelect = screen.getByLabelText("Provider") as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: "claude" } });

    const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: "gpt-5.2-codex" } });

    const reasoningSelect = screen.getByLabelText("Reasoning effort") as HTMLSelectElement;
    fireEvent.change(reasoningSelect, { target: { value: "high" } });

    expect(onProviderChange).toHaveBeenCalledWith("claude");
    expect(onModelChange).toHaveBeenCalledWith("gpt-5.2-codex");
    expect(onReasoningEffortChange).toHaveBeenCalledWith("high");
  });
});
