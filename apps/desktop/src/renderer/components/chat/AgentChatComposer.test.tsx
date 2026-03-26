/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    expect(screen.getByRole("button", { name: "Plan" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Guarded edit" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Full auto" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Custom" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("maps Codex preset modes and reveals custom controls", () => {
    const onCodexApprovalPolicyChange = vi.fn();
    const onCodexSandboxChange = vi.fn();
    const onCodexConfigSourceChange = vi.fn();
    renderComposer({
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
      onCodexApprovalPolicyChange,
      onCodexSandboxChange,
      onCodexConfigSourceChange,
    });

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(onCodexConfigSourceChange).toHaveBeenLastCalledWith("flags");
    expect(onCodexApprovalPolicyChange).toHaveBeenLastCalledWith("untrusted");
    expect(onCodexSandboxChange).toHaveBeenLastCalledWith("read-only");

    fireEvent.click(screen.getByRole("button", { name: "Guarded edit" }));
    expect(onCodexConfigSourceChange).toHaveBeenLastCalledWith("flags");
    expect(onCodexApprovalPolicyChange).toHaveBeenLastCalledWith("on-failure");
    expect(onCodexSandboxChange).toHaveBeenLastCalledWith("workspace-write");

    fireEvent.click(screen.getByRole("button", { name: "Full auto" }));
    expect(onCodexConfigSourceChange).toHaveBeenLastCalledWith("flags");
    expect(onCodexApprovalPolicyChange).toHaveBeenLastCalledWith("never");
    expect(onCodexSandboxChange).toHaveBeenLastCalledWith("danger-full-access");

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(onCodexConfigSourceChange).toHaveBeenLastCalledWith("config-toml");
  });

  it("shows the raw Codex controls in custom mode", () => {
    renderComposer({
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "config-toml",
    });

    expect(screen.getByDisplayValue("config.toml")).toBeTruthy();
    expect(screen.getByDisplayValue("On request")).toBeTruthy();
    expect(screen.getByDisplayValue("Workspace write")).toBeTruthy();
  });

  it("enables native text assistance on the prompt textarea", () => {
    renderComposer();

    const textarea = screen.getByPlaceholderText("Steer the active turn...");
    expect(textarea.getAttribute("spellcheck")).toBe("true");
    expect(textarea.getAttribute("autocorrect")).toBe("on");
    expect(textarea.getAttribute("autocapitalize")).toBe("sentences");
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

  it("keeps the textarea text-assist attributes enabled by default", () => {
    renderComposer();

    const textarea = screen.getByRole("textbox");
    expect(textarea.getAttribute("spellcheck")).toBe("true");
    expect(textarea.getAttribute("autocorrect")).toBe("on");
    expect(textarea.getAttribute("autocapitalize")).toBe("sentences");
  });

  it("keeps an unavailable API-only model visible in the selector", () => {
    renderComposer({
      modelId: "openai/gpt-5.4-mini",
      availableModelIds: ["openai/gpt-5.4"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Select model" }));
    fireEvent.click(screen.getByRole("button", { name: /^API\b/i }));

    const option = screen.getByRole("option", { name: /GPT-5\.4-Mini/i });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain("API only · not configured");
  });

  it("lists GPT-5.4-Mini in the OpenAI section even when it is unavailable", () => {
    renderComposer({
      modelId: "openai/gpt-5.4",
      availableModelIds: ["openai/gpt-5.4"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Select model" }));
    fireEvent.click(screen.getByRole("button", { name: /^API\b/i }));

    const option = screen.getByRole("option", { name: /GPT-5\.4-Mini/i });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain("API only · not configured");
  });

  /* ── Attachment picker tests ── */

  it("opens the attachment picker when pressing @ in the textarea (turn inactive)", () => {
    renderComposer({ turnActive: false, draft: "" });

    const textarea = screen.getByPlaceholderText("Message the assistant...");
    fireEvent.keyDown(textarea, { key: "@" });

    expect(screen.getByPlaceholderText("Search files...")).toBeTruthy();
  });

  it("does not open the attachment picker when pressing @ during an active turn", () => {
    renderComposer({ turnActive: true, draft: "" });

    const textarea = screen.getByPlaceholderText("Steer the active turn...");
    fireEvent.keyDown(textarea, { key: "@" });

    expect(screen.queryByPlaceholderText("Search files...")).toBeNull();
  });

  it("searches for files via onSearchAttachments when typing in the picker", async () => {
    vi.useFakeTimers();

    const onSearchAttachments = vi.fn().mockResolvedValue([
      { path: "/project/src/index.ts", type: "file" },
      { path: "/project/src/app.tsx", type: "file" },
    ]);
    renderComposer({ turnActive: false, draft: "", onSearchAttachments });

    const textarea = screen.getByPlaceholderText("Message the assistant...");
    fireEvent.keyDown(textarea, { key: "@" });

    const searchInput = screen.getByPlaceholderText("Search files...");
    fireEvent.change(searchInput, { target: { value: "index" } });

    // The search debounce is 120ms
    await act(async () => { vi.advanceTimersByTime(150); });

    expect(onSearchAttachments).toHaveBeenCalledWith("index");

    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText("/project/src/index.ts")).toBeTruthy();
      expect(screen.getByText("/project/src/app.tsx")).toBeTruthy();
    });
  });

  it("discards stale search results when a newer search completes first", async () => {
    vi.useFakeTimers();

    let resolveFirst!: (value: Array<{ path: string; type: "file" }>) => void;
    let resolveSecond!: (value: Array<{ path: string; type: "file" }>) => void;

    const firstPromise = new Promise<Array<{ path: string; type: "file" }>>((r) => { resolveFirst = r; });
    const secondPromise = new Promise<Array<{ path: string; type: "file" }>>((r) => { resolveSecond = r; });

    const onSearchAttachments = vi.fn()
      .mockReturnValueOnce(firstPromise)
      .mockReturnValueOnce(secondPromise);

    renderComposer({ turnActive: false, draft: "", onSearchAttachments });

    const textarea = screen.getByPlaceholderText("Message the assistant...");
    fireEvent.keyDown(textarea, { key: "@" });
    const searchInput = screen.getByPlaceholderText("Search files...");

    // Type "old" and wait for debounce
    fireEvent.change(searchInput, { target: { value: "old" } });
    await act(async () => { vi.advanceTimersByTime(150); });

    // Type "new" and wait for debounce — this increments searchRequestIdRef
    fireEvent.change(searchInput, { target: { value: "new" } });
    await act(async () => { vi.advanceTimersByTime(150); });

    // The second (newer) search resolves first
    await act(async () => { resolveSecond([{ path: "/project/new-result.ts", type: "file" }]); });

    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText("/project/new-result.ts")).toBeTruthy();
    });

    // Now the first (stale) search resolves — its results should be discarded
    await act(async () => { resolveFirst([{ path: "/project/stale-result.ts", type: "file" }]); });

    // Wait a tick to make sure no re-render happens with stale data
    await waitFor(() => {
      expect(screen.queryByText("/project/stale-result.ts")).toBeNull();
      expect(screen.getByText("/project/new-result.ts")).toBeTruthy();
    });
  });

  it("selects an attachment from results and closes the picker", async () => {
    vi.useFakeTimers();

    const onAddAttachment = vi.fn();
    const onSearchAttachments = vi.fn().mockResolvedValue([
      { path: "/project/utils.ts", type: "file" },
    ]);

    renderComposer({ turnActive: false, draft: "", onAddAttachment, onSearchAttachments });

    const textarea = screen.getByPlaceholderText("Message the assistant...");
    fireEvent.keyDown(textarea, { key: "@" });

    const searchInput = screen.getByPlaceholderText("Search files...");
    fireEvent.change(searchInput, { target: { value: "utils" } });
    await act(async () => { vi.advanceTimersByTime(150); });

    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText("/project/utils.ts")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("/project/utils.ts"));

    expect(onAddAttachment).toHaveBeenCalledWith({ path: "/project/utils.ts", type: "file" });
    // Picker should close after selection
    expect(screen.queryByPlaceholderText("Search files...")).toBeNull();
  });

  it("selects an attachment via Enter key on the highlighted result", async () => {
    vi.useFakeTimers();

    const onAddAttachment = vi.fn();
    const onSearchAttachments = vi.fn().mockResolvedValue([
      { path: "/project/alpha.ts", type: "file" },
      { path: "/project/beta.ts", type: "file" },
    ]);

    renderComposer({ turnActive: false, draft: "", onAddAttachment, onSearchAttachments });

    const textarea = screen.getByPlaceholderText("Message the assistant...");
    fireEvent.keyDown(textarea, { key: "@" });

    const searchInput = screen.getByPlaceholderText("Search files...");
    fireEvent.change(searchInput, { target: { value: "project" } });
    await act(async () => { vi.advanceTimersByTime(150); });

    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText("/project/alpha.ts")).toBeTruthy();
    });

    // Move cursor down to second result and press Enter
    fireEvent.keyDown(searchInput, { key: "ArrowDown" });
    fireEvent.keyDown(searchInput, { key: "Enter" });

    expect(onAddAttachment).toHaveBeenCalledWith({ path: "/project/beta.ts", type: "file" });
    expect(screen.queryByPlaceholderText("Search files...")).toBeNull();
  });

  it("adds a file attachment via the hidden file input", async () => {
    const onAddAttachment = vi.fn();
    renderComposer({ turnActive: false, draft: "", onAddAttachment });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

    const file = new File(["content"], "a.ts", { type: "text/plain" });
    Object.defineProperty(file, "path", { value: "/project/a.ts", writable: false });

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(onAddAttachment).toHaveBeenCalledTimes(1);
    });

    expect(onAddAttachment).toHaveBeenCalledWith({ path: "/project/a.ts", type: "file" });
  });

  it("prevents submitting a whitespace-only message", () => {
    const onSubmit = vi.fn();
    renderComposer({ turnActive: false, draft: "   ", onSubmit, busy: false });

    const textarea = screen.getByPlaceholderText("Message the assistant...");

    // Try submitting via Enter
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables the Send button when draft is whitespace-only", () => {
    renderComposer({ turnActive: false, draft: "   \n\t  " });

    const sendButton = screen.getByTitle("Send");
    expect(sendButton.hasAttribute("disabled")).toBe(true);
  });
});
