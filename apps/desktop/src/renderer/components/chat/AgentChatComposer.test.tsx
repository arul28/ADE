/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, type RenderResult } from "@testing-library/react";
import type { ComponentProps } from "react";
import { AgentChatComposer } from "./AgentChatComposer";
import { modifierKeyLabel } from "../../lib/platform";

function installMatchMediaMock(): void {
  if (typeof window.matchMedia === "function") return;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

vi.mock("@emoji-mart/data", () => ({
  default: { categories: [], emojis: {}, aliases: {}, sheet: { cols: 0, rows: 0 } },
}));

vi.mock("@emoji-mart/data/sets/15/native.json", () => ({
  default: { categories: [], emojis: {}, aliases: {}, sheet: { cols: 0, rows: 0 } },
}));

vi.mock("@lobehub/icons", () => {
  const brand = () => {
    const Component = () => null;
    Object.assign(Component, {
      Avatar: () => null,
      Color: () => null,
      Combine: () => null,
      Text: () => null,
      colorPrimary: "#888",
      title: "stub",
    });
    return Component;
  };
  return {
    Anthropic: brand(),
    Claude: brand(),
    Codex: brand(),
    Cursor: brand(),
    Gemini: brand(),
    Google: brand(),
    Grok: brand(),
    Groq: brand(),
    OpenAI: brand(),
    OpenCode: brand(),
    OpenRouter: brand(),
    XAI: brand(),
  };
});

beforeEach(() => {
  installMatchMediaMock();
});

afterEach(cleanup);

function buildComposerProps(overrides: Partial<ComponentProps<typeof AgentChatComposer>> = {}) {
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
    opencodePermissionMode: "edit",
    executionMode: "focused",
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
    onOpenCodePermissionModeChange: vi.fn(),
    onComputerUsePolicyChange: vi.fn(),
    ...overrides,
  };

  return props;
}

function renderComposer(overrides: Partial<ComponentProps<typeof AgentChatComposer>> = {}) {
  const props = buildComposerProps(overrides);

  const view = render(<AgentChatComposer {...props} />);
  return Object.assign(view, props) as RenderResult & ComponentProps<typeof AgentChatComposer>;
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

    const stopButtons = screen.getAllByTitle(`Stop the active turn only (${modifierKeyLabel}+.)`);
    fireEvent.click(stopButtons[stopButtons.length - 1]!);

    expect(props.onInterrupt).toHaveBeenCalledTimes(1);
    expect(props.onClearDraft).not.toHaveBeenCalled();
  });

  it("renders Claude mode dropdown without a Chat toggle", () => {
    renderComposer({
      sessionProvider: "claude",
      modelId: "anthropic/claude-sonnet-4-6",
      availableModelIds: ["anthropic/claude-sonnet-4-6"],
    });

    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Claude permission mode" });
    expect(trigger.textContent).toContain("Ask permissions");

    fireEvent.click(trigger);

    expect(screen.getByRole("listbox", { name: "Claude permission mode" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Ask permissions/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Accept edits/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Plan mode/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Bypass permissions/ })).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: "Claude permission mode" }));
    fireEvent.click(screen.getByRole("option", { name: /Plan mode/ }));

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

    fireEvent.click(screen.getByRole("button", { name: "Claude permission mode" }));
    fireEvent.click(screen.getByRole("option", { name: /Plan mode/ }));

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

    fireEvent.click(screen.getByRole("button", { name: "Codex approval preset" }));

    expect(screen.getByRole("option", { name: "Default permissions" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Plan mode" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Full access" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Custom (config.toml)" })).toBeTruthy();
    expect(screen.queryByDisplayValue("ADE flags")).toBeNull();
    expect(screen.queryByDisplayValue("On request")).toBeNull();
    expect(screen.queryByDisplayValue("Workspace write")).toBeNull();
  });

  it("maps Codex preset buttons to the underlying approval and sandbox controls", () => {
    const onCodexPresetChange = vi.fn();
    renderComposer({ onCodexPresetChange });

    fireEvent.click(screen.getByRole("button", { name: "Codex approval preset" }));
    fireEvent.click(screen.getByRole("option", { name: "Full access" }));

    expect(onCodexPresetChange).toHaveBeenCalledWith({
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
      codexConfigSource: "flags",
    });
  });

  it("can hide native permission controls for fixed-mode surfaces", () => {
    renderComposer({
      sessionProvider: "codex",
      hideNativeControls: true,
    });

    expect(screen.queryByRole("button", { name: "Codex approval preset" })).toBeNull();
  });

  it("avoids promising option chips when a pending question is freeform only", () => {
    renderComposer({
      pendingInput: {
        requestId: "req-1",
        itemId: "item-1",
        source: "ade",
        kind: "question",
        title: "Input needed",
        description: "What should we test first?",
        questions: [{
          id: "answer",
          header: "Question 1",
          question: "What should we test first?",
          allowsFreeform: true,
        }],
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        turnId: null,
      },
    });

    expect(screen.getByText("Answer in the inline question card, or type below.")).toBeTruthy();
    expect(screen.queryByText("Answer in the inline question card, or pick an option there.")).toBeNull();
  });

  it("keeps the option hint when a pending question includes selectable options", () => {
    renderComposer({
      pendingInput: {
        requestId: "req-2",
        itemId: "item-2",
        source: "ade",
        kind: "structured_question",
        title: "Input needed",
        description: "Which flow should we test first?",
        questions: [{
          id: "answer",
          header: "Question 1",
          question: "Which flow should we test first?",
          allowsFreeform: true,
          options: [
            { label: "Question flow", value: "question_flow" },
            { label: "Plan updates", value: "plan_updates" },
          ],
        }],
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        turnId: null,
      },
    });

    expect(screen.getByText("Answer in the inline question card, or pick an option there.")).toBeTruthy();
  });

  it("keeps the option hint when any pending question includes selectable options", () => {
    renderComposer({
      pendingInput: {
        requestId: "req-2b",
        itemId: "item-2b",
        source: "codex",
        kind: "structured_question",
        title: "Input needed",
        description: "Two questions are pending",
        questions: [
          {
            id: "first",
            header: "Question 1",
            question: "What should we inspect first?",
            allowsFreeform: true,
          },
          {
            id: "second",
            header: "Question 2",
            question: "Which flow should we use?",
            allowsFreeform: true,
            options: [
              { label: "Question flow", value: "question_flow" },
              { label: "Plan updates", value: "plan_updates" },
            ],
          },
        ],
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        turnId: null,
      },
    });

    expect(screen.getByText("Answer in the inline question card, or pick an option there.")).toBeTruthy();
  });

  it("uses decline wording for native Codex structured questions", () => {
    const props = renderComposer({
      pendingInput: {
        requestId: "req-2c",
        itemId: "item-2c",
        source: "codex",
        kind: "structured_question",
        title: "Input needed",
        description: "Which flow should we test first?",
        questions: [{
          id: "answer",
          header: "Question 1",
          question: "Which flow should we test first?",
          allowsFreeform: true,
          options: [
            { label: "Question flow", value: "question_flow" },
            { label: "Plan updates", value: "plan_updates" },
          ],
        }],
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        turnId: null,
      },
    });

    const decline = screen.getByRole("button", { name: "Decline" });
    fireEvent.click(decline);

    expect(props.onApproval).toHaveBeenCalledWith("decline");
  });

  it("labels multi-question prompts explicitly in the pending banner", () => {
    renderComposer({
      pendingInput: {
        requestId: "req-3",
        itemId: "item-3",
        source: "codex",
        kind: "structured_question",
        title: "Input needed",
        description: "Multiple decisions are needed",
        questions: [
          {
            id: "q1",
            header: "Question 1",
            question: "What should we test first?",
            allowsFreeform: true,
          },
          {
            id: "q2",
            header: "Question 2",
            question: "Which validation strategy should we use?",
            allowsFreeform: true,
          },
        ],
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        turnId: null,
      },
    });

    expect(screen.getByText("2 Questions · codex")).toBeTruthy();
  });

  it("allows attachments while steering an active Codex turn", () => {
    renderComposer({ turnActive: true });

    expect((screen.getByTitle("Attach files or images (@)") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTitle("Upload file from disk") as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows attachments while steering an active Claude turn", () => {
    renderComposer({
      turnActive: true,
      sessionProvider: "claude",
      modelId: "anthropic/claude-sonnet-4-6",
      availableModelIds: ["anthropic/claude-sonnet-4-6"],
    });

    expect((screen.getByTitle("Attach files or images (@)") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTitle("Upload file from disk") as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows attachments while steering an active Cursor turn", () => {
    renderComposer({
      turnActive: true,
      sessionProvider: "cursor",
      modelId: "cursor/auto",
      availableModelIds: ["cursor/auto"],
    });

    expect((screen.getByTitle("Attach files or images (@)") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTitle("Upload file from disk") as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows attachments while steering an active OpenCode turn", () => {
    renderComposer({
      turnActive: true,
      sessionProvider: "opencode",
      modelId: "opencode/openai/gpt-5.4",
      availableModelIds: ["opencode/openai/gpt-5.4"],
    });

    expect((screen.getByTitle("Attach files or images (@)") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTitle("Upload file from disk") as HTMLButtonElement).disabled).toBe(false);
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

  it("marks the textarea layout variant in grid-tile mode", () => {
    const { container } = renderComposer({
      layoutVariant: "grid-tile",
      composerMaxHeightPx: 128,
    });

    const textarea = screen.getByPlaceholderText("Steer the active turn...") as HTMLTextAreaElement;
    expect(textarea.dataset.chatLayoutVariant).toBe("grid-tile");
    expect(textarea.className).toContain("resize-none");
    const composerShell = container.querySelector("[data-chat-composer-mode]");
    expect(composerShell?.className).not.toContain("rounded-none");
    expect(composerShell?.parentElement?.className ?? "").not.toContain("rounded-none");
  });

  it("opts the chat textarea into native typing assistance", () => {
    renderComposer();

    const textarea = screen.getByPlaceholderText("Steer the active turn...") as HTMLTextAreaElement;
    expect(textarea.getAttribute("autocomplete")).toBe("on");
    expect(textarea.getAttribute("autocorrect")).toBe("on");
    expect(textarea.getAttribute("autocapitalize")).toBe("sentences");
    expect(textarea.getAttribute("spellcheck")).toBe("true");
  });

  it("focuses the grid composer when the tile becomes active", () => {
    const props = buildComposerProps({
      layoutVariant: "grid-tile",
      composerMaxHeightPx: 128,
      isActive: false,
    });
    const view = render(<AgentChatComposer {...props} />);

    const textarea = screen.getByPlaceholderText("Steer the active turn...") as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(textarea);

    view.rerender(<AgentChatComposer {...props} isActive />);

    expect(document.activeElement).toBe(textarea);
  });

  it("does not autofocus the grid composer when only hover state changes", () => {
    const props = buildComposerProps({
      layoutVariant: "grid-tile",
      composerMaxHeightPx: 128,
      isActive: false,
      shouldAutofocus: false,
    });
    const view = render(<AgentChatComposer {...props} />);

    const textarea = screen.getByPlaceholderText("Steer the active turn...") as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(textarea);

    view.rerender(<AgentChatComposer {...props} isActive shouldAutofocus={false} />);

    expect(document.activeElement).not.toBe(textarea);
  });

  it("shows the parallel launch entry point when the draft surface enables it", () => {
    const onParallelChatModeChange = vi.fn();
    renderComposer({
      turnActive: false,
      draft: "",
      showParallelChatToggle: true,
      onParallelChatModeChange,
    });

    fireEvent.click(screen.getByRole("button", { name: /Parallel models/i }));

    expect(onParallelChatModeChange).toHaveBeenCalledWith(true);
  });

  it("disables parallel controls while a parallel launch is running", () => {
    renderComposer({
      turnActive: false,
      draft: "Ship it",
      parallelChatMode: true,
      parallelLaunchBusy: true,
      parallelLaunchStatus: "Creating child lanes…",
      parallelModelSlots: [
        { modelId: "openai/gpt-5.4-codex", reasoningEffort: "high" },
        { modelId: "anthropic/claude-sonnet-4-6", reasoningEffort: "medium" },
        { modelId: "openai/gpt-5.4-mini", reasoningEffort: "low" },
      ],
    });

    expect((screen.getByRole("button", { name: "Single model" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add model" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: "Configure" })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: "Remove" })[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Creating child lanes…")).toBeTruthy();
  });

});
