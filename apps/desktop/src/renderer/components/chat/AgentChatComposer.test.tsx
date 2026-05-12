/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { NormalizedLinearIssue } from "../../../shared/types";
import { AgentChatComposer } from "./AgentChatComposer";

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

afterEach(() => {
  cleanup();
  delete (window as any).ade;
});

function buildComposerProps(overrides: Partial<ComponentProps<typeof AgentChatComposer>> = {}) {
  const props: ComponentProps<typeof AgentChatComposer> = {
    modelId: "openai/gpt-5.4",
    availableModelIds: ["openai/gpt-5.4"],
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

function makeLinearIssue(overrides: Partial<NormalizedLinearIssue> = {}): NormalizedLinearIssue {
  return {
    id: "issue-1",
    identifier: "ADE-123",
    title: "Attach Linear context to chat",
    description: "Use this issue as prompt context.",
    url: "https://linear.app/ade/issue/ADE-123/attach-linear-context-to-chat",
    projectId: "project-1",
    projectSlug: "ade",
    projectName: "ADE",
    teamId: "team-1",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "state-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    priorityLabel: "high",
    labels: ["desktop"],
    assigneeId: "user-1",
    assigneeName: "Arul",
    ownerId: "user-1",
    creatorId: "user-2",
    creatorName: "Annie",
    blockerIssueIds: [],
    hasOpenBlockers: false,
    dueDate: null,
    estimate: null,
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    raw: {},
    ...overrides,
  };
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

    const stopButtons = screen.getAllByLabelText("Stop active turn");
    fireEvent.click(stopButtons[stopButtons.length - 1]!);

    expect(props.onInterrupt).toHaveBeenCalledTimes(1);
    expect(props.onClearDraft).not.toHaveBeenCalled();
  });

  it("renders and removes a macOS VM target chip", () => {
    const onRemoveMacosVmContext = vi.fn();
    const view = renderComposer({
      turnActive: false,
      draft: "",
      macosVmContextItems: [{
        kind: "macos_vm_target",
        id: "vm-target-1",
        laneId: "lane-1",
        laneName: "Lane One",
        vmName: "ade-lane-one",
        provider: "lume",
        state: "running",
        hostLanePath: "/repo/.ade/worktrees/lane-one",
        guestLanePath: "/Volumes/My Shared Files",
        runCommand: "lume run ade-lane-one --shared-dir /repo/.ade/worktrees/lane-one",
        sshCommand: null,
        vncUrl: null,
        windowTitleQuery: "ade-lane-one",
        selectedAt: "2026-05-07T00:00:00.000Z",
        metadata: {},
      }],
      onRemoveMacosVmContext,
    });

    expect(screen.getByText("ade-lane-one")).toBeTruthy();
    fireEvent.click(screen.getByText("ade-lane-one"));
    expect(screen.getByText("/Volumes/My Shared Files")).toBeTruthy();

    const remove = view.container.querySelector("[data-macos-vm-remove='true']");
    expect(remove).toBeTruthy();
    fireEvent.click(remove as Element);
    expect(onRemoveMacosVmContext).toHaveBeenCalledWith("vm-target-1");
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
    expect(screen.getByRole("option", { name: /Auto/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Accept edits/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Plan mode/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Bypass permissions/ })).toBeTruthy();
  });

  it("routes Claude auto through the native permission callback", () => {
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
    fireEvent.click(screen.getByRole("option", { name: /Auto/ }));

    expect(onInteractionModeChange).toHaveBeenCalledWith("default");
    expect(onClaudePermissionModeChange).toHaveBeenCalledWith("auto");
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

  it("toggles Codex fast mode for supported models", () => {
    const onCodexFastModeChange = vi.fn();
    renderComposer({
      sessionProvider: "codex",
      modelId: "openai/gpt-5.5",
      availableModelIds: ["openai/gpt-5.5"],
      codexFastMode: false,
      onCodexFastModeChange,
    });

    const fastButton = screen.getByRole("button", { name: "Fast mode" });
    expect(fastButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(fastButton);

    expect(onCodexFastModeChange).toHaveBeenCalledWith(true);
  });

  it("hides Codex fast mode for unsupported models", () => {
    renderComposer({
      sessionProvider: "codex",
      modelId: "openai/gpt-5.4-mini",
      availableModelIds: ["openai/gpt-5.4-mini"],
      codexFastMode: true,
    });

    expect(screen.queryByRole("button", { name: "Fast mode" })).toBeNull();
  });

  it("renders Droid autonomy controls without OpenCode permission labels", () => {
    const onDroidPermissionModeChange = vi.fn();
    renderComposer({
      sessionProvider: "droid",
      modelId: "droid/gpt-5.2",
      availableModelIds: ["droid/gpt-5.2"],
      droidPermissionMode: "auto-low",
      onDroidPermissionModeChange,
    });

    const autonomySelect = screen.getByRole("combobox", { name: "Autonomy" }) as HTMLSelectElement;
    expect(Array.from(autonomySelect.options).map((option) => option.value)).toEqual([
      "read-only",
      "auto-low",
      "auto-medium",
      "auto-high",
    ]);
    expect(screen.queryByRole("combobox", { name: "Permissions" })).toBeNull();

    fireEvent.change(autonomySelect, { target: { value: "auto-high" } });

    expect(onDroidPermissionModeChange).toHaveBeenCalledWith("auto-high");
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

    expect(screen.getByText("Answer in the inline question card, or decline.")).toBeTruthy();
    expect(screen.queryByText("Answer in the inline question card, or pick an option there.")).toBeNull();
  });

  it("locks the prompt box while a pending question is waiting", () => {
    const props = renderComposer({
      pendingInput: {
        requestId: "req-lock",
        itemId: "item-lock",
        source: "claude",
        kind: "question",
        title: "Input needed",
        description: "What should we do next?",
        questions: [{
          id: "answer",
          header: "Question 1",
          question: "What should we do next?",
          allowsFreeform: true,
        }],
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        turnId: null,
      },
    });

    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textbox.disabled).toBe(true);
    expect(textbox.placeholder).toBe("Answer the question card above, or decline it.");
    expect(screen.queryByLabelText("Send steer message")).toBeNull();
    expect((screen.getByLabelText("Open attachment picker") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Upload file from disk") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Open command picker") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(props.onApproval).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
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

    expect((screen.getByLabelText("Open attachment picker") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("Upload file from disk") as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows attachments while steering an active Claude turn", () => {
    renderComposer({
      turnActive: true,
      sessionProvider: "claude",
      modelId: "anthropic/claude-sonnet-4-6",
      availableModelIds: ["anthropic/claude-sonnet-4-6"],
    });

    expect((screen.getByLabelText("Open attachment picker") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("Upload file from disk") as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows attachments while steering an active Cursor turn", () => {
    renderComposer({
      turnActive: true,
      sessionProvider: "cursor",
      modelId: "cursor/auto",
      availableModelIds: ["cursor/auto"],
    });

    expect((screen.getByLabelText("Open attachment picker") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("Upload file from disk") as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows attachments while steering an active OpenCode turn", () => {
    renderComposer({
      turnActive: true,
      sessionProvider: "opencode",
      modelId: "opencode/openai/gpt-5.4",
      availableModelIds: ["opencode/openai/gpt-5.4"],
    });

    expect((screen.getByLabelText("Open attachment picker") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("Upload file from disk") as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders the issue context menu outside the clipped composer shell", () => {
    const { container } = renderComposer({
      draft: "",
      turnActive: false,
      onAddContextAttachment: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Attach issue context" }));

    const menu = document.body.querySelector("[data-issue-context-menu]");
    const composerShell = container.querySelector("[data-chat-composer-mode]");
    expect(menu).toBeTruthy();
    expect(menu?.parentElement).toBe(document.body);
    expect(composerShell?.contains(menu)).toBe(false);
    expect((menu as HTMLElement).className).toContain("fixed");
  });

  it("offers Linear settings when issue search needs a connection", async () => {
    const onOpenLinearSettings = vi.fn();
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        cto: {
          getLinearIssuePickerData: vi.fn().mockResolvedValue({
            projects: [],
            users: [],
            states: [],
          }),
          searchLinearIssues: vi.fn().mockRejectedValue(new Error("Linear token missing. Set it in Settings > Linear.")),
        },
      },
    });

    renderComposer({
      draft: "",
      turnActive: false,
      onAddContextAttachment: vi.fn(),
      onOpenLinearSettings,
    });

    fireEvent.click(screen.getByRole("button", { name: "Attach issue context" }));
    fireEvent.click(screen.getByRole("button", { name: /Linear issue/i }));

    await screen.findByText(/Linear token missing/i);
    fireEvent.click(screen.getByRole("button", { name: "Open Linear settings" }));

    expect(onOpenLinearSettings).toHaveBeenCalledTimes(1);
  });

  it("attaches Linear issue context from the issue dropdown", async () => {
    const issue = makeLinearIssue();
    const onAddContextAttachment = vi.fn();
    const searchLinearIssues = vi.fn().mockResolvedValue({
      issues: [issue],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        cto: {
          getLinearIssuePickerData: vi.fn().mockResolvedValue({
            projects: [{ id: "project-1", name: "ADE", slug: "ade", teamName: "ADE", teamKey: "ADE" }],
            users: [{ id: "user-1", name: "arul", displayName: "Arul", email: "arul@example.com", active: true }],
            states: [{ id: "state-1", name: "In Progress", type: "started", teamId: "team-1", teamKey: "ADE" }],
          }),
          searchLinearIssues,
        },
      },
    });

    renderComposer({
      draft: "",
      turnActive: false,
      onAddContextAttachment,
    });

    fireEvent.click(screen.getByRole("button", { name: "Attach issue context" }));
    fireEvent.click(screen.getByRole("button", { name: /Linear issue/i }));

    await waitFor(() => expect(searchLinearIssues).toHaveBeenCalled());
    const issueIdentifier = (await screen.findAllByText("ADE-123"))[0]!;
    const issueRow = issueIdentifier.closest("button");
    expect(issueRow).toBeTruthy();
    fireEvent.click(issueRow!);
    fireEvent.click(screen.getByRole("button", { name: "Attach issue" }));

    await waitFor(() => {
      expect(onAddContextAttachment).toHaveBeenCalledTimes(1);
    });
    expect(onAddContextAttachment.mock.calls[0]?.[0]).toMatchObject({
      type: "linear_issue",
      source: "manual",
      issue: {
        id: "issue-1",
        identifier: "ADE-123",
        title: "Attach Linear context to chat",
        projectSlug: "ade",
      },
    });
  });

  it("keeps appended Linear issue search pages loaded", async () => {
    const firstIssue = makeLinearIssue();
    const secondIssue = makeLinearIssue({
      id: "issue-2",
      identifier: "ADE-124",
      title: "Second page issue",
    });
    const searchLinearIssues = vi.fn().mockImplementation(async (args: { after?: string | null }) => {
      if (args.after === "cursor-1") {
        return {
          issues: [secondIssue],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      }
      return {
        issues: [firstIssue],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      };
    });
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        cto: {
          getLinearIssuePickerData: vi.fn().mockResolvedValue({
            projects: [],
            users: [],
            states: [],
          }),
          searchLinearIssues,
        },
      },
    });

    renderComposer({
      draft: "",
      turnActive: false,
      onAddContextAttachment: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Attach issue context" }));
    fireEvent.click(screen.getByRole("button", { name: /Linear issue/i }));

    await waitFor(() => expect(screen.getAllByText("ADE-123").length).toBeGreaterThan(0));
    await new Promise((resolve) => window.setTimeout(resolve, 260));
    expect(searchLinearIssues).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByText("ADE-124").length).toBeGreaterThan(0));
    expect(searchLinearIssues).toHaveBeenLastCalledWith(expect.objectContaining({ after: "cursor-1" }));
    await new Promise((resolve) => window.setTimeout(resolve, 260));

    expect(searchLinearIssues).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("ADE-123").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ADE-124").length).toBeGreaterThan(0);
  });

  it("attaches a native clipboard image when macOS Cmd+V does not expose paste files", async () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const readClipboardImage = vi.fn().mockResolvedValue({
      data: "abc123",
      filename: "clipboard.png",
      mimeType: "image/png",
    });
    const saveTempAttachment = vi.fn().mockResolvedValue({ path: "/tmp/ade-clipboard.png" });
    (window as any).ade = {
      app: { readClipboardImage },
      agentChat: { saveTempAttachment },
    };

    try {
      const props = renderComposer({
        turnActive: false,
        draft: "",
      });

      fireEvent.keyDown(screen.getByPlaceholderText("Type to vibecode..."), {
        key: "v",
        metaKey: true,
      });

      await waitFor(() => expect(readClipboardImage).toHaveBeenCalledTimes(1));
      expect(saveTempAttachment).toHaveBeenCalledWith({
        data: "abc123",
        filename: "clipboard.png",
      });
      expect(props.onAddAttachment).toHaveBeenCalledWith({
        path: "/tmp/ade-clipboard.png",
        type: "image",
      });
    } finally {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("clears the drop highlight when a URL drop is rejected", async () => {
    const props = renderComposer({
      turnActive: false,
      draft: "",
    });
    const rejectedUrlDrop = {
      files: [],
      types: ["text/uri-list"],
      getData: vi.fn((type: string) => (
        type === "text/uri-list" ? "https://example.com/page" : ""
      )),
    };
    const input = screen.getByPlaceholderText("Type to vibecode...");

    fireEvent.dragOver(input, { dataTransfer: rejectedUrlDrop });
    expect(screen.getByText("Drop files to attach")).toBeTruthy();

    fireEvent.drop(input, { dataTransfer: rejectedUrlDrop });

    await waitFor(() => expect(screen.queryByText("Drop files to attach")).toBeNull());
    expect(props.onAddAttachment).not.toHaveBeenCalled();
  });

  it("does not attach URLs whose image extension appears only in query text", () => {
    const props = renderComposer({
      turnActive: false,
      draft: "",
    });
    const clipboardData = {
      files: [],
      items: [],
      getData: vi.fn((type: string) => (
        type === "text/uri-list" || type === "text/plain"
          ? "https://example.com/api/asset?file=hero.png"
          : ""
      )),
    };

    const pasteAllowed = fireEvent.paste(screen.getByPlaceholderText("Type to vibecode..."), {
      clipboardData,
    });

    expect(pasteAllowed).toBe(true);
    expect(props.onAddAttachment).not.toHaveBeenCalled();
    expect(screen.queryByText("Image URL attached")).toBeNull();
  });

  it("hides native permission controls until a model is selected", () => {
    const props = buildComposerProps({
      modelId: "",
      availableModelIds: ["opencode/openai/gpt-5.4"],
      sessionProvider: "opencode",
    });
    const view = render(<AgentChatComposer {...props} />);
    expect(screen.queryByRole("combobox", { name: "Permissions" })).toBeNull();

    view.rerender(<AgentChatComposer {...props} modelId="opencode/openai/gpt-5.4" />);
    expect(screen.getByRole("combobox", { name: "Permissions" })).toBeTruthy();
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

  it("uses a contextual accessible name for active turn textareas", () => {
    renderComposer({
      draft: "",
      turnActive: true,
      messagePlaceholder: "Message the mission orchestrator...",
    });

    const textarea = screen.getByRole("textbox", {
      name: "Steer active turn: Message the mission orchestrator",
    }) as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("Steer the active turn...");
  });

  it("uses a contextual accessible name for active rich composers", () => {
    renderComposer({
      draft: "",
      turnActive: true,
      messagePlaceholder: "Message this mission worker...",
      iosElementContextItems: [
        {
          kind: "ios_element",
          id: "button-1",
          componentId: "PrimaryButton",
          sourceFile: null,
          sourceLine: null,
          frame: null,
          metadata: { label: "Primary" },
          selectedAt: "2026-05-07T00:00:00.000Z",
        },
      ],
    });

    expect(screen.getByRole("textbox", {
      name: "Steer active turn: Message this mission worker",
    })).toBeTruthy();
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
        { modelId: "openai/gpt-5.4", reasoningEffort: "high" },
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
