/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import type { ComponentProps } from "react";
import type {
  IosElementContextItem,
  NormalizedLinearIssue,
  OpenProjectBinding,
} from "../../../shared/types";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import {
  LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
  formatAttachmentSize,
} from "../../../shared/chatAttachmentLimits";
import {
  AgentChatComposer,
  HEIC_CONVERSION_UNAVAILABLE_MESSAGE,
} from "./AgentChatComposer";
import { useAppStore } from "../../state/appStore";
import {
  resetBuiltinSurfacePlugins,
  seedBuiltinSurfacePlugins,
} from "../../../test/builtinSurfaces";
import { formatChatOutputContextBlock } from "../../../shared/chatOutputContext";

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
    Github: brand(),
    GithubCopilot: brand(),
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
  // Issue context has a Linear half and a core GitHub half. Only the Linear
  // half is a plugin surface; these tests describe a machine that has it.
  seedBuiltinSurfacePlugins(["linear"]);
});

afterEach(() => {
  cleanup();
  resetBuiltinSurfacePlugins();
  useAppStore.setState({ promptStashButtonEnabled: true });
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

function installPromptStashBridge(promptStashes: Record<string, unknown>) {
  const previousAde = (window as any).ade ?? {};
  (window as any).ade = {
    ...previousAde,
    agentChat: {
      ...(previousAde.agentChat ?? {}),
      promptStashes,
    },
  };
}

const CAPTION_FREE_PERMISSION_CASES: Array<{
  provider: string;
  triggerName: string;
  optionCount: number;
  overrides: Partial<ComponentProps<typeof AgentChatComposer>>;
}> = [
  {
    provider: "Claude",
    triggerName: "Claude permission mode",
    optionCount: 5,
    overrides: {
      sessionProvider: "claude",
      modelId: "anthropic/claude-sonnet-5",
      availableModelIds: ["anthropic/claude-sonnet-5"],
    },
  },
  {
    provider: "Codex",
    triggerName: "Codex permission mode",
    optionCount: 5,
    overrides: { sessionProvider: "codex" },
  },
  {
    provider: "Cursor",
    triggerName: "Cursor mode",
    optionCount: 4,
    overrides: {
      sessionProvider: "cursor",
      modelId: "cursor/auto",
      availableModelIds: ["cursor/auto"],
      cursorModeSnapshot: {
        currentModeId: "agent",
        availableModeIds: ["agent", "ask", "plan", "full-auto"],
      },
      onCursorModeChange: vi.fn(),
    },
  },
  {
    provider: "Droid",
    triggerName: "Droid autonomy mode",
    optionCount: 5,
    overrides: {
      sessionProvider: "droid",
      modelId: "droid/gpt-5.2",
      availableModelIds: ["droid/gpt-5.2"],
      onDroidPermissionModeChange: vi.fn(),
    },
  },
  {
    provider: "OpenCode",
    triggerName: "OpenCode permission mode",
    optionCount: 4,
    overrides: {
      sessionProvider: "opencode",
      modelId: "opencode/openai/gpt-5.4",
      availableModelIds: ["opencode/openai/gpt-5.4"],
    },
  },
];

function makeIosContextItem(id: string): IosElementContextItem {
  return {
    kind: "ios_element",
    id,
    componentId: `Component-${id}`,
    sourceFile: "Sources/App/ContentView.swift",
    sourceLine: 12,
    frame: null,
    metadata: {},
    selectedAt: "2026-07-26T00:00:00.000Z",
  };
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

/**
 * Issue context lives in the composer's overflow control, which renders as a
 * plain button when it holds a single entry and as a menu when it holds more.
 * Tests care about reaching it, not about which form it took.
 */
function openIssueContext() {
  const inline = screen.queryByRole("button", { name: "Issue context" });
  if (inline) {
    fireEvent.click(inline);
    return;
  }
  fireEvent.click(screen.getByRole("button", { name: "More composer controls" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Issue context/ }));
}

describe("AgentChatComposer", () => {
  it("re-resolves credentialed smart-link previews when the composer is reused", async () => {
    const url = "https://github.com/arul28/ADE/pull/835";
    const resolveSmartLinkPreview = vi.fn()
      .mockResolvedValueOnce({
        url,
        provider: "github",
        kind: "github_pr",
        label: "arul28/ADE#835",
        title: "First project title",
      })
      .mockResolvedValueOnce({
        url,
        provider: "github",
        kind: "github_pr",
        label: "arul28/ADE#835",
        title: "Second project title",
      });
    (window as any).ade = { agentChat: { resolveSmartLinkPreview } };
    const props = buildComposerProps({ draft: url, turnActive: false });
    const view = render(<AgentChatComposer {...props} />);

    await waitFor(() => expect(resolveSmartLinkPreview).toHaveBeenCalledTimes(1));
    view.rerender(<AgentChatComposer {...props} draft="" />);
    await waitFor(() => expect(screen.getByRole("textbox").textContent).toBe(""));
    view.rerender(<AgentChatComposer {...props} draft={url} />);

    await waitFor(() => expect(resolveSmartLinkPreview).toHaveBeenCalledTimes(2));
  });

  it("renders a real GitHub brand mark instead of a text monogram on github chips", async () => {
    const url = "https://github.com/arul28/ADE/pull/835";
    const resolveSmartLinkPreview = vi.fn().mockResolvedValue({
      url,
      provider: "github",
      kind: "github_pr",
      label: "arul28/ADE#835",
    });
    (window as any).ade = { agentChat: { resolveSmartLinkPreview } };
    const props = buildComposerProps({ draft: url, turnActive: false });
    const view = render(<AgentChatComposer {...props} />);

    const icon = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>("[data-smart-link-icon]");
      if (!el) throw new Error("smart-link icon not rendered yet");
      return el;
    });
    // A real logo SVG, never the "GH" fallback monogram.
    expect(icon.querySelector("svg")).toBeTruthy();
    expect(icon.textContent ?? "").not.toContain("GH");
  });

  it("keeps the rich smart-link editor left-aligned so a pasted link never centers the composer", () => {
    const url = "https://github.com/arul28/ADE/pull/835";
    (window as any).ade = {
      agentChat: {
        resolveSmartLinkPreview: vi.fn().mockResolvedValue({
          url,
          provider: "github",
          kind: "github_pr",
          label: "arul28/ADE#835",
        }),
      },
    };
    const props = buildComposerProps({ draft: url, turnActive: false });
    render(<AgentChatComposer {...props} />);

    // The contenteditable must carry an explicit text-left; otherwise it
    // inherits text-align:center from centered empty-state ancestors when a
    // paste swaps the textarea for this rich editor.
    expect(screen.getByRole("textbox").className).toContain("text-left");
  });

  it("hydrates highlighted assistant output as an inline Chat context chip", async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    (window as any).ade = { app: { writeClipboardText } };
    const block = formatChatOutputContextBlock("retry the lane checkout")!;
    const view = render(<AgentChatComposer {...buildComposerProps({
      draft: `please ${block} thanks`,
      turnActive: false,
    })} />);

    const chip = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>("[data-composer-chip='chat-context']");
      if (!el) throw new Error("chat context chip not rendered");
      return el;
    });
    expect(chip.textContent).toContain("Chat context");
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy/ }));
    expect(writeClipboardText).toHaveBeenCalledWith("retry the lane checkout");
  });

  it("clear draft only triggers the draft-clear action during an active turn", () => {
    const props = renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(props.onClearDraft).toHaveBeenCalledTimes(1);
    expect(props.onInterrupt).not.toHaveBeenCalled();
  });

  it("stashes the current prompt with Cmd+S even when its appearance button is hidden", async () => {
    useAppStore.setState({ promptStashButtonEnabled: false });
    const created = {
      id: "stash-1",
      text: "Need a steer message",
      provider: "codex",
      modelId: "openai/gpt-5.4",
      createdAt: "2026-07-28T12:00:00.000Z",
    };
    const create = vi.fn().mockResolvedValue(created);
    installPromptStashBridge({
      list: vi.fn().mockResolvedValue([]),
      create,
      delete: vi.fn().mockResolvedValue(true),
    });
    const props = renderComposer();

    expect(screen.queryByRole("button", { name: "Stash prompt" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "s", metaKey: true });

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      text: "Need a steer message",
      provider: "codex",
      modelId: "openai/gpt-5.4",
    }, null));
    expect(props.onDraftChange).toHaveBeenCalledWith("");
  });

  it("threads the effective composer binding through the complete image stash operation", async () => {
    const composerMachineBinding: OpenProjectBinding = {
      kind: "remote" as const,
      key: "remote:source-machine:source-project",
      targetId: "source-machine",
      runtimeName: "Source Mac",
      projectId: "source-project",
      rootPath: "/remote/source-project",
      displayName: "Source project",
    };
    const sourceAttachment = {
      path: "/remote/source-project/design.png",
      type: "image" as const,
    };
    const storedAttachment = {
      path: "/bound-project/.ade/attachments/design.png",
      type: "image" as const,
    };
    const getImageDataUrl = vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,cHJldmlldw==",
    });
    const saveTempAttachment = vi.fn().mockResolvedValue({
      path: storedAttachment.path,
    });
    const createPromptStash = vi.fn().mockResolvedValue({
      id: "stash-image",
      text: "Need a steer message",
      provider: "codex",
      modelId: "openai/gpt-5.4",
      attachments: [storedAttachment],
      createdAt: "2026-07-28T12:00:00.000Z",
    });
    (window as any).ade = {
      agentChat: {
        promptStashes: {
          list: vi.fn().mockResolvedValue([]),
          create: createPromptStash,
          delete: vi.fn().mockResolvedValue(true),
        },
        getImageDataUrl,
        saveTempAttachment,
      },
    };

    renderComposer({
      attachments: [sourceAttachment],
      composerMachineBinding,
    });
    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));

    await waitFor(() => expect(getImageDataUrl).toHaveBeenCalledWith(
      sourceAttachment.path,
      composerMachineBinding,
    ));
    await waitFor(() => expect(createPromptStash).toHaveBeenCalledWith({
      text: "Need a steer message",
      provider: "codex",
      modelId: "openai/gpt-5.4",
      attachments: [storedAttachment],
    }, composerMachineBinding));
    expect(getImageDataUrl.mock.calls).toContainEqual([
      sourceAttachment.path,
      composerMachineBinding,
    ]);
    expect(saveTempAttachment.mock.calls).toEqual([[
      {
        data: "cHJldmlldw==",
        filename: "design.png",
      },
      composerMachineBinding,
    ]]);
  });

  it("moves a queued steer message back to the composer for editing", () => {
    const onEditSteer = vi.fn();
    const attachments = [{ path: "docs/queued.md", type: "file" as const }];
    renderComposer({
      pendingSteers: [{
        steerId: "steer-1",
        text: "Queued one",
        attachments,
        contextAttachments: [],
      }],
      onEditSteer,
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));

    expect(onEditSteer).toHaveBeenCalledWith("steer-1", "Queued one", attachments, []);
    expect(screen.queryByDisplayValue("Queued one")).toBeNull();
  });

  it("removes a queued steer message", () => {
    const onCancelSteer = vi.fn();
    renderComposer({
      pendingSteers: [{
        steerId: "steer-1",
        text: "Queued one",
        attachments: [],
        contextAttachments: [],
      }],
      onCancelSteer,
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove queued message" }));

    expect(onCancelSteer).toHaveBeenCalledWith("steer-1");
  });

  const CLAUDE_STEER_OVERRIDES = {
    sessionProvider: "claude" as const,
    modelId: "anthropic/claude-sonnet-5",
    availableModelIds: ["anthropic/claude-sonnet-5"],
  };

  it("primary send folds the draft into the running Claude turn", () => {
    const onSendSteerNow = vi.fn();
    renderComposer({
      ...CLAUDE_STEER_OVERRIDES,
      onSendSteerNow,
      onSendSteerInterrupt: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Send during turn" }));

    expect(onSendSteerNow).toHaveBeenCalledTimes(1);
  });

  it("split-button menu selects what the primary send action will do", () => {
    const onSubmit = vi.fn();
    const onSendSteerNow = vi.fn();
    const onSendSteerInterrupt = vi.fn();
    const view = renderComposer({
      ...CLAUDE_STEER_OVERRIDES,
      onSubmit,
      onSendSteerNow,
      onSendSteerInterrupt,
    });

    fireEvent.click(screen.getByRole("button", { name: "More send options" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Send after turn/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSendSteerInterrupt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send after turn" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "More send options" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Interrupt & send/ }));
    expect(onSendSteerInterrupt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Interrupt & send" }));
    expect(onSendSteerInterrupt).toHaveBeenCalledTimes(1);

    view.rerender(<AgentChatComposer {...buildComposerProps({
      ...CLAUDE_STEER_OVERRIDES,
      onSubmit,
      onSendSteerNow,
      onSendSteerInterrupt: undefined,
    })} />);
    expect(screen.getByRole("button", { name: "Send during turn" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More send options" }));
    expect(screen.queryByRole("menuitemradio", { name: /Interrupt & send/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send during turn" }));
    expect(onSendSteerNow).toHaveBeenCalledTimes(1);
  });

  it("keeps Claude steering options compact and concise", () => {
    renderComposer({
      ...CLAUDE_STEER_OVERRIDES,
      onSendSteerNow: vi.fn(),
      onSendSteerInterrupt: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "More send options" }));

    const menu = screen.getByRole("menu", { name: "Send options" });
    expect(menu.style.width).toBe("240px");
    expect(menu.textContent).toContain("After the current tool step.");
    expect(menu.textContent).toContain("When this turn finishes.");
    expect(menu.textContent).toContain("Stop and redirect Claude now.");
  });

  const CURSOR_STEER_OVERRIDES = {
    sessionProvider: "cursor" as const,
    modelId: "cursor/composer-2",
    availableModelIds: ["cursor/composer-2"],
  };

  it("offers Cursor only interrupt-and-continue plus queue, with interrupt selected by default", () => {
    const onSendSteerInterrupt = vi.fn();
    renderComposer({
      ...CURSOR_STEER_OVERRIDES,
      // Cursor has no inline dispatch: the host would reject it.
      onSendSteerNow: undefined,
      onSendSteerInterrupt,
    });

    // The default mode is the redirect, so it is what the primary button runs.
    fireEvent.click(screen.getByRole("button", { name: "Interrupt & continue" }));
    expect(onSendSteerInterrupt).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "More send options" }));
    const options = screen.getAllByRole("menuitemradio").map((item) => item.textContent ?? "");
    expect(options).toHaveLength(2);
    expect(options[0]).toContain("Interrupt & continue");
    expect(options[1]).toContain("Send after turn");
    expect(screen.queryByRole("menuitemradio", { name: /Send during turn/ })).toBeNull();
    expect(screen.getByRole("menu", { name: "Send options" }).textContent)
      .toContain("Stop and redirect Cursor now.");
  });

  it("falls back to queueing when the picked model's provider offers a mode the live session cannot dispatch", () => {
    // A Cursor session with a Claude model picked mid-turn: the composer's
    // capability follows the *picked* provider (Claude, whose default is
    // "send during turn") while the wired handlers follow the *session*
    // (Cursor, which has no inline dispatch). The draft must still go
    // somewhere — it queues rather than silently disappearing.
    const onSubmit = vi.fn();
    const onSendSteerInterrupt = vi.fn();
    renderComposer({
      ...CLAUDE_STEER_OVERRIDES,
      onSubmit,
      onSendSteerNow: undefined,
      onSendSteerInterrupt,
    });

    // No dead "Send during turn" affordance: the mode downgraded to queue.
    expect(screen.queryByRole("button", { name: "Send during turn" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send after turn" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSendSteerInterrupt).not.toHaveBeenCalled();

    // Enter takes the same route.
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(2);

    // And the menu never offers the mode that has nowhere to go.
    fireEvent.click(screen.getByRole("button", { name: "More send options" }));
    expect(screen.queryByRole("menuitemradio", { name: /Send during turn/ })).toBeNull();
  });

  it("keeps all three delivery modes on Claude", () => {
    renderComposer({
      ...CLAUDE_STEER_OVERRIDES,
      onSendSteerNow: vi.fn(),
      onSendSteerInterrupt: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "Send during turn" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More send options" }));
    const options = screen.getAllByRole("menuitemradio").map((item) => item.textContent ?? "");
    expect(options).toHaveLength(3);
    expect(options[0]).toContain("Send during turn");
    expect(options[2]).toContain("Interrupt & send");
  });

  it("disables the active-turn send actions when the draft is whitespace-only", () => {
    const onSendSteerNow = vi.fn();
    renderComposer({
      ...CLAUDE_STEER_OVERRIDES,
      draft: "   ",
      onSendSteerNow,
      onSendSteerInterrupt: vi.fn(),
    });

    const sendNow = screen.getByRole("button", { name: "Send during turn" }) as HTMLButtonElement;
    expect(sendNow.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "More send options" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(sendNow);
    expect(onSendSteerNow).not.toHaveBeenCalled();
  });

  it("routes Enter to the selected active-turn send mode", () => {
    const onSendSteerNow = vi.fn();
    const onSubmit = vi.fn();
    renderComposer({
      ...CLAUDE_STEER_OVERRIDES,
      onSendSteerNow,
      onSendSteerInterrupt: vi.fn(),
      onSubmit,
    });

    fireEvent.click(screen.getByRole("button", { name: "More send options" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Send after turn/ }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSendSteerNow).not.toHaveBeenCalled();
  });

  it("accepts the prompt suggestion with Tab", () => {
    const onDraftChange = vi.fn();
    renderComposer({
      turnActive: false,
      draft: "",
      promptSuggestion: "Audit the Work tab",
      onDraftChange,
    });

    const textbox = screen.getByRole("textbox");
    expect(textbox.getAttribute("placeholder")).toBe("Audit the Work tab");

    fireEvent.keyDown(textbox, { key: "Tab" });

    expect(onDraftChange).toHaveBeenCalledWith("Audit the Work tab");
  });

  it("selects a slash command from the command picker", async () => {
    const onDraftChange = vi.fn();
    const { container } = renderComposer({
      turnActive: false,
      draft: "",
      onDraftChange,
      sdkSlashCommands: [{
        name: "status",
        description: "Summarize current state",
        source: "sdk",
      }],
    });

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/", selectionStart: 1 },
    });
    const statusCommand = await screen.findByText("/status");
    const menu = statusCommand.closest(".ade-chat-drawer-glass");
    const composerShell = container.querySelector("[data-chat-composer-mode]");
    expect(menu?.className).toContain("fixed");
    expect(menu?.parentElement).toBe(document.body);
    expect(composerShell?.contains(menu)).toBe(false);
    expect((menu as HTMLElement | null)?.style.width).toBe("420px");
    fireEvent.click(statusCommand);

    expect(onDraftChange).toHaveBeenCalledWith("/status ");
  });

  it("shows slash commands when typing a leading slash", async () => {
    renderComposer({
      turnActive: false,
      draft: "",
      sdkSlashCommands: [{
        name: "status",
        description: "Summarize current state",
        source: "sdk",
      }],
    });

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/st", selectionStart: 3 },
    });

    expect(await screen.findByText("/status")).toBeTruthy();
  });

  it("shows a slash command hint for a bare slash before commands are available", async () => {
    const { container } = renderComposer({
      turnActive: false,
      draft: "",
      sdkSlashCommands: [],
    });

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/", selectionStart: 1 },
    });

    const hint = await screen.findByText("Type to search commands");
    const menu = hint.closest(".ade-chat-drawer-glass");
    const composerShell = container.querySelector("[data-chat-composer-mode]");
    expect(menu?.parentElement).toBe(document.body);
    expect(composerShell?.contains(menu)).toBe(false);
  });

  it("shows file matches when typing an at-command", async () => {
    const onSearchAttachments = vi.fn().mockResolvedValue([{ path: "src/App.tsx", type: "file" }]);

    renderComposer({
      turnActive: false,
      draft: "",
      sessionId: "session-1",
      onSearchAttachments,
    });

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "@src", selectionStart: 4 },
    });

    await waitFor(() => {
      expect(onSearchAttachments).toHaveBeenCalledWith("src");
    });
    expect(await screen.findByText("App.tsx")).toBeTruthy();
  });

  it("keeps an exact file match available after trailing prose", async () => {
    const onSearchAttachments = vi.fn().mockResolvedValue([{ path: "src/foo.ts", type: "file" }]);

    renderComposer({
      turnActive: false,
      draft: "",
      sessionId: "session-1",
      onSearchAttachments,
    });

    const draft = "ask @src/foo.ts about this";
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: draft, selectionStart: draft.length },
    });

    await waitFor(() => expect(onSearchAttachments).toHaveBeenCalledWith("src/foo.ts"));
    expect(await screen.findByText("foo.ts")).toBeTruthy();
  });

  it("does not reopen the file menu after a confirmed token and trailing prose", () => {
    const onSearchAttachments = vi.fn().mockResolvedValue([{ path: "src/foo.ts", type: "file" }]);

    renderComposer({
      turnActive: false,
      draft: "",
      sessionId: "session-1",
      attachments: [{ path: "src/foo.ts", type: "file" }],
      onSearchAttachments,
    });

    const draft = "ask @src/foo.ts about this";
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: draft, selectionStart: draft.length },
    });

    expect(document.body.querySelector(".ade-chat-drawer-glass")).toBeNull();
    expect(onSearchAttachments).not.toHaveBeenCalled();
  });

  it("closes the at menu when the query stops matching and keeps typing from reopening it", async () => {
    const onSearchAttachments = vi.fn().mockResolvedValue([]);
    const props = buildComposerProps({
      turnActive: false,
      draft: "",
      sessionId: "session-1",
      onSearchAttachments,
    });
    const view = render(<AgentChatComposer {...props} />);
    const textbox = screen.getByRole("textbox");

    fireEvent.change(textbox, { target: { value: "@cursor", selectionStart: 7 } });
    view.rerender(<AgentChatComposer {...props} draft="@cursor" />);

    await waitFor(() => expect(onSearchAttachments).toHaveBeenCalledWith("cursor"));
    await waitFor(() => expect(document.body.querySelector(".ade-chat-drawer-glass")).toBeNull());

    // The rest of the sentence extends a query that already matched nothing, so
    // the menu must stay gone instead of parking over the composer.
    const draft = "@cursor was the runtime we used";
    fireEvent.change(textbox, { target: { value: draft, selectionStart: draft.length } });
    view.rerender(<AgentChatComposer {...props} draft={draft} />);

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(document.body.querySelector(".ade-chat-drawer-glass")).toBeNull();
  });

  it("keeps the at menu closed after Escape until a new trigger is typed", async () => {
    const onSearchAttachments = vi.fn().mockResolvedValue([{ path: "src/App.tsx", type: "file" }]);
    const props = buildComposerProps({
      turnActive: false,
      draft: "",
      sessionId: "session-1",
      onSearchAttachments,
    });
    const view = render(<AgentChatComposer {...props} />);
    const textbox = screen.getByRole("textbox");

    fireEvent.change(textbox, { target: { value: "@src", selectionStart: 4 } });
    view.rerender(<AgentChatComposer {...props} draft="@src" />);
    expect(await screen.findByText("App.tsx")).toBeTruthy();

    fireEvent.keyDown(textbox, { key: "Escape" });
    await waitFor(() => expect(document.body.querySelector(".ade-chat-drawer-glass")).toBeNull());

    fireEvent.change(textbox, { target: { value: "@src/A", selectionStart: 6 } });
    view.rerender(<AgentChatComposer {...props} draft="@src/A" />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(document.body.querySelector(".ade-chat-drawer-glass")).toBeNull();

    // A brand new @ elsewhere in the draft is a new search, so it opens again.
    const draft = "@src/A and @src";
    fireEvent.change(textbox, { target: { value: draft, selectionStart: draft.length } });
    view.rerender(<AgentChatComposer {...props} draft={draft} />);
    expect(await screen.findByText("App.tsx")).toBeTruthy();
  });

  it("keeps trailing prose when selecting a shorthand file match", async () => {
    const onSearchAttachments = vi.fn().mockResolvedValue([{ path: "src/foo.ts", type: "file" }]);
    const props = buildComposerProps({
      turnActive: false,
      draft: "",
      sessionId: "session-1",
      onSearchAttachments,
    });
    const view = render(<AgentChatComposer {...props} />);
    const draft = "ask @foo.ts about this";

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: draft, selectionStart: draft.length },
    });
    view.rerender(<AgentChatComposer {...props} draft={draft} />);

    await waitFor(() => expect(onSearchAttachments).toHaveBeenCalledWith("foo.ts"));
    fireEvent.click(await screen.findByText("foo.ts"));

    expect(props.onDraftChange).toHaveBeenLastCalledWith("ask @src/foo.ts about this");
  });

  it("keeps an extensionless spaced file path intact before trailing prose", async () => {
    const onSearchAttachments = vi.fn().mockResolvedValue([{ path: "src/my folder", type: "file" }]);

    renderComposer({
      turnActive: false,
      draft: "",
      sessionId: "session-1",
      onSearchAttachments,
    });

    const draft = "ask @src/my folder about this";
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: draft, selectionStart: draft.length },
    });

    await waitFor(() => expect(onSearchAttachments).toHaveBeenCalledWith("src/my folder about this"));
    expect(await screen.findByText("my folder")).toBeTruthy();
  });

  it("preserves trailing prose when selecting an extensionless path prefix", async () => {
    const onSearchAttachments = vi.fn().mockResolvedValue([{ path: "src/my folder", type: "file" }]);
    const props = buildComposerProps({
      turnActive: false,
      draft: "",
      sessionId: "session-1",
      onSearchAttachments,
    });
    const view = render(<AgentChatComposer {...props} />);
    const draft = "ask @src/my review this";

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: draft, selectionStart: draft.length },
    });
    view.rerender(<AgentChatComposer {...props} draft={draft} />);

    await waitFor(() => expect(onSearchAttachments).toHaveBeenCalledWith("src/my review this"));
    fireEvent.click(await screen.findByText("my folder"));

    expect(props.onDraftChange).toHaveBeenLastCalledWith("ask @src/my folder review this");
  });

  it("keeps spaced chat mentions searchable and displays the chat title in the chip", async () => {
    const onSearchMentions = vi.fn().mockResolvedValue([{
      kind: "chat" as const,
      id: "chat-1",
      title: "a b c",
      subtitle: "Primary · codex",
    }]);
    const props = buildComposerProps({
      turnActive: false,
      draft: "",
      onSearchMentions,
    });
    const view = render(<AgentChatComposer {...props} />);
    const textbox = screen.getByRole("textbox");

    fireEvent.change(textbox, {
      target: { value: "@a b c", selectionStart: 6 },
    });
    view.rerender(<AgentChatComposer {...props} draft="@a b c" />);

    await waitFor(() => expect(onSearchMentions).toHaveBeenCalledWith("a b c"));
    fireEvent.click(await waitFor(() => {
      const row = document.querySelector<HTMLElement>("[data-menu-index='0']");
      expect(row?.textContent).toContain("a b c");
      return row!;
    }));

    expect(props.onDraftChange).toHaveBeenLastCalledWith("@chat:chat-1 ");
    view.rerender(<AgentChatComposer {...props} draft="@chat:chat-1 " mentionLabels={{ "@chat:chat-1": "a b c" }} />);

    const chip = await waitFor(() => {
      const node = view.container.querySelector<HTMLElement>("[data-composer-chip='mention']");
      expect(node?.querySelector("[data-composer-chip-label]")?.textContent).toBe("a b c");
      return node!;
    });
    expect(chip.dataset.composerChipKind).toBe("chat");
    expect(chip.className).toContain("max-w-[10.5rem]");
    expect(chip.querySelector("[data-composer-chip-icon]")).not.toBeNull();
  });

  it("restores persisted mention titles after a composer remount", () => {
    const props = buildComposerProps({
      turnActive: false,
      draft: "@chat:chat-1 ",
      mentionLabels: { "@chat:chat-1": "a b c" },
    });
    const first = render(<AgentChatComposer {...props} />);
    expect(first.container.querySelector("[data-composer-chip-label]")?.textContent).toBe("a b c");

    first.unmount();
    const second = render(<AgentChatComposer {...props} />);
    expect(second.container.querySelector("[data-composer-chip-label]")?.textContent).toBe("a b c");
  });

  it("restores persisted mention titles after a rich composer remount", () => {
    const iosContext = {
      kind: "ios_element" as const,
      id: "ios-1",
      componentId: "PrimaryButton",
      sourceFile: null,
      sourceLine: null,
      frame: null,
      metadata: { label: "Primary" },
      selectedAt: "2026-05-07T00:00:00.000Z",
    };
    const props = buildComposerProps({
      turnActive: false,
      draft: "@chat:chat-1 ",
      mentionLabels: { "@chat:chat-1": "a b c" },
      iosElementContextItems: [iosContext],
    });
    const first = render(<AgentChatComposer {...props} />);
    expect(first.container.querySelector("[data-composer-chip='mention']")?.querySelector("[data-composer-chip-label]")?.textContent).toBe("a b c");

    first.unmount();
    const second = render(<AgentChatComposer {...props} />);
    expect(second.container.querySelector("[data-composer-chip='mention']")?.querySelector("[data-composer-chip-label]")?.textContent).toBe("a b c");
  });

  it("falls back to the canonical mention token when a persisted rich mention label is cleared", () => {
    const props = buildComposerProps({
      turnActive: false,
      draft: "@chat:chat-1 ",
      mentionLabels: { "@chat:chat-1": "a b c" },
      iosElementContextItems: [makeIosContextItem("ios-1")],
    });
    const view = render(<AgentChatComposer {...props} />);
    const chip = () => view.container.querySelector<HTMLElement>("[data-composer-chip='mention']");

    expect(chip()?.querySelector("[data-composer-chip-label]")?.textContent).toBe("a b c");
    view.rerender(<AgentChatComposer {...props} mentionLabels={{}} />);

    expect(chip()?.querySelector("[data-composer-chip-label]")?.textContent).toBe("@chat:chat-1");
    expect(chip()?.title).toBe("@chat:chat-1");
  });

  it("does not consume prose after a matching spaced chat mention", async () => {
    const onSearchMentions = vi.fn().mockResolvedValue([{
      kind: "chat" as const,
      id: "chat-1",
      title: "a b c",
    }]);
    const props = buildComposerProps({
      turnActive: false,
      draft: "",
      onSearchMentions,
    });
    const view = render(<AgentChatComposer {...props} />);
    const textbox = screen.getByRole("textbox");
    const draft = "ask @a b c about this";

    fireEvent.change(textbox, {
      target: { value: draft, selectionStart: draft.length },
    });
    view.rerender(<AgentChatComposer {...props} draft={draft} />);

    fireEvent.click(await waitFor(() => {
      const row = document.querySelector<HTMLElement>("[data-menu-index='0']");
      expect(row?.textContent).toContain("a b c");
      return row!;
    }));

    expect(props.onDraftChange).toHaveBeenLastCalledWith("ask @chat:chat-1 about this");
  });

  it("uses lane attachment search for at-command suggestions before a session exists", async () => {
    const onSearchAttachments = vi.fn().mockResolvedValue([{ path: "docs/README.md", type: "file" }]);

    renderComposer({
      turnActive: false,
      draft: "",
      sessionId: null,
      onSearchAttachments,
    });

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "@read", selectionStart: 5 },
    });

    await waitFor(() => {
      expect(onSearchAttachments).toHaveBeenCalledWith("read");
    });
    expect(screen.queryByText("File search unavailable for this session")).toBeNull();
    expect(await screen.findByText("README.md")).toBeTruthy();
  });

  it("does not reuse cached at-command suggestions when attachment search changes", async () => {
    const laneSearch = vi.fn().mockResolvedValue([{ path: "lane-a/AOnly.tsx", type: "file" }]);
    const sessionSearch = vi.fn().mockResolvedValue([{ path: "lane-b/BOnly.tsx", type: "file" }]);
    const props = buildComposerProps({
      turnActive: false,
      draft: "",
      sessionId: null,
      onSearchAttachments: laneSearch,
    });
    const view = render(<AgentChatComposer {...props} />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "@src", selectionStart: 4 },
    });

    expect(await screen.findByText("AOnly.tsx")).toBeTruthy();

    view.rerender(
      <AgentChatComposer
        {...props}
        draft="@src"
        sessionId="session-1"
        onSearchAttachments={sessionSearch}
      />,
    );

    expect(screen.queryByText("AOnly.tsx")).toBeNull();
    await waitFor(() => {
      expect(sessionSearch).toHaveBeenCalledWith("src");
    });
    expect(await screen.findByText("BOnly.tsx")).toBeTruthy();
  });

  it("keeps the caret visible when the plain composer renders a slash command badge", async () => {
    const props = buildComposerProps({
      turnActive: false,
      draft: "",
      sdkSlashCommands: [{
        name: "status",
        description: "Summarize current state",
        source: "sdk",
      }],
    });
    const view = render(<AgentChatComposer {...props} />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/", selectionStart: 1 },
    });
    fireEvent.click(await screen.findByText("/status"));
    view.rerender(<AgentChatComposer {...props} draft="/status " />);

    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textbox.style.caretColor).toBe("var(--color-fg)");
    expect(textbox.className).toContain("text-left");
  });

  it("opens the slash menu mid-sentence and splices only the trigger span", async () => {
    const props = buildComposerProps({
      turnActive: false,
      draft: "",
      sdkSlashCommands: [{
        name: "status",
        description: "Summarize current state",
        source: "sdk",
      }],
    });
    const view = render(<AgentChatComposer {...props} />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "fix bug then run /st", selectionStart: 20 },
    });
    view.rerender(<AgentChatComposer {...props} draft="fix bug then run /st" />);

    fireEvent.click(await screen.findByText("/status"));

    expect(props.onDraftChange).toHaveBeenLastCalledWith("fix bug then run /status ");
  });

  describe("plugin slash commands", () => {
    const FIX_COMMAND = {
      name: "fix",
      description: "Fix the build",
      source: "plugin" as const,
      plugin: { pluginId: "acme", displayName: "Acme", actionId: "runFix" },
    };

    /**
     * The real dispatch chain, stubbed only at the host boundary: the composer
     * goes through `runPluginSocketAction`, the plugin bridge and the composer
     * edit target exactly as a contributed button does. Stubbing higher would
     * stop proving that a `{composer:{…}}` response reaches the draft.
     */
    function installPluginBridge(result: unknown) {
      const invoke = vi.fn().mockResolvedValue(result);
      (window as any).ade = { ...((window as any).ade ?? {}), plugins: { invoke } };
      return invoke;
    }

    it("attributes a contributed command to its plugin in the menu", async () => {
      renderComposer({ turnActive: false, draft: "", sdkSlashCommands: [FIX_COMMAND] });

      fireEvent.change(screen.getByRole("textbox"), { target: { value: "/", selectionStart: 1 } });

      const row = (await screen.findByText("/fix")).closest("[data-index], div");
      expect(row?.textContent).toContain("Acme");
      expect(row?.textContent).toContain("Fix the build");
    });

    it("invokes the plugin instead of writing the command into the draft", async () => {
      const invoke = installPluginBridge(null);
      const props = buildComposerProps({
        turnActive: false,
        draft: "",
        isActive: true,
        sessionId: "session-7",
        sdkSlashCommands: [FIX_COMMAND],
      });
      const view = render(<AgentChatComposer {...props} />);

      // A prefix, not the whole word: the plain composer renders confirmed
      // command tokens in a backdrop overlay, so a draft of "/fix" would put a
      // second "/fix" on screen and the query below would match both.
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "/fi", selectionStart: 3 } });
      view.rerender(<AgentChatComposer {...props} draft="/fi" />);
      fireEvent.click(await screen.findByText("/fix"));

      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      expect(invoke.mock.calls[0]![0]).toEqual(expect.objectContaining({
        pluginId: "acme",
        action: "runFix",
        args: { context: expect.objectContaining({ kind: "composer", sessionId: "session-7", draft: "" }) },
      }));
      // The command word is consumed. Left in place it would be one Enter away
      // from being sent to the model as an ordinary message.
      expect(props.onDraftChange).toHaveBeenLastCalledWith("");
      expect(props.onDraftChange).not.toHaveBeenCalledWith("/fix ");
    });

    it("hands the plugin the rest of the draft and consumes only the trigger span", async () => {
      const invoke = installPluginBridge(null);
      const props = buildComposerProps({
        turnActive: false,
        draft: "",
        isActive: true,
        sdkSlashCommands: [FIX_COMMAND],
      });
      const view = render(<AgentChatComposer {...props} />);

      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "tidy the imports /fi", selectionStart: 20 },
      });
      view.rerender(<AgentChatComposer {...props} draft="tidy the imports /fi" />);
      fireEvent.click(await screen.findByText("/fix"));

      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      const context = (invoke.mock.calls[0]![0] as any).args.context;
      expect(context.draft).toBe("tidy the imports ");
      expect(props.onDraftChange).toHaveBeenLastCalledWith("tidy the imports ");
    });

    it("writes a plugin's composer response back into the draft", async () => {
      installPluginBridge({ composer: { replaceText: "fix: restore the failing import" } });
      const props = buildComposerProps({
        turnActive: false,
        draft: "",
        isActive: true,
        sessionId: "session-7",
        sdkSlashCommands: [FIX_COMMAND],
      });
      const view = render(<AgentChatComposer {...props} />);

      // A prefix, not the whole word: the plain composer renders confirmed
      // command tokens in a backdrop overlay, so a draft of "/fix" would put a
      // second "/fix" on screen and the query below would match both.
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "/fi", selectionStart: 3 } });
      view.rerender(<AgentChatComposer {...props} draft="/fi" />);
      fireEvent.click(await screen.findByText("/fix"));

      await waitFor(() => {
        expect(props.onDraftChange).toHaveBeenLastCalledWith("fix: restore the failing import");
      });
    });

    it("still writes an ordinary command into the draft", async () => {
      const invoke = installPluginBridge(null);
      const props = buildComposerProps({
        turnActive: false,
        draft: "",
        isActive: true,
        sdkSlashCommands: [{ name: "status", description: "Summarize current state", source: "sdk" as const }],
      });
      const view = render(<AgentChatComposer {...props} />);

      fireEvent.change(screen.getByRole("textbox"), { target: { value: "/stat", selectionStart: 5 } });
      view.rerender(<AgentChatComposer {...props} draft="/stat" />);
      fireEvent.click(await screen.findByText("/status"));

      expect(props.onDraftChange).toHaveBeenLastCalledWith("/status ");
      expect(invoke).not.toHaveBeenCalled();
    });

    /**
     * The typed path. The menu is one way in; typing the command you already
     * know is the other, and it is the one a returning user takes. Sent as text
     * it never ran — the plugin stayed silent and the transcript grew a message
     * the user meant as a button press.
     */
    it("invokes the plugin when the command is typed and submitted", async () => {
      const invoke = installPluginBridge(null);
      const props = buildComposerProps({
        turnActive: false,
        draft: "/fix",
        isActive: true,
        sessionId: "session-7",
        sdkSlashCommands: [FIX_COMMAND],
      });
      render(<AgentChatComposer {...props} />);

      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      expect(invoke.mock.calls[0]![0]).toEqual(expect.objectContaining({
        pluginId: "acme",
        action: "runFix",
        args: { context: expect.objectContaining({ kind: "composer", sessionId: "session-7", draft: "" }) },
      }));
      // Nothing reached the model, and the command word did not survive to be
      // sent by the next Enter.
      expect(props.onSubmit).not.toHaveBeenCalled();
      expect(props.onDraftChange).toHaveBeenLastCalledWith("");
    });

    it("passes what the user typed after the command to the plugin", async () => {
      const invoke = installPluginBridge(null);
      const props = buildComposerProps({
        turnActive: false,
        draft: "/fix the failing import",
        isActive: true,
        sdkSlashCommands: [FIX_COMMAND],
      });
      render(<AgentChatComposer {...props} />);

      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      const context = (invoke.mock.calls[0]![0] as any).args.context;
      expect(context.draft).toBe(" the failing import");
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it("sends an unrecognized command to the model, as it always has", () => {
      const invoke = installPluginBridge(null);
      const props = buildComposerProps({
        turnActive: false,
        draft: "/unknown",
        isActive: true,
        sdkSlashCommands: [FIX_COMMAND],
      });
      render(<AgentChatComposer {...props} />);

      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

      expect(invoke).not.toHaveBeenCalled();
      expect(props.onSubmit).toHaveBeenCalledTimes(1);
    });

    it("leaves a runtime command alone — the runtime interprets its own", () => {
      const invoke = installPluginBridge(null);
      const props = buildComposerProps({
        turnActive: false,
        draft: "/status now",
        isActive: true,
        sdkSlashCommands: [
          FIX_COMMAND,
          { name: "status", description: "Summarize current state", source: "sdk" as const },
        ],
      });
      render(<AgentChatComposer {...props} />);

      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

      expect(invoke).not.toHaveBeenCalled();
      expect(props.onSubmit).toHaveBeenCalledTimes(1);
    });

    it("does not treat a plugin command mentioned mid-sentence as an invoke", () => {
      const invoke = installPluginBridge(null);
      const props = buildComposerProps({
        turnActive: false,
        draft: "should I run /fix here?",
        isActive: true,
        sdkSlashCommands: [FIX_COMMAND],
      });
      render(<AgentChatComposer {...props} />);

      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

      expect(invoke).not.toHaveBeenCalled();
      expect(props.onSubmit).toHaveBeenCalledTimes(1);
    });

    it("does not invoke a command that claims the plugin source but carries no plugin", async () => {
      const invoke = installPluginBridge(null);
      const props = buildComposerProps({
        turnActive: false,
        draft: "",
        isActive: true,
        // A host too old to send `plugin`, or a malformed row. It must degrade
        // to ordinary draft text rather than becoming an unclickable row.
        sdkSlashCommands: [{ name: "fix", description: "Fix the build", source: "plugin" as const }],
      });
      const view = render(<AgentChatComposer {...props} />);

      // A prefix, not the whole word: the plain composer renders confirmed
      // command tokens in a backdrop overlay, so a draft of "/fix" would put a
      // second "/fix" on screen and the query below would match both.
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "/fi", selectionStart: 3 } });
      view.rerender(<AgentChatComposer {...props} draft="/fi" />);
      fireEvent.click(await screen.findByText("/fix"));

      expect(invoke).not.toHaveBeenCalled();
      expect(props.onDraftChange).toHaveBeenLastCalledWith("/fix ");
    });
  });

  it("falls through to send when Enter hits an unmatched mid-sentence slash token", async () => {
    const props = buildComposerProps({
      turnActive: false,
      draft: "",
      sdkSlashCommands: [{
        name: "status",
        description: "Summarize current state",
        source: "sdk",
      }],
    });
    const view = render(<AgentChatComposer {...props} />);

    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "check /tmp", selectionStart: 10 } });
    view.rerender(<AgentChatComposer {...props} draft="check /tmp" />);
    expect(await screen.findByText('No commands match "tmp"')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByText('No commands match "tmp"')).toBeNull();
    });
  });

  it("replaces a mid-sentence @query with the selected file and attaches it", async () => {
    const onSearchAttachments = vi.fn().mockResolvedValue([{ path: "src/App.tsx", type: "file" }]);
    const props = buildComposerProps({
      turnActive: false,
      draft: "",
      sessionId: "session-1",
      onSearchAttachments,
    });
    const view = render(<AgentChatComposer {...props} />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "fix the parser in @src", selectionStart: 22 },
    });
    view.rerender(<AgentChatComposer {...props} draft="fix the parser in @src" />);

    fireEvent.click(await screen.findByText("App.tsx"));

    expect(props.onDraftChange).toHaveBeenLastCalledWith("fix the parser in @src/App.tsx ");
    expect(props.onAddAttachment).toHaveBeenCalledWith({ path: "src/App.tsx", type: "file" });
  });

  it("dismisses an attachment error from the composer preview row", async () => {
    const view = renderComposer({
      turnActive: false,
      draft: "",
    });
    const uploadInput = view.container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(uploadInput).toBeTruthy();

    const oversized = new File(["too large"], "oversized.txt", { type: "text/plain" });
    Object.defineProperty(oversized, "size", {
      value: LEGACY_MAX_CHAT_ATTACHMENT_BYTES + 1024 * 1024,
    });
    fireEvent.change(uploadInput!, { target: { files: [oversized] } });

    const capMessage = new RegExp(
      `Maximum allowed size is ${formatAttachmentSize(LEGACY_MAX_CHAT_ATTACHMENT_BYTES)}`,
    );
    expect(await screen.findByText(capMessage)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss error"));

    await waitFor(() => {
      expect(screen.queryByText(capMessage)).toBeNull();
    });
  });

  it("copies Electron file-path uploads into the composer runtime", async () => {
    const composerMachineBinding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:studio:ade",
      targetId: "studio",
      runtimeName: "Mac Studio",
      projectId: "ade",
      rootPath: "/Users/admin/Projects/ADE",
      displayName: "ADE",
    };
    const saveTempAttachment = vi.fn().mockResolvedValue({
      path: "/Users/admin/Projects/ADE/.ade/attachments/spec.txt",
    });
    (window as any).ade = {
      agentChat: { saveTempAttachment },
    };
    const props = renderComposer({
      turnActive: false,
      draft: "",
      composerMachineBinding,
    });
    const uploadInput = props.container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["remote-safe"], "spec.txt", { type: "text/plain" }) as File & { path?: string };
    Object.defineProperty(file, "path", {
      configurable: true,
      value: "/Users/arul/Desktop/spec.txt",
    });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn(async () => new TextEncoder().encode("remote-safe").buffer),
    });

    fireEvent.change(uploadInput, { target: { files: [file] } });

    await waitFor(() => expect(saveTempAttachment).toHaveBeenCalledWith({
      data: "cmVtb3RlLXNhZmU=",
      filename: "spec.txt",
    }, composerMachineBinding));
    expect(props.onAddAttachment).toHaveBeenCalledWith({
      path: "/Users/admin/Projects/ADE/.ade/attachments/spec.txt",
      type: "file",
    });
    expect(props.onAddAttachment).not.toHaveBeenCalledWith({
      path: "/Users/arul/Desktop/spec.txt",
      type: "file",
    });
  });

  it("moves from the prompt to image attachments and removes them from the keyboard", () => {
    const props = renderComposer({
      turnActive: false,
      draft: "",
      attachments: [{ path: "/tmp/pasted-image.png", type: "image" }],
    });

    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    textbox.focus();
    textbox.setSelectionRange(0, 0);

    fireEvent.keyDown(textbox, { key: "ArrowUp" });

    const imageButton = screen.getByRole("button", { name: "Open pasted-image.png" });
    expect(document.activeElement).toBe(imageButton);

    fireEvent.keyDown(imageButton, { key: "ArrowDown" });
    expect(document.activeElement).toBe(textbox);

    textbox.focus();
    textbox.setSelectionRange(0, 0);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    fireEvent.keyDown(imageButton, { key: "Delete" });

    expect(props.onRemoveAttachment).toHaveBeenCalledWith("/tmp/pasted-image.png");
    expect(document.activeElement).toBe(textbox);
  });

  it("cycles the selected chat's prompt history and restores the draft", () => {
    const onDraftChange = vi.fn();
    const onPromptHistoryNavigate = vi.fn();
    const promptHistory = [
      { text: "First prompt", eventKey: "prompt-1" },
      { text: "Second prompt", eventKey: "prompt-2" },
    ] as const;
    const props = buildComposerProps({
      draft: "unfinished draft",
      onDraftChange,
      onPromptHistoryNavigate,
      promptHistory,
      turnActive: false,
    });
    const view = render(<AgentChatComposer {...props} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

    textbox.focus();
    textbox.setSelectionRange(0, 0);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    expect(onDraftChange).toHaveBeenLastCalledWith("Second prompt");
    expect(onPromptHistoryNavigate).toHaveBeenLastCalledWith(promptHistory[1]);

    view.rerender(<AgentChatComposer {...props} draft="Second prompt" />);
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    expect(onDraftChange).toHaveBeenLastCalledWith("First prompt");
    expect(onPromptHistoryNavigate).toHaveBeenLastCalledWith(promptHistory[0]);

    view.rerender(<AgentChatComposer {...props} draft="First prompt" />);
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    expect(onDraftChange).toHaveBeenLastCalledWith("Second prompt");

    view.rerender(<AgentChatComposer {...props} draft="Second prompt" />);
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    expect(onDraftChange).toHaveBeenLastCalledWith("unfinished draft");
    expect(onPromptHistoryNavigate).toHaveBeenLastCalledWith(null);
  });

  it("keeps the selected prompt anchored when older history is prepended", () => {
    const onDraftChange = vi.fn();
    const initialHistory = [
      { text: "Older prompt", eventKey: "prompt-1" },
      { text: "Latest prompt", eventKey: "prompt-2" },
    ] as const;
    const props = buildComposerProps({
      draft: "unfinished draft",
      onDraftChange,
      promptHistory: initialHistory,
      turnActive: false,
    });
    const view = render(<AgentChatComposer {...props} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

    textbox.focus();
    textbox.setSelectionRange(0, 0);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    expect(onDraftChange).toHaveBeenLastCalledWith("Latest prompt");

    view.rerender(
      <AgentChatComposer
        {...props}
        draft="Latest prompt"
        promptHistory={[
          { text: "Newly loaded oldest prompt", eventKey: "prompt-0" },
          ...initialHistory,
        ]}
      />,
    );
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });

    expect(onDraftChange).toHaveBeenLastCalledWith("Older prompt");
  });

  it("keeps multiline caret motion after an interrupted history sequence", () => {
    const onDraftChange = vi.fn();
    const promptHistory = [
      { text: "Older line one\nOlder line two", eventKey: "prompt-1" },
      { text: "Latest line one\nLatest line two", eventKey: "prompt-2" },
    ] as const;
    const props = buildComposerProps({
      draft: "",
      onDraftChange,
      promptHistory,
      turnActive: false,
    });
    const view = render(<AgentChatComposer {...props} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

    textbox.focus();
    textbox.setSelectionRange(0, 0);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    expect(onDraftChange).toHaveBeenLastCalledWith(promptHistory[1].text);

    view.rerender(<AgentChatComposer {...props} draft={promptHistory[1].text} />);
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });

    // The click canceled the rapid-history sequence. At the end of a multiline
    // prompt, a single ArrowUp belongs to native caret movement.
    expect(onDraftChange).toHaveBeenCalledTimes(1);

    textbox.setSelectionRange(0, 0);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    expect(onDraftChange).toHaveBeenLastCalledWith(promptHistory[0].text);
  });

  it("keeps native caret motion on a multiline new draft", () => {
    const onDraftChange = vi.fn();
    const props = buildComposerProps({
      draft: "line one\nline two",
      onDraftChange,
      promptHistory: [{ text: "Latest prompt", eventKey: "prompt-1" }],
      turnActive: false,
    });
    render(<AgentChatComposer {...props} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

    textbox.focus();
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });

    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("treats a direction change as an interruption of the rapid sequence", () => {
    const onDraftChange = vi.fn();
    const promptHistory = [
      { text: "Oldest line one\nOldest line two", eventKey: "prompt-1" },
      { text: "Middle line one\nMiddle line two", eventKey: "prompt-2" },
      { text: "Latest line one\nLatest line two", eventKey: "prompt-3" },
    ] as const;
    const props = buildComposerProps({
      draft: "unfinished draft",
      onDraftChange,
      promptHistory,
      turnActive: false,
    });
    const view = render(<AgentChatComposer {...props} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

    textbox.focus();
    textbox.setSelectionRange(0, 0);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    view.rerender(<AgentChatComposer {...props} draft={promptHistory[2].text} />);
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    view.rerender(<AgentChatComposer {...props} draft={promptHistory[1].text} />);
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    view.rerender(<AgentChatComposer {...props} draft={promptHistory[2].text} />);
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);

    // The Up after a Down is no longer part of the Down sequence. At the end
    // of a multiline prompt it therefore belongs to native caret movement.
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    expect(onDraftChange).toHaveBeenCalledTimes(3);
  });

  it("expires the rapid-history window after three seconds", () => {
    vi.useFakeTimers();
    try {
      const onDraftChange = vi.fn();
      const promptHistory = [
        { text: "Older line one\nOlder line two", eventKey: "prompt-1" },
        { text: "Latest line one\nLatest line two", eventKey: "prompt-2" },
      ] as const;
      const props = buildComposerProps({
        draft: "",
        onDraftChange,
        promptHistory,
        turnActive: false,
      });
      const view = render(<AgentChatComposer {...props} />);
      const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

      textbox.focus();
      textbox.setSelectionRange(0, 0);
      fireEvent.keyDown(textbox, { key: "ArrowUp" });
      view.rerender(<AgentChatComposer {...props} draft={promptHistory[1].text} />);
      textbox.setSelectionRange(textbox.value.length, textbox.value.length);
      act(() => vi.advanceTimersByTime(3_001));
      fireEvent.keyDown(textbox, { key: "ArrowUp" });

      expect(onDraftChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-stashes an unsent draft before selecting the latest prompt", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "stash-auto-1",
      text: "unfinished draft",
      provider: "codex",
      modelId: "openai/gpt-5.4",
      createdAt: "2026-08-10T12:00:00.000Z",
    });
    installPromptStashBridge({
      list: vi.fn().mockResolvedValue([]),
      create,
      delete: vi.fn().mockResolvedValue(true),
    });
    const onDraftChange = vi.fn();
    const props = buildComposerProps({
      draft: "unfinished draft",
      onDraftChange,
      promptHistory: [{ text: "Latest prompt", eventKey: "prompt-1" }],
      turnActive: false,
    });
    render(<AgentChatComposer {...props} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

    textbox.focus();
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      text: "unfinished draft",
      provider: "codex",
      modelId: "openai/gpt-5.4",
    }, null));
    expect(onDraftChange).toHaveBeenCalledWith("Latest prompt");
  });

  it("consumes an auto-stash that finishes after history navigation is interrupted", async () => {
    let resolveCreate: ((entry: {
      id: string;
      text: string;
      provider: string;
      modelId: string;
      createdAt: string;
    }) => void) | undefined;
    const create = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    const remove = vi.fn().mockResolvedValue(true);
    installPromptStashBridge({
      list: vi.fn().mockResolvedValue([]),
      create,
      delete: remove,
    });
    const props = buildComposerProps({
      draft: "unfinished draft",
      promptHistory: [{ text: "Latest prompt", eventKey: "prompt-1" }],
      turnActive: false,
    });
    const view = render(<AgentChatComposer {...props} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

    textbox.focus();
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    view.rerender(<AgentChatComposer {...props} draft="newer draft" />);
    resolveCreate?.({
      id: "stash-auto-interrupted-1",
      text: "unfinished draft",
      provider: "codex",
      modelId: "openai/gpt-5.4",
      createdAt: "2026-08-10T12:00:00.000Z",
    });

    await waitFor(() => expect(remove).toHaveBeenCalledWith(
      { id: "stash-auto-interrupted-1" },
      null,
    ));
  });

  it("consumes an auto-stash that finishes after the composer unmounts", async () => {
    let resolveCreate: ((entry: {
      id: string;
      text: string;
      provider: string;
      modelId: string;
      createdAt: string;
    }) => void) | undefined;
    const create = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    const remove = vi.fn().mockResolvedValue(true);
    installPromptStashBridge({
      list: vi.fn().mockResolvedValue([]),
      create,
      delete: remove,
    });
    const props = buildComposerProps({
      draft: "unfinished draft",
      promptHistory: [{ text: "Latest prompt", eventKey: "prompt-1" }],
      turnActive: false,
    });
    const view = render(<AgentChatComposer {...props} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

    textbox.focus();
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    view.unmount();
    resolveCreate?.({
      id: "stash-auto-unmounted-1",
      text: "unfinished draft",
      provider: "codex",
      modelId: "openai/gpt-5.4",
      createdAt: "2026-08-10T12:00:00.000Z",
    });

    await waitFor(() => expect(remove).toHaveBeenCalledWith(
      { id: "stash-auto-unmounted-1" },
      null,
    ));
  });

  it("consumes the auto-stash when history restores the original draft", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "stash-auto-restore-1",
      text: "unfinished draft",
      provider: "codex",
      modelId: "openai/gpt-5.4",
      createdAt: "2026-08-10T12:00:00.000Z",
    });
    const remove = vi.fn().mockResolvedValue(true);
    installPromptStashBridge({
      list: vi.fn().mockResolvedValue([]),
      create,
      delete: remove,
    });
    const props = buildComposerProps({
      draft: "unfinished draft",
      promptHistory: [{ text: "Latest prompt", eventKey: "prompt-1" }],
      turnActive: false,
    });
    const view = render(<AgentChatComposer {...props} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;

    textbox.focus();
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    view.rerender(<AgentChatComposer {...props} draft="Latest prompt" />);
    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.keyDown(textbox, { key: "ArrowDown" });

    await waitFor(() => expect(remove).toHaveBeenCalledWith(
      { id: "stash-auto-restore-1" },
      null,
    ));
  });

  it("stop only interrupts the active turn", () => {
    const props = renderComposer();

    const stopButtons = screen.getAllByLabelText("Stop active turn");
    fireEvent.click(stopButtons[stopButtons.length - 1]!);

    expect(props.onInterrupt).toHaveBeenCalledTimes(1);
    expect(props.onClearDraft).not.toHaveBeenCalled();
  });

  it("renders Claude mode dropdown without a Chat toggle", () => {
    renderComposer({
      sessionProvider: "claude",
      modelId: "anthropic/claude-sonnet-5",
      availableModelIds: ["anthropic/claude-sonnet-5"],
    });

    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Claude permission mode" });
    expect(trigger.textContent).toContain("Manual");

    fireEvent.click(trigger);

    expect(screen.getByRole("listbox", { name: "Claude permission mode" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Manual/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Auto/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Accept edits/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Plan mode/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Bypass/ })).toBeTruthy();
  });

  it("uses a compact permission menu without a selected-mode header", () => {
    renderComposer({
      sessionProvider: "claude",
      modelId: "anthropic/claude-sonnet-5",
      availableModelIds: ["anthropic/claude-sonnet-5"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Claude permission mode" }));

    const listbox = screen.getByRole("listbox", { name: "Claude permission mode" });
    expect(listbox.style.width).toBe("240px");
    expect(within(listbox).queryByText("Mode", { exact: true })).toBeNull();
  });

  it.each(CAPTION_FREE_PERMISSION_CASES)(
    "renders title-only $provider permission rows",
    ({ triggerName, optionCount, overrides }) => {
      renderComposer(overrides);
      fireEvent.click(screen.getByRole("button", { name: triggerName }));

      const listbox = screen.getByRole("listbox", { name: triggerName });
      const options = Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]'));
      expect(options).toHaveLength(optionCount);
      for (const option of options) {
        expect(option.textContent?.trim()).toBe(option.getAttribute("aria-label"));
        expect(option.getAttribute("title")?.length).toBeGreaterThan(0);
      }
    },
  );

  it("routes Claude auto through the native permission callback", () => {
    const onInteractionModeChange = vi.fn();
    const onClaudePermissionModeChange = vi.fn();
    renderComposer({
      sessionProvider: "claude",
      modelId: "anthropic/claude-sonnet-5",
      availableModelIds: ["anthropic/claude-sonnet-5"],
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
      modelId: "anthropic/claude-sonnet-5",
      availableModelIds: ["anthropic/claude-sonnet-5"],
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
      modelId: "anthropic/claude-sonnet-5",
      availableModelIds: ["anthropic/claude-sonnet-5"],
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

    fireEvent.click(screen.getByRole("button", { name: "Codex permission mode" }));

    expect(screen.getByRole("option", { name: "Default permissions" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Edit mode" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Plan mode" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Full access" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Custom (config.toml)" })).toBeTruthy();
    expect(screen.queryByDisplayValue("ADE flags")).toBeNull();
    expect(screen.queryByDisplayValue("On request")).toBeNull();
    expect(screen.queryByDisplayValue("Workspace write")).toBeNull();
  });

  it("wires permission preset triggers to composer container-query compact layout", () => {
    const { container } = renderComposer({
      sessionProvider: "codex",
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    });

    expect(container.querySelector(".ade-chat-composer-footer")).toBeTruthy();

    const trigger = screen.getByRole("button", { name: "Codex permission mode" });
    expect(trigger.className).toContain("ade-chat-composer-permission-trigger");
    expect(trigger.querySelector(".ade-chat-composer-permission-label")).toBeTruthy();
    expect(trigger.querySelector(".ade-chat-composer-permission-chevron")).toBeTruthy();
  });

  it("maps Codex preset buttons to the underlying approval and sandbox controls", () => {
    const onCodexPresetChange = vi.fn();
    renderComposer({ onCodexPresetChange });

    fireEvent.click(screen.getByRole("button", { name: "Codex permission mode" }));
    fireEvent.click(screen.getByRole("option", { name: "Plan mode" }));

    expect(onCodexPresetChange).toHaveBeenCalledWith({
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    });

    fireEvent.click(screen.getByRole("button", { name: "Codex permission mode" }));
    fireEvent.click(screen.getByRole("option", { name: "Edit mode" }));

    expect(onCodexPresetChange).toHaveBeenCalledWith({
      codexApprovalPolicy: "untrusted",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    });

    fireEvent.click(screen.getByRole("button", { name: "Codex permission mode" }));
    fireEvent.click(screen.getByRole("option", { name: "Full access" }));

    expect(onCodexPresetChange).toHaveBeenCalledWith({
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
      codexConfigSource: "flags",
    });
  });

  it("renders the overflow entry directly when only one control survives gating", () => {
    // A "⋯" that opens onto a single row is a menu pretending to be a button.
    // Surfaces gate these entries independently, so on a CLI draft only one may
    // survive — it should be reachable in one click, not two.
    renderComposer({ turnActive: false, draft: "" });

    expect(screen.queryByRole("button", { name: "More composer controls" })).toBeNull();
    expect(screen.getByRole("button", { name: "Issue context" })).toBeTruthy();
  });

  it("moves focus through the overflow menu and returns it after keyboard selection", async () => {
    const onToggleAppControl = vi.fn();
    renderComposer({
      turnActive: false,
      draft: "",
      showAppControlToggle: true,
      onToggleAppControl,
    });

    const trigger = screen.getByRole("button", { name: "More composer controls" });
    fireEvent.click(trigger);
    const issue = screen.getByRole("menuitemcheckbox", { name: /Issue context/ });
    const appControl = screen.getByRole("menuitemcheckbox", { name: /Electron Control/i });
    expect((issue as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(appControl));
    fireEvent.keyDown(appControl, { key: "ArrowDown" });
    expect(document.activeElement).toBe(appControl);
    fireEvent.keyDown(appControl, { key: "Enter" });
    expect(onToggleAppControl).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("focuses and keyboard-navigates the portalled Send options", async () => {
    // Two adjacent circular buttons both carrying an arrow read as one control
    // duplicated, so background launch is a row on Send's caret instead.
    renderComposer({
      turnActive: false,
      draft: "Launch this.",
      onSubmitInBackground: vi.fn(),
    });

    const splitControl = document.querySelector("[data-composer-idle-send-control]");
    expect(splitControl).toBeTruthy();
    expect(within(splitControl as HTMLElement).getByRole("button", { name: "Send" })).toBeTruthy();
    const caret = within(splitControl as HTMLElement).getByRole("button", { name: "Send options" });

    fireEvent.click(caret);
    const sendRow = screen.getByRole("menuitem", { name: /^Send/ });
    const backgroundRow = screen.getByRole("menuitem", { name: /Launch in background/ });
    await waitFor(() => expect(document.activeElement).toBe(sendRow));
    fireEvent.keyDown(sendRow, { key: "ArrowDown" });
    expect(document.activeElement).toBe(backgroundRow);
    fireEvent.keyDown(backgroundRow, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(caret));
    expect(screen.queryByRole("menu", { name: "Send options" })).toBeNull();
  });

  it("skips disabled Send options during arrow navigation", async () => {
    renderComposer({
      turnActive: false,
      draft: "Launch this.",
      onSubmitInBackground: vi.fn(),
      backgroundLaunchBusy: true,
    });

    const caret = screen.getByRole("button", { name: "Send options" });
    caret.focus();
    fireEvent.click(caret);
    const sendRow = screen.getByRole("menuitem", { name: /^Send/ });
    const disabledBackground = screen.getByRole("menuitem", { name: /Launching/ });
    expect((sendRow as HTMLButtonElement).disabled).toBe(true);
    expect((disabledBackground as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(caret));
    fireEvent.keyDown(screen.getByRole("menu", { name: "Send options" }), { key: "ArrowDown" });
    expect(document.activeElement).toBe(caret);
  });

  it("no longer owns a standalone fast-mode toolbar control", () => {
    // Fast mode is a property of the model, so it moved onto the model row in
    // the shared ModelPicker (toggle behaviour is covered by ModelPicker.test).
    // What this suite owns is that the composer stopped rendering a fourth pill
    // beside the model name.
    renderComposer({
      sessionProvider: "codex",
      modelId: "openai/gpt-5.5",
      availableModelIds: ["openai/gpt-5.5"],
      fastMode: false,
      onFastModeChange: vi.fn(),
    });

    expect(screen.queryByRole("button", { name: "Fast mode" })).toBeNull();
    expect(document.querySelector("[data-chat-composer-fast-toggle]")).toBeNull();
  });

  it("names fast mode on the collapsed model trigger", () => {
    renderComposer({
      sessionProvider: "codex",
      modelId: "openai/gpt-5.5",
      availableModelIds: ["openai/gpt-5.5"],
      fastMode: true,
      onFastModeChange: vi.fn(),
    });

    expect(document.querySelector("[data-model-picker-trigger]")?.textContent).toMatch(/Fast/);
  });

  it("hides Codex fast mode for unsupported models", () => {
    renderComposer({
      sessionProvider: "codex",
      modelId: "openai/gpt-5.4-mini",
      availableModelIds: ["openai/gpt-5.4-mini"],
      fastMode: true,
    });

    expect(screen.queryByRole("button", { name: "Fast mode" })).toBeNull();
  });

  it("hides model, reasoning, and fast controls when the host surface owns them", () => {
    renderComposer({
      sessionProvider: "codex",
      modelId: "openai/gpt-5.5",
      availableModelIds: ["openai/gpt-5.5"],
      fastMode: true,
      hideModelControls: true,
    });

    expect(document.querySelector("[data-model-picker-trigger]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reasoning effort" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fast mode" })).toBeNull();
  });

  it("hides parallel slot model, reasoning, and fast controls when the host surface owns them", () => {
    renderComposer({
      sessionProvider: "codex",
      availableModelIds: ["openai/gpt-5.5", "anthropic/claude-sonnet-5"],
      hideModelControls: true,
      parallelChatMode: true,
      parallelConfiguringIndex: 0,
      parallelModelSlots: [
        { modelId: "openai/gpt-5.5", reasoningEffort: "high", fastMode: true },
        { modelId: "anthropic/claude-sonnet-5", reasoningEffort: "medium" },
      ],
    });

    expect(document.querySelector("[data-model-picker-trigger]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reasoning effort" })).toBeNull();
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

    const autonomyTrigger = screen.getByRole("button", { name: "Droid autonomy mode" });
    fireEvent.click(autonomyTrigger);
    expect(screen.getByRole("option", { name: "Read-only" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Auto low" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Auto medium" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Auto high" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "AGI (orchestrator)" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Permissions" })).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: "Auto high" }));

    expect(onDroidPermissionModeChange).toHaveBeenCalledWith("auto-high");
  });

  it("renders OpenCode config permission mode", () => {
    const onOpenCodePermissionModeChange = vi.fn();
    renderComposer({
      sessionProvider: "opencode",
      modelId: "opencode/openai/gpt-5.4",
      availableModelIds: ["opencode/openai/gpt-5.4"],
      opencodePermissionMode: "edit",
      onOpenCodePermissionModeChange,
    });

    const permissionsTrigger = screen.getByRole("button", { name: "OpenCode permission mode" });
    fireEvent.click(permissionsTrigger);
    expect(screen.getByRole("option", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Full auto" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Config" })).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: "Config" }));

    expect(onOpenCodePermissionModeChange).toHaveBeenCalledWith("config-toml");
  });

  it("can hide native permission controls for fixed-mode surfaces", () => {
    renderComposer({
      sessionProvider: "codex",
      hideNativeControls: true,
    });

    expect(screen.queryByRole("button", { name: "Codex permission mode" })).toBeNull();
  });

  it("uses explicit per-app choices for Computer Use elicitation", () => {
    const props = renderComposer({
      pendingInput: {
        requestId: "cu-1",
        itemId: "mcp-elicitation:computer_use:cu-1",
        source: "codex",
        kind: "approval",
        title: "Computer Use permission",
        description: "Allow Codex to use Calculator?",
        questions: [],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
        providerMetadata: {
          mcpElicitation: true,
          persistenceSupported: true,
          url: "https://example.com/authorize",
        },
        turnId: "turn-1",
      },
    });

    expect(screen.getByText("Allow Codex to use Calculator?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open authorization" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(props.onApproval).toHaveBeenNthCalledWith(1, "accept");
    expect(props.onApproval).toHaveBeenNthCalledWith(2, "accept_for_session");
    expect(props.onApproval).toHaveBeenNthCalledWith(3, "decline");
  });

  it("shows a plugin install its whole disclosure and its own buttons", () => {
    const body = [
      "A drink counter.",
      "From this computer: /tmp/tipsy",
      "Community plugin. It runs with the same access as tools you install yourself.",
      "",
      "Adds:",
      "- Tipsy tab",
    ].join("\n");
    const props = renderComposer({
      pendingInput: {
        requestId: "plugin-install-1",
        itemId: "plugin-install-1",
        source: "ade",
        kind: "approval",
        title: "Install Tipsy 0.3.0?",
        description: body,
        questions: [{
          id: "plugin_install",
          header: "Plugin install",
          question: "Install Tipsy 0.3.0?",
          allowsFreeform: false,
          options: [
            { label: "Install", value: "install", decision: "accept", description: "Runs with the same access as tools you install yourself." },
            { label: "Don't install", value: "deny", decision: "decline" },
          ],
        }],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
        turnId: "turn-1",
      },
    });

    // Every part of the disclosure, not the title repeated back.
    const disclosure = screen.getByText((_, node) => node?.textContent === body && node.tagName === "DIV");
    expect(disclosure).toBeTruthy();
    expect(disclosure.className).toContain("whitespace-pre-wrap");

    // The caller's words, and none of the generic trio — "Accept all" in
    // particular would read as a standing grant this gate never offered.
    const install = screen.getByRole("button", { name: "Install" });
    expect(install.getAttribute("title")).toBe("Runs with the same access as tools you install yourself.");
    expect(screen.getByRole("button", { name: "Don't install" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept all" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();

    // Both halves go back: the gate reads the decision AND the option value,
    // and treats either one alone as no consent.
    fireEvent.click(install);
    expect(props.onApproval).toHaveBeenNthCalledWith(1, "accept", null, { plugin_install: "install" });
    fireEvent.click(screen.getByRole("button", { name: "Don't install" }));
    expect(props.onApproval).toHaveBeenNthCalledWith(2, "decline", null, { plugin_install: "deny" });
  });

  it("names the plugin, not ADE, and offers a way to read the whole listing", () => {
    // The reported defect: this card asks a person to run third-party code and
    // identified itself with ADE's generic avatar and the word "ADE".
    const props = renderComposer({
      pendingInput: {
        requestId: "plugin-install-2",
        itemId: "plugin-install-2",
        source: "ade",
        kind: "approval",
        title: "Install Focus 1.0.0?",
        description: "Adds:\n- Focus tab (custom UI on desktop; panel on other devices)",
        questions: [{
          id: "plugin_install",
          header: "Plugin install",
          question: "Install Focus 1.0.0?",
          allowsFreeform: false,
          options: [
            { label: "Install", value: "install", decision: "accept" },
            { label: "Don't install", value: "deny", decision: "decline" },
          ],
        }],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
        origin: { kind: "plugin", pluginId: "ade-focus", displayName: "Focus", icon: "timer" },
        providerMetadata: {
          pluginInstall: true,
          pluginId: "ade-focus",
          source: "/tmp/focus",
          sourceKind: "path",
          trust: "community",
        },
        turnId: "turn-1",
      },
    });

    expect(screen.getByTestId("pending-input-header-label").textContent).toBe("Focus · Approval");
    expect(screen.getByTestId("pending-input-plugin-mark").getAttribute("data-plugin-id"))
      .toBe("ade-focus");

    // The link is a link. Reading the listing must not answer the gate the
    // agent is blocked on.
    const link = screen.getByTestId("pending-input-marketplace-link");
    expect(link.getAttribute("data-route"))
      .toBe(`/marketplace?install=${encodeURIComponent("/tmp/focus")}`);
    fireEvent.click(link);
    expect(props.onApproval).not.toHaveBeenCalled();
  });

  it("keeps ADE's own mark on a host card that names no plugin", () => {
    const { container } = renderComposer({
      pendingInput: {
        requestId: "approval-host",
        itemId: "approval-host",
        source: "ade",
        kind: "approval",
        description: "Run the migration?",
        questions: [],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
        turnId: "turn-1",
      },
    });
    expect(screen.getByTestId("pending-input-header-label").textContent).toBe("ADE · Approval");
    expect(screen.queryByTestId("pending-input-plugin-mark")).toBeNull();
    expect(screen.queryByTestId("pending-input-marketplace-link")).toBeNull();
    const mark = container.querySelector("img[alt='ADE']");
    expect(mark?.getAttribute("src")).toContain("ade-icon.webp");
  });

  it("keeps the generic approval buttons when the options carry no decision", () => {
    // A structured question that happens to arrive as an approval still has no
    // mapping from an option to a decision, so the card must not guess one.
    renderComposer({
      pendingInput: {
        requestId: "approval-no-decision",
        itemId: "approval-no-decision",
        source: "ade",
        kind: "approval",
        description: "Run the migration?",
        questions: [{
          id: "answer",
          header: "Question 1",
          question: "Run the migration?",
          options: [
            { label: "Yes", value: "yes" },
            { label: "No", value: "no" },
          ],
          allowsFreeform: false,
        }],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
        turnId: "turn-1",
      },
    });

    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  });

  it.each([
    "file:///tmp/authorize.html",
    "about:blank",
  ])("does not expose MCP authorization for non-HTTP(S) URL %s", (url) => {
    renderComposer({
      pendingInput: {
        requestId: "mcp-auth-invalid-url",
        itemId: "mcp-elicitation:computer_use:mcp-auth-invalid-url",
        source: "codex",
        kind: "approval",
        description: "Allow Codex to authenticate this MCP server?",
        questions: [],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
        providerMetadata: {
          mcpElicitation: true,
          persistenceSupported: false,
          url,
        },
        turnId: "turn-1",
      },
    });

    expect(screen.queryByRole("button", { name: "Open authorization" })).toBeNull();
  });

  it("does not offer persistent Computer Use approval when the server disallows it", () => {
    renderComposer({
      pendingInput: {
        requestId: "cu-2",
        itemId: "mcp-elicitation:computer_use:cu-2",
        source: "codex",
        kind: "approval",
        description: "Allow Codex to use System Settings?",
        questions: [],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
        providerMetadata: {
          mcpElicitation: true,
          persistenceSupported: false,
        },
        turnId: "turn-1",
      },
    });

    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull();
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

    // The card IS the composer now. A freeform-only question offers no
    // ledger rows and the note field is the answer, not a qualifier.
    expect(screen.getByTestId("ask-question-composer")).toBeTruthy();
    expect(screen.getByText("ADE asks")).toBeTruthy();
    expect(screen.queryByText("Input needed · ade")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect((screen.getByTestId("ask-question-note-answer") as HTMLInputElement).placeholder).toBe("Your answer");
    // The duplicate "answer the card above" banner is gone with the card it
    // pointed at.
    expect(screen.queryByText(/Answer in the inline question card/)).toBeNull();
  });

  // A question whose questions all fail to parse (readPendingInputQuestion drops
  // empty text, so a whitespace-only askUser produces this) renders no card —
  // and composerInputLocked is already true. Without a Decline that is a dead
  // composer with no way out: the exact failure this redesign removes.
  it("regression: a question with no parsable questions still offers a Decline", () => {
    const props = renderComposer({
      pendingInput: {
        requestId: "req-empty",
        itemId: "item-empty",
        source: "claude",
        kind: "question",
        title: "Input needed",
        description: "The agent asked something unparseable.",
        questions: [],
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        turnId: null,
      },
    });

    expect(screen.queryByTestId("ask-question-composer")).toBeNull();
    const decline = screen.getByTestId("pending-input-fallback-decline");
    expect(decline).toBeTruthy();
    fireEvent.click(decline);
    expect(props.onApproval).toHaveBeenCalledWith("decline");
  });

  // Hiding the model/permission/effort row is the point; hiding the whole
  // footer took the only mid-turn interrupt with it.
  it("regression: the turn stop control survives a question gate", () => {
    renderComposer({
      turnActive: true,
      pendingInput: {
        requestId: "req-stop",
        itemId: "item-stop",
        source: "claude",
        kind: "question",
        title: "Input needed",
        description: "What next?",
        questions: [{ id: "answer", header: "Q", question: "What next?", allowsFreeform: true }],
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        turnId: null,
      },
    });

    expect(screen.getByTestId("ask-question-composer")).toBeTruthy();
    expect(screen.getByLabelText(/stop/i)).toBeTruthy();
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

    // The question card replaces the textarea inside the same frame rather
    // than sitting above a disabled one, and the model / permission / effort
    // row is hidden until it resolves.
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.getByTestId("ask-question-composer")).toBeTruthy();
    expect(screen.queryByLabelText("Send steer message")).toBeNull();
    expect(screen.queryByLabelText("Upload file from disk")).toBeNull();
    // The composer's own Send is gone with the footer; the only Send on screen
    // is the card's, and it is disabled until the question is answered.
    expect(screen.getByTestId("ask-question-send")).toHaveProperty("disabled", true);

    // Nothing is dispatched until the user actually answers or declines.
    expect(props.onApproval).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("ask-question-decline"));
    expect(props.onApproval).toHaveBeenCalledWith("decline");
  });

  it("blocks send when the selected model is unavailable on a constrained surface", () => {
    const onSubmit = vi.fn();
    const onSubmitBlocked = vi.fn();
    const onSubmitInBackground = vi.fn();
    renderComposer({
      turnActive: false,
      draft: "This should not send with a stale model.",
      modelId: "openai/retired-model",
      availableModelIds: ["openai/gpt-5.4"],
      constrainModelSelection: true,
      modelUnavailableMessage: "This model is not available in this context.",
      onSubmit,
      onSubmitBlocked,
      onSubmitInBackground,
    });

    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send options" }));
    expect(
      (screen.getByRole("menuitem", { name: /Launch in background/ }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSubmitInBackground).not.toHaveBeenCalled();
    expect(onSubmitBlocked).toHaveBeenCalledWith("This model is not available in this context.");
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

    expect(screen.getByTestId("ask-question-option-answer-question_flow")).toBeTruthy();
    expect(screen.getByTestId("ask-question-option-answer-plan_updates")).toBeTruthy();
    expect((screen.getByTestId("ask-question-note-answer") as HTMLInputElement).placeholder)
      .toBe("Or send your own response instead");
  });

  it("renders each paged question's own options as the user advances", () => {
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

    // Page 1 is freeform-only; page 2 carries the options.
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    fireEvent.change(screen.getByTestId("ask-question-note-first"), { target: { value: "the composer" } });
    fireEvent.click(screen.getByTestId("ask-question-send"));
    expect(screen.getByTestId("ask-question-option-second-question_flow")).toBeTruthy();
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

  it("uses the shared provider verb in the pending banner", () => {
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

    expect(screen.getByText("Codex asks")).toBeTruthy();
    expect(screen.queryByText("2 Questions · codex")).toBeNull();
  });

  it("allows attachments while steering an active Codex turn", () => {
    renderComposer({ turnActive: true });

    expect((screen.getByLabelText("Upload file from disk") as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows attachments while steering an active Claude turn", () => {
    renderComposer({
      turnActive: true,
      sessionProvider: "claude",
      modelId: "anthropic/claude-sonnet-5",
      availableModelIds: ["anthropic/claude-sonnet-5"],
    });

    expect((screen.getByLabelText("Upload file from disk") as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows attachments while steering an active Cursor turn", () => {
    renderComposer({
      turnActive: true,
      sessionProvider: "cursor",
      modelId: "cursor/auto",
      availableModelIds: ["cursor/auto"],
    });

    expect((screen.getByLabelText("Upload file from disk") as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows attachments while steering an active OpenCode turn", () => {
    renderComposer({
      turnActive: true,
      sessionProvider: "opencode",
      modelId: "opencode/openai/gpt-5.4",
      availableModelIds: ["opencode/openai/gpt-5.4"],
    });

    expect((screen.getByLabelText("Upload file from disk") as HTMLButtonElement).disabled).toBe(false);
  });

  it("starts orchestrator mode from a visible composer button", () => {
    const onStartOrchestratorChat = vi.fn();
    renderComposer({
      turnActive: false,
      sessionId: null,
      onStartOrchestratorChat,
    });

    fireEvent.click(screen.getByRole("button", { name: "More composer controls" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Start orchestrator mode/ }));

    expect(onStartOrchestratorChat).toHaveBeenCalledTimes(1);
  });

  it("marks the visible orchestrator composer button as active", () => {
    const onStopOrchestratorChat = vi.fn();
    const { container } = renderComposer({
      turnActive: false,
      sessionId: null,
      onStartOrchestratorChat: vi.fn(),
      onStopOrchestratorChat,
      orchestratorModeActive: true,
    });

    // Active state has to survive being folded away, so the collapsed trigger
    // carries a dot and the row itself reports aria-checked.
    const trigger = screen.getByRole("button", { name: "More composer controls" });
    fireEvent.click(trigger);

    const row = screen.getByRole("menuitemcheckbox", { name: /Orchestrator mode/ });
    expect(row.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("[data-chat-composer-orchestrator-glow]")).toBeTruthy();

    fireEvent.click(row);
    expect(onStopOrchestratorChat).toHaveBeenCalledTimes(1);
  });

  it("keeps model controls visible for active worker orchestration sessions", () => {
    renderComposer({
      orchestrationRole: "worker",
      sessionId: "worker-session",
    });

    expect(screen.getByRole("button", { name: /Select model/i })).toBeTruthy();
  });

  it("hides lead model controls only after the lead session exists", () => {
    const props = buildComposerProps({
      orchestrationRole: "lead",
      sessionId: null,
    });
    const view = render(<AgentChatComposer {...props} />);

    expect(screen.getByRole("button", { name: /Select model/i })).toBeTruthy();

    view.rerender(<AgentChatComposer {...props} sessionId="lead-session" />);

    expect(screen.queryByRole("button", { name: /Select model/i })).toBeNull();
  });

  it("renders the issue context menu outside the clipped composer shell", () => {
    const { container } = renderComposer({
      draft: "",
      turnActive: false,
      onAddContextAttachment: vi.fn(),
    });

    openIssueContext();

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
        plugins: {},
      },
    });

    renderComposer({
      draft: "",
      turnActive: false,
      onAddContextAttachment: vi.fn(),
      onOpenLinearSettings,
    });

    openIssueContext();
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
        plugins: {},
      },
    });

    renderComposer({
      draft: "",
      turnActive: false,
      onAddContextAttachment,
    });

    openIssueContext();
    fireEvent.click(screen.getByRole("button", { name: /Linear issue/i }));

    await waitFor(() => expect(searchLinearIssues).toHaveBeenCalled());
    const issueIdentifier = (await screen.findAllByText("ADE-123"))[0]!;
    // The issue row is a `div role="button"` (the checkbox is a real <button>
    // sibling, so the row can't be a nested <button>).
    const issueRow = issueIdentifier.closest('[role="button"]');
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
        plugins: {},
      },
    });

    renderComposer({
      draft: "",
      turnActive: false,
      onAddContextAttachment: vi.fn(),
    });

    openIssueContext();
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

    const composerMachineBinding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:studio:ade",
      targetId: "studio",
      runtimeName: "Mac Studio",
      projectId: "ade",
      rootPath: "/Users/admin/Projects/ADE",
      displayName: "ADE",
    };
    try {
      const props = renderComposer({
        turnActive: false,
        draft: "",
        composerMachineBinding,
      });

      fireEvent.keyDown(screen.getByPlaceholderText("Type to vibecode..."), {
        key: "v",
        metaKey: true,
      });

      await waitFor(() => expect(readClipboardImage).toHaveBeenCalledTimes(1));
      expect(saveTempAttachment).toHaveBeenCalledWith({
        data: "abc123",
        filename: "clipboard.png",
      }, composerMachineBinding);
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

  it("fails closed when the selected machine cannot own new attachments", async () => {
    const readClipboardImage = vi.fn();
    const saveTempAttachment = vi.fn();
    (window as any).ade = {
      app: { readClipboardImage },
      agentChat: { saveTempAttachment },
    };
    const reason = "Reconnect the selected machine project or choose another machine before attaching files.";
    renderComposer({
      turnActive: false,
      draft: "",
      composerMachineBinding: null,
      attachmentPersistenceUnavailableReason: reason,
    });

    const input = screen.getByPlaceholderText("Type to vibecode...");
    fireEvent.keyDown(input, { key: "v", metaKey: true });

    expect((screen.getByRole("button", { name: "Upload file from disk" }) as HTMLButtonElement).disabled).toBe(true);
    expect(readClipboardImage).not.toHaveBeenCalled();
    expect(saveTempAttachment).not.toHaveBeenCalled();
  });

  it("uses runtime temp attachments for native macOS clipboard image fallback even when local save IPC is available", async () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const saveClipboardImageAttachment = vi.fn().mockResolvedValue({
      path: "/tmp/ade-native-clipboard.png",
      mimeType: "image/png",
      previewDataUrl: "data:image/png;base64,preview",
    });
    const readClipboardImage = vi.fn().mockResolvedValue({
      data: "abc123",
      filename: "clipboard.png",
      mimeType: "image/png",
    });
    const saveTempAttachment = vi.fn().mockResolvedValue({ path: "/remote/project/.ade/attachments/clipboard.png" });
    (window as any).ade = {
      app: { saveClipboardImageAttachment, readClipboardImage },
      agentChat: { saveTempAttachment },
    };

    const composerMachineBinding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:studio:ade",
      targetId: "studio",
      runtimeName: "Mac Studio",
      projectId: "ade",
      rootPath: "/Users/admin/Projects/ADE",
      displayName: "ADE",
    };
    try {
      const props = renderComposer({
        turnActive: false,
        draft: "",
        composerMachineBinding,
      });

      fireEvent.keyDown(screen.getByPlaceholderText("Type to vibecode..."), {
        key: "v",
        metaKey: true,
      });

      await waitFor(() => expect(readClipboardImage).toHaveBeenCalledTimes(1));
      expect(saveClipboardImageAttachment).not.toHaveBeenCalled();
      expect(saveTempAttachment).toHaveBeenCalledWith({
        data: "abc123",
        filename: "clipboard.png",
      }, composerMachineBinding);
      expect(props.onAddAttachment).toHaveBeenCalledWith({
        path: "/remote/project/.ade/attachments/clipboard.png",
        type: "image",
      });
    } finally {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("shows a pasted image preview while the temp attachment is still saving", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:ade-paste-preview");
    const revokeObjectURL = vi.fn();
    const previousCreateObjectURL = URL.createObjectURL;
    const previousRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });

    let resolveSave: (value: { path: string }) => void = () => {};
    const saveTempAttachment = vi.fn(() => new Promise<{ path: string }>((resolve) => {
      resolveSave = resolve;
    }));
    (window as any).ade = {
      app: {},
      agentChat: { saveTempAttachment },
    };

    try {
      const props = renderComposer({
        turnActive: false,
        draft: "",
      });
      const file = new File([new Uint8Array([1, 2, 3])], "paste.png", { type: "image/png" });
      Object.defineProperty(file, "arrayBuffer", {
        configurable: true,
        value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
      });
      const clipboardData = {
        files: [file],
        items: [],
        getData: vi.fn(() => ""),
      };

      fireEvent.paste(screen.getByPlaceholderText("Type to vibecode..."), { clipboardData });

      expect(await screen.findByRole("status", { name: "Attaching paste.png" })).toBeTruthy();
      expect(screen.getByAltText("paste.png preview").getAttribute("src")).toBe("blob:ade-paste-preview");
      expect(createObjectURL).toHaveBeenCalledWith(file);

      resolveSave({ path: "/tmp/ade-paste.png" });
      await waitFor(() => expect(props.onAddAttachment).toHaveBeenCalledWith({
        path: "/tmp/ade-paste.png",
        type: "image",
      }));
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: previousCreateObjectURL,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: previousRevokeObjectURL,
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

    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, "dataTransfer", {
      configurable: true,
      value: rejectedUrlDrop,
    });
    fireEvent(input, dropEvent);

    await waitFor(() => expect(screen.queryByText("Drop files to attach")).toBeNull());
    expect(dropEvent.defaultPrevented).toBe(true);
    expect(props.onAddAttachment).not.toHaveBeenCalled();
  });

  it("accepts a file dragover before the browser exposes its file list", () => {
    renderComposer({
      turnActive: false,
      draft: "",
    });
    const dataTransfer = {
      files: [],
      types: ["Files"],
      getData: vi.fn(() => ""),
    };
    const dragOverEvent = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragOverEvent, "dataTransfer", {
      configurable: true,
      value: dataTransfer,
    });

    fireEvent(screen.getByPlaceholderText("Type to vibecode..."), dragOverEvent);

    expect(dragOverEvent.defaultPrevented).toBe(true);
    expect(screen.getByText("Drop files to attach")).toBeTruthy();
  });

  it.each(["heic", "HEIF"])("accepts a .%s image URL drop", (extension) => {
    const props = renderComposer({
      turnActive: false,
      draft: "",
    });
    const imageUrl = `https://example.com/photos/IMG_0001.${extension}`;
    const dataTransfer = {
      files: [],
      types: ["text/uri-list"],
      getData: vi.fn((type: string) => (type === "text/uri-list" ? imageUrl : "")),
    };
    fireEvent.drop(screen.getByPlaceholderText("Type to vibecode..."), { dataTransfer });

    expect(props.onAddAttachment).toHaveBeenCalledWith({
      path: imageUrl,
      type: "image-url",
      url: imageUrl,
    });
    expect(props.onAddAttachment).toHaveBeenCalledTimes(1);
    expect(dataTransfer.getData).toHaveBeenCalledWith("text/uri-list");
  });

  it("converts HEIC uploads to JPEG before saving the attachment", async () => {
    const convertImageToJpeg = vi.fn().mockResolvedValue({
      ok: true,
      data: "/9j/converted",
      filename: "IMG_0001.jpg",
      mimeType: "image/jpeg",
    });
    const saveTempAttachment = vi.fn().mockResolvedValue({
      path: "/tmp/ade-IMG_0001.jpg",
    });
    (window as any).ade = {
      app: { convertImageToJpeg },
      agentChat: { saveTempAttachment },
    };
    const props = renderComposer({ turnActive: false, draft: "" });
    const file = new File([new Uint8Array([1, 2, 3])], "IMG_0001.HEIC", { type: "" });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
    });
    const dataTransfer = {
      files: [file],
      types: ["Files"],
      getData: vi.fn(() => ""),
    };

    fireEvent.drop(screen.getByPlaceholderText("Type to vibecode..."), { dataTransfer });

    await waitFor(() => expect(convertImageToJpeg).toHaveBeenCalledWith({
      data: "AQID",
      filename: "IMG_0001.HEIC",
      mimeType: null,
    }));
    await waitFor(() => expect(saveTempAttachment).toHaveBeenCalledWith({
      data: "/9j/converted",
      filename: "IMG_0001.jpg",
    }, null));
    expect(props.onAddAttachment).toHaveBeenCalledWith({
      path: "/tmp/ade-IMG_0001.jpg",
      type: "image",
    });
  });

  it("explains the Windows-style no-codec fallback instead of attaching HEIC bytes as an image", async () => {
    const convertImageToJpeg = vi.fn().mockResolvedValue({ ok: false, errorCode: "unavailable" });
    const saveTempAttachment = vi.fn();
    (window as any).ade = {
      app: { convertImageToJpeg },
      agentChat: { saveTempAttachment },
    };
    const props = renderComposer({ turnActive: false, draft: "" });
    const file = new File([new Uint8Array([1, 2, 3])], "IMG_0002.heic", { type: "image/heic" });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
    });
    const dataTransfer = {
      files: [file],
      types: ["Files"],
      getData: vi.fn(() => ""),
    };

    fireEvent.drop(screen.getByPlaceholderText("Type to vibecode..."), { dataTransfer });

    expect(await screen.findByText(HEIC_CONVERSION_UNAVAILABLE_MESSAGE)).toBeTruthy();
    expect(saveTempAttachment).not.toHaveBeenCalled();
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
    expect(screen.queryByRole("button", { name: "OpenCode permission mode" })).toBeNull();

    view.rerender(<AgentChatComposer {...props} modelId="opencode/openai/gpt-5.4" />);
    expect(screen.getByRole("button", { name: "OpenCode permission mode" })).toBeTruthy();
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

  it("shows the prompt clipboard hint only while draft text is present", () => {
    const view = renderComposer({
      turnActive: false,
      draft: "Keep a rescue copy.",
      launchPromptClipboardEnabled: true,
    });

    expect(screen.getByText(/Prompt copies to clipboard on send/)).toBeTruthy();

    view.rerender(<AgentChatComposer {...buildComposerProps({ turnActive: false, draft: "" })} />);

    expect(screen.queryByText(/Prompt copies to clipboard on send/)).toBeNull();
  });

  it("uses a contextual accessible name for active turn textareas", () => {
    renderComposer({
      draft: "",
      turnActive: true,
      messagePlaceholder: "Message the active coordinator...",
    });

    const textarea = screen.getByRole("textbox", {
      name: "Steer active turn: Message the active coordinator",
    }) as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("Steer the active turn...");
  });

  it("uses a contextual accessible name for active rich composers", () => {
    renderComposer({
      draft: "",
      turnActive: true,
      messagePlaceholder: "Message this worker...",
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
      name: "Steer active turn: Message this worker",
    })).toBeTruthy();
  });

  it("shows the launch clipboard notice with an inline Setting control while draft text is present", () => {
    const onOpenLaunchPromptClipboardSettings = vi.fn();
    renderComposer({
      draft: "Recoverable launch prompt",
      turnActive: false,
      launchPromptClipboardEnabled: true,
      onOpenLaunchPromptClipboardSettings,
    });

    expect(screen.getByText(/Prompt copies to clipboard on send/)).toBeTruthy();

    const settingButton = screen.getByRole("button", { name: "Setting" });
    fireEvent.click(settingButton);
    expect(onOpenLaunchPromptClipboardSettings).toHaveBeenCalledTimes(1);

    // The notice stays visible (no focus gating) and keeps the inline Setting control.
    expect(screen.getByText(/Prompt copies to clipboard on send/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Setting" })).toBeTruthy();
  });

  it("hides the launch clipboard helper when the setting is disabled", () => {
    renderComposer({
      draft: "No helper",
      turnActive: false,
      launchPromptClipboardEnabled: false,
    });

    fireEvent.focus(screen.getByRole("textbox"));

    expect(screen.queryByText(/Prompt copies to clipboard on send/)).toBeNull();
  });

  it("hides the launch clipboard helper when the reminder setting is disabled", () => {
    renderComposer({
      draft: "Copy silently",
      turnActive: false,
      launchPromptClipboardEnabled: true,
      launchPromptClipboardNoticeEnabled: false,
    });

    fireEvent.focus(screen.getByRole("textbox"));

    expect(screen.queryByText(/Prompt copies to clipboard on send/)).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: "More composer controls" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Parallel models/i }));

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
        { modelId: "anthropic/claude-sonnet-5", reasoningEffort: "medium" },
        { modelId: "openai/gpt-5.4-mini", reasoningEffort: "low" },
      ],
    });

    expect((screen.getByRole("button", { name: "Single model" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add model" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: "Configure" })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole("button", { name: "Remove" })[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Creating child lanes…")).toBeTruthy();
  });

  it("marks the chips a selection intersects and clears the stale ones", async () => {
    const props = buildComposerProps({
      draft: "",
      turnActive: false,
      shouldAutofocus: false,
      iosElementContextItems: [makeIosContextItem("ios-1"), makeIosContextItem("ios-2")],
    });
    render(<AgentChatComposer {...props} />);

    const editor = screen.getByRole("textbox");
    const chips = () => Array.from(editor.querySelectorAll<HTMLElement>("[data-composer-chip]"));
    const selectedChipIds = () =>
      Array.from(editor.querySelectorAll<HTMLElement>("[data-composer-chip-selected]")).map((chip) => chip.dataset.iosContextId);
    await waitFor(() => expect(chips()).toHaveLength(2));

    editor.focus();
    const selection = window.getSelection();
    if (!selection) throw new Error("jsdom selection unavailable");
    const selectAll = document.createRange();
    selectAll.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(selectAll);
    document.dispatchEvent(new Event("selectionchange"));

    await waitFor(() => expect(selectedChipIds()).toEqual(["ios-1", "ios-2"]));

    // Shrinking the selection onto the first chip must release the second one.
    const firstChipOnly = document.createRange();
    firstChipOnly.setStartBefore(chips()[0]);
    firstChipOnly.setEndAfter(chips()[0]);
    selection.removeAllRanges();
    selection.addRange(firstChipOnly);
    document.dispatchEvent(new Event("selectionchange"));

    await waitFor(() => expect(selectedChipIds()).toEqual(["ios-1"]));

    // Collapsing to a plain caret drops every mark.
    const caret = document.createRange();
    caret.setStart(editor, 0);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    document.dispatchEvent(new Event("selectionchange"));

    await waitFor(() => expect(selectedChipIds()).toEqual([]));
  });

  it("listens for selectionchange only while the rich composer is focused and holds a chip", async () => {
    const url = "https://github.com/arul28/ADE/pull/835";
    (window as any).ade = {
      agentChat: {
        resolveSmartLinkPreview: vi.fn().mockResolvedValue({
          url,
          provider: "github",
          kind: "github_pr",
          label: "arul28/ADE#835",
        }),
      },
    };
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const attachCount = () => addSpy.mock.calls.filter(([type]) => type === "selectionchange").length;
    const detachCount = () => removeSpy.mock.calls.filter(([type]) => type === "selectionchange").length;

    try {
      const props = buildComposerProps({ draft: url, turnActive: false, shouldAutofocus: false });
      const view = render(<AgentChatComposer {...props} />);
      const editor = screen.getByRole("textbox");
      await waitFor(() => expect(editor.querySelectorAll("[data-composer-chip]")).toHaveLength(1));

      // Chipped but unfocused: nothing global is attached.
      expect(attachCount()).toBe(0);

      editor.focus();
      expect(attachCount()).toBe(1);

      // Chip count drops to zero while still focused: the listener goes away.
      view.rerender(<AgentChatComposer {...props} draft="" />);
      await waitFor(() => {
        expect(editor.querySelectorAll("[data-composer-chip]")).toHaveLength(0);
        expect(detachCount()).toBe(1);
      });

      view.unmount();
      expect(detachCount()).toBe(attachCount());
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  /**
   * The running chat's machine label. PR #968 redesigned the new-chat composer
   * and deleted this chip along the way, leaving no way to tell where a chat was
   * executing while typing into it. These lock the restored contract.
   */
  describe("machine chip", () => {
    const chip = (container: HTMLElement) =>
      container.querySelector('[data-chat-composer-machine-chip="readonly"]');

    it("names the remote machine a running chat is pinned to", () => {
      const { container } = renderComposer({
        sessionId: "session-1",
        composerMachineBinding: {
          kind: "remote",
          key: "remote:target-studio:project-a",
          targetId: "target-studio",
          runtimeName: "Arul's Mac Studio",
          projectId: "project-a",
          rootPath: "/repo-a",
          displayName: "Repo A",
        },
      });

      expect(chip(container)?.textContent).toContain("Arul's Mac Studio");
      expect(chip(container)?.getAttribute("aria-label")).toBe("Running on Arul's Mac Studio");
    });

    it("truncates a long remote machine label while retaining its full accessible name", () => {
      const machineName = "Arul's always-on Mac Studio in the office rack";
      const { container } = renderComposer({
        sessionId: "session-1",
        composerMachineBinding: {
          kind: "remote",
          key: "remote:target-studio:project-a",
          targetId: "target-studio",
          runtimeName: machineName,
          projectId: "project-a",
          rootPath: "/repo-a",
          displayName: "Repo A",
        },
      });

      const element = chip(container)!;
      expect(element.getAttribute("aria-label")).toBe(`Running on ${machineName}`);
      expect(element.querySelector("span")?.className).toContain("max-w-24");
      expect(element.querySelector("span")?.className).toContain("truncate");
    });

    it("names this computer when a running chat has no remote binding", () => {
      // A null binding is not "unknown" — it is local. The composer is one row
      // with nothing to contrast against, so unlike the sidebar it states the
      // machine even when the answer is "here".
      const { container } = renderComposer({
        sessionId: "session-1",
        composerMachineBinding: null,
      });

      expect(chip(container)?.textContent).toContain(THIS_MACHINE_NAME);
    });

    it("names the remote machine for a running orchestration lead", () => {
      const { container } = renderComposer({
        sessionId: "lead-session",
        orchestrationRole: "lead",
        composerMachineBinding: {
          kind: "remote",
          key: "remote:target-studio:project-a",
          targetId: "target-studio",
          runtimeName: "Arul's Mac Studio",
          projectId: "project-a",
          rootPath: "/repo-a",
          displayName: "Repo A",
        },
      });

      expect(screen.queryByRole("button", { name: /Select model/i })).toBeNull();
      expect(chip(container)?.textContent).toContain("Arul's Mac Studio");
      expect(chip(container)?.getAttribute("aria-label")).toBe("Running on Arul's Mac Studio");
    });

    it("names the remote machine when the host hides model controls", () => {
      const { container } = renderComposer({
        sessionId: "embedded-session",
        hideModelControls: true,
        composerMachineBinding: {
          kind: "remote",
          key: "remote:target-studio:project-a",
          targetId: "target-studio",
          runtimeName: "Arul's Mac Studio",
          projectId: "project-a",
          rootPath: "/repo-a",
          displayName: "Repo A",
        },
      });

      expect(screen.queryByRole("button", { name: /Select model/i })).toBeNull();
      expect(chip(container)?.textContent).toContain("Arul's Mac Studio");
      expect(chip(container)?.getAttribute("aria-label")).toBe("Running on Arul's Mac Studio");
    });

    it("is read-only — moving a chat is the handoff flow's job, not a picker", () => {
      const { container } = renderComposer({
        sessionId: "session-1",
        composerMachineBinding: null,
      });

      const element = chip(container)!;
      expect(element.tagName).toBe("SPAN");
      expect(element.closest("button")).toBeNull();
      expect(element.getAttribute("aria-haspopup")).toBeNull();
    });

    it("stays out of a draft composer, where the launch shelf owns the choice", () => {
      // A draft has a CHOICE of machine, not a machine. Labelling it here would
      // either duplicate the shelf's picker or assert a default about to change.
      const { container } = renderComposer({ sessionId: null });
      expect(chip(container)).toBeNull();
    });
  });

  describe("compact context dial", () => {
    const usageViewModel = {
      provider: "codex",
      state: "measured" as const,
      contextWindow: 200_000,
      usedTokens: 160_000,
      inputTokens: 160_000,
      outputTokens: 500,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      ratio: 0.8,
      windowSource: "runtime" as const,
    };

    it("sends compact from the meter without submitting the unsent draft", () => {
      const onCompactContext = vi.fn();
      const view = renderComposer({
        turnActive: false,
        sessionProvider: "codex",
        usageViewModel,
        onCompactContext,
        draft: "keep this draft",
      });

      fireEvent.click(screen.getByRole("button", { name: "Context usage: 80% full. Compact context" }));
      expect(onCompactContext).toHaveBeenCalledTimes(1);
      expect(view.onSubmit).not.toHaveBeenCalled();
      expect(view.onDraftChange).not.toHaveBeenCalled();
    });

    it("disables compact while the turn is active", () => {
      const onCompactContext = vi.fn();
      renderComposer({
        turnActive: true,
        sessionProvider: "claude",
        usageViewModel,
        onCompactContext,
      });

      const button = screen.getByRole("button", {
        name: "Context usage: 80% full. Wait for this turn to finish before compacting.",
      });
      expect(button).toHaveProperty("disabled", true);
      fireEvent.click(button);
      expect(onCompactContext).not.toHaveBeenCalled();
    });

    it("keeps the meter read-only for providers without /compact", () => {
      renderComposer({
        turnActive: false,
        sessionProvider: "cursor",
        usageViewModel: { ...usageViewModel, provider: "cursor" },
        onCompactContext: vi.fn(),
      });

      expect(screen.queryByRole("button", { name: /Compact context/i })).toBeNull();
      expect(screen.getByLabelText("Context usage: 80% full")).toBeTruthy();
    });

    it("follows the live session provider, not the model picker", () => {
      const onCompactContext = vi.fn();
      renderComposer({
        turnActive: false,
        sessionProvider: "claude",
        compactSessionProvider: "cursor",
        usageViewModel,
        onCompactContext,
      });
      expect(screen.queryByRole("button", { name: /Compact context/i })).toBeNull();

      cleanup();
      renderComposer({
        turnActive: false,
        sessionProvider: "cursor",
        compactSessionProvider: "claude",
        usageViewModel,
        onCompactContext,
      });
      expect(screen.getByRole("button", { name: "Context usage: 80% full. Compact context" })).toBeTruthy();
    });

    it("hides compact while the composer is locked on a subagent view", () => {
      renderComposer({
        turnActive: false,
        sessionProvider: "codex",
        usageViewModel,
        onCompactContext: vi.fn(),
        inputLockMessage: "Viewing Explore",
      });
      expect(screen.queryByRole("button", { name: /Compact context/i })).toBeNull();
      expect(screen.getByLabelText("Context usage: 80% full")).toBeTruthy();
    });
  });
});
