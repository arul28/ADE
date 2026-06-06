/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type {
  AgentChatEventEnvelope,
  AgentChatEventHistorySnapshot,
  AgentChatModelCatalog,
  AgentChatParallelLaunchState,
  AgentChatSession,
  AgentChatSessionSummary,
  PrSummary,
  TerminalSessionChangedEvent,
  TerminalSessionDetail,
} from "../../../shared/types";
import { createDynamicCursorCliModelDescriptor, getModelById } from "../../../shared/modelRegistry";
import { invalidateAgentChatSessionListCache } from "../../lib/agentChatSessionListCache";
import { invalidateAgentChatSlashCommandsCache } from "../../lib/agentChatSlashCommandsCache";
import { getAiStatusCached, invalidateAiDiscoveryCache } from "../../lib/aiDiscoveryCache";
import { DRAFT_LAUNCH_JOB_STALE_AFTER_MS } from "../../lib/draftLaunchJobs";
import { invalidateProjectConfigCache } from "../../lib/projectConfigCache";
import { useAppStore } from "../../state/appStore";
import {
  rememberRuntimeCatalog,
  resetModelPickerRuntimeCatalogForTests,
} from "../shared/ModelPicker/runtimeCatalogCache";
import {
  AgentChatPane,
  buildParallelLaunchPrompt,
  cleanupSubagentAutoOpenStorage,
  cleanupTransientParallelLaunchLanes,
  formatParallelLaunchFailureMessage,
  getSubagentAutoOpenStorageKey,
  isMatchingOptimisticUserMessage,
  mergeChatHistorySnapshot,
  parallelLaneModelSuffix,
  resolveNextSelectedSessionId,
  shouldPromoteSessionForComputerUse,
  type AgentChatSessionCreatedOptions,
} from "./AgentChatPane";

vi.mock("../terminals/TerminalView", () => {
  const ReactMod = require("react") as typeof React;
  return {
    TerminalView: (props: { sessionId: string; ptyId: string }) =>
      ReactMod.createElement("div", { "data-testid": "terminal-view" }, `${props.sessionId}:${props.ptyId}`),
  };
});

vi.mock("./ChatIosSimulatorPanel", () => {
  const ReactMod = require("react") as typeof React;
  return {
    ChatIosSimulatorPanel: () => ReactMod.createElement("div", { "data-testid": "ios-panel" }, "iOS panel mounted"),
  };
});

vi.mock("./ChatAppControlPanel", () => {
  const ReactMod = require("react") as typeof React;
  return {
    ChatAppControlPanel: () => ReactMod.createElement("div", { "data-testid": "app-control-panel" }, "App Control panel mounted"),
  };
});

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
    Kimi: brand(),
    LmStudio: brand(),
    Ollama: brand(),
    OpenAI: brand(),
    OpenCode: brand(),
    OpenRouter: brand(),
    XAI: brand(),
  };
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSession(sessionId: string, overrides: Partial<AgentChatSessionSummary> = {}): AgentChatSessionSummary {
  return {
    sessionId,
    laneId: "lane-1",
    provider: "codex",
    model: "gpt-5.4",
    modelId: "openai/gpt-5.4",
    endedAt: null,
    lastOutputPreview: null,
    summary: null,
    startedAt: "2026-03-24T05:57:45.700Z",
    lastActivityAt: "2026-03-24T05:57:45.700Z",
    status: "active",
    sessionProfile: "workflow",
    title: null,
    goal: null,
    completion: null,
    reasoningEffort: "xhigh",
    executionMode: "focused",
    interactionMode: null,
    ...overrides,
  };
}

function buildPrSummary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 224,
    githubUrl: "https://github.com/arul28/ADE/pull/224",
    githubNodeId: "PR_node224",
    title: "Show merged PR state",
    state: "open",
    baseBranch: "main",
    headBranch: "feature/pr-state",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 1,
    deletions: 1,
    lastSyncedAt: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildCreatedSession(sessionId: string, overrides: Partial<AgentChatSession> = {}): AgentChatSession {
  return {
    id: sessionId,
    laneId: "lane-1",
    provider: "codex",
    model: "gpt-5.4",
    modelId: "openai/gpt-5.4",
    status: "idle",
    sessionProfile: "workflow",
    reasoningEffort: "xhigh",
    executionMode: "focused",
    createdAt: "2026-03-24T05:57:45.700Z",
    lastActivityAt: "2026-03-24T05:57:45.700Z",
    ...overrides,
  };
}

function buildStatusStartedTranscript(sessionId: string): string {
  return `${JSON.stringify({
    sessionId,
    timestamp: "2026-03-24T05:57:45.700Z",
    event: {
      type: "status",
      turnStatus: "started",
      turnId: "turn-1",
    },
  })}\n`;
}

function seedRuntimeModelCatalog(): void {
  rememberRuntimeCatalog({
    fetchedAt: "2026-05-22T00:00:00.000Z",
    groups: [
      {
        key: "codex",
        displayName: "Codex",
        providers: [{
          key: "codex",
          displayName: "Codex",
          badgeColor: "#60A5FA",
          modelCount: 1,
          subsections: [{
            key: "default",
            label: "Codex",
            models: [{
              id: "openai/gpt-5.4",
              runtimeModelId: "gpt-5.4",
              provider: "codex",
              providerKey: "codex",
              groupKey: "codex",
              displayName: "GPT-5.4",
              isDefault: false,
              isAvailable: true,
            }],
          }],
        }],
      },
      {
        key: "claude",
        displayName: "Claude",
        providers: [{
          key: "claude",
          displayName: "Claude",
          badgeColor: "#D97706",
          modelCount: 1,
          subsections: [{
            key: "default",
            label: "Claude",
            models: [{
              id: "anthropic/claude-sonnet-4-6",
              runtimeModelId: "claude-sonnet-4-6",
              provider: "claude",
              providerKey: "claude",
              groupKey: "claude",
              displayName: "Claude Sonnet 4.6",
              isDefault: true,
              isAvailable: true,
            }],
          }],
        }],
      },
    ],
  } as AgentChatModelCatalog, { mode: "cached" });
}

function seedCursorRuntimeModelCatalog(): { cliOnlyId: string; chatOnlyId: string; bothId: string } {
  const cliOnly = createDynamicCursorCliModelDescriptor("cli-only", "Cursor CLI Only", {
    cursorAvailability: { cli: true, sdk: false },
  });
  const chatOnly = createDynamicCursorCliModelDescriptor("chat-only", "Cursor Chat Only", {
    cursorAvailability: { cli: false, sdk: true },
  });
  const both = createDynamicCursorCliModelDescriptor("both", "Cursor Both", {
    cursorAvailability: { cli: true, sdk: true },
  });
  const models = [cliOnly, chatOnly, both];
  rememberRuntimeCatalog({
    fetchedAt: "2026-05-22T00:00:00.000Z",
    groups: [{
      key: "cursor",
      displayName: "Cursor",
      providers: [{
        key: "cursor",
        displayName: "Cursor",
        badgeColor: "#8B5CF6",
        modelCount: models.length,
        subsections: [{
          key: "cursor",
          label: "Cursor",
          models: models.map((model, index) => ({
            id: model.id,
            runtimeModelId: model.providerModelId,
            provider: "cursor",
            providerKey: "cursor",
            groupKey: "cursor",
            displayName: model.displayName,
            isDefault: index === 2,
            isAvailable: true,
            cursorAvailability: model.cursorAvailability,
          })),
        }],
      }],
    }],
  } as AgentChatModelCatalog, { mode: "cached" });
  return { cliOnlyId: cliOnly.id, chatOnlyId: chatOnly.id, bothId: both.id };
}

function seedFastCursorRuntimeModelCatalog(): { modelId: string; fastAlias: string } {
  const model = createDynamicCursorCliModelDescriptor("composer-2.5", "Composer 2.5", {
    aliases: ["other-fast", "composer-2.5-speed-fast"],
    serviceTiers: ["fast"],
    cursorAvailability: { cli: true, sdk: true },
  });
  rememberRuntimeCatalog({
    fetchedAt: "2026-05-22T00:00:00.000Z",
    groups: [{
      key: "cursor",
      displayName: "Cursor",
      providers: [{
        key: "cursor",
        displayName: "Cursor",
        badgeColor: "#8B5CF6",
        modelCount: 1,
        subsections: [{
          key: "cursor",
          label: "Cursor",
          models: [{
            id: model.id,
            runtimeModelId: model.providerModelId,
            provider: "cursor",
            providerKey: "cursor",
            groupKey: "cursor",
            displayName: model.displayName,
            isDefault: true,
            isAvailable: true,
            aliases: model.aliases,
            serviceTiers: model.serviceTiers,
            cursorAvailability: model.cursorAvailability,
          }],
        }],
      }],
    }],
  } as AgentChatModelCatalog, { mode: "cached" });
  return { modelId: model.id, fastAlias: "composer-2.5-speed-fast" };
}

function seedReasoningCursorRuntimeModelCatalog(): { modelId: string; concreteModel: string } {
  const concreteModel = "claude-opus-4-7-thinking-medium-fast";
  const model = createDynamicCursorCliModelDescriptor("claude-opus-4-7-thinking", "Opus 4.7 1M Thinking", {
    reasoningTiers: ["low", "medium"],
    serviceTiers: ["fast"],
    cursorAvailability: { cli: true, sdk: false },
    cursorCliVariants: [
      { modelId: "claude-opus-4-7-thinking-low", reasoningEffort: "low", fastMode: false },
      { modelId: "claude-opus-4-7-thinking-low-fast", reasoningEffort: "low", fastMode: true },
      { modelId: "claude-opus-4-7-thinking-medium", reasoningEffort: "medium", fastMode: false },
      { modelId: concreteModel, reasoningEffort: "medium", fastMode: true },
    ],
  });
  rememberRuntimeCatalog({
    fetchedAt: "2026-05-22T00:00:00.000Z",
    groups: [{
      key: "cursor",
      displayName: "Cursor",
      providers: [{
        key: "cursor",
        displayName: "Cursor",
        badgeColor: "#8B5CF6",
        modelCount: 1,
        subsections: [{
          key: "cursor",
          label: "Cursor",
          models: [{
            id: model.id,
            runtimeModelId: model.providerModelId,
            provider: "cursor",
            providerKey: "cursor",
            groupKey: "cursor",
            displayName: model.displayName,
            isDefault: true,
            isAvailable: true,
            aliases: model.aliases,
            reasoningEfforts: model.reasoningTiers?.map((effort) => ({ effort, description: `${effort} reasoning` })),
            serviceTiers: model.serviceTiers,
            cursorAvailability: model.cursorAvailability,
            cursorCliVariants: model.cursorCliVariants,
          }],
        }],
      }],
    }],
  } as AgentChatModelCatalog, { mode: "cached" });
  return { modelId: model.id, concreteModel };
}

function buildPendingInputTranscript(sessionId: string): string {
  return `${JSON.stringify({
    sessionId,
    timestamp: "2026-03-24T05:57:45.700Z",
    event: {
      type: "approval_request",
      itemId: "approval-1",
      kind: "tool_call",
      description: "Which branch should I use?",
      turnId: "turn-1",
      detail: {
        tool: "askUser",
        question: "Which branch should I use?",
      },
    },
  })}\n`;
}

function buildOrchestrationPlanApprovalTranscript(sessionId: string): string {
  return `${JSON.stringify({
    sessionId,
    timestamp: "2026-03-24T05:57:45.700Z",
    event: {
      type: "approval_request",
      itemId: "approval-1",
      kind: "tool_call",
      description: "Plan ready for approval",
      turnId: "turn-1",
      detail: {
        request: {
          requestId: "approval-1",
          itemId: "approval-1",
          source: "ade",
          kind: "plan_approval",
          title: "Plan ready",
          description: "1. Inspect\n2. Patch\n3. Verify",
          questions: [],
          allowsFreeform: true,
          blocking: true,
          canProceedWithoutAnswer: false,
          providerMetadata: {
            orchestrationPlanApproval: true,
          },
        },
      },
    },
  })}\n`;
}

function installAdeMocks(options?: {
  transcript?: string;
  sendError?: Error;
  steerError?: Error;
  listError?: Error;
  createError?: Error;
  handoffResult?: { session: AgentChatSession; usedFallbackSummary: boolean };
  sessions?: AgentChatSessionSummary[];
  eventHistory?: AgentChatEventHistorySnapshot | ((args: { sessionId: string; maxEvents?: number }) => Promise<AgentChatEventHistorySnapshot> | AgentChatEventHistorySnapshot);
  includeClaudeModel?: boolean;
  cursorModels?: Array<{ id: string }>;
  parallelLaunchState?: AgentChatParallelLaunchState | null;
  linkedPr?: PrSummary | null;
}) {
  const send = options?.sendError
    ? vi.fn().mockRejectedValue(options.sendError)
    : vi.fn().mockResolvedValue(undefined);
  const steer = options?.steerError
    ? vi.fn().mockRejectedValue(options.steerError)
    : vi.fn().mockResolvedValue(undefined);
  const list = options?.listError
    ? vi.fn().mockRejectedValue(options.listError)
    : vi.fn().mockResolvedValue(options?.sessions ?? [buildSession("session-1")]);
  const handoff = vi.fn().mockResolvedValue(options?.handoffResult ?? {
    session: buildCreatedSession("handoff-session-1"),
    usedFallbackSummary: false,
  });
  const create = options?.createError
    ? vi.fn().mockRejectedValue(options.createError)
    : vi.fn().mockImplementation(async (args: Record<string, unknown> = {}) => {
        const overrides: Partial<AgentChatSession> = {
          laneId: typeof args.laneId === "string" ? args.laneId : "lane-1",
          reasoningEffort: (args.reasoningEffort as string | null | undefined) ?? "xhigh",
        };
        if (typeof args.provider === "string") overrides.provider = args.provider as AgentChatSession["provider"];
        if (typeof args.model === "string") overrides.model = args.model;
        if (typeof args.modelId === "string") overrides.modelId = args.modelId;
        if (typeof args.interactionMode === "string") {
          overrides.interactionMode = args.interactionMode as AgentChatSession["interactionMode"];
        }
        return buildCreatedSession("created-session", overrides);
      });
  const createLane = vi.fn().mockResolvedValue({
    id: "lane-created",
    name: "auto-created-lane",
    laneType: "worktree",
    branchRef: "refs/heads/auto-created-lane",
    worktreePath: "/tmp/project-under-test/auto-created-lane",
    parentLaneId: "lane-primary",
  });
  const suggestLaneName = vi.fn().mockResolvedValue("parallel-task");
  const parallelLaunchStateGet = vi.fn().mockResolvedValue(options?.parallelLaunchState ?? null);
  const parallelLaunchStateSet = vi.fn().mockResolvedValue(undefined);
  const deleteChat = vi.fn().mockResolvedValue(undefined);
  const archive = vi.fn().mockResolvedValue(undefined);
  const unarchive = vi.fn().mockResolvedValue(undefined);
  const deleteLane = vi.fn().mockResolvedValue(undefined);
  const writeClipboardText = vi.fn().mockResolvedValue(undefined);
  const chatEventListeners = new Set<(event: AgentChatEventEnvelope) => void>();
  const sessionChangeListeners = new Set<(event: TerminalSessionChangedEvent) => void>();

  globalThis.window.ade = {
    app: {
      writeClipboardText,
    },
    projectConfig: {
      get: vi.fn().mockResolvedValue({
        effective: {
          ai: {
            chat: {
              sendOnEnter: true,
            },
          },
        },
      }),
    },
    ai: {
      getStatus: vi.fn().mockRejectedValue(new Error("no ai status")),
    },
    agentChat: {
      models: vi.fn().mockImplementation(async ({ provider }: { provider: string }) => {
        if (provider === "codex") return [{ id: "gpt-5.4" }];
        if (provider === "claude") return options?.includeClaudeModel ? [{ id: "anthropic/claude-sonnet-4-6" }] : [];
        if (provider === "cursor") return options?.cursorModels ?? [];
        if (provider === "opencode") return [{ id: "openai/gpt-5.4-mini" }];
        return [];
      }),
      slashCommands: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn().mockImplementation((listener: (event: AgentChatEventEnvelope) => void) => {
        chatEventListeners.add(listener);
        return () => {
          chatEventListeners.delete(listener);
        };
      }),
      handoff,
      send,
      steer,
      list,
      ...(options?.eventHistory !== undefined
        ? {
            getEventHistory: vi.fn().mockImplementation(async (args: { sessionId: string; maxEvents?: number }) => {
              if (typeof options.eventHistory === "function") return options.eventHistory(args);
              return options.eventHistory;
            }),
          }
        : {}),
      suggestLaneName,
      parallelLaunchState: {
        get: parallelLaunchStateGet,
        set: parallelLaunchStateSet,
      },
      getSummary: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
        const sessions = options?.sessions ?? [buildSession("session-1")];
        return sessions.find((s) => s.sessionId === sessionId) ?? null;
      }),
      editSteer: vi.fn().mockResolvedValue(undefined),
      updateSession: vi.fn().mockResolvedValue(undefined),
      archive,
      unarchive,
      interrupt: vi.fn().mockResolvedValue(undefined),
      approve: vi.fn().mockResolvedValue(undefined),
      respondToInput: vi.fn().mockResolvedValue(undefined),
      warmupModel: vi.fn().mockResolvedValue(undefined),
      fileSearch: vi.fn().mockResolvedValue([]),
      create,
      delete: deleteChat,
      dispose: vi.fn().mockResolvedValue(undefined),
    },
    sessions: {
      get: vi.fn().mockResolvedValue({ toolType: "codex-chat" }),
      readTranscriptTail: vi.fn().mockResolvedValue(options?.transcript ?? ""),
      getDelta: vi.fn().mockResolvedValue(null),
      onChanged: vi.fn().mockImplementation((listener: (event: TerminalSessionChangedEvent) => void) => {
        sessionChangeListeners.add(listener);
        return () => {
          sessionChangeListeners.delete(listener);
        };
      }),
    },
    computerUse: {
      getOwnerSnapshot: vi.fn().mockResolvedValue({ artifacts: [] }),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
    },
    files: {
      listWorkspaces: vi.fn().mockResolvedValue([]),
    },
    lanes: {
      list: vi.fn().mockResolvedValue([]),
      listSnapshots: vi.fn().mockResolvedValue([]),
      create: createLane,
      createChild: vi.fn(),
      delete: deleteLane,
    },
    git: {
      listBranches: vi.fn().mockResolvedValue([]),
      getActionRuntime: vi.fn().mockResolvedValue(null),
      onActionRuntimeEvent: vi.fn().mockImplementation(() => () => undefined),
    },
    diff: {
      getChanges: vi.fn().mockResolvedValue({ staged: [], unstaged: [] }),
    },
    prs: {
      getForLane: vi.fn().mockResolvedValue(options?.linkedPr ?? null),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
      getChecks: vi.fn().mockResolvedValue([]),
      openInGitHub: vi.fn().mockResolvedValue(undefined),
    },
    pty: {
      create: vi.fn().mockResolvedValue({ ptyId: "pty-created", sessionId: "terminal-created", pid: 1234 }),
      onExit: vi.fn().mockImplementation(() => () => undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      onData: vi.fn().mockImplementation(() => () => undefined),
    },
    terminal: {
      list: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue({ terminalId: "term-1", data: "", nextSince: 0 }),
      write: vi.fn().mockResolvedValue({ ok: true }),
      signal: vi.fn().mockResolvedValue({ ok: true }),
      activeForChat: vi.fn().mockResolvedValue(null),
    },
    iosSimulator: {
      getStatus: vi.fn().mockResolvedValue({ platform: "darwin" }),
      onEvent: vi.fn().mockImplementation((listener: (event: { type: string; chatSessionId?: string; laneId?: string; mode?: string }) => void) => {
        iosEventListener = listener;
        return () => {
          if (iosEventListener === listener) iosEventListener = null;
        };
      }),
    },
    appControl: {
      getStatus: vi.fn().mockResolvedValue({ supported: true }),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
    },
    orchestration: {
      runCreate: vi.fn().mockResolvedValue({ runId: "run-1" }),
    },
  } as any;

  return {
    send,
    steer,
    list,
    create,
    createLane,
    deleteChat,
    archive,
    unarchive,
    deleteLane,
    suggestLaneName,
    parallelLaunchStateGet,
    parallelLaunchStateSet,
    handoff,
    writeClipboardText,
    emitChatEvent: (event: AgentChatEventEnvelope) => {
      for (const listener of chatEventListeners) {
        listener(event);
      }
    },
    emitSessionChanged: (event: TerminalSessionChangedEvent) => {
      for (const listener of sessionChangeListeners) {
        listener(event);
      }
    },
  };
}

function resetChatTestStore() {
  useAppStore.setState({
    project: null,
    projectBinding: null,
    laneSnapshots: [],
    lanes: [],
    selectedLaneId: null,
    focusedSessionId: null,
    projectTransition: null,
    laneInspectorTabs: {},
    launchPromptClipboardEnabled: true,
    launchPromptClipboardNoticeEnabled: true,
    workViewByProject: {},
    laneWorkViewByScope: {},
    draftLaunchJobsByScope: {},
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

const originalAde = globalThis.window.ade;
const originalNavigatorPlatform = window.navigator.platform;
const originalMatchMedia = window.matchMedia;
let iosEventListener: ((event: { type: string; chatSessionId?: string; laneId?: string; mode?: string }) => void) | null = null;

function installMatchMediaMock(): void {
  if (typeof window.matchMedia === "function") return;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
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
  invalidateAgentChatSessionListCache();
  invalidateAgentChatSlashCommandsCache();
  invalidateAiDiscoveryCache();
  invalidateProjectConfigCache();
  resetModelPickerRuntimeCatalogForTests();
  window.localStorage.clear();
  window.sessionStorage.clear();
  iosEventListener = null;
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
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
  resetChatTestStore();
});

afterEach(() => {
  cleanup();
  invalidateAgentChatSessionListCache();
  invalidateAgentChatSlashCommandsCache();
  invalidateAiDiscoveryCache();
  invalidateProjectConfigCache();
  resetModelPickerRuntimeCatalogForTests();
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: originalNavigatorPlatform,
  });
  if (originalMatchMedia === undefined) {
    delete (window as unknown as { matchMedia?: Window["matchMedia"] }).matchMedia;
  } else {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  }
  if (originalAde === undefined) {
    delete (globalThis.window as any).ade;
  } else {
    globalThis.window.ade = originalAde;
  }
});

function renderPane(session: AgentChatSessionSummary) {
  return render(
    <MemoryRouter>
      <AgentChatPane
        laneId={session.laneId}
        lockSessionId={session.sessionId}
        hideSessionTabs
        initialSessionSummary={session}
        onSessionCreated={vi.fn()}
      />
    </MemoryRouter>,
  );
}

function renderResolverPane(session: AgentChatSessionSummary) {
  return render(
    <MemoryRouter>
      <AgentChatPane
        laneId={session.laneId}
        lockSessionId={session.sessionId}
        hideSessionTabs
        initialSessionSummary={session}
        presentation={{ mode: "resolver" }}
      />
    </MemoryRouter>,
  );
}

function renderTabbedPane(session: AgentChatSessionSummary) {
  return render(
    <MemoryRouter>
      <AgentChatPane
        laneId={session.laneId}
        initialSessionId={session.sessionId}
        initialSessionSummary={session}
      />
    </MemoryRouter>,
  );
}

function seedDrawerStore() {
  useAppStore.setState({
    project: { rootPath: "/tmp/project-under-test" } as any,
    lanes: [{
      id: "lane-1",
      name: "drawer lane",
      branchRef: "refs/heads/drawer-lane",
      laneType: "worktree",
      worktreePath: "/tmp/project-under-test/drawer-lane",
    } as any],
    selectedLaneId: "lane-1",
  });
}

function seedRemoteChatStore() {
  const rootPath = "/Users/admin/Projects/perf pass";
  useAppStore.setState({
    project: { rootPath, displayName: "perf pass" } as any,
    projectBinding: {
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      projectId: "project-1",
      runtimeName: "Mac Studio",
      displayName: "perf pass",
      rootPath,
    } as any,
    lanes: [{
      id: "lane-1",
      name: "remote lane",
      branchRef: "refs/heads/remote-lane",
      laneType: "worktree",
      worktreePath: `${rootPath}/.ade/worktrees/remote-lane`,
    } as any],
    selectedLaneId: "lane-1",
  });
  return rootPath;
}

function renderDrawerPane() {
  const session = buildSession("session-1", { title: "Drawer audit chat" });
  installAdeMocks({ sessions: [session] });
  seedDrawerStore();
  return renderPane(session);
}

function renderDrawerSessionPane(
  sessions: AgentChatSessionSummary[],
  options?: {
    transcript?: string;
    presentation?: React.ComponentProps<typeof AgentChatPane>["presentation"];
  },
) {
  const active = sessions[0]!;
  const mocks = installAdeMocks({ sessions, transcript: options?.transcript });
  seedDrawerStore();
  const view = render(
    <MemoryRouter>
      <AgentChatPane
        laneId="lane-1"
        initialSessionId={active.sessionId}
        initialSessionSummary={active}
        presentation={options?.presentation}
      />
    </MemoryRouter>,
  );
  return { ...mocks, view };
}

function renderParallelDraftPane(args?: {
  laneId?: string;
  availableModelIdsOverride?: string[];
  initialEntry?: string;
  suppressDraftLaunchNavigation?: boolean;
}) {
  const laneId = args?.laneId ?? "lane-1";
  useAppStore.setState({
    project: { rootPath: "/tmp/project-under-test" } as any,
    lanes: [{
      id: laneId,
      name: "parent-lane",
      laneType: "worktree",
      branchRef: "refs/heads/parent-lane",
      worktreePath: "/tmp/project-under-test/parent-lane",
    } as any],
    selectedLaneId: laneId,
  });

  return render(
    <MemoryRouter initialEntries={[args?.initialEntry ?? "/work"]}>
      <Routes>
        <Route
          path="*"
          element={(
            <>
              <AgentChatPane
                laneId={laneId}
                forceDraftMode
                embeddedWorkLayout
                suppressDraftLaunchNavigation={args?.suppressDraftLaunchNavigation}
                availableModelIdsOverride={args?.availableModelIdsOverride}
              />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function renderAutoCreateDraftPane(args?: {
  onSessionCreated?: (
    session: AgentChatSession,
    options?: AgentChatSessionCreatedOptions,
  ) => void | Promise<void>;
  workDraftKind?: "chat" | "cli" | "chat-orchestrator";
  onLaunchCliSession?: React.ComponentProps<typeof AgentChatPane>["onLaunchCliSession"];
  onLaneChange?: React.ComponentProps<typeof AgentChatPane>["onLaneChange"];
  lanes?: any[];
}) {
  const lanes = args?.lanes ?? [
    {
      id: "lane-primary",
      name: "Primary",
      laneType: "primary",
      branchRef: "refs/heads/main",
      worktreePath: "/tmp/project-under-test",
    },
    {
      id: "lane-1",
      name: "current-lane",
      laneType: "worktree",
      branchRef: "refs/heads/current-lane",
      worktreePath: "/tmp/project-under-test/current-lane",
      parentLaneId: "lane-primary",
    },
  ] as any[];
  useAppStore.setState({
    project: { rootPath: "/tmp/project-under-test" } as any,
    lanes,
    selectedLaneId: "lane-1",
  });

  return render(
    <MemoryRouter initialEntries={["/work"]}>
      <Routes>
        <Route
          path="*"
          element={(
            <>
              <AgentChatPane
                laneId="lane-1"
                forceDraftMode
                embeddedWorkLayout
                workDraftKind={args?.workDraftKind}
                availableLanes={lanes}
                onLaneChange={args?.onLaneChange ?? vi.fn()}
                onSessionCreated={args?.onSessionCreated}
                onLaunchCliSession={args?.onLaunchCliSession}
              />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function composerDraftStorageKeyForTest(args: {
  projectRoot: string;
  companionStateKey: string;
  workDraftKind?: "work-start" | "chat" | "cli" | "chat-orchestrator";
}) {
  return [
    "ade.chat.composerDraft.v1",
    args.projectRoot,
    args.companionStateKey,
    "standard",
    args.workDraftKind ?? "work-start",
  ].map(encodeURIComponent).join(":");
}

function draftLaunchJobsScopeKeyForTest(args: {
  projectRoot: string;
  laneId: string;
  workDraftKind?: "work-start" | "chat-orchestrator";
}) {
  return [
    "draft-launch-jobs",
    args.projectRoot,
    args.laneId,
    "standard",
    args.workDraftKind ?? "work-start",
  ].map(encodeURIComponent).join(":");
}

async function clickEnabledModelOption(name: RegExp | string) {
  const options = await screen.findAllByRole("option", { name });
  const enabledOption = options.find((option) => option.getAttribute("aria-disabled") !== "true");
  expect(enabledOption).toBeTruthy();
  fireEvent.click(enabledOption!);
}

function sessionTabTitles(expectedTitles: string[]) {
  const tabs = screen.getAllByRole("button")
    .filter((button) => expectedTitles.includes(button.textContent?.trim() ?? ""));
  return tabs.map((button) => button.textContent?.trim());
}

describe("AgentChatPane remote startup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the remote binding root for AI status cache lookups", async () => {
    const session = buildSession("session-1", { status: "idle" });
    installAdeMocks({ sessions: [session] });
    window.ade.ai.getStatus = vi.fn().mockResolvedValue({
      mode: "subscription",
      availableProviders: {
        claude: {
          binary: { present: false, source: "missing", path: null },
          auth: { ready: false, mode: "none", detail: null },
        },
        codex: true,
        cursor: false,
        droid: false,
      },
      models: { claude: [], codex: [], cursor: [], droid: [] },
      features: [],
      availableModelIds: ["openai/gpt-5.4"],
    }) as any;
    const remoteRoot = seedRemoteChatStore();
    await getAiStatusCached({ projectRoot: remoteRoot });
    vi.mocked(window.ade.ai.getStatus).mockClear();

    renderPane(session);

    await screen.findByRole("button", { name: /^Select model/ });
    await Promise.resolve();

    expect(window.ade.ai.getStatus).not.toHaveBeenCalled();
  });

  it("skips mount-time session delta fetches for remote chats", async () => {
    const session = buildSession("session-1", { status: "idle" });
    installAdeMocks({ sessions: [session] });
    seedRemoteChatStore();

    renderPane(session);

    await screen.findByRole("button", { name: /^Select model/ });
    await Promise.resolve();

    expect(window.ade.sessions.getDelta).not.toHaveBeenCalled();
  });

  it("defers unfinished parallel launch recovery on remote draft mount", async () => {
    vi.useFakeTimers();
    const { parallelLaunchStateGet } = installAdeMocks({ sessions: [] });
    seedRemoteChatStore();

    render(
      <MemoryRouter initialEntries={["/work"]}>
        <AgentChatPane
          laneId="lane-1"
          forceDraftMode
          embeddedWorkLayout
        />
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(parallelLaunchStateGet).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(14_999);
      await Promise.resolve();
    });
    expect(parallelLaunchStateGet).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(parallelLaunchStateGet).toHaveBeenCalledWith({
      projectRoot: "/Users/admin/Projects/perf pass",
      parentLaneId: "lane-1",
    });
  });

  it("fetches remote session delta after a turn completes", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const mocks = installAdeMocks({ sessions: [session] });
    vi.mocked(window.ade.sessions.getDelta).mockResolvedValue({ insertions: 4, deletions: 2 } as any);
    seedRemoteChatStore();

    renderPane(session);

    await screen.findByRole("button", { name: /^Select model/ });
    expect(window.ade.sessions.getDelta).not.toHaveBeenCalled();

    await act(async () => {
      mocks.emitChatEvent({
        sessionId: session.sessionId,
        timestamp: "2026-06-04T12:00:00.000Z",
        event: { type: "status", turnStatus: "started", turnId: "turn-1" },
      } as any);
    });
    expect(window.ade.sessions.getDelta).not.toHaveBeenCalled();

    await act(async () => {
      mocks.emitChatEvent({
        sessionId: session.sessionId,
        timestamp: "2026-06-04T12:00:01.000Z",
        event: { type: "status", turnStatus: "completed", turnId: "turn-1" },
      } as any);
    });

    await waitFor(() => {
      expect(window.ade.sessions.getDelta).toHaveBeenCalledWith(session.sessionId);
    });
  });
});

describe("AgentChatPane companion drawers", () => {
  it("opens and closes the iOS simulator and App Control drawers from chat chrome", async () => {
    renderDrawerPane();

    await waitFor(() => {
      expect(typeof iosEventListener).toBe("function");
    });
    act(() => {
      iosEventListener?.({
        type: "drawer-open-requested",
        chatSessionId: "session-1",
        laneId: "lane-1",
        mode: "control",
      });
    });

    expect(screen.getByTestId("ios-panel").textContent).toBe("iOS panel mounted");
    fireEvent.click(screen.getAllByRole("button", { name: "Close iOS simulator drawer" })[0]!);
    await waitFor(() => {
      expect(screen.queryByTestId("ios-panel")).toBeNull();
    });

    const iosButton = screen.getAllByRole("button", { name: "Open iOS simulator drawer" })[0]!;
    fireEvent.click(iosButton);

    expect(screen.getByTestId("ios-panel").textContent).toBe("iOS panel mounted");
    expect(screen.getAllByRole("button", { name: "Close iOS simulator drawer" })[0]!.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getAllByRole("button", { name: "Close iOS simulator drawer" })[0]!);
    await waitFor(() => {
      expect(screen.queryByTestId("ios-panel")).toBeNull();
    });

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Open App Control drawer" }).length).toBeGreaterThan(0);
    });
    const appControlButton = screen.getAllByRole("button", { name: "Open App Control drawer" })[0]!;
    fireEvent.click(appControlButton);

    expect(screen.getByTestId("app-control-panel").textContent).toBe("App Control panel mounted");
    expect(screen.getAllByRole("button", { name: "Close App Control drawer" })[0]!.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getAllByRole("button", { name: "Close App Control drawer" })[0]!);
    await waitFor(() => {
      expect(screen.queryByTestId("app-control-panel")).toBeNull();
    });
  });

  it("opens the proof drawer as a floating info pane (no split divider)", async () => {
    renderDrawerPane();

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Proof" }));
    expect(screen.getByText("No artifacts captured yet.")).toBeTruthy();

    // Chat actions is an info pane: it floats over the right gutter created by
    // the centered transcript, so it does NOT get a resizable split divider.
    expect(screen.queryByRole("separator")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close chat actions drawer" }));
    await waitFor(() => {
      expect(screen.queryByText("No artifacts captured yet.")).toBeNull();
    });
  });

  it("persists split resize from the real divider on a working panel", async () => {
    renderDrawerPane();

    // App Control is a heavy working panel that keeps the resizable split (and
    // therefore the drag divider) — unlike the floating chat-actions info pane.
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Open App Control drawer" }).length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Open App Control drawer" })[0]!);
    expect(screen.getByTestId("app-control-panel").textContent).toBe("App Control panel mounted");

    const divider = screen.getByRole("separator", { name: "" });
    const splitParent = divider.parentElement;
    expect(splitParent).toBeInstanceOf(HTMLElement);
    Object.defineProperty(splitParent as HTMLElement, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        width: 1000,
        height: 600,
        top: 0,
        right: 1000,
        bottom: 600,
        left: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.mouseDown(divider, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 600 });
    fireEvent.mouseUp(document);

    await waitFor(() => {
      expect(window.sessionStorage.getItem("ade.chat.rightPaneSplit")).toBe("40");
    });
  });

  it("restores an archived chat from the archived selector", async () => {
    const active = buildSession("active-session", { title: "Active chat" });
    const archived = buildSession("archived-session", {
      title: "Archived chat",
      archivedAt: "2026-05-12T00:00:00.000Z",
    });
    const { unarchive } = renderDrawerSessionPane([active, archived]);

    const restoreSelect = await screen.findByTitle("Restore archived chat");
    fireEvent.change(restoreSelect, { target: { value: "archived-session" } });

    await waitFor(() => {
      expect(unarchive).toHaveBeenCalledWith({ sessionId: "archived-session" });
    });
  });

  it("clears a persistent identity chat view without deleting the session", async () => {
    const transcript = `${JSON.stringify({
      sessionId: "persistent-session",
      timestamp: "2026-05-12T00:00:00.000Z",
      event: {
        type: "text",
        text: "Persistent identity view text",
        itemId: "persistent-text",
        turnId: "turn-1",
      },
    })}\n`;

    renderDrawerSessionPane(
      [buildSession("persistent-session", { title: "Persistent identity" })],
      {
        transcript,
        presentation: { mode: "standard", profile: "persistent_identity" },
      },
    );

    expect(await screen.findByText("Persistent identity view text")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear view" }));

    await waitFor(() => {
      expect(screen.queryByText("Persistent identity view text")).toBeNull();
    });
    expect(globalThis.window.ade.agentChat.delete).not.toHaveBeenCalled();
  });
});

describe("AgentChatPane submit recovery", () => {
  it("uses the model override as the constrained draft picker list", async () => {
    installAdeMocks({ sessions: [] });
    seedRuntimeModelCatalog();

    renderParallelDraftPane({
      availableModelIdsOverride: ["anthropic/claude-sonnet-4-6"],
    });

    expect(await screen.findByText("Start a new conversation")).toBeTruthy();
    const includedModelLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
    const trigger = await screen.findByRole("button", { name: /^Select model/ });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    const includedModel = await screen.findByRole("option", { name: new RegExp(escapeRegExp(includedModelLabel), "i") });
    expect(includedModel.getAttribute("aria-disabled")).not.toBe("true");

    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    const excludedModelLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    expect(screen.queryByRole("option", { name: new RegExp(escapeRegExp(excludedModelLabel), "i") })).toBeNull();
  });

  it("blocks draft submit when the constrained model list no longer contains the selected model", async () => {
    const { create, send } = installAdeMocks({ sessions: [] });
    const launchConfigKey = [
      "ade.chat.lastLaunchConfig.v1",
      "/tmp/project-under-test",
      "lane-1",
      "standard",
      "chat",
    ].map(encodeURIComponent).join(":");
    window.localStorage.setItem(launchConfigKey, JSON.stringify({
      version: 1,
      modelId: "openai/gpt-5.4",
      updatedAt: "2026-05-20T12:00:00.000Z",
      controls: {
        interactionMode: "default",
        claudePermissionMode: "default",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        opencodePermissionMode: "edit",
        droidPermissionMode: "auto-low",
        cursorModeId: "agent",
        cursorConfigValues: {},
      },
    }));

    renderParallelDraftPane({
      availableModelIdsOverride: [],
    });

    const modelLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    expect(await screen.findByRole("button", { name: new RegExp(`current: ${escapeRegExp(modelLabel)}`, "i") })).toBeTruthy();
    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "This must not launch with a stale model." } });
    expect((await screen.findByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(await screen.findByText("No models are available for this chat surface.")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("blocks active session submit when a constrained list excludes the current model", async () => {
    const session = buildSession("stale-model-session", {
      title: "Stale model chat",
      model: "gpt-5.4",
      modelId: "openai/gpt-5.4",
    });
    const { send } = installAdeMocks({ sessions: [session] });
    seedDrawerStore();

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          initialSessionId={session.sessionId}
          initialSessionSummary={session}
          availableModelIdsOverride={["anthropic/claude-sonnet-4-6"]}
        />
      </MemoryRouter>,
    );

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "This should not send with a stale model." } });
    expect((await screen.findByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(await screen.findByText("Select an available model for this chat surface before sending.")).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it("hydrates a draft chat from the last launched config before first send", async () => {
    const { create } = installAdeMocks({ sessions: [] });
    const launchConfigKey = [
      "ade.chat.lastLaunchConfig.v1",
      "/tmp/project-under-test",
      "lane-1",
      "standard",
      "chat",
    ].map(encodeURIComponent).join(":");
    window.localStorage.setItem(launchConfigKey, JSON.stringify({
      version: 1,
      modelId: "openai/gpt-5.4",
      reasoningEffort: "xhigh",
      codexFastMode: true,
      executionMode: "focused",
      updatedAt: "2026-05-20T12:00:00.000Z",
      controls: {
        interactionMode: "default",
        claudePermissionMode: "default",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
        opencodePermissionMode: "edit",
        droidPermissionMode: "auto-low",
        cursorModeId: "agent",
        cursorConfigValues: {},
      },
    }));

    renderParallelDraftPane({
      availableModelIdsOverride: ["openai/gpt-5.4"],
    });

    const modelLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    expect(await screen.findByRole("button", { name: new RegExp(`current: ${escapeRegExp(modelLabel)}`, "i") })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Fast mode" })).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Reasoning effort").textContent).toContain("XH");
    expect(screen.getByRole("button", { name: "Codex approval preset" }).textContent).toContain("Full access");

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Launch with the restored config." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        modelId: "openai/gpt-5.4",
        reasoningEffort: "xhigh",
        codexFastMode: true,
        permissionMode: "full-auto",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      }));
    });
  });

  it("prefers the newest session config over a stored launch snapshot", async () => {
    const previous = buildSession("previous-session", {
      status: "idle",
      reasoningEffort: "high",
      codexFastMode: true,
      permissionMode: "full-auto",
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
      codexConfigSource: "flags",
    });
    const { create } = installAdeMocks({ sessions: [previous] });
    const launchConfigKey = [
      "ade.chat.lastLaunchConfig.v1",
      "/tmp/project-under-test",
      "lane-1",
      "standard",
      "chat",
    ].map(encodeURIComponent).join(":");
    window.localStorage.setItem(launchConfigKey, JSON.stringify({
      version: 1,
      modelId: "openai/gpt-5.4",
      reasoningEffort: "xhigh",
      codexFastMode: false,
      executionMode: "focused",
      updatedAt: "2026-05-20T12:00:00.000Z",
      controls: {
        interactionMode: "default",
        claudePermissionMode: "default",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        opencodePermissionMode: "edit",
        droidPermissionMode: "auto-low",
        cursorModeId: "agent",
        cursorConfigValues: {},
      },
    }));

    renderParallelDraftPane({
      availableModelIdsOverride: ["openai/gpt-5.4"],
    });

    const approvalButton = await screen.findByRole("button", { name: "Codex approval preset" });
    await waitFor(() => {
      expect(approvalButton.textContent).toContain("Full access");
      expect((screen.getByRole("button", { name: "Fast mode" })).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByLabelText("Reasoning effort").textContent).toContain("HI");
    });

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Use the newest session settings." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        modelId: "openai/gpt-5.4",
        reasoningEffort: "high",
        codexFastMode: true,
        permissionMode: "full-auto",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
      }));
    });
  });

  it("does not let a late lane-session hydration overwrite a model picked for the draft", async () => {
    const lanes = [
      {
        id: "lane-1",
        name: "current-lane",
        laneType: "worktree",
        branchRef: "refs/heads/current-lane",
        worktreePath: "/tmp/project-under-test/current-lane",
      },
      {
        id: "lane-2",
        name: "target-lane",
        laneType: "worktree",
        branchRef: "refs/heads/target-lane",
        worktreePath: "/tmp/project-under-test/target-lane",
      },
    ] as any[];
    useAppStore.setState({
      project: { rootPath: "/tmp/project-under-test" } as any,
      lanes,
      selectedLaneId: "lane-1",
    });
    const launchConfigKey = [
      "ade.chat.lastLaunchConfig.v1",
      "/tmp/project-under-test",
      "lane-1",
      "standard",
      "chat",
    ].map(encodeURIComponent).join(":");
    window.localStorage.setItem(launchConfigKey, JSON.stringify({
      version: 1,
      modelId: "openai/gpt-5.4",
      reasoningEffort: "xhigh",
      codexFastMode: false,
      executionMode: "focused",
      updatedAt: "2026-05-20T12:00:00.000Z",
      controls: {
        interactionMode: "default",
        claudePermissionMode: "default",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        opencodePermissionMode: "edit",
        droidPermissionMode: "auto-low",
        cursorModeId: "agent",
        cursorConfigValues: {},
      },
    }));
    const { create } = installAdeMocks({ sessions: [], includeClaudeModel: true });
    let resolveLaneTwoSessions!: (rows: AgentChatSessionSummary[]) => void;
    const laneTwoSessions = new Promise<AgentChatSessionSummary[]>((resolve) => {
      resolveLaneTwoSessions = resolve;
    });
    window.ade.agentChat.list = vi.fn().mockImplementation(async ({ laneId }: { laneId: string }) => (
      laneId === "lane-2" ? laneTwoSessions : []
    )) as any;

    function DraftLaneHarness() {
      const [laneId, setLaneId] = React.useState("lane-1");
      return (
        <MemoryRouter>
          <AgentChatPane
            laneId={laneId}
            forceDraftMode
            embeddedWorkLayout
            availableLanes={lanes}
            onLaneChange={setLaneId}
          />
        </MemoryRouter>
      );
    }

    render(<DraftLaneHarness />);

    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    expect(await screen.findByRole("button", { name: new RegExp(`current: ${escapeRegExp(codexLabel)}`, "i") })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /target-lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Launch on the selected lane and model." } });

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const claudeLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(claudeLabel), "i"));

    await act(async () => {
      resolveLaneTwoSessions([
        buildSession("lane-2-previous", {
          laneId: "lane-2",
          model: "gpt-5.4",
          modelId: "openai/gpt-5.4",
          reasoningEffort: "high",
        }),
      ]);
      await laneTwoSessions;
    });

    expect(await screen.findByRole("button", { name: new RegExp(`current: ${escapeRegExp(claudeLabel)}`, "i") })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-2",
        provider: "claude",
        modelId: "anthropic/claude-sonnet-4-6",
      }));
    });
  });

  it("loads Claude slash commands for a draft chat before session creation", async () => {
    installAdeMocks({ sessions: [], includeClaudeModel: true });
    vi.mocked(window.ade.agentChat.slashCommands).mockImplementation(async (args) => {
      if (args.provider === "claude") {
        return [{
          name: "/agents",
          description: "Manage agent configurations.",
          source: "sdk",
        }];
      }
      return [];
    });

    renderParallelDraftPane({
      availableModelIdsOverride: ["anthropic/claude-sonnet-4-6"],
    });

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(/Claude Sonnet 4\.6/i);

    await waitFor(() => {
      expect(window.ade.agentChat.slashCommands).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-1",
        provider: "claude",
        projectRoot: "/tmp/project-under-test",
      }));
    });

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "/", selectionStart: 1 } });

    expect(await screen.findByText("/agents")).toBeTruthy();
  });

  it("opens the chat terminal drawer when a CLI-created terminal belongs to the active chat", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { emitSessionChanged } = installAdeMocks({ sessions: [session] });
    const terminalSession: TerminalSessionDetail = {
      id: "terminal-1",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: "pty-1",
      tracked: true,
      pinned: false,
      manuallyNamed: false,
      goal: null,
      title: "CLI run",
      startedAt: "2026-03-24T05:57:45.700Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: "/tmp/terminal-1.log",
      headShaStart: null,
      headShaEnd: null,
      status: "running",
      lastOutputPreview: null,
      summary: null,
      toolType: "shell",
      runtimeState: "running",
      resumeCommand: null,
      resumeMetadata: null,
      archivedAt: null,
      chatSessionId: session.sessionId,
    };
    vi.mocked(window.ade.sessions.get).mockResolvedValue(terminalSession);

    renderPane(session);

    await screen.findByRole("textbox");
    act(() => {
      emitSessionChanged({ sessionId: terminalSession.id, reason: "created" });
    });

    expect(await screen.findByText("CLI run")).toBeTruthy();
    expect(screen.getByTestId("terminal-view").textContent).toBe("terminal-1:pty-1");
    expect(window.ade.pty.create).not.toHaveBeenCalled();
  });

  it("keeps the chat terminal drawer wired when Work hides lane tool drawers", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { emitSessionChanged } = installAdeMocks({ sessions: [session] });
    const terminalSession: TerminalSessionDetail = {
      id: "terminal-1",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: "pty-1",
      tracked: true,
      pinned: false,
      manuallyNamed: false,
      goal: null,
      title: "Work shell",
      startedAt: "2026-03-24T05:57:45.700Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: "/tmp/terminal-1.log",
      headShaStart: null,
      headShaEnd: null,
      status: "running",
      lastOutputPreview: null,
      summary: null,
      toolType: "shell",
      runtimeState: "running",
      resumeCommand: null,
      resumeMetadata: null,
      archivedAt: null,
      chatSessionId: session.sessionId,
    };
    vi.mocked(window.ade.sessions.get).mockResolvedValue(terminalSession);

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          lockSessionId={session.sessionId}
          hideSessionTabs
          hideLaneToolDrawers
          initialSessionSummary={session}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole("textbox");
    expect(await screen.findByRole("button", { name: /(Open|Close) terminal/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open iOS simulator drawer" })).toBeNull();

    act(() => {
      emitSessionChanged({ sessionId: terminalSession.id, reason: "created" });
    });

    expect(await screen.findByText("Work shell")).toBeTruthy();
    expect(screen.getByTestId("terminal-view").textContent).toBe("terminal-1:pty-1");
  });

  it("reveals rapid CLI-created terminals independently", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { emitSessionChanged } = installAdeMocks({ sessions: [session] });
    const terminalSession = (id: string, ptyId: string, title: string): TerminalSessionDetail => ({
      id,
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId,
      tracked: true,
      pinned: false,
      manuallyNamed: false,
      goal: null,
      title,
      startedAt: "2026-03-24T05:57:45.700Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: `/tmp/${id}.log`,
      headShaStart: null,
      headShaEnd: null,
      status: "running",
      lastOutputPreview: null,
      summary: null,
      toolType: "shell",
      runtimeState: "running",
      resumeCommand: null,
      resumeMetadata: null,
      archivedAt: null,
      chatSessionId: session.sessionId,
    });
    const sessionsById = new Map<string, TerminalSessionDetail>([
      ["terminal-1", terminalSession("terminal-1", "pty-1", "CLI run 1")],
      ["terminal-2", terminalSession("terminal-2", "pty-2", "CLI run 2")],
    ]);
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(123);
    vi.mocked(window.ade.sessions.get).mockImplementation(async (sessionId: string) => sessionsById.get(sessionId) ?? null);

    try {
      renderPane(session);

      await screen.findByRole("textbox");
      act(() => {
        emitSessionChanged({ sessionId: "terminal-1", reason: "created" });
      });

      expect(await screen.findByText("CLI run 1")).toBeTruthy();
      act(() => {
        emitSessionChanged({ sessionId: "terminal-2", reason: "created" });
      });

      expect(await screen.findByText("CLI run 2")).toBeTruthy();
      await waitFor(() => {
        expect(screen.getByTestId("terminal-view").textContent).toBe("terminal-2:pty-2");
      });
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("shows a green session indicator while the agent is working", async () => {
    const session = buildSession("session-1");
    installAdeMocks({
      transcript: buildStatusStartedTranscript(session.sessionId),
    });

    renderTabbedPane(session);

    expect(await screen.findByLabelText("Agent working")).toBeTruthy();
  });

  it("shows an amber session indicator while waiting for user input", async () => {
    const session = buildSession("session-1");
    installAdeMocks({
      transcript: buildPendingInputTranscript(session.sessionId),
    });

    renderTabbedPane(session);

    expect(await screen.findByLabelText("Waiting for your input")).toBeTruthy();
  });

  it("blocks the composer prompt while a pending input request is active", async () => {
    const session = buildSession("session-1");
    const { send, steer } = installAdeMocks({
      transcript: buildPendingInputTranscript(session.sessionId),
    });

    renderPane(session);

    expect(await screen.findByText("Answer in the inline question card, or decline.")).toBeTruthy();
    const textbox = screen.getByPlaceholderText("Answer the question card above, or decline it.") as HTMLTextAreaElement;

    expect(textbox.disabled).toBe(true);
    expect(textbox.placeholder).toBe("Answer the question card above, or decline it.");

    fireEvent.keyDown(textbox, { key: "Enter" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(window.ade.agentChat.respondToInput).not.toHaveBeenCalled();
  });

  it("lets a typed follow-up revise an orchestration plan-ready gate", async () => {
    const session = buildSession("session-1", {
      awaitingInput: true,
    });
    const { send, steer } = installAdeMocks({
      sessions: [session],
      transcript: buildOrchestrationPlanApprovalTranscript(session.sessionId),
    });

    renderPane(session);

    expect(await screen.findByRole("button", { name: "Implement" })).toBeTruthy();
    expect((await screen.findAllByText("Inspect")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Patch").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Verify").length).toBeGreaterThan(0);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textbox.disabled).toBe(false);

    fireEvent.change(textbox, { target: { value: "Add the rollback risks before implementation." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(window.ade.agentChat.respondToInput).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        itemId: "approval-1",
        decision: "decline",
        responseText: "Add the rollback risks before implementation.",
      });
    });
    expect(send).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it("falls back to the session summary when a chat is awaiting input", async () => {
    const session = buildSession("session-1", {
      status: "active",
      awaitingInput: true,
    });
    installAdeMocks({
      sessions: [session],
    });

    renderTabbedPane(session);

    expect(await screen.findByLabelText("Waiting for your input")).toBeTruthy();
    expect(screen.queryByLabelText("Agent working")).toBeNull();
  });

  it("blocks submit when the session summary is awaiting input before the pending card loads", async () => {
    const session = buildSession("session-1", {
      status: "active",
      awaitingInput: true,
    });
    const { send, steer } = installAdeMocks({
      sessions: [session],
    });

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "This should wait." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    expect(await screen.findByText("Answer or decline the pending request before sending another message.")).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it("disables chat sending while the project is switching", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { send, steer } = installAdeMocks({ sessions: [session] });
    useAppStore.setState({
      projectTransition: {
        kind: "switching",
        rootPath: "/tmp/next",
        startedAtMs: Date.now(),
      },
    } as any);

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    expect((textbox as HTMLTextAreaElement).placeholder).toBe("Project is switching...");
    fireEvent.change(textbox, { target: { value: "This should wait." } });
    const sendButton = await screen.findByRole("button", { name: "Send" });
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sendButton);

    expect(send).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it("does not keep showing a working indicator when the session summary is idle", async () => {
    const session = buildSession("session-1", {
      status: "idle",
    });
    installAdeMocks({
      sessions: [session],
      transcript: buildStatusStartedTranscript(session.sessionId),
    });

    renderTabbedPane(session);

    await waitFor(() => {
      expect(screen.queryByLabelText("Agent working")).toBeNull();
    });
    expect(screen.getByLabelText("Ready for next prompt")).toBeTruthy();
  });

  it("keeps the draft cleared after send succeeds even if session refresh fails", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { send } = installAdeMocks({
      listError: new Error("refresh failed"),
    });

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Ship the transcript cleanup." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Ship the transcript cleanup.",
        displayText: "Ship the transcript cleanup.",
      }));
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("does not automatically inject lane macOS VM capability context into sends", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { send } = installAdeMocks({ sessions: [session] });
    (window.ade as any).macosVm = {
      getStatus: vi.fn().mockResolvedValue({
        platform: "darwin",
        arch: "arm64",
        supported: true,
        checkedAt: "2026-05-07T00:00:00.000Z",
        activeProvider: {
          kind: "lume",
          available: true,
          version: "0.3.9",
          detail: "Lume is available.",
          docsUrl: "https://cua.ai/docs/lume/guide/fundamentals/vm-management",
        },
        tools: [],
        laneVm: {
          id: "macos-vm:lane-1",
          provider: "lume",
          name: "ade-lane-one",
          laneId: "lane-1",
          laneName: "Lane 1",
          laneRoot: "/repo/.ade/worktrees/lane-one",
          state: "running",
          cpuCores: 4,
          memory: "8GB",
          diskSize: "80GB",
          display: "1920x1200",
          guestSharedPath: "/Volumes/My Shared Files",
          sharedDirectory: "/repo/.ade/cache/macos-vms/shares/lane-1/worktree",
          createdAt: "2026-05-07T00:00:00.000Z",
          updatedAt: "2026-05-07T00:00:00.000Z",
          lastStartedAt: "2026-05-07T00:00:00.000Z",
          lastStoppedAt: null,
          ipAddress: "192.168.64.3",
          sshCommand: "ssh lume@192.168.64.3",
          vncUrl: "vnc://127.0.0.1:5900",
          lastError: null,
          metadata: { shareMode: "sanitized-mirror" },
        },
        vms: [],
        docs: {
          appleVirtualization: "https://developer.apple.com/documentation/virtualization",
          appleSharedDirectories: "https://developer.apple.com/documentation/virtualization/vzvirtiofilesystemdeviceconfiguration",
          lume: "https://cua.ai/docs/lume/guide/fundamentals/vm-management",
        },
      }),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
    };

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Use the ADE VM to check the app." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(window.ade.macosVm.getStatus).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        displayText: "Use the ADE VM to check the app.",
        text: "Use the ADE VM to check the app.",
      }));
    });
  });

  it("does not inject lane macOS VM context into unrelated sends", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { send } = installAdeMocks({ sessions: [session] });
    (window.ade as any).macosVm = {
      getStatus: vi.fn().mockResolvedValue({
        platform: "darwin",
        arch: "arm64",
        supported: true,
        checkedAt: "2026-05-07T00:00:00.000Z",
        activeProvider: {
          kind: "lume",
          available: true,
          version: "0.3.9",
          detail: "Lume is available.",
          docsUrl: "https://cua.ai/docs/lume/guide/fundamentals/vm-management",
        },
        tools: [],
        laneVm: null,
        vms: [],
        docs: {},
      }),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
    };

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Fix the PR header action." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(window.ade.macosVm.getStatus).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        displayText: "Fix the PR header action.",
        text: "Fix the PR header action.",
      }));
      expect((window.ade as any).app.writeClipboardText).toHaveBeenCalledWith("Fix the PR header action.");
    });
  });

  it("shows an optimistic queued bubble immediately for Cursor-style sends", async () => {
    const session = buildSession("session-1", { status: "idle" });
    let resolveSend!: () => void;
    const send = vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
      resolveSend = resolve;
    }));
    const list = vi.fn().mockResolvedValue([session]);
    installAdeMocks({
      sessions: [session],
    });
    window.ade.agentChat.send = send as any;
    window.ade.agentChat.list = list as any;

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Ship the optimistic bubble." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByText("Ship the optimistic bubble.")).toBeTruthy();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Ship the optimistic bubble.",
      }));
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");

    resolveSend();
  });

  it("keeps the optimistic sent bubble visible when send resolves before the chat event arrives", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { send } = installAdeMocks({
      sessions: [session],
    });

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Open the simulator screen in preview." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Open the simulator screen in preview.",
      }));
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    });

    await waitFor(() => {
      expect(screen.getByText("Open the simulator screen in preview.")).toBeTruthy();
    });
  });

  it("matches a recovered committed user message to the optimistic first bubble", () => {
    type UserMessageEvent = Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>;
    const optimistic: AgentChatEventEnvelope = {
      sessionId: "session-1",
      timestamp: "2026-03-24T05:57:45.700Z",
      event: {
        type: "user_message",
        text: "Pearl UI audit handoff",
        attachments: [{ path: "docs/audit.md", type: "file" }],
        deliveryState: "queued",
      },
    };
    const committedUserEvent: UserMessageEvent = {
      type: "user_message",
      text: "Full handoff prompt with all implementation details.",
      displayText: "Pearl UI audit handoff",
      attachments: [{ path: "docs/audit.md", type: "file" }],
    };
    const committed: AgentChatEventEnvelope = {
      sessionId: "session-1",
      timestamp: "2026-03-24T05:57:46.000Z",
      event: committedUserEvent,
    };

    expect(isMatchingOptimisticUserMessage(committed, optimistic)).toBe(true);
    expect(isMatchingOptimisticUserMessage({
      ...committed,
      event: { ...committedUserEvent, steerId: "steer-1", deliveryState: "delivered" },
    }, optimistic)).toBe(false);
    expect(isMatchingOptimisticUserMessage({
      ...committed,
      event: { ...committedUserEvent, attachments: [{ path: "docs/other.md", type: "file" }] },
    }, optimistic)).toBe(false);
  });

  it("renders a duplicated live Codex user_message envelope only once", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { emitChatEvent } = installAdeMocks({
      sessions: [session],
    });

    renderPane(session);

    await screen.findByRole("textbox");
    const envelope: AgentChatEventEnvelope = {
      sessionId: session.sessionId,
      timestamp: "2026-03-24T05:57:46.000Z",
      sequence: 1,
      event: {
        type: "user_message",
        text: "Render this Codex message once.",
      },
    };

    act(() => {
      emitChatEvent(envelope);
      emitChatEvent(envelope);
    });

    await waitFor(() => {
      expect(screen.getAllByText("Render this Codex message once.")).toHaveLength(1);
    });
  });

  it("renders committed user messages without waiting for the debounced event flush", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { emitChatEvent } = installAdeMocks({
      sessions: [session],
    });

    renderPane(session);

    await screen.findByRole("textbox");

    vi.useFakeTimers();
    try {
      act(() => {
        emitChatEvent({
          sessionId: session.sessionId,
          timestamp: "2026-03-24T05:57:46.000Z",
          sequence: 1,
          event: {
            type: "user_message",
            text: "Render this committed message immediately.",
          },
        });
      });

      expect(screen.getByText("Render this committed message immediately.")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the draft cleared after steer succeeds even if session refresh fails", async () => {
    const session = buildSession("session-1");
    const { steer } = installAdeMocks({
      transcript: buildStatusStartedTranscript(session.sessionId),
      listError: new Error("refresh failed"),
    });

    renderPane(session);

    const textbox = await screen.findByPlaceholderText("Steer the active turn...");
    fireEvent.change(textbox, { target: { value: "Stop checking docs and just drive the browser." } });
    fireEvent.click(screen.getByLabelText("Send steer message"));

    await waitFor(() => {
      expect(steer).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        text: "Stop checking docs and just drive the browser.",
      });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("falls back to a normal send when the active-turn marker is stale", async () => {
    const session = buildSession("session-1");
    const { send, steer } = installAdeMocks({
      transcript: buildStatusStartedTranscript(session.sessionId),
      steerError: new Error("No active turn to steer."),
    });

    renderPane(session);

    const textbox = await screen.findByPlaceholderText("Steer the active turn...");
    fireEvent.change(textbox, { target: { value: "Recover by starting a new turn." } });
    fireEvent.click(screen.getByLabelText("Send steer message"));

    await waitFor(() => {
      expect(steer).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        text: "Recover by starting a new turn.",
      });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Recover by starting a new turn.",
      }));
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("retries a send when the turn ends between send-active and steer", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { send, steer } = installAdeMocks({
      sessions: [session],
      steerError: new Error("No active turn to steer."),
    });
    send.mockRejectedValueOnce(new Error("turn is already active"));

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Please keep going." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
      expect(steer).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        text: "Please keep going.",
      });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("restores the draft when the send itself fails", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { send } = installAdeMocks({
      sendError: new Error("send failed"),
    });

    renderPane(session);

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Retry after the failure." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalled();
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Retry after the failure.");
    });
  });

  it("sends the selected Claude interaction mode with the next turn", async () => {
    const session = buildSession("session-1", {
      status: "idle",
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelId: "anthropic/claude-sonnet-4-6",
      permissionMode: "default",
      interactionMode: "default",
      claudePermissionMode: "default",
    });
    const sessions = [session];
    const updateSession = vi.fn().mockImplementation(async (args: any) => {
      sessions[0] = {
        ...sessions[0]!,
        interactionMode: args.interactionMode ?? sessions[0]!.interactionMode,
        claudePermissionMode: args.claudePermissionMode ?? sessions[0]!.claudePermissionMode,
        permissionMode: args.permissionMode ?? sessions[0]!.permissionMode,
      };
      return sessions[0];
    });
    const { send } = installAdeMocks({
      includeClaudeModel: true,
      sessions,
    });
    window.ade.agentChat.updateSession = updateSession as any;

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Claude permission mode" }));
    fireEvent.click(await screen.findByRole("option", { name: "Plan mode" }));

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        interactionMode: "plan",
      }));
    });

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Just plan the implementation." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Just plan the implementation.",
        interactionMode: "plan",
      }));
    });
  });

  it("waits for Codex permission updates before sending the next turn", async () => {
    const session = buildSession("session-1", {
      status: "idle",
      permissionMode: "default",
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    });
    const sessions = [session];
    let resolveUpdateSession: (() => void) | null = null;
    const updateSession = vi.fn().mockImplementation((args: any) => new Promise((resolve) => {
      resolveUpdateSession = () => {
        sessions[0] = {
          ...sessions[0]!,
          permissionMode: args.permissionMode ?? sessions[0]!.permissionMode,
          codexApprovalPolicy: args.codexApprovalPolicy ?? sessions[0]!.codexApprovalPolicy,
          codexSandbox: args.codexSandbox ?? sessions[0]!.codexSandbox,
          codexConfigSource: args.codexConfigSource ?? sessions[0]!.codexConfigSource,
        };
        resolve(sessions[0]);
      };
    }));
    const { send } = installAdeMocks({
      sessions,
    });
    window.ade.agentChat.updateSession = updateSession as any;

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Codex approval preset" }));
    fireEvent.click(await screen.findByRole("option", { name: "Full access" }));

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        permissionMode: "full-auto",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      }));
    });

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Make the change now." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).not.toHaveBeenCalled();

    const flushUpdateSession = resolveUpdateSession as (() => void) | null;
    expect(flushUpdateSession).toBeTypeOf("function");
    flushUpdateSession?.();

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Make the change now.",
      }));
    });
  });

  it("waits for Codex fast mode updates before sending the next turn", async () => {
    const session = buildSession("session-1", {
      status: "idle",
      codexFastMode: false,
    });
    const sessions = [session];
    const resolveUpdates: Array<() => void> = [];
    const updateSession = vi.fn().mockImplementation((args: any) => new Promise((resolve) => {
      resolveUpdates.push(() => {
        sessions[0] = {
          ...sessions[0]!,
          codexFastMode: args.codexFastMode ?? sessions[0]!.codexFastMode,
        };
        resolve(sessions[0]);
      });
    }));
    const { send } = installAdeMocks({
      sessions,
    });
    window.ade.agentChat.updateSession = updateSession as any;

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Fast mode" }));

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        codexFastMode: true,
      }));
    });

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Use the faster tier." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).not.toHaveBeenCalled();

    resolveUpdates[0]?.();
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Use the faster tier.",
      }));
    });
  });

  it("persists Codex reasoning effort changes on the selected session", async () => {
    const session = buildSession("session-1", {
      status: "idle",
      reasoningEffort: "medium",
    });
    const updateSession = vi.fn().mockImplementation(async (args: any) => ({
      ...session,
      reasoningEffort: args.reasoningEffort,
    }));
    installAdeMocks({
      sessions: [session],
    });
    window.ade.agentChat.updateSession = updateSession as any;

    renderPane(session);

    const reasoningTrigger = await screen.findByLabelText("Reasoning effort");
    fireEvent.pointerDown(reasoningTrigger, { button: 0 });
    fireEvent.click(reasoningTrigger);
    fireEvent.click(await screen.findByRole("radio", { name: /^High/i }));

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        reasoningEffort: "high",
      });
    });
  });

  it("resyncs Claude composer permissions from refreshed session state", async () => {
    const session = buildSession("session-1", {
      status: "idle",
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelId: "anthropic/claude-sonnet-4-6",
      permissionMode: "edit",
      interactionMode: "default",
      claudePermissionMode: "default",
    });
    const sessions = [session];
    const { emitChatEvent } = installAdeMocks({
      includeClaudeModel: true,
      sessions,
    });

    renderPane(session);

    const trigger = await screen.findByRole("button", { name: "Claude permission mode" });
    expect(trigger.textContent ?? "").not.toContain("plan");

    sessions[0] = {
      ...session,
      permissionMode: "plan",
      interactionMode: "plan",
      claudePermissionMode: "acceptEdits",
    };

    emitChatEvent({
      sessionId: session.sessionId,
      timestamp: "2026-03-24T07:10:00.000Z",
      event: {
        type: "system_notice",
        noticeKind: "info",
        message: "Session entered plan mode.",
        detail: {
          permissionModeTransition: "entered_plan_mode",
        },
      },
    });

    await waitFor(() => {
      expect(trigger.textContent ?? "").toContain("Plan");
    });
  });

  it("exits plan mode in the composer chip when an exit notice arrives even if the session refetch is stale", async () => {
    // Reproduces the production bug: the backend accepted the plan and emitted
    // the exit notice, but the debounced session refetch still reports plan
    // (e.g. raced by the compaction that immediately follows). The chip must
    // still leave plan, driven by the authoritative transition notice.
    const session = buildSession("session-1", {
      status: "idle",
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelId: "anthropic/claude-sonnet-4-6",
      permissionMode: "plan",
      interactionMode: "plan",
      // The Claude mode picker writes "plan" into claudePermissionMode too, so
      // exercise that state — the chip must leave plan via BOTH fields.
      claudePermissionMode: "plan",
    });
    const sessions = [session];
    const { emitChatEvent } = installAdeMocks({
      includeClaudeModel: true,
      sessions,
    });

    renderPane(session);

    const trigger = await screen.findByRole("button", { name: "Claude permission mode" });
    await waitFor(() => {
      expect(trigger.textContent ?? "").toContain("Plan");
    });

    // Intentionally leave sessions[0] in plan mode: the refetch triggered by the
    // notice returns stale data, so the effect that syncs the chip from the
    // session never sees a mode change. Only the direct notice handler can fix
    // the chip here.
    emitChatEvent({
      sessionId: session.sessionId,
      timestamp: "2026-03-24T07:20:00.000Z",
      event: {
        type: "system_notice",
        noticeKind: "info",
        message: "Session exited plan mode",
        detail: {
          permissionModeTransition: "exited_plan_mode",
        },
      },
    });

    await waitFor(() => {
      expect(trigger.textContent ?? "").not.toContain("Plan");
    });
  });

  it("moves the most recently selected work chat tab to the top", async () => {
    const newerSession = buildSession("session-newer", {
      title: "Newer chat",
      startedAt: "2026-03-24T06:00:00.000Z",
      lastActivityAt: "2026-03-24T06:05:00.000Z",
    });
    const olderSession = buildSession("session-older", {
      title: "Older chat",
      startedAt: "2026-03-24T05:00:00.000Z",
      lastActivityAt: "2026-03-24T05:05:00.000Z",
    });
    installAdeMocks({
      sessions: [olderSession, newerSession],
    });

    renderTabbedPane(newerSession);

    await waitFor(() => {
      expect(sessionTabTitles(["Newer chat", "Older chat"])).toEqual(["Newer chat", "Older chat"]);
    });

    fireEvent.click(screen.getByRole("button", { name: /Older chat/i }));

    await waitFor(() => {
      expect(sessionTabTitles(["Older chat", "Newer chat"])).toEqual(["Older chat", "Newer chat"]);
    });
  });

  it("does not auto-fetch Cursor inventory on chat boot", async () => {
    let resolveProjectConfig: (value: unknown) => void = () => {};
    const projectConfig = new Promise((resolve) => {
      resolveProjectConfig = resolve;
    });
    installAdeMocks({
      sessions: [],
    });
    useAppStore.setState({
      project: { rootPath: "/tmp/project-under-test" } as any,
      lanes: [{
        id: "lane-1",
        name: "Lane 1",
        laneType: "worktree",
        branchRef: "refs/heads/lane-1",
        worktreePath: "/tmp/project-under-test/lane-1",
      } as any],
      selectedLaneId: "lane-1",
    });
    window.ade.projectConfig.get = vi.fn().mockReturnValue(projectConfig) as any;
    window.ade.ai.getStatus = vi.fn().mockResolvedValue({
      mode: "subscription",
      availableProviders: {
        claude: {
          binary: { present: false, source: "missing", path: null },
          auth: { ready: false, mode: "none", detail: null },
        },
        codex: true,
        cursor: true,
        droid: false,
      },
      models: { claude: [], codex: [], cursor: [], droid: [] },
      features: [],
      detectedAuth: [
        { type: "cli-subscription", cli: "codex", authenticated: true },
        { type: "api-key", provider: "cursor" },
      ],
      availableModelIds: [],
    }) as any;
    window.ade.agentChat.models = vi.fn().mockResolvedValue([]) as any;

    render(
      <MemoryRouter>
        <AgentChatPane laneId="lane-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Loading sessions")).toBeTruthy();

    await act(async () => {
      resolveProjectConfig({
        effective: {
          ai: {
            chat: {
              sendOnEnter: true,
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Loading sessions")).toBeNull();
    });
    expect(await screen.findByText("Start a new conversation")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.ade.agentChat.models).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "cursor" }),
    );
  });

  it("uses Cursor model IDs from AI status without probing Cursor inventory", async () => {
    installAdeMocks({
      sessions: [],
    });
    useAppStore.setState({
      project: { rootPath: "/tmp/project-under-test" } as any,
      lanes: [{
        id: "lane-1",
        name: "Lane 1",
        laneType: "worktree",
        branchRef: "refs/heads/lane-1",
        worktreePath: "/tmp/project-under-test/lane-1",
      } as any],
      selectedLaneId: "lane-1",
    });
    window.ade.ai.getStatus = vi.fn().mockResolvedValue({
      mode: "subscription",
      availableProviders: {
        claude: {
          binary: { present: false, source: "missing", path: null },
          auth: { ready: false, mode: "none", detail: null },
        },
        codex: true,
        cursor: true,
        droid: false,
      },
      models: { claude: [], codex: [], cursor: [], droid: [] },
      features: [],
      detectedAuth: [
        { type: "cli-subscription", cli: "codex", authenticated: true },
        { type: "api-key", provider: "cursor" },
      ],
      availableModelIds: ["cursor/auto"],
    }) as any;
    window.ade.agentChat.models = vi.fn().mockResolvedValue([]) as any;

    render(
      <MemoryRouter>
        <AgentChatPane laneId="lane-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Start a new conversation")).toBeTruthy();
    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.ade.agentChat.models).not.toHaveBeenCalled();
  });

  it("does not poll Cursor Cloud agents for a CLI-only Cursor session", async () => {
    const session = buildSession("session-1", {
      provider: "cursor",
      model: "auto",
      modelId: "cursor/auto",
      status: "idle",
    });
    installAdeMocks({
      sessions: [session],
    });
    const cursorCloudListAgents = vi.fn().mockResolvedValue({ items: [] });
    window.ade.ai.getStatus = vi.fn().mockResolvedValue({
      mode: "subscription",
      availableProviders: {
        claude: {
          binary: { present: false, source: "missing", path: null },
          auth: { ready: false, mode: "none", detail: null },
        },
        codex: true,
        cursor: false,
        droid: false,
      },
      models: { claude: [], codex: [], cursor: [], droid: [] },
      features: [],
      detectedAuth: [
        { type: "cli-subscription", cli: "codex", authenticated: true },
      ],
      availableModelIds: ["cursor/auto"],
      providerConnections: {
        claude: null,
        codex: null,
        cursor: {
          provider: "cursor",
          authAvailable: false,
          runtimeDetected: true,
          runtimeAvailable: false,
          usageAvailable: false,
          path: "/usr/local/bin/cursor-agent",
          blocker: "Add a Cursor API key before using Cursor Cloud agents.",
          lastCheckedAt: "2026-05-26T00:00:00.000Z",
          sources: [{ kind: "cli", detected: true, authenticated: true, path: "/usr/local/bin/cursor-agent" }],
        },
        droid: null,
      },
    }) as any;
    window.ade.ai.cursorCloudListAgents = cursorCloudListAgents as any;

    renderPane(session);

    await waitFor(() => {
      expect(window.ade.ai.getStatus).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cursorCloudListAgents).not.toHaveBeenCalled();
  });

  it("keeps the committed model visible until the backend confirms the switch", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const sessions = [session];
    let resolveUpdateSession!: (value: AgentChatSessionSummary) => void;
    const updateSession = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveUpdateSession = resolve;
    }));
    const warmupModel = vi.fn().mockResolvedValue(undefined);
    installAdeMocks({
      sessions,
      includeClaudeModel: true,
    });
    window.ade.agentChat.updateSession = updateSession as any;
    window.ade.agentChat.warmupModel = warmupModel as any;

    renderPane(session);

    const trigger = await screen.findByRole("button", { name: /^Select model/ });
    const currentLabel = getModelById(session.modelId ?? "")?.displayName ?? session.modelId ?? "";
    const nextLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
    const nextLabelPattern = new RegExp(escapeRegExp(nextLabel), "i");
    expect(trigger.textContent ?? "").toContain(currentLabel);

    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(nextLabelPattern);

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        modelId: "anthropic/claude-sonnet-4-6",
      }));
    });
    expect(screen.getByRole("button", { name: /^Select model/ }).textContent ?? "").toContain(currentLabel);
    expect(warmupModel).not.toHaveBeenCalled();

    const updatedSession: AgentChatSessionSummary = {
      ...session,
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelId: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "medium",
      permissionMode: "default",
      interactionMode: "default",
      claudePermissionMode: "default",
    };
    sessions[0] = updatedSession;
    resolveUpdateSession(updatedSession);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Select model/ }).textContent ?? "").toContain(nextLabel);
    });
    await waitFor(() => {
      expect(warmupModel).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        modelId: "anthropic/claude-sonnet-4-6",
      });
    });
  });

  it("keeps the committed model visible when the backend rejects a switch", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const updateSession = vi.fn().mockRejectedValue(new Error("switch failed"));
    const warmupModel = vi.fn().mockResolvedValue(undefined);
    installAdeMocks({
      sessions: [session],
      includeClaudeModel: true,
    });
    window.ade.agentChat.updateSession = updateSession as any;
    window.ade.agentChat.warmupModel = warmupModel as any;

    renderPane(session);

    const trigger = await screen.findByRole("button", { name: /^Select model/ });
    const currentLabel = getModelById(session.modelId ?? "")?.displayName ?? session.modelId ?? "";
    const nextLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
    const nextLabelPattern = new RegExp(escapeRegExp(nextLabel), "i");
    expect(trigger.textContent ?? "").toContain(currentLabel);

    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(nextLabelPattern);

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        modelId: "anthropic/claude-sonnet-4-6",
      }));
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Select model/ }).textContent ?? "").toContain(currentLabel);
    });
    expect(warmupModel).not.toHaveBeenCalled();
  });

  it("bumps a work chat to the top when a turn starts mid-stream", async () => {
    const newerSession = buildSession("session-newer", {
      title: "Newer chat",
      startedAt: "2026-03-24T06:00:00.000Z",
      lastActivityAt: "2026-03-24T06:05:00.000Z",
    });
    const olderSession = buildSession("session-older", {
      title: "Older chat",
      startedAt: "2026-03-24T05:00:00.000Z",
      lastActivityAt: "2026-03-24T05:05:00.000Z",
    });
    const { emitChatEvent } = installAdeMocks({
      sessions: [olderSession, newerSession],
    });

    renderTabbedPane(newerSession);

    await waitFor(() => {
      expect(sessionTabTitles(["Newer chat", "Older chat"])).toEqual(["Newer chat", "Older chat"]);
    });

    emitChatEvent({
      sessionId: olderSession.sessionId,
      timestamp: "2026-03-24T07:00:00.000Z",
      event: {
        type: "status",
        turnStatus: "started",
        turnId: "turn-older-1",
      },
    });

    await waitFor(() => {
      expect(sessionTabTitles(["Older chat", "Newer chat"])).toEqual(["Older chat", "Newer chat"]);
    });
  });

  it("shows chat handoff only for standard locked work chats", async () => {
    const session = buildSession("session-1");
    installAdeMocks();
    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    expect(await screen.findByText("Start a sibling chat on another model")).toBeTruthy();

    cleanup();
    installAdeMocks();
    renderResolverPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    await waitFor(() => {
      expect(screen.getByText("Handoff is not available for this chat.")).toBeTruthy();
    });
  });

  it("filters Cursor CLI-only models from chat handoff picking", async () => {
    const { bothId } = seedCursorRuntimeModelCatalog();
    const session = buildSession("session-1", { status: "idle" });
    installAdeMocks({
      cursorModels: [{ id: bothId }],
    });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));

    const handoffTextEl = await screen.findByText("Start a sibling chat on another model");
    const handoffMenu = handoffTextEl.parentElement!.parentElement!;
    fireEvent.click(within(handoffMenu as HTMLElement).getByRole("button", { name: /^Select model/ }));
    fireEvent.click(await screen.findByRole("tab", { name: /^Cursor$/i }));

    await waitFor(() => {
      expect(screen.getByText("Cursor Chat Only")).toBeTruthy();
    });
    expect(screen.getAllByText("Cursor Both").length).toBeGreaterThan(0);
    expect(screen.queryByText("Cursor CLI Only")).toBeNull();
  });

  it("hides chat handoff when the pane cannot open the created work chat", async () => {
    const session = buildSession("session-1");
    installAdeMocks();

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
        />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    expect(await screen.findByText("Handoff is not available for this chat.")).toBeTruthy();
  });

  it("disables chat handoff while the current turn is still active", async () => {
    const session = buildSession("session-1");
    installAdeMocks({
      transcript: buildStatusStartedTranscript(session.sessionId),
    });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    const createBtn = await screen.findByRole("button", { name: "Create handoff chat" });
    await waitFor(() => {
      expect((createBtn as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("creates a sibling handoff chat and opens the returned work tab", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const onSessionCreated = vi.fn().mockResolvedValue(undefined);
    const { handoff } = installAdeMocks({
      handoffResult: {
        session: buildCreatedSession("session-2"),
        usedFallbackSummary: false,
      },
    });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
          onSessionCreated={onSessionCreated}
        />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    expect(await screen.findByText("Create opens the new work chat and sends the handoff summary as its first message.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Create handoff chat" }));

    await waitFor(() => {
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        sourceSessionId: session.sessionId,
        targetModelId: "openai/gpt-5.4-mini",
        mode: "brief",
        reasoningEffort: "xhigh",
        permissionMode: "default",
        claudePermissionMode: "default",
        opencodePermissionMode: "edit",
        droidPermissionMode: "auto-low",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        cursorModeId: "agent",
        cursorConfigValues: {},
      }));
      expect(onSessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "session-2" }));
    });
  });

  it("sends the selected handoff model and permission mode", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { handoff } = installAdeMocks({
      includeClaudeModel: true,
      handoffResult: {
        session: buildCreatedSession("session-2", {
          provider: "claude",
          model: "sonnet",
          modelId: "anthropic/claude-sonnet-4-6",
          interactionMode: "plan",
          permissionMode: "plan",
        }),
        usedFallbackSummary: false,
      },
    });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));

    const handoffTextEl = await screen.findByText("Start a sibling chat on another model");
    const handoffMenu = handoffTextEl.parentElement!.parentElement!;
    expect(handoffMenu).toBeTruthy();
    fireEvent.click(within(handoffMenu as HTMLElement).getByRole("button", { name: /^Select model/ }));
    const claudeLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(claudeLabel), "i"));
    expect(screen.getByText("Fork keeps the complete Claude transcript through the SDK. Brief sends a summary as the first message.")).toBeTruthy();

    const permissionSelect = await screen.findByLabelText("Claude permission mode for handoff") as HTMLSelectElement;
    expect(within(permissionSelect).getByRole("option", { name: "Auto" })).toBeTruthy();
    fireEvent.change(permissionSelect, { target: { value: "plan" } });
    fireEvent.click(await screen.findByRole("button", { name: "Brief handoff" }));

    await waitFor(() => {
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        sourceSessionId: session.sessionId,
        targetModelId: "anthropic/claude-sonnet-4-6",
        mode: "brief",
        claudePermissionMode: "plan",
        permissionMode: "plan",
      }));
    });
  });

  it("can fork a Claude handoff with full SDK history", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { handoff } = installAdeMocks({
      includeClaudeModel: true,
      handoffResult: {
        session: buildCreatedSession("session-2", {
          provider: "claude",
          model: "sonnet",
          modelId: "anthropic/claude-sonnet-4-6",
        }),
        usedFallbackSummary: false,
      },
    });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));

    const handoffTextEl2 = await screen.findByText("Start a sibling chat on another model");
    const handoffMenu = handoffTextEl2.parentElement!.parentElement!;
    expect(handoffMenu).toBeTruthy();
    fireEvent.click(within(handoffMenu as HTMLElement).getByRole("button", { name: /^Select model/ }));
    const claudeLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(claudeLabel), "i"));
    fireEvent.click(await screen.findByRole("button", { name: "Fork full history" }));

    await waitFor(() => {
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        sourceSessionId: session.sessionId,
        targetModelId: "anthropic/claude-sonnet-4-6",
        mode: "fork",
      }));
    });
  });

  it("does not wait for onSessionCreated before sending the first message in a new chat", async () => {
    const onSessionCreated = vi.fn().mockImplementation(() => new Promise<void>(() => {}));
    const { send, create, writeClipboardText } = installAdeMocks({ sessions: [] });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceNewSession
          onSessionCreated={onSessionCreated}
        />
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";

    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Ship the instant route fix." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(create).toHaveBeenCalled();
      expect(onSessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "created-session" }));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "created-session",
        text: "Ship the instant route fix.",
        displayText: "Ship the instant route fix.",
      }));
      expect(writeClipboardText).toHaveBeenCalledWith("Ship the instant route fix.");
    });
  });

  it("copies a new chat prompt before session creation failures can lose it", async () => {
    const { writeClipboardText } = installAdeMocks({
      sessions: [],
      createError: new Error("create exploded"),
    });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceNewSession
        />
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Recover this prompt if launch fails." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith("Recover this prompt if launch fails.");
      expect(screen.getByText("create exploded")).toBeTruthy();
    });
  });

  it("copies submitted prompts when the launch clipboard reminder is disabled", async () => {
    useAppStore.setState({ launchPromptClipboardNoticeEnabled: false });
    const { send, writeClipboardText } = installAdeMocks({ sessions: [] });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceNewSession
        />
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Copy quietly." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "Copy quietly." }));
      expect(writeClipboardText).toHaveBeenCalledWith("Copy quietly.");
    });
  });

  it("does not copy submitted prompts when the launch clipboard setting is disabled", async () => {
    useAppStore.setState({ launchPromptClipboardEnabled: false });
    const { send, writeClipboardText } = installAdeMocks({ sessions: [] });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceNewSession
        />
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Do not copy this prompt." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        text: "Do not copy this prompt.",
      }));
    });
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("logs synchronous session-created callback failures without blocking the first send", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSessionCreated = vi.fn(() => {
      throw new Error("callback exploded");
    });
    const { send } = installAdeMocks({ sessions: [] });

    try {
      render(
        <MemoryRouter>
          <AgentChatPane
            laneId="lane-1"
            forceNewSession
            onSessionCreated={onSessionCreated}
          />
        </MemoryRouter>,
      );

      const trigger = await screen.findByRole("button", { name: /^Select model/ });
      const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";

      fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
      await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

      const textbox = await screen.findByRole("textbox");
      fireEvent.change(textbox, { target: { value: "Keep sending despite callback failure." } });
      fireEvent.click(await screen.findByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(onSessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "created-session" }));
        expect(send).toHaveBeenCalledWith(expect.objectContaining({
          sessionId: "created-session",
          text: "Keep sending despite callback failure.",
        }));
      });
      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith("notifySessionCreated failed:", expect.any(Error));
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("foreground auto-create opens the new chat in Work instead of routing to Lanes", async () => {
    const onSessionCreated = vi.fn();
    const { send, create, createLane, suggestLaneName, writeClipboardText } = installAdeMocks({ sessions: [] });
    suggestLaneName.mockResolvedValue("fix-auto-create-flow");
    createLane.mockResolvedValue({
      id: "lane-created",
      name: "fix-auto-create-flow",
      laneType: "worktree",
      branchRef: "refs/heads/fix-auto-create-flow",
      worktreePath: "/tmp/project-under-test/fix-auto-create-flow",
      parentLaneId: "lane-primary",
    });

    renderAutoCreateDraftPane({ onSessionCreated });

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Fix auto create lane routing." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-primary",
        prompt: "Fix auto create lane routing.",
        modelId: "openai/gpt-5.4",
        fallbackName: expect.stringMatching(/^chat-\d{8}-\d{6}$/),
      }));
      expect(createLane).toHaveBeenCalledWith({
        name: "fix-auto-create-flow",
        parentLaneId: "lane-primary",
      });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ laneId: "lane-created" }));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "created-session",
        text: "Fix auto create lane routing.",
      }));
      expect(writeClipboardText).toHaveBeenCalledWith("Fix auto create lane routing.");
      expect(onSessionCreated).toHaveBeenCalledWith(
        expect.objectContaining({ id: "created-session", laneId: "lane-created" }),
        { activate: false, source: "draft-launch" },
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/work?laneId=lane-created&sessionId=created-session");
    });
  });

  it("can keep foreground draft launches inside an embedded Lanes work pane", async () => {
    const { send, create } = installAdeMocks({ sessions: [] });
    const launchConfigKey = [
      "ade.chat.lastLaunchConfig.v1",
      "/tmp/project-under-test",
      "lane-1",
      "standard",
      "chat",
    ].map(encodeURIComponent).join(":");
    window.localStorage.setItem(launchConfigKey, JSON.stringify({
      version: 1,
      modelId: "openai/gpt-5.4",
      updatedAt: "2026-05-28T12:00:00.000Z",
      controls: {
        interactionMode: "default",
        claudePermissionMode: "default",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        opencodePermissionMode: "edit",
        droidPermissionMode: "auto-low",
        cursorModeId: "agent",
        cursorConfigValues: {},
      },
    }));

    renderParallelDraftPane({
      initialEntry: "/lanes?laneId=lane-1",
      suppressDraftLaunchNavigation: true,
      availableModelIdsOverride: ["openai/gpt-5.4"],
    });

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Stay in the lane work pane." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-1",
        modelId: "openai/gpt-5.4",
      }));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "created-session",
        text: "Stay in the lane work pane.",
      }));
    });
    expect(screen.getByTestId("location").textContent).toBe("/lanes?laneId=lane-1");
  });

  it("routes Work sidebar draft insertions into the visible draft composer", async () => {
    installAdeMocks({ sessions: [] });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceDraftMode
          embeddedWorkLayout
          draftContextTargetId="work:draft:lane-1:chat"
        />
      </MemoryRouter>,
    );

    const textbox = await screen.findByRole("textbox") as HTMLTextAreaElement;
    window.dispatchEvent(new CustomEvent("ade:agent-chat:insert-draft", {
      detail: {
        draftTargetId: "work:draft:lane-other:chat",
        text: "wrong draft",
      },
    }));
    expect(textbox.value).toBe("");

    window.dispatchEvent(new CustomEvent("ade:agent-chat:insert-draft", {
      detail: {
        draftTargetId: "work:draft:lane-1:chat",
        text: "Use the selected browser context.",
      },
    }));

    await waitFor(() => {
      expect(textbox.value).toBe("Use the selected browser context.");
    });
  });

  it("keeps Auto-create selected while reporting Primary as the Work tools lane", async () => {
    installAdeMocks({ sessions: [] });
    const onLaneChange = vi.fn();
    renderAutoCreateDraftPane({ onLaneChange });

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    expect(onLaneChange).toHaveBeenCalledWith("lane-primary");
    expect(await screen.findByText("Auto-create lane")).toBeTruthy();
    expect(await screen.findByText("Tools use Primary until the lane is created.")).toBeTruthy();
  });

  it("falls back to the first available Work tools lane when Auto-create has no Primary lane", async () => {
    installAdeMocks({ sessions: [] });
    const onLaneChange = vi.fn();
    renderAutoCreateDraftPane({
      onLaneChange,
      lanes: [
        {
          id: "lane-worktree",
          name: "current-lane",
          laneType: "worktree",
          branchRef: "refs/heads/current-lane",
          worktreePath: "/tmp/project-under-test/current-lane",
        },
      ],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    expect(onLaneChange).toHaveBeenCalledWith("lane-worktree");
    expect(await screen.findByText("Tools use current-lane until the lane is created.")).toBeTruthy();
  });

  it("keeps orchestrator lead mode on the first Claude draft send", async () => {
    const { send, create } = installAdeMocks({ sessions: [], includeClaudeModel: true });

    renderAutoCreateDraftPane({ workDraftKind: "chat-orchestrator" });

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const claudeLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(claudeLabel), "i"));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Coordinate the release checklist." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        interactionMode: "orchestrator-lead",
        provider: "claude",
      }));
      expect(window.ade.orchestration.runCreate).toHaveBeenCalledWith({
        laneId: "lane-1",
        leadSessionId: "created-session",
      });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "created-session",
        interactionMode: "orchestrator-lead",
      }));
    });
  });

  it("does not send an orchestrator draft prompt when bundle allocation fails", async () => {
    const { send, create, deleteChat } = installAdeMocks({ sessions: [], includeClaudeModel: true });
    vi.mocked(window.ade.orchestration.runCreate).mockRejectedValueOnce(new Error("disk full"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      renderAutoCreateDraftPane({ workDraftKind: "chat-orchestrator" });

      const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
      const claudeLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
      fireEvent.pointerDown(modelTrigger, { button: 0 });
      fireEvent.click(modelTrigger);
      fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
      await clickEnabledModelOption(new RegExp(escapeRegExp(claudeLabel), "i"));

      const textbox = await screen.findByRole("textbox");
      fireEvent.change(textbox, { target: { value: "Coordinate the release checklist." } });
      fireEvent.click(await screen.findByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
          interactionMode: "orchestrator-lead",
          provider: "claude",
        }));
        expect(window.ade.orchestration.runCreate).toHaveBeenCalledWith({
          laneId: "lane-1",
          leadSessionId: "created-session",
        });
      });
      expect(send).not.toHaveBeenCalled();
      expect(deleteChat).toHaveBeenCalledWith({ sessionId: "created-session" });
      expect(await screen.findByText("Orchestration bundle could not be allocated: disk full")).toBeTruthy();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("background auto-create reports the new chat without stealing focus and shows a dismissible notice", async () => {
    const onSessionCreated = vi.fn();
    const { createLane, suggestLaneName } = installAdeMocks({ sessions: [] });
    suggestLaneName.mockResolvedValue("background-lane");
    createLane.mockResolvedValue({
      id: "lane-created",
      name: "background-lane",
      laneType: "worktree",
      branchRef: "refs/heads/background-lane",
      worktreePath: "/tmp/project-under-test/background-lane",
      parentLaneId: "lane-primary",
    });

    renderAutoCreateDraftPane({ onSessionCreated });

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Launch this in the background." } });
    fireEvent.click(await screen.findByRole("button", { name: "Auto-create in background" }));

    await waitFor(() => {
      expect(onSessionCreated).toHaveBeenCalledWith(
        expect.objectContaining({ id: "created-session", laneId: "lane-created" }),
        { activate: false, source: "draft-launch" },
      );
      expect(screen.getByText(/Launch this in the background\./i)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Dismiss launch status" })).toBeTruthy();
    });
    expect(screen.getByTestId("location").textContent).toBe("/work");

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/work?laneId=lane-created&sessionId=created-session");
    });
  });

  it("rolls back the created session and auto-created lane when the first draft send fails", async () => {
    const onSessionCreated = vi.fn();
    const { send, createLane, suggestLaneName, deleteChat, deleteLane } = installAdeMocks({
      sessions: [],
      sendError: new Error("send failed"),
    });
    suggestLaneName.mockResolvedValue("failing-draft-lane");
    createLane.mockResolvedValue({
      id: "lane-created",
      name: "failing-draft-lane",
      laneType: "worktree",
      branchRef: "refs/heads/failing-draft-lane",
      worktreePath: "/tmp/project-under-test/failing-draft-lane",
      parentLaneId: "lane-primary",
    });

    renderAutoCreateDraftPane({ onSessionCreated });

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "This first send will fail." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "created-session",
        text: "This first send will fail.",
      }));
      expect(deleteChat).toHaveBeenCalledWith({ sessionId: "created-session" });
      expect(deleteLane).toHaveBeenCalledWith({ laneId: "lane-created", force: true });
      expect(onSessionCreated).not.toHaveBeenCalled();
    });
  });

  it("merges a failed launch restore into a new draft instead of discarding the restore snapshot", async () => {
    const { createLane, suggestLaneName } = installAdeMocks({
      sessions: [],
      sendError: new Error("send failed"),
    });
    suggestLaneName.mockResolvedValue("failing-draft-lane");
    createLane.mockResolvedValue({
      id: "lane-created",
      name: "failing-draft-lane",
      laneType: "worktree",
      branchRef: "refs/heads/failing-draft-lane",
      worktreePath: "/tmp/project-under-test/failing-draft-lane",
      parentLaneId: "lane-primary",
    });

    renderAutoCreateDraftPane();

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Failed launch draft." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByText(/Launch failed: send failed/i)).toBeTruthy();
    });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New draft stays." } });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("New draft stays.\n\nFailed launch draft.");
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("deletes an auto-created draft lane when session creation fails", async () => {
    const onSessionCreated = vi.fn();
    const { send, createLane, suggestLaneName, deleteChat, deleteLane } = installAdeMocks({
      sessions: [],
      createError: new Error("create failed"),
    });
    suggestLaneName.mockResolvedValue("session-create-fails");
    createLane.mockResolvedValue({
      id: "lane-created",
      name: "session-create-fails",
      laneType: "worktree",
      branchRef: "refs/heads/session-create-fails",
      worktreePath: "/tmp/project-under-test/session-create-fails",
      parentLaneId: "lane-primary",
    });

    renderAutoCreateDraftPane({ onSessionCreated });

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "This session create will fail." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(deleteLane).toHaveBeenCalledWith({ laneId: "lane-created", force: true });
      expect(deleteChat).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(onSessionCreated).not.toHaveBeenCalled();
    });
  });

  it("restores the Work draft bucket after remount with text, model, and attachment refs", async () => {
    installAdeMocks({ sessions: [] });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    window.localStorage.setItem(composerDraftStorageKeyForTest({
      projectRoot: "/tmp/project-under-test",
      companionStateKey: "draft:lane-1",
    }), JSON.stringify({
      version: 1,
      text: "Persist this Work draft.",
      modelId: "openai/gpt-5.4",
      reasoningEffort: null,
      codexFastMode: false,
      executionMode: "focused",
      controls: {},
      attachments: [{ path: "/tmp/project-under-test/spec.md", type: "file" }],
      contextAttachments: [],
      iosContextItems: [],
      appControlContextItems: [],
      builtInBrowserContextItems: [],
      macosVmContextItems: [],
      draftLaunchTargetId: null,
      updatedAt: "2026-05-27T00:00:00.000Z",
    }));

    const firstRender = renderAutoCreateDraftPane();

    expect(await screen.findByDisplayValue("Persist this Work draft.")).toBeTruthy();
    expect(screen.getByText("spec.md")).toBeTruthy();
    expect(await screen.findByRole("button", { name: new RegExp(`Select model \\(current: ${escapeRegExp(codexLabel)}\\)`, "i") })).toBeTruthy();

    firstRender.unmount();
    renderAutoCreateDraftPane();

    expect(await screen.findByDisplayValue("Persist this Work draft.")).toBeTruthy();
    expect(screen.getByText("spec.md")).toBeTruthy();
  });

  it("debounces persisted draft writes without storing screenshot data URLs", async () => {
    installAdeMocks({ sessions: [] });
    const storageKey = composerDraftStorageKeyForTest({
      projectRoot: "/tmp/project-under-test",
      companionStateKey: "draft:lane-1",
    });
    window.localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      text: "Persisted with visual context.",
      modelId: "openai/gpt-5.4",
      reasoningEffort: null,
      codexFastMode: false,
      executionMode: "focused",
      controls: {},
      attachments: [],
      contextAttachments: [],
      iosContextItems: [{
        kind: "ios_element",
        id: "ios-context-1",
        componentId: "ContinueButton",
        sourceFile: null,
        sourceLine: null,
        frame: { x: 1, y: 2, width: 3, height: 4 },
        metadata: {},
        accessibilityIdentifier: null,
        screenshotDataUrl: "data:image/png;base64,ios",
        selectedAt: "2026-05-27T00:00:00.000Z",
      }],
      appControlContextItems: [{
        kind: "app_control_element",
        id: "app-context-1",
        provider: "coordinate-fallback",
        componentId: "SendButton",
        sourceFile: null,
        sourceLine: null,
        frame: { x: 1, y: 2, width: 3, height: 4 },
        metadata: {},
        screenshotDataUrl: "data:image/png;base64,app",
        selectedAt: "2026-05-27T00:00:00.000Z",
      }],
      builtInBrowserContextItems: [{
        kind: "built_in_browser_element",
        id: "browser-context-1",
        provider: "cdp",
        componentId: "button.primary",
        url: "https://example.com",
        title: "Example",
        sourceFile: null,
        sourceLine: null,
        frame: { x: 1, y: 2, width: 3, height: 4 },
        pixelFrame: { x: 1, y: 2, width: 3, height: 4 },
        metadata: {},
        screenshotDataUrl: "data:image/png;base64,browser",
        selectedAt: "2026-05-27T00:00:00.000Z",
      }],
      macosVmContextItems: [{
        kind: "macos_vm_target",
        id: "vm-context-1",
        laneId: "lane-1",
        laneName: "Lane 1",
        vmName: "ADE VM",
        provider: "lume",
        state: "running",
        hostLanePath: "/tmp/project-under-test",
        guestLanePath: "/workspace",
        runCommand: "npm test",
        sshCommand: null,
        vncUrl: null,
        windowTitleQuery: "ADE",
        screenshotDataUrl: "data:image/png;base64,vm",
        selectedAt: "2026-05-27T00:00:00.000Z",
        metadata: {},
      }],
      draftLaunchTargetId: null,
      updatedAt: "2026-05-27T00:00:00.000Z",
    }));

    renderAutoCreateDraftPane();

    const textbox = await screen.findByRole("textbox");
    await waitFor(() => {
      expect(textbox.textContent).toContain("Persisted with visual context.");
    });
    textbox.textContent = "Persisted with visual context and edits.";
    fireEvent.input(textbox);

    await waitFor(() => {
      const raw = window.localStorage.getItem(storageKey);
      expect(raw).toBeTruthy();
      expect(raw).not.toContain("data:image/png;base64");
      const stored = JSON.parse(raw!);
      expect(stored.text.trim()).toBe("Persisted with visual context and edits.");
      expect(stored.iosContextItems[0]).not.toHaveProperty("screenshotDataUrl");
      expect(stored.appControlContextItems[0]).not.toHaveProperty("screenshotDataUrl");
      expect(stored.builtInBrowserContextItems[0].screenshotDataUrl).toBeNull();
      expect(stored.macosVmContextItems[0]).not.toHaveProperty("screenshotDataUrl");
    });
  });

  it("ignores malformed persisted draft attachment/context entries instead of crashing", async () => {
    installAdeMocks({ sessions: [] });
    window.localStorage.setItem(composerDraftStorageKeyForTest({
      projectRoot: "/tmp/project-under-test",
      companionStateKey: "draft:lane-1",
    }), JSON.stringify({
      version: 1,
      text: "Persisted with bad refs.",
      modelId: "openai/gpt-5.4",
      controls: {},
      attachments: [
        { type: "file" },
        { path: 42, type: "image" },
        { path: "/tmp/project-under-test/valid.md" },
      ],
      contextAttachments: [
        { type: "linear_issue", issue: { id: null } },
        { type: "orchestration_annotation", item: { runId: "run-1", anchor: {}, capturedAt: "now" } },
      ],
      iosContextItems: [{ kind: "ios_element", id: "bad" }],
      appControlContextItems: [{ kind: "app_control_element", componentId: "missing-id" }],
      builtInBrowserContextItems: [{ kind: "built_in_browser_element" }],
      macosVmContextItems: [{ kind: "macos_vm_target", id: "vm-1" }],
    }));

    renderAutoCreateDraftPane();

    expect(await screen.findByDisplayValue("Persisted with bad refs.")).toBeTruthy();
    expect(screen.getByText("valid.md")).toBeTruthy();
    expect(screen.queryByText("undefined")).toBeNull();
  });

  it("clears the submitted draft and keeps the composer usable while auto-create launch is pending", async () => {
    const { suggestLaneName } = installAdeMocks({ sessions: [] });
    let resolveSuggestedName!: (value: string) => void;
    suggestLaneName.mockImplementation(() => new Promise<string>((resolve) => {
      resolveSuggestedName = resolve;
    }));

    renderAutoCreateDraftPane();

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Launch this and let me keep typing." } });
    fireEvent.click(await screen.findByRole("button", { name: "Auto-create in background" }));

    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalled();
      expect(screen.getByText(/Choosing a branch name/i)).toBeTruthy();
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Auto-create in background" }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect((textbox as HTMLTextAreaElement).disabled).toBe(false);
    expect((textbox as HTMLTextAreaElement).value).toBe("");

    fireEvent.change(textbox, { target: { value: "Next thought while it launches." } });
    expect((textbox as HTMLTextAreaElement).value).toBe("Next thought while it launches.");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Auto-create in background" }) as HTMLButtonElement).disabled).toBe(false);

    resolveSuggestedName("still-editable-lane");
    await waitFor(() => {
      expect(screen.getByText(/Launch this and let me keep typing\./i)).toBeTruthy();
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Next thought while it launches.");
    });
  });

  it("keeps a pending auto-create launch visible after the new chat pane remounts", async () => {
    const { createLane, suggestLaneName } = installAdeMocks({ sessions: [] });
    let resolveSuggestedName!: (value: string) => void;
    let resolveCreateLane!: () => void;
    suggestLaneName.mockImplementation(() => new Promise<string>((resolve) => {
      resolveSuggestedName = resolve;
    }));
    createLane.mockImplementation(({ name }: { name: string; parentLaneId: string }) => new Promise((resolve) => {
      resolveCreateLane = () => resolve({
        id: `lane-${name}`,
        name,
        laneType: "worktree",
        branchRef: `refs/heads/${name}`,
        worktreePath: `/tmp/project-under-test/${name}`,
        parentLaneId: "lane-primary",
      });
    }));

    const rendered = renderAutoCreateDraftPane();

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Keep this launch visible." } });
    fireEvent.click(await screen.findByRole("button", { name: "Auto-create in background" }));

    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Choosing a branch name/i)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Dismiss launch status" })).toBeNull();

    rendered.unmount();
    renderAutoCreateDraftPane();

    expect(await screen.findByText(/Choosing a branch name/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss launch status" })).toBeNull();

    await act(async () => {
      resolveSuggestedName("remounted-lane");
    });
    await waitFor(() => {
      expect(screen.getByText(/^Creating lane for chat\.\.\.$/i)).toBeTruthy();
    });

    await act(async () => {
      resolveCreateLane();
    });

    await waitFor(() => {
      expect(screen.getByText(/Keep this launch visible\./i)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Dismiss launch status" })).toBeTruthy();
    });
  });

  it("allows stale active draft launch rows to be hidden", async () => {
    installAdeMocks({ sessions: [] });
    const scopeKey = draftLaunchJobsScopeKeyForTest({
      projectRoot: "/tmp/project-under-test",
      laneId: "lane-1",
    });
    useAppStore.setState({
      draftLaunchJobsByScope: {
        [scopeKey]: [{
          id: "stale-draft-launch",
          mode: "background",
          draftKind: "chat",
          status: "naming-lane",
          title: "Stale background launch",
          laneId: null,
          laneName: null,
          sessionId: null,
          error: null,
          autoOpen: false,
          createdAtMs: Date.now() - DRAFT_LAUNCH_JOB_STALE_AFTER_MS - 1,
          snapshot: {
            text: "Recover from a stuck launch.",
            draft: "Recover from a stuck launch.",
            modelId: "openai/gpt-5.4",
            reasoningEffort: null,
            codexFastMode: false,
            executionMode: "focused",
            interactionMode: "native",
            nativeControls: {},
            attachments: [],
            contextAttachments: [],
            iosContextItems: [],
            appControlContextItems: [],
            builtInBrowserContextItems: [],
            macosVmContextItems: [],
            visualContextPrefix: "",
            visualContextDisplayChips: "",
            isLiteralSlashCommand: false,
          },
        } as any],
      },
    });

    renderAutoCreateDraftPane();

    expect(await screen.findByText(/Still working\. You can hide this status/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss launch status" }));

    await waitFor(() => {
      expect(screen.queryByTestId("draft-launch-job")).toBeNull();
    });
  });

  it("ignores late failures from hidden stale draft launch rows", async () => {
    const { suggestLaneName } = installAdeMocks({ sessions: [] });
    let rejectSuggestedName!: (error: Error) => void;
    suggestLaneName.mockImplementation(() => new Promise<string>((_resolve, reject) => {
      rejectSuggestedName = reject;
    }));

    renderAutoCreateDraftPane();

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Launch in the background, then leave it hidden." } });
    fireEvent.click(await screen.findByRole("button", { name: "Auto-create in background" }));

    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Choosing a branch name/i)).toBeTruthy();
    });

    const scopeKey = draftLaunchJobsScopeKeyForTest({
      projectRoot: "/tmp/project-under-test",
      laneId: "lane-1",
    });
    const draftLaunchJobsByScope = useAppStore.getState().draftLaunchJobsByScope;
    act(() => {
      useAppStore.setState({
        draftLaunchJobsByScope: {
          ...draftLaunchJobsByScope,
          [scopeKey]: (draftLaunchJobsByScope[scopeKey] ?? []).map((job) => ({
            ...job,
            createdAtMs: 0,
          })),
        },
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss launch status" }));
    await waitFor(() => {
      expect(screen.queryByTestId("draft-launch-job")).toBeNull();
    });

    await act(async () => {
      rejectSuggestedName(new Error("hidden stale launch failed"));
    });

    expect(screen.queryByText(/hidden stale launch failed/i)).toBeNull();
    expect(screen.queryByTestId("draft-launch-job")).toBeNull();
  });

  it("keeps an auto-create failure visible when the launch fails after remount", async () => {
    const { send, suggestLaneName } = installAdeMocks({ sessions: [] });
    let rejectSend!: (error: Error) => void;
    suggestLaneName.mockResolvedValue("fails-after-remount");
    send.mockImplementation(() => new Promise<void>((_resolve, reject) => {
      rejectSend = reject;
    }));

    const rendered = renderAutoCreateDraftPane();

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Surface the failure after remount." } });
    fireEvent.click(await screen.findByRole("button", { name: "Auto-create in background" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalled();
    });

    rendered.unmount();
    renderAutoCreateDraftPane();

    await act(async () => {
      rejectSend(new Error("send failed after remount"));
    });

    await waitFor(() => {
      expect(screen.getByText(/Launch failed: send failed after remount/i)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Dismiss failed launch" })).toBeTruthy();
    });
  });

  it("ignores duplicate auto-create submits for the same draft while lane naming is pending", async () => {
    const { suggestLaneName } = installAdeMocks({ sessions: [] });
    suggestLaneName.mockImplementation(() => new Promise<string>(() => {
      // Keep the first launch in-flight so duplicate clicks race the same snapshot.
    }));

    renderAutoCreateDraftPane();

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Launch once even if clicked twice." } });
    const launchButton = await screen.findByRole("button", { name: "Auto-create in background" });
    await act(async () => {
      launchButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      launchButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalledTimes(1);
      expect(screen.getAllByText(/Choosing a branch name/i)).toHaveLength(1);
    });
  });

  it("keeps draft launch rows scoped to the lane pane that launched them", async () => {
    const { suggestLaneName } = installAdeMocks({ sessions: [] });
    suggestLaneName.mockImplementation(() => new Promise<string>(() => {
      // Keep the launch in-flight so the status row remains visible.
    }));
    const lanes = [
      {
        id: "lane-primary",
        name: "Primary",
        laneType: "primary",
        branchRef: "refs/heads/main",
        worktreePath: "/tmp/project-under-test",
      },
      {
        id: "lane-1",
        name: "Lane one",
        laneType: "worktree",
        branchRef: "refs/heads/lane-one",
        worktreePath: "/tmp/project-under-test/lane-one",
        parentLaneId: "lane-primary",
      },
      {
        id: "lane-2",
        name: "Lane two",
        laneType: "worktree",
        branchRef: "refs/heads/lane-two",
        worktreePath: "/tmp/project-under-test/lane-two",
        parentLaneId: "lane-primary",
      },
    ] as any[];
    useAppStore.setState({
      project: { rootPath: "/tmp/project-under-test" } as any,
      lanes,
      selectedLaneId: "lane-1",
    });

    render(
      <MemoryRouter initialEntries={["/work"]}>
        <div data-testid="lane-one-pane">
          <AgentChatPane
            laneId="lane-1"
            forceDraftMode
            embeddedWorkLayout
            availableLanes={lanes}
            onLaneChange={vi.fn()}
          />
        </div>
        <div data-testid="lane-two-pane">
          <AgentChatPane
            laneId="lane-2"
            forceDraftMode
            embeddedWorkLayout
            availableLanes={lanes}
            onLaneChange={vi.fn()}
          />
        </div>
      </MemoryRouter>,
    );

    const paneOne = screen.getByTestId("lane-one-pane");
    const paneTwo = screen.getByTestId("lane-two-pane");
    const modelTrigger = await within(paneOne).findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await within(paneOne).findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await within(paneOne).findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Only lane one should show this launch." } });
    fireEvent.click(await within(paneOne).findByRole("button", { name: "Auto-create in background" }));

    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalledTimes(1);
      expect(within(paneOne).getByText(/Choosing a branch name/i)).toBeTruthy();
    });
    expect(within(paneTwo).queryByText(/Choosing a branch name/i)).toBeNull();
    expect(within(paneTwo).queryByTestId("draft-launch-job")).toBeNull();
  });

  it("keeps every in-flight background draft launch visible past the completed-notice cap", async () => {
    const { suggestLaneName } = installAdeMocks({ sessions: [] });
    suggestLaneName.mockImplementation(() => new Promise<string>(() => {
      // keep the launch in-flight
    }));

    renderAutoCreateDraftPane();

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    for (let index = 1; index <= 9; index += 1) {
      fireEvent.change(textbox, { target: { value: `Launch background chat ${index}.` } });
      fireEvent.click(await screen.findByRole("button", { name: "Auto-create in background" }));
      await waitFor(() => {
        expect(suggestLaneName).toHaveBeenCalledTimes(index);
      });
    }

    expect(screen.getAllByTestId("draft-launch-job")).toHaveLength(9);
    expect(screen.getAllByText(/Choosing a branch name/i)).toHaveLength(9);
  });

  it("allows multiple background auto-create launches to stay pending at the same time", async () => {
    const { suggestLaneName, createLane, create, send } = installAdeMocks({ sessions: [] });
    const suggestResolvers: Array<(value: string) => void> = [];
    suggestLaneName.mockImplementation(() => new Promise<string>((resolve) => {
      suggestResolvers.push(resolve);
    }));
    createLane.mockImplementation(async ({ name }: { name: string; parentLaneId: string }) => ({
      id: `lane-${name}`,
      name,
      laneType: "worktree",
      branchRef: `refs/heads/${name}`,
      worktreePath: `/tmp/project-under-test/${name}`,
      parentLaneId: "lane-primary",
    }));

    renderAutoCreateDraftPane();

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "First auto lane." } });
    fireEvent.click(await screen.findByRole("button", { name: "Auto-create in background" }));
    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalledTimes(1);
      expect((textbox as HTMLTextAreaElement).value).toBe("");
    });

    fireEvent.change(textbox, { target: { value: "Second auto lane." } });
    fireEvent.click(await screen.findByRole("button", { name: "Auto-create in background" }));
    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalledTimes(2);
      expect(screen.getAllByText(/Choosing a branch name/i)).toHaveLength(2);
    });

    await act(async () => {
      suggestResolvers[0]?.("first-lane");
      suggestResolvers[1]?.("second-lane");
    });

    await waitFor(() => {
      expect(createLane).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/First auto lane\./i)).toBeTruthy();
      expect(screen.getByText(/Second auto lane\./i)).toBeTruthy();
    });
  });

  it("launches a tracked CLI session from the Work draft composer instead of creating an ADE chat", async () => {
    const { send, create } = installAdeMocks({ sessions: [] });
    const onLaunchCliSession = vi.fn().mockResolvedValue({ sessionId: "terminal-1", ptyId: "pty-1" });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceDraftMode
          embeddedWorkLayout
          workDraftKind="cli"
          onLaunchCliSession={onLaunchCliSession}
        />
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";

    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Run the unified CLI launch." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(onLaunchCliSession).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-1",
        profile: "codex",
        title: "Run the unified CLI launch",
        startupDelayMs: 180,
        tracked: true,
        disposition: "foreground",
      }));
      expect((window.ade as any).app.writeClipboardText).toHaveBeenCalledWith("Run the unified CLI launch.");
    });
    const launchArgs = onLaunchCliSession.mock.calls[0]?.[0];
    expect(launchArgs.command).toBe("codex");
    expect(launchArgs.args).toEqual(expect.arrayContaining(["--no-alt-screen"]));
    expect(launchArgs.startupCommand).not.toContain("ADE session guidance");
    expect(launchArgs.startupCommand).not.toContain("Run the unified CLI launch.");
    expect(launchArgs.initialInput).toContain("ADE session guidance");
    expect(launchArgs.initialInput).toContain("Run the unified CLI launch.");
    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves typed Work draft text when switching between Chat and CLI start modes", async () => {
    installAdeMocks({ sessions: [] });
    const onLaunchCliSession = vi.fn().mockResolvedValue({ sessionId: "terminal-1", ptyId: "pty-1" });

    const view = render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceDraftMode
          embeddedWorkLayout
          workDraftKind="chat"
          onLaunchCliSession={onLaunchCliSession}
        />
      </MemoryRouter>,
    );

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Keep this draft while I switch modes." } });

    view.rerender(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceDraftMode
          embeddedWorkLayout
          workDraftKind="cli"
          onLaunchCliSession={onLaunchCliSession}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Keep this draft while I switch modes.");
    });
  });

  it("does not restore a CLI-only Cursor model into a Chat Work draft", async () => {
    const { cliOnlyId } = seedCursorRuntimeModelCatalog();
    installAdeMocks({ sessions: [] });
    window.localStorage.setItem(composerDraftStorageKeyForTest({
      projectRoot: "/tmp/project-under-test",
      companionStateKey: "draft:lane-1",
    }), JSON.stringify({
      version: 1,
      text: "Keep the prompt but not the CLI-only model.",
      modelId: cliOnlyId,
      reasoningEffort: null,
      codexFastMode: false,
      executionMode: "focused",
      controls: {},
      attachments: [],
      contextAttachments: [],
      iosContextItems: [],
      appControlContextItems: [],
      builtInBrowserContextItems: [],
      macosVmContextItems: [],
      draftLaunchTargetId: null,
      updatedAt: "2026-05-27T00:00:00.000Z",
    }));

    renderAutoCreateDraftPane({ workDraftKind: "chat" });

    expect(await screen.findByDisplayValue("Keep the prompt but not the CLI-only model.")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /current: Cursor CLI Only/i })).toBeNull();
    });
  });

  it("uses the selected Codex plan preset when launching a Work draft CLI session", async () => {
    installAdeMocks({ sessions: [] });
    useAppStore.setState({
      project: { rootPath: "/tmp/project-under-test" } as any,
    });
    const onLaunchCliSession = vi.fn().mockResolvedValue({ sessionId: "terminal-1", ptyId: "pty-1" });
    const launchConfigKey = [
      "ade.chat.lastLaunchConfig.v1",
      "/tmp/project-under-test",
      "lane-1",
      "standard",
      "cli",
    ].map(encodeURIComponent).join(":");
    window.localStorage.setItem(launchConfigKey, JSON.stringify({
      version: 1,
      modelId: "openai/gpt-5.4",
      reasoningEffort: "medium",
      codexFastMode: false,
      executionMode: "focused",
      updatedAt: "2026-05-26T12:00:00.000Z",
      controls: {
        interactionMode: "default",
        claudePermissionMode: "default",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        opencodePermissionMode: "edit",
        droidPermissionMode: "auto-low",
        cursorModeId: "agent",
        cursorConfigValues: {},
      },
    }));

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceDraftMode
          embeddedWorkLayout
          workDraftKind="cli"
          onLaunchCliSession={onLaunchCliSession}
        />
      </MemoryRouter>,
    );

    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    expect(await screen.findByRole("button", { name: new RegExp(`current: ${escapeRegExp(codexLabel)}`, "i") })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Codex approval preset" }));
    fireEvent.click(await screen.findByRole("option", { name: "Plan mode" }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Launch Codex in plan mode." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(onLaunchCliSession).toHaveBeenCalledWith(expect.objectContaining({
        profile: "codex",
        tracked: true,
      }));
    });
    const launchArgs = onLaunchCliSession.mock.calls[0]?.[0];
    expect(launchArgs.args).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--ask-for-approval", "on-request"]));
    expect(launchArgs.args).not.toContain("workspace-write");
    expect(launchArgs.startupCommand).toContain("codex --no-alt-screen");
    expect(launchArgs.startupCommand).toContain("--sandbox read-only --ask-for-approval on-request");
  });

  it("uses the selected Codex edit preset when launching a Work draft CLI session", async () => {
    installAdeMocks({ sessions: [] });
    useAppStore.setState({
      project: { rootPath: "/tmp/project-under-test" } as any,
    });
    const onLaunchCliSession = vi.fn().mockResolvedValue({ sessionId: "terminal-1", ptyId: "pty-1" });
    const launchConfigKey = [
      "ade.chat.lastLaunchConfig.v1",
      "/tmp/project-under-test",
      "lane-1",
      "standard",
      "cli",
    ].map(encodeURIComponent).join(":");
    window.localStorage.setItem(launchConfigKey, JSON.stringify({
      version: 1,
      modelId: "openai/gpt-5.4",
      reasoningEffort: "medium",
      codexFastMode: false,
      executionMode: "focused",
      updatedAt: "2026-05-26T12:00:00.000Z",
      controls: {
        interactionMode: "default",
        claudePermissionMode: "default",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        opencodePermissionMode: "edit",
        droidPermissionMode: "auto-low",
        cursorModeId: "agent",
        cursorConfigValues: {},
      },
    }));

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceDraftMode
          embeddedWorkLayout
          workDraftKind="cli"
          onLaunchCliSession={onLaunchCliSession}
        />
      </MemoryRouter>,
    );

    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    expect(await screen.findByRole("button", { name: new RegExp(`current: ${escapeRegExp(codexLabel)}`, "i") })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Codex approval preset" }));
    fireEvent.click(await screen.findByRole("option", { name: "Edit mode" }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Launch Codex in edit mode." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(onLaunchCliSession).toHaveBeenCalledWith(expect.objectContaining({
        profile: "codex",
        tracked: true,
      }));
    });
    const launchArgs = onLaunchCliSession.mock.calls[0]?.[0];
    expect(launchArgs.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write", "--ask-for-approval", "untrusted"]));
    expect(launchArgs.startupCommand).toContain("--sandbox workspace-write --ask-for-approval untrusted");
  });

  it("uses the Cursor fast model alias when launching a fast Work draft CLI session", async () => {
    const { modelId, fastAlias } = seedFastCursorRuntimeModelCatalog();
    installAdeMocks({ sessions: [], cursorModels: [{ id: modelId }] });
    useAppStore.setState({
      project: { rootPath: "/tmp/project-under-test" } as any,
    });
    const onLaunchCliSession = vi.fn().mockResolvedValue({ sessionId: "terminal-1", ptyId: "pty-1" });
    const launchConfigKey = [
      "ade.chat.lastLaunchConfig.v1",
      "/tmp/project-under-test",
      "lane-1",
      "standard",
      "cli",
    ].map(encodeURIComponent).join(":");
    window.localStorage.setItem(launchConfigKey, JSON.stringify({
      version: 1,
      modelId,
      reasoningEffort: null,
      codexFastMode: true,
      executionMode: "focused",
      updatedAt: "2026-05-26T12:00:00.000Z",
      controls: {
        interactionMode: "default",
        claudePermissionMode: "default",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        opencodePermissionMode: "edit",
        droidPermissionMode: "auto-low",
        cursorModeId: "agent",
        cursorConfigValues: {},
      },
    }));

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceDraftMode
          embeddedWorkLayout
          workDraftKind="cli"
          onLaunchCliSession={onLaunchCliSession}
        />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("button", { name: /Fast mode/i })).getAttribute("aria-pressed")).toBe("true");

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Run Cursor in fast mode." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(onLaunchCliSession).toHaveBeenCalledWith(expect.objectContaining({
        profile: "cursor",
        tracked: true,
      }));
    });
    const launchArgs = onLaunchCliSession.mock.calls[0]?.[0];
    expect(launchArgs.startupCommand).toContain(`--model ${fastAlias}`);
    expect(launchArgs.args).toEqual(expect.arrayContaining([expect.stringContaining("Run Cursor in fast mode.")]));
  });

  it("uses the concrete Cursor CLI variant for Work draft reasoning and fast controls", async () => {
    const { modelId, concreteModel } = seedReasoningCursorRuntimeModelCatalog();
    installAdeMocks({ sessions: [], cursorModels: [{ id: modelId }] });
    useAppStore.setState({
      project: { rootPath: "/tmp/project-under-test" } as any,
    });
    const onLaunchCliSession = vi.fn().mockResolvedValue({ sessionId: "terminal-1", ptyId: "pty-1" });
    const launchConfigKey = [
      "ade.chat.lastLaunchConfig.v1",
      "/tmp/project-under-test",
      "lane-1",
      "standard",
      "cli",
    ].map(encodeURIComponent).join(":");
    window.localStorage.setItem(launchConfigKey, JSON.stringify({
      version: 1,
      modelId,
      reasoningEffort: "medium",
      codexFastMode: true,
      executionMode: "focused",
      updatedAt: "2026-05-26T12:00:00.000Z",
      controls: {
        interactionMode: "default",
        claudePermissionMode: "default",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        opencodePermissionMode: "edit",
        droidPermissionMode: "auto-low",
        cursorModeId: "agent",
        cursorConfigValues: {},
      },
    }));

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceDraftMode
          embeddedWorkLayout
          workDraftKind="cli"
          onLaunchCliSession={onLaunchCliSession}
        />
      </MemoryRouter>,
    );

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Run Cursor with medium fast thinking." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(onLaunchCliSession).toHaveBeenCalledWith(expect.objectContaining({
        profile: "cursor",
        tracked: true,
      }));
    });
    const launchArgs = onLaunchCliSession.mock.calls[0]?.[0];
    expect(launchArgs.startupCommand).toContain(`--model ${concreteModel}`);
    expect(launchArgs.args).toEqual(expect.arrayContaining([expect.stringContaining("Run Cursor with medium fast thinking.")]));
  });

  it("auto-creates a lane for a foreground CLI session draft", async () => {
    const { send, create, createLane, suggestLaneName, writeClipboardText } = installAdeMocks({ sessions: [] });
    const onLaunchCliSession = vi.fn().mockResolvedValue({ sessionId: "terminal-created", ptyId: "pty-created" });
    suggestLaneName.mockResolvedValue("cli-auto-lane");
    createLane.mockResolvedValue({
      id: "lane-created",
      name: "cli-auto-lane",
      laneType: "worktree",
      branchRef: "refs/heads/cli-auto-lane",
      worktreePath: "/tmp/project-under-test/cli-auto-lane",
      parentLaneId: "lane-primary",
    });

    renderAutoCreateDraftPane({ workDraftKind: "cli", onLaunchCliSession });

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Launch a CLI agent on a new lane." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-primary",
        prompt: "Launch a CLI agent on a new lane.",
        modelId: "openai/gpt-5.4",
      }));
      expect(createLane).toHaveBeenCalledWith({
        name: "cli-auto-lane",
        parentLaneId: "lane-primary",
      });
      expect(onLaunchCliSession).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-created",
        profile: "codex",
        title: "Launch a CLI agent on a new lane",
        startupDelayMs: 180,
        tracked: true,
        disposition: "foreground",
      }));
      expect(writeClipboardText).toHaveBeenCalledWith("Launch a CLI agent on a new lane.");
    });
    const launchArgs = onLaunchCliSession.mock.calls[0]?.[0];
    expect(launchArgs.startupCommand).not.toContain("Launch a CLI agent on a new lane.");
    expect(launchArgs.initialInput).toContain("Launch a CLI agent on a new lane.");
    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("launches a CLI session draft in the background without stealing focus", async () => {
    const { send, create, createLane, suggestLaneName } = installAdeMocks({ sessions: [] });
    const onLaunchCliSession = vi.fn().mockResolvedValue({ sessionId: "terminal-created", ptyId: "pty-created" });
    suggestLaneName.mockResolvedValue("background-cli-lane");
    createLane.mockResolvedValue({
      id: "lane-created",
      name: "background-cli-lane",
      laneType: "worktree",
      branchRef: "refs/heads/background-cli-lane",
      worktreePath: "/tmp/project-under-test/background-cli-lane",
      parentLaneId: "lane-primary",
    });

    renderAutoCreateDraftPane({ workDraftKind: "cli", onLaunchCliSession });

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Launch this CLI session in the background." } });
    fireEvent.click(await screen.findByRole("button", { name: "Auto-create in background" }));

    await waitFor(() => {
      expect(onLaunchCliSession).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-created",
        profile: "codex",
        startupDelayMs: 180,
        tracked: true,
        disposition: "background",
      }));
      expect(screen.getByText(/Launch this CLI session in the background\./i)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Dismiss launch status" })).toBeTruthy();
    });
    const launchArgs = onLaunchCliSession.mock.calls[0]?.[0];
    expect(launchArgs.startupCommand).not.toContain("Launch this CLI session in the background.");
    expect(launchArgs.initialInput).toContain("Launch this CLI session in the background.");
    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByTestId("location").textContent).toBe("/work");

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/work?laneId=lane-created&sessionId=terminal-created");
    });
  });

  it("keeps immediate agent events for a freshly created chat before session refresh catches up", async () => {
    const { create, emitChatEvent } = installAdeMocks({ sessions: [] });
    const send = vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      emitChatEvent({
        sessionId,
        timestamp: "2026-03-24T05:57:46.000Z",
        event: {
          type: "status",
          turnStatus: "started",
          turnId: "turn-1",
        },
      });
      emitChatEvent({
        sessionId,
        timestamp: "2026-03-24T05:57:46.100Z",
        event: {
          type: "text",
          text: "Fresh session reply",
          turnId: "turn-1",
          messageId: "assistant-1",
        },
      });
      emitChatEvent({
        sessionId,
        timestamp: "2026-03-24T05:57:46.200Z",
        event: {
          type: "done",
          turnId: "turn-1",
          status: "completed",
          model: "gpt-5.4",
        },
      });
    });
    window.ade.agentChat.send = send as any;

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceNewSession
        />
      </MemoryRouter>,
    );

    const trigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";

    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Ship it." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(create).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "created-session",
        text: "Ship it.",
      }));
    });

    expect(await screen.findByText("Fresh session reply")).toBeTruthy();
  });

  it("preserves background streamed events when switching back to a chat with same-timestamp transcript entries", async () => {
    const primarySession = buildSession("session-1", {
      title: "Primary chat",
      lastActivityAt: "2026-03-24T05:57:45.700Z",
    });
    const backgroundSession = buildSession("session-2", {
      title: "Background chat",
      lastActivityAt: "2026-03-24T05:57:45.600Z",
    });
    const { emitChatEvent } = installAdeMocks({
      sessions: [primarySession, backgroundSession],
    });
    window.ade.sessions.readTranscriptTail = vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === "session-2") {
        return `${JSON.stringify({
          sessionId: "session-2",
          timestamp: "2026-03-24T06:00:00.000Z",
          sequence: 1,
          event: {
            type: "status",
            turnStatus: "started",
            turnId: "turn-2",
          },
        })}\n`;
      }
      return "";
    });

    renderTabbedPane(primarySession);

    await screen.findByRole("button", { name: /Primary chat/i });
    await screen.findByRole("button", { name: /Background chat/i });

    emitChatEvent({
      sessionId: "session-2",
      timestamp: "2026-03-24T06:00:00.000Z",
      sequence: 2,
      event: {
        type: "text",
        text: "Background output kept streaming",
        turnId: "turn-2",
        messageId: "assistant-2",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /Background chat/i }));

    expect(await screen.findByText("Background output kept streaming")).toBeTruthy();
  });

  it("validates empty legacy event-history snapshots before treating them as loaded", async () => {
    const session = buildSession("session-1", { title: "Possibly foreign chat" });
    installAdeMocks({
      sessions: [],
      eventHistory: {
        sessionId: session.sessionId,
        events: [],
        truncated: false,
      },
    });

    renderPane(session);

    await waitFor(() => {
      expect(window.ade.agentChat.getEventHistory).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
      }));
      expect(window.ade.agentChat.getSummary).toHaveBeenCalledWith({ sessionId: session.sessionId });
      expect(window.ade.sessions.readTranscriptTail).not.toHaveBeenCalled();
    });
  });

  it("rejects explicit foreign-session event-history snapshots", async () => {
    const session = buildSession("session-1", { title: "Foreign chat" });
    installAdeMocks({
      sessions: [session],
      eventHistory: {
        sessionId: session.sessionId,
        events: [],
        truncated: false,
        sessionFound: false,
      },
    });

    renderPane(session);

    await waitFor(() => {
      expect(window.ade.agentChat.getEventHistory).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
      }));
      expect(window.ade.sessions.readTranscriptTail).not.toHaveBeenCalled();
    });
  });

  it("reloads a previously viewed chat transcript when switching back to recover missed background output", async () => {
    const primarySession = buildSession("session-1", {
      title: "Primary chat",
      lastActivityAt: "2026-03-24T05:57:45.700Z",
    });
    const backgroundSession = buildSession("session-2", {
      title: "Background chat",
      lastActivityAt: "2026-03-24T05:57:45.600Z",
    });
    let backgroundTranscript = `${JSON.stringify({
      sessionId: "session-2",
      timestamp: "2026-03-24T06:00:00.000Z",
      sequence: 1,
      event: {
        type: "status",
        turnStatus: "started",
        turnId: "turn-2",
      },
    })}\n`;

    installAdeMocks({
      sessions: [primarySession, backgroundSession],
    });
    const readTranscriptTail = vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === "session-2") return backgroundTranscript;
      return "";
    });
    window.ade.sessions.readTranscriptTail = readTranscriptTail as any;

    renderTabbedPane(primarySession);

    const primaryTab = await screen.findByRole("button", { name: /Primary chat/i });
    const backgroundTab = await screen.findByRole("button", { name: /Background chat/i });

    fireEvent.click(backgroundTab);
    await waitFor(() => {
      expect(readTranscriptTail).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-2" }));
    });

    fireEvent.click(primaryTab);

    backgroundTranscript += `${JSON.stringify({
      sessionId: "session-2",
      timestamp: "2026-03-24T06:00:01.000Z",
      sequence: 2,
      event: {
        type: "text",
        text: "Recovered from transcript on revisit",
        turnId: "turn-2",
        messageId: "assistant-2",
      },
    })}\n`;

    fireEvent.click(backgroundTab);

    expect(await screen.findByText("Recovered from transcript on revisit")).toBeTruthy();
    expect(readTranscriptTail).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-2" }));
  });

  it("hydrates a visible inactive grid tile without requiring a click", async () => {
    const session = buildSession("grid-inactive-chat", {
      title: "Grid inactive chat",
    });
    installAdeMocks({ sessions: [session] });
    const readTranscriptTail = vi.fn().mockResolvedValue(`${JSON.stringify({
      sessionId: session.sessionId,
      timestamp: "2026-03-24T06:00:00.000Z",
      sequence: 1,
      event: {
        type: "text",
        text: "Visible inactive grid tile loaded",
        turnId: "turn-grid",
        messageId: "assistant-grid",
      },
    })}\n`);
    window.ade.sessions.readTranscriptTail = readTranscriptTail as any;

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
          layoutVariant="grid-tile"
          isTileActive={false}
          isTileVisible
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Visible inactive grid tile loaded")).toBeTruthy();
    expect(readTranscriptTail).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.sessionId }));
  });

  it("streams live events into visible inactive grid tiles without requiring focus", async () => {
    const session = buildSession("grid-live-chat", {
      title: "Grid live chat",
    });
    const { emitChatEvent } = installAdeMocks({ sessions: [session] });
    window.ade.sessions.readTranscriptTail = vi.fn().mockResolvedValue("") as any;

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
          layoutVariant="grid-tile"
          isTileActive={false}
          isTileVisible
        />
      </MemoryRouter>,
    );

    await screen.findByRole("textbox");

    vi.useFakeTimers();
    try {
      act(() => {
        emitChatEvent({
          sessionId: session.sessionId,
          timestamp: "2026-03-24T06:00:02.000Z",
          sequence: 2,
          event: {
            type: "text",
            text: "Visible inactive grid tile streamed",
            turnId: "turn-grid-live",
            messageId: "assistant-grid-live",
          },
        });
      });

      expect(screen.getByText("Visible inactive grid tile streamed")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("poll-recovers visible active grid tiles when live IPC misses an event", async () => {
    vi.useFakeTimers();
    const session = buildSession("grid-recovery-chat", {
      title: "Grid recovery chat",
      status: "active",
    });
    installAdeMocks({ sessions: [session] });
    let transcript = "";
    const readTranscriptTail = vi.fn().mockImplementation(async () => transcript);
    window.ade.sessions.readTranscriptTail = readTranscriptTail as any;

    try {
      render(
        <MemoryRouter>
          <AgentChatPane
            laneId={session.laneId}
            lockSessionId={session.sessionId}
            hideSessionTabs
            initialSessionSummary={session}
            layoutVariant="grid-tile"
            isTileActive={false}
            isTileVisible
          />
        </MemoryRouter>,
      );

      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.queryByText("Recovered grid tile output")).toBeNull();

      transcript = `${JSON.stringify({
        sessionId: session.sessionId,
        timestamp: "2026-03-24T06:00:03.000Z",
        sequence: 3,
        event: {
          type: "text",
          text: "Recovered grid tile output",
          turnId: "turn-grid-recovery",
          messageId: "assistant-grid-recovery",
        },
      })}\n`;

      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByText("Recovered grid tile output")).toBeTruthy();
      expect(readTranscriptTail).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.sessionId }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hydrate hidden inactive chat tiles", async () => {
    vi.useFakeTimers();
    const session = buildSession("hidden-inactive-chat", {
      title: "Hidden inactive chat",
    });
    installAdeMocks({ sessions: [session] });
    const readTranscriptTail = vi.fn().mockResolvedValue("");
    window.ade.sessions.readTranscriptTail = readTranscriptTail as any;

    try {
      render(
        <MemoryRouter>
          <AgentChatPane
            laneId={session.laneId}
            lockSessionId={session.sessionId}
            hideSessionTabs
            initialSessionSummary={session}
            layoutVariant="grid-tile"
            isTileActive={false}
          />
        </MemoryRouter>,
      );

      await act(async () => {
        vi.advanceTimersByTime(550);
      });
      expect(readTranscriptTail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows 'New chat' in the header when no session is selected", async () => {
    installAdeMocks({ sessions: [] });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceNewSession
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("New chat")).toBeTruthy();
  });

  it("shows the session title in the header when the session has one", async () => {
    const session = buildSession("session-1", {
      title: "Fix login bug",
    });
    installAdeMocks({ sessions: [session] });
    renderPane(session);

    expect(await screen.findByText("Fix login bug")).toBeTruthy();
  });

  it("renders the git toolbar when laneId is provided", async () => {
    const session = buildSession("session-1");
    installAdeMocks({ sessions: [session] });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          laneLabel="feature/auth"
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
        />
      </MemoryRouter>,
    );

    // The git toolbar renders a PR button when laneId is present
    expect(await screen.findByText("PR")).toBeTruthy();
  });

  it("labels a merged linked PR in the git toolbar", async () => {
    const session = buildSession("session-1");
    installAdeMocks({
      sessions: [session],
      linkedPr: buildPrSummary({ state: "merged" }),
    });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          laneLabel="feature/auth"
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("MERGED #224")).toBeTruthy();
  });

  it("does not render the git toolbar when laneId is null", async () => {
    const session = buildSession("session-1");
    installAdeMocks({ sessions: [session] });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={null}
          laneLabel="feature/auth"
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
        />
      </MemoryRouter>,
    );

    // Wait for the pane to fully render — no git toolbar when laneId is null
    await waitFor(() => {
      expect(screen.queryByText("PR")).toBeNull();
    });
  });

  it("launches one child lane per parallel model and opens work-focus tiling", async () => {
    const createdLanes: Array<Record<string, unknown>> = [];
    const { send, suggestLaneName, parallelLaunchStateSet, writeClipboardText } = installAdeMocks({ sessions: [], includeClaudeModel: true });
    const createChild = vi.fn().mockImplementation(async ({ name, parentLaneId }: { name: string; parentLaneId: string }) => {
      const lane = {
        id: `lane-child-${createdLanes.length + 1}`,
        name,
        laneType: "worktree",
        branchRef: `refs/heads/${name}`,
        worktreePath: `/tmp/project-under-test/${name}`,
        parentLaneId,
      };
      createdLanes.push(lane);
      return lane;
    });
    const create = vi.fn().mockImplementation(async (args: Record<string, unknown>) => buildCreatedSession(
      `session-${String(args.laneId)}`,
      {
        laneId: String(args.laneId),
        provider: args.provider as AgentChatSession["provider"],
        model: String(args.model),
        modelId: String(args.modelId),
        reasoningEffort: (args.reasoningEffort as string | null | undefined) ?? null,
      },
    ));
    suggestLaneName.mockResolvedValue("fix-login");
    window.ade.lanes.createChild = createChild as any;
    window.ade.lanes.list = vi.fn().mockImplementation(async () => ([
      {
        id: "lane-1",
        name: "parent-lane",
        laneType: "worktree",
        branchRef: "refs/heads/parent-lane",
        worktreePath: "/tmp/project-under-test/parent-lane",
      },
      ...createdLanes,
    ])) as any;
    window.ade.agentChat.create = create as any;

    renderParallelDraftPane({
      availableModelIdsOverride: [
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
      ],
    });

    const baseModelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(baseModelTrigger, { button: 0 });
    fireEvent.click(baseModelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: /Parallel models/i }));
    fireEvent.click(screen.getAllByRole("button", { name: "Configure" })[1]!);

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const claudeLabel = getModelById("anthropic/claude-sonnet-4-6")?.displayName ?? "Claude Sonnet 4.6";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(claudeLabel), "i"));

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix the login bug" } });
    fireEvent.click(await screen.findByRole("button", { name: /Send to lanes/i }));

    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-1",
        prompt: "Fix the login bug",
        modelId: "openai/gpt-5.4",
        fallbackName: expect.stringMatching(/^chat-\d{8}-\d{6}$/),
      }));
      expect(createChild).toHaveBeenCalledTimes(2);
    });
    expect(createChild.mock.calls.map(([args]) => args.name)).toEqual([
      "fix-login-codex-gpt-5-4",
      "fix-login-claude-sonnet",
    ]);

    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(writeClipboardText).toHaveBeenCalledTimes(1);
    expect(writeClipboardText).toHaveBeenCalledWith("Fix the login bug");
    expect(create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      laneId: "lane-child-1",
      provider: "codex",
      modelId: "openai/gpt-5.4",
    }));
    expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      laneId: "lane-child-2",
      provider: "claude",
      modelId: "anthropic/claude-sonnet-4-6",
    }));
    expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: "session-lane-child-1",
      text: "Fix the login bug",
      displayText: "Fix the login bug",
    }));
    expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: "session-lane-child-2",
      text: "Fix the login bug",
      displayText: "Fix the login bug",
    }));
    expect(parallelLaunchStateSet.mock.calls.some(([args]) =>
      args.projectRoot === "/tmp/project-under-test"
      && args.parentLaneId === "lane-1"
      && args.state?.status === "creating_lanes"
      && args.state.createdLaneIds.includes("lane-child-1"),
    )).toBe(true);
    expect(parallelLaunchStateSet.mock.calls.some(([args]) =>
      args.projectRoot === "/tmp/project-under-test"
      && args.parentLaneId === "lane-1"
      && args.state?.status === "completed"
      && args.state.sentLaneIds.includes("lane-child-2"),
    )).toBe(true);
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/lanes?laneIds=lane-child-1%2Clane-child-2&workFocus=1");
      expect(parallelLaunchStateSet).toHaveBeenLastCalledWith({
        projectRoot: "/tmp/project-under-test",
        parentLaneId: "lane-1",
        state: null,
      });
    });
  });

  it("cleans up a recovered unfinished parallel launch when the parent draft reopens", async () => {
    const deleteLane = vi.fn().mockResolvedValue(undefined);
    const { parallelLaunchStateGet, parallelLaunchStateSet } = installAdeMocks({
      parallelLaunchState: {
        parentLaneId: "lane-1",
        createdLaneIds: ["lane-child-1"],
        sentLaneIds: [],
        status: "sending",
        updatedAt: "2026-04-23T00:00:00.000Z",
        lastError: null,
      },
    });
    window.ade.lanes.delete = deleteLane as any;

    renderParallelDraftPane();

    await waitFor(() => {
      expect(parallelLaunchStateGet).toHaveBeenCalledWith({
        projectRoot: "/tmp/project-under-test",
        parentLaneId: "lane-1",
      });
      expect(deleteLane).toHaveBeenCalledWith({ laneId: "lane-child-1", force: true });
    });
    expect(parallelLaunchStateSet).toHaveBeenCalledWith({
      projectRoot: "/tmp/project-under-test",
      parentLaneId: "lane-1",
      state: null,
    });
  });

  it("surfaces partial rollback failures when a parallel launch cannot clean up", async () => {
    const createdLanes: Array<Record<string, unknown>> = [];
    const send = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Lane 2 failed to send."));
    const deleteLane = vi.fn().mockImplementation(async ({ laneId }: { laneId: string }) => {
      if (laneId === "lane-child-1") {
        throw new Error("worktree locked");
      }
      const index = createdLanes.findIndex((lane) => lane.id === laneId);
      if (index >= 0) createdLanes.splice(index, 1);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { suggestLaneName, parallelLaunchStateSet } = installAdeMocks({ sessions: [], includeClaudeModel: true });
    const createChild = vi.fn().mockImplementation(async ({ name, parentLaneId }: { name: string; parentLaneId: string }) => {
      const lane = {
        id: `lane-child-${createdLanes.length + 1}`,
        name,
        laneType: "worktree",
        branchRef: `refs/heads/${name}`,
        worktreePath: `/tmp/project-under-test/${name}`,
        parentLaneId,
      };
      createdLanes.push(lane);
      return lane;
    });
    const create = vi.fn().mockImplementation(async (args: Record<string, unknown>) => buildCreatedSession(
      `session-${String(args.laneId)}`,
      {
        laneId: String(args.laneId),
        provider: args.provider as AgentChatSession["provider"],
        model: String(args.model),
        modelId: String(args.modelId),
      },
    ));
    suggestLaneName.mockResolvedValue("fix-login");
    window.ade.agentChat.send = send as any;
    window.ade.agentChat.create = create as any;
    window.ade.lanes.createChild = createChild as any;
    window.ade.lanes.delete = deleteLane as any;
    window.ade.lanes.list = vi.fn().mockImplementation(async () => ([
      {
        id: "lane-1",
        name: "parent-lane",
        laneType: "worktree",
        branchRef: "refs/heads/parent-lane",
        worktreePath: "/tmp/project-under-test/parent-lane",
      },
      ...createdLanes,
    ])) as any;

    renderParallelDraftPane({
      availableModelIdsOverride: [
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
      ],
    });

    const baseModelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(baseModelTrigger, { button: 0 });
    fireEvent.click(baseModelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));

    fireEvent.click(await screen.findByRole("button", { name: /Parallel models/i }));
    fireEvent.click(screen.getAllByRole("button", { name: "Configure" })[1]!);
    fireEvent.click(await screen.findByRole("button", { name: /^Select model/ }));
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(/Claude Sonnet 4\.6/i);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix the login bug" } });
    fireEvent.click(await screen.findByRole("button", { name: /Send to lanes/i }));

    expect(await screen.findByText(/Lane 2 failed to send\./i)).toBeTruthy();
    expect(screen.getByText(/Cleanup could not delete lane lane-child-1/i)).toBeTruthy();
    expect(deleteLane).toHaveBeenNthCalledWith(1, { laneId: "lane-child-1", force: true });
    expect(deleteLane).toHaveBeenNthCalledWith(2, { laneId: "lane-child-2", force: true });
    expect(errorSpy).toHaveBeenCalledWith(
      "parallel launch cleanup failed",
      expect.objectContaining({ laneId: "lane-child-1" }),
    );
    expect(parallelLaunchStateSet.mock.calls.some(([args]) =>
      args.projectRoot === "/tmp/project-under-test"
      && args.parentLaneId === "lane-1"
      && args.state?.status === "cleanup_pending"
      && args.state.createdLaneIds.includes("lane-child-1"),
    )).toBe(true);
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Pure function unit tests (consolidated from AgentChatPane.test.ts)
// ---------------------------------------------------------------------------

describe("resolveNextSelectedSessionId", () => {
  function buildMinimalSession(sessionId: string): AgentChatSessionSummary {
    return {
      sessionId,
      laneId: "lane-1",
      provider: "claude",
      model: "claude",
      endedAt: null,
      lastOutputPreview: null,
      summary: null,
      startedAt: "2026-03-16T00:00:00.000Z",
      lastActivityAt: "2026-03-16T00:00:00.000Z",
      status: "idle",
      title: null,
      goal: null,
      completion: null,
      reasoningEffort: null,
      executionMode: "focused",
    };
  }

  it("keeps the pending newly created session selected while list refresh still only contains the older chat", () => {
    const rows = [buildMinimalSession("claude-existing")];

    expect(resolveNextSelectedSessionId({
      rows,
      current: null,
      pendingSelectedSessionId: "codex-new",
      optimisticSessionIds: new Set(["codex-new"]),
      draftSelectionLocked: false,
      forceDraft: false,
      preferDraftStart: false,
    })).toBe("codex-new");
  });

  it("falls back to the newest persisted chat once no pending selection exists", () => {
    const rows = [buildMinimalSession("claude-existing"), buildMinimalSession("older")];

    expect(resolveNextSelectedSessionId({
      rows,
      current: null,
      pendingSelectedSessionId: null,
      optimisticSessionIds: new Set(),
      draftSelectionLocked: false,
      forceDraft: false,
      preferDraftStart: false,
    })).toBe("claude-existing");
  });
});

describe("shouldPromoteSessionForComputerUse", () => {
  it("promotes older light sessions when the session profile isn't already workflow", () => {
    expect(shouldPromoteSessionForComputerUse({ sessionProfile: "light" })).toBe(true);
    expect(shouldPromoteSessionForComputerUse({ sessionProfile: undefined })).toBe(true);
    expect(shouldPromoteSessionForComputerUse({ sessionProfile: "workflow" })).toBe(false);
  });
});

describe("mergeChatHistorySnapshot", () => {
  function envelope(
    timestamp: string,
    sequence: number,
    text: string,
  ): AgentChatEventEnvelope {
    return {
      sessionId: "session-1",
      timestamp,
      sequence,
      event: {
        type: "text",
        text,
        messageId: `message-${text}`,
      },
    };
  }

  it("keeps live events after a provider sequence reset", () => {
    const beforeRestart = envelope("2026-04-30T23:14:47.751Z", 1003, "before restart");
    const afterRestartUser = envelope("2026-04-30T23:19:57.083Z", 1, "after restart user");
    const afterRestartReply = envelope("2026-04-30T23:21:34.621Z", 66, "after restart reply");
    const stillLive = envelope("2026-04-30T23:25:10.427Z", 146, "still live");

    const merged = mergeChatHistorySnapshot(
      [beforeRestart, afterRestartUser, afterRestartReply],
      [beforeRestart, afterRestartUser, afterRestartReply, stillLive],
    );

    expect(merged.map((entry) => entry.event.type === "text" ? entry.event.text : "")).toEqual([
      "before restart",
      "after restart user",
      "after restart reply",
      "still live",
    ]);
  });

  it("keeps same-millisecond live tail events without trusting global sequence order", () => {
    const snapshotLast = envelope("2026-04-30T23:25:10.427Z", 146, "snapshot last");
    const sameMillisecondTail = envelope("2026-04-30T23:25:10.427Z", 1, "same millisecond tail");

    const merged = mergeChatHistorySnapshot(
      [snapshotLast],
      [snapshotLast, sameMillisecondTail],
    );

    expect(merged.map((entry) => entry.event.type === "text" ? entry.event.text : "")).toEqual([
      "snapshot last",
      "same millisecond tail",
    ]);
  });

  it("preserves existing event object identity when a recovery snapshot is unchanged", () => {
    const first = envelope("2026-04-30T23:14:47.751Z", 1003, "first");
    const second = envelope("2026-04-30T23:19:57.083Z", 1004, "second");
    const parsedFirst = envelope("2026-04-30T23:14:47.751Z", 1003, "first");
    const parsedSecond = envelope("2026-04-30T23:19:57.083Z", 1004, "second");

    const existing = [first, second];
    const merged = mergeChatHistorySnapshot([parsedFirst, parsedSecond], existing);

    expect(merged).toBe(existing);
    expect(merged[0]).toBe(first);
    expect(merged[1]).toBe(second);
  });

  it("reuses existing snapshot entries while appending newly recovered events", () => {
    const first = envelope("2026-04-30T23:14:47.751Z", 1003, "first");
    const parsedFirst = envelope("2026-04-30T23:14:47.751Z", 1003, "first");
    const parsedSecond = envelope("2026-04-30T23:19:57.083Z", 1004, "second");

    const merged = mergeChatHistorySnapshot([parsedFirst, parsedSecond], [first]);

    expect(merged[0]).toBe(first);
    expect(merged[1]).toBe(parsedSecond);
  });
});

describe("subagent auto-open storage", () => {
  function createStorageShim(initial: Record<string, string> = {}) {
    const entries = new Map(Object.entries(initial));
    return {
      get length() {
        return entries.size;
      },
      key(index: number) {
        return Array.from(entries.keys())[index] ?? null;
      },
      getItem(key: string) {
        return entries.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        entries.set(key, value);
      },
      removeItem(key: string) {
        entries.delete(key);
      },
    };
  }

  it("expires timestamped auto-open markers and migrates legacy markers", () => {
    const now = Date.parse("2026-05-14T12:00:00.000Z");
    const freshKey = getSubagentAutoOpenStorageKey("fresh-session");
    const staleKey = getSubagentAutoOpenStorageKey("stale-session");
    const legacyKey = getSubagentAutoOpenStorageKey("legacy-session");
    const storage = createStorageShim();

    storage.setItem(freshKey, JSON.stringify({ firedAt: now - 60_000 }));
    storage.setItem(staleKey, JSON.stringify({ firedAt: now - 8 * 24 * 60 * 60 * 1000 }));
    storage.setItem(legacyKey, "1");
    storage.setItem("ade.chat.other", "keep");

    cleanupSubagentAutoOpenStorage(storage, now);

    expect(storage.getItem(freshKey)).toBe(JSON.stringify({ firedAt: now - 60_000 }));
    expect(storage.getItem(staleKey)).toBeNull();
    expect(storage.getItem(legacyKey)).toBe(JSON.stringify({ firedAt: now }));
    expect(storage.getItem("ade.chat.other")).toBe("keep");
  });
});

describe("parallel launch helpers", () => {
  it("keeps same-family model lane suffixes distinct", () => {
    expect(parallelLaneModelSuffix(getModelById("openai/gpt-5.4"))).toBe("codex-gpt-5-4");
    expect(parallelLaneModelSuffix(getModelById("openai/gpt-5.4-mini"))).toBe("codex-gpt-5-4-mini");
  });

  it("preserves the default attachment review request when project docs are prepended", () => {
    const result = buildParallelLaunchPrompt({
      text: "",
      attachmentCount: 2,
    });

    expect(result.displayText).toBe("Please review the attached files.");
    expect(result.sendText).toBe("Please review the attached files.");
  });

  it("uses an issue-context prompt for context-only parallel launches", () => {
    const result = buildParallelLaunchPrompt({
      text: "",
      attachmentCount: 0,
      contextAttachmentCount: 1,
    });

    expect(result.displayText).toBe("Use the attached issue context.");
    expect(result.sendText).toBe("Use the attached issue context.");
  });

  it("force-cleans transient lanes and refreshes lane state after rollback", async () => {
    const deleteLane = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Lane has uncommitted changes."));
    const refreshLanes = vi.fn().mockResolvedValue(undefined);
    const onCleanupError = vi.fn();

    const issues = await cleanupTransientParallelLaunchLanes({
      laneIds: ["lane-a", "lane-b"],
      deleteLane,
      refreshLanes,
      onCleanupError,
    });

    expect(deleteLane).toHaveBeenNthCalledWith(1, { laneId: "lane-a", force: true });
    expect(deleteLane).toHaveBeenNthCalledWith(2, { laneId: "lane-b", force: true });
    expect(refreshLanes).toHaveBeenCalledTimes(1);
    expect(onCleanupError).toHaveBeenCalledWith(expect.objectContaining({
      phase: "delete",
      laneId: "lane-b",
    }));
    expect(issues).toEqual([
      expect.objectContaining({
        phase: "delete",
        laneId: "lane-b",
      }),
    ]);
  });

  it("treats already-deleted lanes as cleaned up during rollback retries", async () => {
    const deleteLane = vi.fn().mockRejectedValue(new Error("Lane not found."));
    const refreshLanes = vi.fn().mockResolvedValue(undefined);
    const onCleanupError = vi.fn();

    const issues = await cleanupTransientParallelLaunchLanes({
      laneIds: ["lane-a"],
      deleteLane,
      refreshLanes,
      onCleanupError,
    });

    expect(deleteLane).toHaveBeenCalledWith({ laneId: "lane-a", force: true });
    expect(refreshLanes).toHaveBeenCalledTimes(1);
    expect(onCleanupError).not.toHaveBeenCalled();
    expect(issues).toEqual([]);
  });

  it("formats rollback failures so leaked child lanes are surfaced to the user", () => {
    expect(formatParallelLaunchFailureMessage({
      launchError: "Lane 2 failed to send.",
      cleanupIssues: [
        { phase: "delete", laneId: "lane-a", error: new Error("locked") },
        { phase: "refresh", laneId: null, error: new Error("refresh failed") },
      ],
    })).toBe(
      "Lane 2 failed to send. Cleanup could not delete lane lane-a; lane list refresh also failed. Check the lane list before retrying.",
    );
  });
});
