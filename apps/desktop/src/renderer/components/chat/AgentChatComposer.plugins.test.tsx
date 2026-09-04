/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";

import { AgentChatComposer } from "./AgentChatComposer";
import { makeLinearIssueContextAttachment } from "../../../shared/chatContextAttachments";
import type { NormalizedLinearIssue } from "../../../shared/types";
import {
  resetBuiltinSurfacePlugins,
  seedBuiltinSurfacePlugins,
} from "../../../test/builtinSurfaces";
import { useAppStore } from "../../state/appStore";

/**
 * The composer's plugin seams, positive half — contributed menu rows, the
 * submenu a plugin can open on its own, the chrome a plugin runtime takes off,
 * and the machine row that owns Enter.
 *
 * Its own file on purpose. The socket source cache is a module singleton whose
 * first successful load settles it for the rest of the module registry, so ONE
 * manifest serves every test here and a suite that wants a different one needs
 * a different file. The no-plugin case lives in `AgentChatComposer.test.tsx`,
 * which is the only place it is still true.
 */

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
    Qwen: brand(),
    XAI: brand(),
  };
});

const invoked: { action: string; args: any }[] = [];

const MANIFEST = {
  name: "cloudy",
  version: "1.0.0",
  sockets: [
    {
      socket: "composer-menu-item",
      surface: "work",
      id: "stash",
      label: "Save to stash",
      actionId: "stash",
    },
    {
      socket: "chat-menu-item",
      surface: "work",
      id: "attach",
      label: "Tracker issue",
      actionId: "attachIssue",
      submenu: "issue-context",
    },
  ],
  chatRuntimes: [
    {
      id: "one-shot",
      displayName: "Cloudy one-shot",
      capabilities: { followUp: false, interrupt: false, hydrate: true, artifacts: true },
    },
    {
      id: "agent",
      displayName: "Cloudy agent",
      capabilities: { followUp: true, interrupt: true, hydrate: true, artifacts: true },
    },
  ],
};

function installPluginHost(): void {
  const existing = (window as any).ade ?? {};
  (window as any).ade = {
    ...existing,
    plugins: {
      list: async () => [{
        pluginId: "cloudy",
        displayName: "Cloudy",
        enabled: true,
        accent: "#6E56CF",
        icon: null,
        disabledContributions: [],
      }],
      getManifest: async () => MANIFEST,
      listContributions: async () => [],
      invoke: async (args: { pluginId: string; action: string; args: unknown }) => {
        invoked.push({ action: args.action, args: args.args });
        return {};
      },
    },
  };
}

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

beforeEach(() => {
  installMatchMediaMock();
  invoked.length = 0;
  // A machine with no superseding plugin, so ADE draws its own Linear row and
  // the issue-context entry exists on its own. The gate test below replaces it.
  seedBuiltinSurfacePlugins([]);
  installPluginHost();
});

afterEach(() => {
  cleanup();
  resetBuiltinSurfacePlugins();
  useAppStore.setState({ promptStashButtonEnabled: true });
  delete (window as any).ade;
});

function buildComposerProps(
  overrides: Partial<ComponentProps<typeof AgentChatComposer>> = {},
): ComponentProps<typeof AgentChatComposer> {
  return {
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
}

function makeLinearIssue(): NormalizedLinearIssue {
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
  };
}

describe("contributed composer menu rows", () => {
  it("adds a contributed row to the overflow menu after ADE's own entries", async () => {
    render(<AgentChatComposer {...buildComposerProps({
      sessionId: "chat-1",
      isActive: true,
      turnActive: false,
      draft: "Ship the fix",
      onAddContextAttachment: vi.fn(),
    })} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "More composer controls" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More composer controls" }));
    const rows = screen.getAllByRole("menuitemcheckbox").map((node) => node.textContent ?? "");
    // Host content first: the plugin joins the end of the list, never the middle.
    expect(rows[0]).toContain("Issue context");
    expect(rows.at(-1)).toContain("Save to stash");

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Save to stash/ }));
    });
    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.action).toBe("stash");
    expect(invoked[0]?.args.context.draft).toBe("Ship the fix");
  });
});

describe("contributed issue-context rows", () => {
  it("draws contributed rows after ADE's own inside the submenu", async () => {
    render(<AgentChatComposer {...buildComposerProps({
      sessionId: "chat-1",
      isActive: true,
      turnActive: false,
      draft: "",
      onAddContextAttachment: vi.fn(),
    })} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "More composer controls" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More composer controls" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Issue context/ }));

    await waitFor(() => expect(screen.getByText("Tracker issue")).toBeTruthy());
    const menu = document.querySelector("[data-issue-context-menu]")!;
    const labels = Array.from(menu.querySelectorAll("button")).map((node) => node.textContent ?? "");
    expect(labels[0]).toContain("Linear issue");
    expect(labels.at(-1)).toContain("Tracker issue");
  });

  it("opens the submenu for a contributed row when nothing core does", async () => {
    // Installing the Linear owner supersedes ADE's compiled Linear surface, so
    // the core half of the gate is off and no GitHub repo is bound: without the
    // contributed row the entry would not exist at all.
    seedBuiltinSurfacePlugins(["linear"]);
    installPluginHost();

    render(<AgentChatComposer {...buildComposerProps({
      sessionId: "chat-1",
      isActive: true,
      turnActive: false,
      draft: "",
      onAddContextAttachment: vi.fn(),
    })} />);

    // The entry exists at all only because of the contributed row; the
    // contributed overflow row keeps the control in its menu form.
    await waitFor(() => expect(screen.getByRole("button", { name: "More composer controls" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More composer controls" }));
    const entry = screen.getByRole("menuitemcheckbox", { name: /Issue context/ }) as HTMLButtonElement;
    expect(entry.disabled).toBe(false);
    fireEvent.click(entry);
    await waitFor(() => expect(screen.getByText("Tracker issue")).toBeTruthy());
    // ADE's own rows are gone with the surface they belong to.
    expect(screen.queryByText("Linear issue")).toBeNull();
    expect(screen.queryByText("GitHub issue")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText("Tracker issue"));
    });
    expect(invoked.map((entry) => entry.action)).toEqual(["attachIssue"]);
  });
});

describe("chat chrome for a plugin-owned runtime", () => {
  it("drops Stop and the steer control for a runtime that declares neither", async () => {
    render(<AgentChatComposer {...buildComposerProps({
      sessionId: "chat-1",
      isActive: true,
      turnActive: true,
      sessionProvider: "plugin",
      chatRuntimeRef: { pluginId: "cloudy", runtimeId: "one-shot" },
    })} />);

    // Absent, not disabled: there is no sentence that makes a Stop this runtime
    // will never act on true.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop active turn" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Send steer message" })).toBeNull();
  });

  it("keeps Stop and the steer control for a runtime that declares both", async () => {
    render(<AgentChatComposer {...buildComposerProps({
      sessionId: "chat-1",
      isActive: true,
      turnActive: true,
      sessionProvider: "plugin",
      chatRuntimeRef: { pluginId: "cloudy", runtimeId: "agent" },
    })} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Stop active turn" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Send steer message" })).toBeTruthy();
  });

  it("keeps both controls when the runtime cannot be resolved", async () => {
    render(<AgentChatComposer {...buildComposerProps({
      sessionId: "chat-1",
      isActive: true,
      turnActive: true,
      sessionProvider: "plugin",
      chatRuntimeRef: { pluginId: "cloudy", runtimeId: "renamed" },
    })} />);

    // A manifest out of reach must never silently remove a chat's Stop.
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop active turn" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Send steer message" })).toBeTruthy();
  });

  it("leaves a provider-owned session with exactly the controls it had", () => {
    render(<AgentChatComposer {...buildComposerProps({
      sessionId: "chat-1",
      isActive: true,
      turnActive: true,
    })} />);

    expect(screen.getByRole("button", { name: "Stop active turn" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send steer message" })).toBeTruthy();
  });
});

describe("the selected machine row owns Enter", () => {
  const OWNER = { pluginId: "cloudy", actionId: "launch", label: "Cloudy" };

  it("launches through the plugin instead of the local runtime", async () => {
    const onSubmit = vi.fn();

    render(<AgentChatComposer {...buildComposerProps({
      sessionId: null,
      isActive: true,
      turnActive: false,
      draft: "Build the thing",
      onSubmit,
      machineSendOwner: OWNER,
    })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send to Cloudy" }));
    });

    // One send path: the machine row reuses the `ownsSend` branch rather than
    // forking a second launch, so the local runtime never sees the turn.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.action).toBe("launch");
    expect(invoked[0]?.args.send).toBe(true);
    expect(invoked[0]?.args.context.draft).toBe("Build the thing");
  });

  it("joins attached issue context onto the prompt", async () => {
    render(<AgentChatComposer {...buildComposerProps({
      sessionId: null,
      isActive: true,
      turnActive: false,
      draft: "Build the thing",
      contextAttachments: [makeLinearIssueContextAttachment(makeLinearIssue(), "manual")],
      machineSendOwner: OWNER,
    })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send to Cloudy" }));
    });

    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.args.context.draft).toContain("ADE-123");
    expect(invoked[0]?.args.context.draft).toContain("Build the thing");
  });

  it("blocks an empty send instead of falling back to the local runtime", async () => {
    const onSubmit = vi.fn();

    render(<AgentChatComposer {...buildComposerProps({
      sessionId: null,
      isActive: true,
      turnActive: false,
      draft: "",
      onSubmit,
      machineSendOwner: OWNER,
    })} />);

    const send = screen.getByRole("button", { name: "Send to Cloudy" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(invoked).toHaveLength(0);
  });
});
