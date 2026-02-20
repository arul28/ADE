/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatComposer } from "./AgentChatComposer";

function renderComposer(overrides: Partial<React.ComponentProps<typeof AgentChatComposer>> = {}) {
  const onProviderChange = vi.fn();
  const onModelChange = vi.fn();
  const onDraftChange = vi.fn();
  const onSubmit = vi.fn();
  const onInterrupt = vi.fn();
  const onApproval = vi.fn();
  const onAddAttachment = vi.fn();
  const onRemoveAttachment = vi.fn();
  const onSearchAttachments = vi.fn(async () => []);

  const props: React.ComponentProps<typeof AgentChatComposer> = {
    provider: "codex",
    model: "gpt-5.3-codex",
    models: [
      { id: "gpt-5.3-codex", displayName: "gpt-5.3-codex", isDefault: true },
      { id: "gpt-5.2-codex", displayName: "gpt-5.2-codex", isDefault: false }
    ],
    draft: "hello",
    attachments: [],
    pendingApproval: null,
    turnActive: false,
    sendOnEnter: true,
    busy: false,
    onProviderChange,
    onModelChange,
    onDraftChange,
    onSubmit,
    onInterrupt,
    onApproval,
    onAddAttachment,
    onRemoveAttachment,
    onSearchAttachments,
    ...overrides
  };

  const utils = render(<AgentChatComposer {...props} />);
  return {
    ...utils,
    props,
    onProviderChange,
    onModelChange,
    onDraftChange,
    onSubmit,
    onInterrupt,
    onApproval,
    onAddAttachment,
    onRemoveAttachment,
    onSearchAttachments
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

  it("switches provider and model from dropdowns", () => {
    const { onProviderChange, onModelChange } = renderComposer();

    const providerSelect = screen.getByLabelText("Provider") as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: "claude" } });

    const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: "gpt-5.2-codex" } });

    expect(onProviderChange).toHaveBeenCalledWith("claude");
    expect(onModelChange).toHaveBeenCalledWith("gpt-5.2-codex");
  });
});
