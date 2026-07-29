/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type {
  AgentChatEventEnvelope,
  AgentChatEventHistoryPage,
  AgentChatEventHistorySnapshot,
  AgentChatModelCatalog,
  AgentChatParallelLaunchState,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSteerResult,
  AiSettingsStatus,
  ComputerUseArtifactView,
  ComputerUseEventPayload,
  ComputerUseOwnerSnapshot,
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
  cleanupChatActionsAutoOpenStorage,
  cleanupTransientParallelLaunchLanes,
  deriveRuntimeState,
  formatParallelLaunchFailureMessage,
  getChatActionsAutoOpenStorageKey,
  advanceOlderHistoryCursor,
  isMatchingOptimisticUserMessage,
  mergeChatHistorySnapshot,
  mergeOlderChatHistoryPageWithCap,
  parallelLaneModelSuffix,
  prependOlderChatHistoryPage,
  resolveChatHistoryMissAction,
  resolveMergedSnapshotHistoryCursor,
  resolveNextSelectedSessionId,
  resolveRenderedChatSessionId,
  resetChatBootModelRefreshMemoForTests,
  resolveSnapshotHistoryCursor,
  selectAgentChatSessionViewEvictions,
  selectDepartedChatSessionViewCacheSessions,
  shouldCacheAgentChatSessionView,
  shouldPromoteSessionForComputerUse,
  type AgentChatSessionCreatedOptions,
} from "./AgentChatPane";
import {
  DEFAULT_CHAT_COMPANION_UI_STATE,
  chatCompanionUiStorageKey,
  readChatCompanionUiState,
  resetChatCompanionUiStateCacheForTests,
  writeChatCompanionUiState,
} from "./chatCompanionUiState";
import { CHAT_AUTH_RECOVERED_EVENT, CHAT_AUTH_RETRY_REJECTED_EVENT, CHAT_RETRY_AUTH_TURN_EVENT } from "./AgentCliAuthCard";
import { findUserMessageForTurn, isParentUserMessage } from "./chatTurnState";

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
    nextWakeAt: overrides.nextWakeAt ?? null,
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
              id: "anthropic/claude-sonnet-5",
              runtimeModelId: "claude-sonnet-5",
              provider: "claude",
              providerKey: "claude",
              groupKey: "claude",
              displayName: "Claude Sonnet 5",
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

function seedFastOpenCodeRuntimeModelCatalog(): string {
  const modelId = "opencode/openai/gpt-5.4";
  rememberRuntimeCatalog({
    fetchedAt: "2026-05-22T00:00:00.000Z",
    groups: [{
      key: "opencode",
      displayName: "OpenCode",
      providers: [{
        key: "opencode",
        displayName: "OpenCode",
        badgeColor: "#10B981",
        modelCount: 1,
        subsections: [{
          key: "opencode",
          label: "OpenCode",
          models: [{
            id: modelId,
            runtimeModelId: "openai/gpt-5.4",
            provider: "opencode",
            providerKey: "opencode",
            groupKey: "opencode",
            displayName: "GPT 5.4",
            isDefault: true,
            isAvailable: true,
            serviceTiers: ["fast"],
          }],
        }],
      }],
    }],
  } as AgentChatModelCatalog, { mode: "cached" });
  return modelId;
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
  steerResult?: AgentChatSteerResult;
  listError?: Error;
  createError?: Error;
  handoffResult?: { session: AgentChatSession; usedFallbackSummary: boolean } | Promise<{ session: AgentChatSession; usedFallbackSummary: boolean }>;
  handoffError?: Error;
  sessions?: AgentChatSessionSummary[];
  eventHistory?: AgentChatEventHistorySnapshot | ((args: { sessionId: string; maxEvents?: number }) => Promise<AgentChatEventHistorySnapshot> | AgentChatEventHistorySnapshot);
  eventHistoryPage?: (args: { sessionId: string; beforeOffset: number; maxBytes?: number }) => Promise<unknown> | unknown;
  includeClaudeModel?: boolean;
  cursorModels?: Array<{ id: string }>;
  aiStatus?: AiSettingsStatus;
  parallelLaunchState?: AgentChatParallelLaunchState | null;
  linkedPr?: PrSummary | null;
  recoverTurnError?: Error;
}) {
  const send = options?.sendError
    ? vi.fn().mockRejectedValue(options.sendError)
    : vi.fn().mockResolvedValue(undefined);
  const steer = options?.steerError
    ? vi.fn().mockRejectedValue(options.steerError)
    : vi.fn().mockResolvedValue(options?.steerResult ?? { steerId: "steer-default", queued: true });
  const dispatchSteer = vi.fn().mockResolvedValue({ dispatchedAt: Date.now() });
  const cancelSteer = vi.fn().mockResolvedValue(undefined);
  const recoverTurn = options?.recoverTurnError
    ? vi.fn().mockRejectedValue(options.recoverTurnError)
    : vi.fn().mockResolvedValue({
        action: "restart_resume",
        turnId: "turn-1",
        status: "resumed",
      });
  const recoverCodexTurn = vi.fn().mockResolvedValue({
    action: "restart_resume_thread",
    turnId: "turn-1",
    status: "resumed",
  });
  const resolveUnprocessedMessage = vi.fn().mockResolvedValue({
    steerId: "steer-unprocessed",
    action: "run_next",
    status: "completed",
    replacementMessageId: "message-next",
  });
  const list = options?.listError
    ? vi.fn().mockRejectedValue(options.listError)
    : vi.fn().mockResolvedValue(options?.sessions ?? [buildSession("session-1")]);
  const defaultHandoffResult = {
    session: buildCreatedSession("handoff-session-1"),
    usedFallbackSummary: false,
  };
  const handoff = options?.handoffError
    ? vi.fn().mockRejectedValue(options.handoffError)
    : vi.fn().mockImplementation(() => options?.handoffResult ?? Promise.resolve(defaultHandoffResult));
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
  const renameLane = vi.fn().mockResolvedValue(undefined);
  const parallelLaunchStateGet = vi.fn().mockResolvedValue(options?.parallelLaunchState ?? null);
  const parallelLaunchStateSet = vi.fn().mockResolvedValue(undefined);
  const deleteChat = vi.fn().mockResolvedValue(undefined);
  const archive = vi.fn().mockResolvedValue(undefined);
  const unarchive = vi.fn().mockResolvedValue(undefined);
  const getSubagentTranscript = vi.fn().mockResolvedValue([]);
  const setCodexGoal = vi.fn().mockResolvedValue(null);
  const clearCodexGoal = vi.fn().mockResolvedValue(null);
  const setCodexGoalStatus = vi.fn().mockResolvedValue(null);
  const setScheduledWorkPaused = vi.fn().mockImplementation(async (
    args: { paused: boolean },
  ) => ({
    paused: args.paused,
    nextWakeAt: null,
  }));
  const cancelScheduledWork = vi.fn().mockImplementation(async (
    args: { sessionId: string; scheduleId: string },
  ) => ({
    schedule: {
      id: args.scheduleId,
      sessionId: args.sessionId,
      kind: "wakeup",
      status: "cancelled",
      title: "Nightly wake",
      prompt: "continue",
      createdAt: "2026-07-27T18:00:00.000Z",
      durable: true,
      cancellable: true,
    },
    providerCancellationRequested: true,
    providerCancellationConfirmed: true,
  }));
  const deleteLane = vi.fn().mockResolvedValue(undefined);
  const writeClipboardText = vi.fn().mockResolvedValue(undefined);
  const chatEventListeners = new Set<(event: AgentChatEventEnvelope) => void>();
  const sessionChangeListeners = new Set<(event: TerminalSessionChangedEvent) => void>();
  const computerUseEventListeners = new Set<(event: ComputerUseEventPayload) => void>();

  globalThis.window.ade = {
    app: {
      writeClipboardText,
    },
    project: {
      listRecent: vi.fn().mockResolvedValue([]),
    },
    projectConfig: {
      get: vi.fn().mockResolvedValue({
        local: {
          git: {
            newLaneBaseSource: "remote",
          },
        },
        effective: {
          git: {
            autoRebaseOnHeadChange: false,
            newLaneBaseSource: "remote",
          },
          ai: {
            chat: {
              sendOnEnter: true,
            },
          },
        },
      }),
    },
    ai: {
      getStatus: options?.aiStatus
        ? vi.fn().mockResolvedValue(options.aiStatus)
        : vi.fn().mockRejectedValue(new Error("no ai status")),
    },
    agentChat: {
      models: vi.fn().mockImplementation(async ({ provider }: { provider: string }) => {
        if (provider === "codex") return [{ id: "gpt-5.4" }];
        if (provider === "claude") return options?.includeClaudeModel ? [{ id: "anthropic/claude-sonnet-5" }] : [];
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
      ...(options?.eventHistoryPage !== undefined
        ? {
            getEventHistoryPage: vi.fn().mockImplementation(
              async (args: { sessionId: string; beforeOffset: number; maxBytes?: number }) => (
                options.eventHistoryPage!(args)
              ),
            ),
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
      getSubagentTranscript,
      editSteer: vi.fn().mockResolvedValue(undefined),
      cancelSteer,
      dispatchSteer,
      updateSession: vi.fn().mockResolvedValue(undefined),
      archive,
      unarchive,
      interrupt: vi.fn().mockResolvedValue(undefined),
      recoverTurn,
      recoverCodexTurn,
      resolveUnprocessedMessage,
      approve: vi.fn().mockResolvedValue(undefined),
      respondToInput: vi.fn().mockResolvedValue(undefined),
      warmupModel: vi.fn().mockResolvedValue(undefined),
      setScheduledWorkPaused,
      cancelScheduledWork,
      codex: {
        getGoal: vi.fn().mockResolvedValue(null),
        setGoal: setCodexGoal,
        clearGoal: clearCodexGoal,
        setGoalStatus: setCodexGoalStatus,
      },
      fileSearch: vi.fn().mockResolvedValue([]),
      promptStashes: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({
          id: "stash-1",
          text: "saved",
          provider: "codex",
          modelId: "openai/gpt-5.4",
          createdAt: "2026-07-28T12:00:00.000Z",
        }),
        delete: vi.fn().mockResolvedValue(true),
      },
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
      readArtifactPreview: vi.fn().mockResolvedValue(null),
      onEvent: vi.fn().mockImplementation((listener: (event: ComputerUseEventPayload) => void) => {
        computerUseEventListeners.add(listener);
        return () => {
          computerUseEventListeners.delete(listener);
        };
      }),
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
      rename: renameLane,
    },
    git: {
      fetch: vi.fn().mockResolvedValue(undefined),
      listBranches: vi.fn().mockResolvedValue([
        { name: "main", isRemote: false, isCurrent: true, upstream: "origin/main" },
      ]),
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
    dispatchSteer,
    cancelSteer,
    recoverTurn,
    recoverCodexTurn,
    resolveUnprocessedMessage,
    list,
    create,
    createLane,
    deleteChat,
    archive,
    unarchive,
    getSubagentTranscript,
    setCodexGoal,
    clearCodexGoal,
    setCodexGoalStatus,
    setScheduledWorkPaused,
    cancelScheduledWork,
    deleteLane,
    suggestLaneName,
    renameLane,
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
    emitComputerUseEvent: (event: ComputerUseEventPayload) => {
      for (const listener of computerUseEventListeners) {
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
    handoffLaunchJobsByScope: {},
    openProjectTabRoots: [],
    openRemoteProjectTabs: [],
    crossMachineLanesByMachineId: {},
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

function createWindowStorageShim(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, String(value));
    }),
  };
}

function installStorageMocks(): void {
  if (!window.localStorage) {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createWindowStorageShim(),
    });
  }
  if (!window.sessionStorage) {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: createWindowStorageShim(),
    });
  }
}

beforeEach(() => {
  installMatchMediaMock();
  installStorageMocks();
  invalidateAgentChatSessionListCache();
  invalidateAgentChatSlashCommandsCache();
  invalidateAiDiscoveryCache();
  invalidateProjectConfigCache();
  resetModelPickerRuntimeCatalogForTests();
  resetChatBootModelRefreshMemoForTests();
  resetChatCompanionUiStateCacheForTests();
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
  workDraftKind?: "chat" | "cli";
  orchestratorEnabled?: boolean;
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
                orchestratorEnabled={args?.orchestratorEnabled}
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
  workDraftKind?: "work-start" | "chat" | "cli";
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
  workDraftKind?: "work-start";
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
    expect(screen.getByText("No proof collected yet")).toBeTruthy();

    // Chat actions is an info pane: it floats over the right gutter created by
    // the centered transcript, so it does NOT get a resizable split divider.
    expect(screen.queryByRole("separator")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close chat actions drawer" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open chat actions drawer" })).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Close chat actions drawer" })).toBeNull();
  });

  it("removes deleted proof from the open drawer when the event no longer has an owner", async () => {
    const session = buildSession("session-1", { title: "Proof event chat" });
    const proof: ComputerUseArtifactView = {
      id: "proof-deleted",
      kind: "screenshot",
      backendStyle: "local_fallback",
      backendName: "ADE",
      sourceToolName: "capture",
      originalType: "image",
      title: "Proof to delete",
      description: null,
      uri: ".ade/artifacts/proof-deleted.png",
      storageKind: "file",
      mimeType: "image/png",
      metadata: {},
      createdAt: "2026-07-28T12:00:00.000Z",
      links: [],
      reviewState: "pending",
      workflowState: "evidence_only",
      reviewNote: null,
      availability: "available",
    };
    const mocks = installAdeMocks({ sessions: [session] });
    const populatedSnapshot: ComputerUseOwnerSnapshot = {
        owner: { kind: "chat_session", id: session.sessionId },
        backendStatus: {
          backends: [],
          localFallback: { available: true, detail: "Available", supportedKinds: ["screenshot"] },
        },
        summary: "1 proof item",
        activeBackend: null,
        artifacts: [proof],
        recentArtifacts: [proof],
        activity: [],
      };
    vi.mocked(window.ade.computerUse.getOwnerSnapshot)
      .mockResolvedValueOnce(populatedSnapshot)
      .mockResolvedValue({
        owner: { kind: "chat_session", id: session.sessionId },
        backendStatus: {
          backends: [],
          localFallback: { available: true, detail: "Available", supportedKinds: ["screenshot"] },
        },
        summary: "No proof",
        activeBackend: null,
        artifacts: [],
        recentArtifacts: [],
        activity: [],
      });
    seedDrawerStore();
    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Proof" }));
    expect(await screen.findByText("Proof to delete")).toBeTruthy();

    act(() => {
      mocks.emitComputerUseEvent({
        type: "artifact-deleted",
        artifactId: proof.id,
        at: "2026-07-28T12:01:00.000Z",
        owner: null,
      });
    });

    await waitFor(() => expect(screen.queryByText("Proof to delete")).toBeNull());
    expect(await screen.findByText("No proof collected yet")).toBeTruthy();
    expect(window.ade.computerUse.getOwnerSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not reopen chat actions after tasks arrive while the Agents tab is already open", async () => {
    const session = buildSession("session-1");
    const { emitChatEvent } = installAdeMocks({ sessions: [session] });
    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));

    act(() => {
      emitChatEvent({
        sessionId: session.sessionId,
        timestamp: "2026-03-24T06:00:00.000Z",
        sequence: 1,
        event: {
          type: "todo_update",
          items: [
            { id: "task-1", description: "Inspect Claude task events", status: "in_progress" },
          ],
        },
      } as AgentChatEventEnvelope);
    });

    expect((await screen.findAllByText("Inspect Claude task events")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(window.localStorage.getItem(getChatActionsAutoOpenStorageKey(session.sessionId))).toContain("firedAt");
    });

    fireEvent.click(screen.getByRole("button", { name: "Close chat actions drawer" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open chat actions drawer" })).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Close chat actions drawer" })).toBeNull();
  });

  it("refetches selected envelope history after a repair invalidation signal", async () => {
    const session = buildSession("session-repaired", { status: "idle" });
    const { emitChatEvent } = installAdeMocks({
      sessions: [session],
      eventHistory: {
        sessionId: session.sessionId,
        events: [],
        truncated: false,
        sessionFound: true,
      },
    });
    const getEventHistory = window.ade.agentChat.getEventHistory as ReturnType<typeof vi.fn>;
    renderPane(session);

    await waitFor(() => expect(getEventHistory.mock.calls.length).toBeGreaterThan(0));
    const callsBeforeInvalidation = getEventHistory.mock.calls.length;
    act(() => {
      emitChatEvent({
        sessionId: session.sessionId,
        timestamp: "2026-07-10T12:00:00.000Z",
        event: { type: "session_meta_updated", historyInvalidated: true },
      });
    });

    await waitFor(() => expect(getEventHistory.mock.calls.length).toBeGreaterThan(callsBeforeInvalidation));
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

  it("renders a persistent identity chat view without the legacy clear-view control", async () => {
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
    expect(screen.queryByRole("button", { name: "Clear view" })).toBeNull();
  });
});

describe("AgentChatPane durable recovery actions", () => {
  it("appends an unprocessed message for editing without replacing the current draft", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const transcript = `${JSON.stringify({
      sessionId: session.sessionId,
      timestamp: "2026-07-25T05:20:00.000Z",
      event: {
        type: "user_message",
        text: "Original backend prompt.",
        displayText: "Edit this follow-up.",
        steerId: "steer-unprocessed",
        deliveryState: "unprocessed",
        processed: false,
        turnId: "turn-1",
      },
    })}\n`;
    const { resolveUnprocessedMessage } = installAdeMocks({
      sessions: [session],
      transcript,
    });

    renderPane(session);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this draft." } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Keep this draft.\n\nEdit this follow-up.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Run next" }));
    await waitFor(() => {
      expect(resolveUnprocessedMessage).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        steerId: "steer-unprocessed",
        action: "run_next",
      });
    });
  });

  it("dismisses an unprocessed message durably", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const transcript = `${JSON.stringify({
      sessionId: session.sessionId,
      timestamp: "2026-07-25T05:20:00.000Z",
      event: {
        type: "user_message",
        text: "Dismiss this follow-up.",
        steerId: "steer-unprocessed",
        deliveryState: "unprocessed",
        processed: false,
        turnId: "turn-1",
      },
    })}\n`;
    const { resolveUnprocessedMessage } = installAdeMocks({
      sessions: [session],
      transcript,
    });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => {
      expect(resolveUnprocessedMessage).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        steerId: "steer-unprocessed",
        action: "dismiss",
      });
    });
  });

  it("prefers provider-neutral recovery and falls back for older hosts", async () => {
    const session = buildSession("session-1", { status: "active" });
    const transcript = `${JSON.stringify({
      sessionId: session.sessionId,
      timestamp: "2026-07-25T05:20:00.000Z",
      event: {
        type: "turn_health",
        provider: "codex",
        turnId: "turn-1",
        state: "stalled",
        reason: "no_output",
        message: "Codex accepted the turn but has not streamed output.",
        turnStartedAt: "2026-07-25T05:18:00.000Z",
        lastProgressAt: "2026-07-25T05:18:00.000Z",
        detectedAt: "2026-07-25T05:20:00.000Z",
        recoveryCount: 0,
        supportedActions: ["restart_resume"],
        automaticRecoveryAttempted: false,
      },
    })}\n`;
    const { recoverTurn, recoverCodexTurn } = installAdeMocks({
      sessions: [session],
      transcript,
      recoverTurnError: new Error("Action not supported by runtime"),
    });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Restart & resume" }));
    await waitFor(() => {
      expect(recoverTurn).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        turnId: "turn-1",
        action: "restart_resume",
      });
      expect(recoverCodexTurn).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        turnId: "turn-1",
        action: "restart_resume_thread",
      });
    });
  });

  it("does not hide a chat-service outage behind the legacy recovery fallback", async () => {
    const session = buildSession("session-1", { status: "active" });
    const transcript = `${JSON.stringify({
      sessionId: session.sessionId,
      timestamp: "2026-07-25T05:20:00.000Z",
      event: {
        type: "turn_health",
        provider: "codex",
        turnId: "turn-1",
        state: "stalled",
        reason: "no_output",
        message: "Codex accepted the turn but has not streamed output.",
        turnStartedAt: "2026-07-25T05:18:00.000Z",
        lastProgressAt: "2026-07-25T05:18:00.000Z",
        detectedAt: "2026-07-25T05:20:00.000Z",
        recoveryCount: 0,
        supportedActions: ["restart_resume"],
        automaticRecoveryAttempted: false,
      },
    })}\n`;
    const { recoverTurn, recoverCodexTurn } = installAdeMocks({
      sessions: [session],
      transcript,
      recoverTurnError: new Error("Agent chat service not available."),
    });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Restart & resume" }));
    await waitFor(() => {
      expect(recoverTurn).toHaveBeenCalledOnce();
      expect(recoverCodexTurn).not.toHaveBeenCalled();
    });
  });
});

describe("AgentChatPane submit recovery", () => {
  it("resends the latest user message for the selected session after auth retry", async () => {
    const session = buildSession("session-1", {
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
      status: "idle",
    });
    const transcript = [
      {
        sessionId: session.sessionId,
        timestamp: "2026-03-24T05:57:45.700Z",
        event: {
          type: "user_message",
          text: "First prompt",
          turnId: "turn-1",
        },
      },
      {
        sessionId: session.sessionId,
        timestamp: "2026-03-24T05:57:46.700Z",
        event: {
          type: "text",
          text: "First answer",
          turnId: "turn-1",
        },
      },
      {
        sessionId: session.sessionId,
        timestamp: "2026-03-24T05:57:47.700Z",
        event: {
          type: "user_message",
          text: "Retry this exact prompt\n\nUse docs/auth.md and the selected plan note.",
          displayText: "Retry this exact prompt",
          attachments: [{ path: "docs/auth.md", type: "file" }],
          contextAttachments: [{
            type: "orchestration_annotation",
            item: {
              type: "orchestration_annotation",
              runId: "run-auth",
              anchor: { kind: "plan_step", id: "step-auth", preview: "login recovery" },
              selectionExcerpt: "login recovery",
              comment: "Use this selected plan note.",
              capturedAt: "2026-03-24T05:57:47.500Z",
            },
          }],
          metadata: { source: "auth-retry-test" },
          turnId: "turn-2",
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    const { send } = installAdeMocks({
      sessions: [session],
      transcript,
      includeClaudeModel: true,
    });
    const getStatus = vi.fn().mockResolvedValue({
      mode: "subscription",
      availableProviders: {
        claude: {
          binary: { present: true, source: "path", path: "/usr/local/bin/claude" },
          auth: { ready: true, mode: "subscription", detail: null },
        },
        codex: true,
        cursor: false,
        droid: false,
      },
      models: { claude: [], codex: [], cursor: [], droid: [] },
      features: [],
      detectedAuth: [
        { type: "cli-subscription", cli: "claude", authenticated: true },
      ],
      availableModelIds: ["anthropic/claude-sonnet-5"],
    });
    window.ade.ai.getStatus = getStatus as any;
    seedDrawerStore();

    renderPane(session);

    expect(await screen.findByText("Retry this exact prompt")).toBeTruthy();
    await waitFor(() => {
      expect(getStatus).toHaveBeenCalled();
    });
    getStatus.mockClear();
    send.mockImplementationOnce(async () => {
      expect(getStatus).toHaveBeenCalledWith({
        force: true,
        refreshOpenCodeInventory: false,
      });
    });

    fireEvent(window, new CustomEvent(CHAT_RETRY_AUTH_TURN_EVENT, {
      detail: { sessionId: session.sessionId },
    }));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        text: "Retry this exact prompt\n\nUse docs/auth.md and the selected plan note.",
        displayText: "Retry this exact prompt",
        attachments: [{ path: "docs/auth.md", type: "file" }],
        contextAttachments: [{
          type: "orchestration_annotation",
          item: {
            type: "orchestration_annotation",
            runId: "run-auth",
            anchor: { kind: "plan_step", id: "step-auth", preview: "login recovery" },
            selectionExcerpt: "login recovery",
            comment: "Use this selected plan note.",
            capturedAt: "2026-03-24T05:57:47.500Z",
          },
        }],
        metadata: { source: "auth-retry-test" },
      });
    });
  });

  it("rejects the auth retry when a turn becomes active before resend", async () => {
    const session = buildSession("session-1", {
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
      status: "idle",
    });
    const transcript = `${JSON.stringify({
      sessionId: session.sessionId,
      timestamp: "2026-03-24T05:57:47.700Z",
      event: {
        type: "user_message",
        text: "Retry into active turn",
        displayText: "Retry into active turn",
        attachments: [{ path: "docs/race.md", type: "file" }],
        contextAttachments: [{
          type: "orchestration_annotation",
          item: {
            type: "orchestration_annotation",
            runId: "run-race",
            anchor: { kind: "plan_step", id: "step-race", preview: "active turn fallback" },
            selectionExcerpt: "active turn fallback",
            comment: "Retry with this fallback context.",
            capturedAt: "2026-03-24T05:57:47.500Z",
          },
        }],
        metadata: { source: "auth-retry-steer-test" },
        turnId: "turn-2",
      },
    })}\n`;
    const { send, steer } = installAdeMocks({
      sessions: [session],
      transcript,
      includeClaudeModel: true,
    });
    send.mockRejectedValueOnce(new Error("turn is already active"));
    seedDrawerStore();
    const rejectedEvents: Array<CustomEvent<{ sessionId?: string }>> = [];
    const onRejected = (event: Event) => {
      rejectedEvents.push(event as CustomEvent<{ sessionId?: string }>);
    };
    window.addEventListener(CHAT_AUTH_RETRY_REJECTED_EVENT, onRejected);

    renderPane(session);

    try {
      expect(await screen.findByText("Retry into active turn")).toBeTruthy();

      fireEvent(window, new CustomEvent(CHAT_RETRY_AUTH_TURN_EVENT, {
        detail: { sessionId: session.sessionId },
      }));

      await waitFor(() => {
        expect(rejectedEvents).toHaveLength(1);
      });
      expect(rejectedEvents[0]?.detail).toEqual({ sessionId: session.sessionId });
      expect(steer).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(CHAT_AUTH_RETRY_REJECTED_EVENT, onRejected);
    }
  });

  it("dispatches auth recovery once after a later successful turn", async () => {
    const session = buildSession("session-1", {
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
      status: "idle",
    });
    const transcript = [
      {
        sessionId: session.sessionId,
        timestamp: "2026-03-24T05:57:45.700Z",
        event: {
          type: "error",
          message: "Authentication failed for Claude Sonnet 5.",
          turnId: "turn-1",
          errorInfo: {
            category: "agent_cli_auth",
            agentCli: {
              agent: "claude",
              displayName: "Claude Code",
              category: "unauthenticated",
              installCommand: "npm install -g @anthropic-ai/claude-code",
              authCommand: "claude auth login",
            },
          },
        },
      },
      {
        sessionId: session.sessionId,
        timestamp: "2026-03-24T05:57:46.700Z",
        event: {
          type: "done",
          status: "completed",
          turnId: "turn-2",
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    const recoverySpy = vi.fn();
    window.addEventListener(CHAT_AUTH_RECOVERED_EVENT, recoverySpy);
    try {
      installAdeMocks({
        sessions: [session],
        transcript,
        includeClaudeModel: true,
      });
      seedDrawerStore();

      renderPane(session);

      await waitFor(() => {
        expect(recoverySpy).toHaveBeenCalledTimes(1);
      });
      const event = recoverySpy.mock.calls[0][0] as CustomEvent<{ sessionId?: string }>;
      expect(event.detail.sessionId).toBe(session.sessionId);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(recoverySpy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(CHAT_AUTH_RECOVERED_EVENT, recoverySpy);
    }
  });

  it("uses the model override as the constrained draft picker list", async () => {
    installAdeMocks({ sessions: [] });
    seedRuntimeModelCatalog();

    renderParallelDraftPane({
      availableModelIdsOverride: ["anthropic/claude-sonnet-5"],
    });

    expect(await screen.findByText("Start a new conversation")).toBeTruthy();
    const includedModelLabel = getModelById("anthropic/claude-sonnet-5")?.displayName ?? "Claude Sonnet 5";
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
          availableModelIdsOverride={["anthropic/claude-sonnet-5"]}
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
      fastMode: true,
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
    expect(screen.getByRole("button", { name: "Codex permission mode" }).textContent).toContain("Full");

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Launch with the restored config." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        modelId: "openai/gpt-5.4",
        reasoningEffort: "xhigh",
        fastMode: true,
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
      fastMode: true,
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
      fastMode: false,
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

    const approvalButton = await screen.findByRole("button", { name: "Codex permission mode" });
    await waitFor(() => {
      expect(approvalButton.textContent).toContain("Full");
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
        fastMode: true,
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
      fastMode: false,
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
    const claudeLabel = getModelById("anthropic/claude-sonnet-5")?.displayName ?? "Claude Sonnet 5";
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
        modelId: "anthropic/claude-sonnet-5",
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
      availableModelIdsOverride: ["anthropic/claude-sonnet-5"],
    });

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(/Claude Sonnet 5/i);

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

  it("reveals chat terminals without a header terminal shortcut when Work hides lane tool drawers", async () => {
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
    expect(screen.queryByRole("button", { name: /(Open|Close) terminal/i })).toBeNull();
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
        displayText: "Stop checking docs and just drive the browser.",
      });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("sends a running-turn Claude draft atomically with inline delivery", async () => {
    const session = buildSession("session-1", {
      provider: "claude",
      model: "anthropic/claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });
    const { steer, dispatchSteer } = installAdeMocks({
      sessions: [session],
      transcript: buildStatusStartedTranscript(session.sessionId),
      includeClaudeModel: true,
      steerResult: { steerId: "steer-live", queued: false },
    });

    renderPane(session);

    const textbox = await screen.findByPlaceholderText("Steer the active turn...");
    fireEvent.change(textbox, { target: { value: "Fold this into the live turn." } });
    fireEvent.click(screen.getByRole("button", { name: "Send during turn" }));

    await waitFor(() => {
      expect(steer).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.sessionId,
          text: "Fold this into the live turn.",
          displayText: "Fold this into the live turn.",
          dispatchMode: "inline",
        }),
      );
    });
    expect(dispatchSteer).not.toHaveBeenCalled();
  });

  it("restores queued Edit content only to the chat that owned it", async () => {
    const session = buildSession("session-1", {
      provider: "claude",
      model: "anthropic/claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
      title: "Primary Claude chat",
    });
    const otherSession = buildSession("session-2", {
      provider: "claude",
      model: "anthropic/claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
      title: "Other Claude chat",
    });
    const { cancelSteer, emitChatEvent } = installAdeMocks({
      sessions: [session, otherSession],
      transcript: buildStatusStartedTranscript(session.sessionId),
      includeClaudeModel: true,
    });
    let resolveCancel!: () => void;
    const cancelPromise = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    cancelSteer.mockImplementationOnce(() => cancelPromise);

    renderTabbedPane(session);
    await screen.findByPlaceholderText("Steer the active turn...");
    const primaryTab = await screen.findByRole("button", { name: /Primary Claude chat/i });
    const otherTab = await screen.findByRole("button", { name: /Other Claude chat/i });

    act(() => {
      emitChatEvent({
        sessionId: session.sessionId,
        timestamp: "2026-03-24T05:57:46.000Z",
        event: {
          type: "user_message",
          steerId: "steer-edit",
          deliveryState: "queued",
          text: "[injected context]\n\nRevise this queued instruction.",
          displayText: "Revise this queued instruction.",
          attachments: [{ path: "docs/queued.md", type: "file" }],
        },
      });
    });

    expect(await screen.findByText("Revise this queued instruction.")).toBeTruthy();
    expect(screen.queryByText(/injected context/)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Edit queued message" }));
    fireEvent.click(otherTab);

    await waitFor(() => {
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    });

    await act(async () => {
      resolveCancel();
      await cancelPromise;
    });

    await waitFor(() => {
      expect(cancelSteer).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        steerId: "steer-edit",
        requireQueued: true,
      });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
      expect(screen.queryByText("queued.md")).toBeNull();
    });

    fireEvent.click(primaryTab);
    await waitFor(() => {
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Revise this queued instruction.");
      expect(screen.getByText("queued.md")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Edit queued message" })).toBeNull();
    });
  });

  it("selects Interrupt & send, then sends it atomically", async () => {
    const session = buildSession("session-1", {
      provider: "claude",
      model: "anthropic/claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });
    const { steer, dispatchSteer } = installAdeMocks({
      sessions: [session],
      transcript: buildStatusStartedTranscript(session.sessionId),
      includeClaudeModel: true,
      steerResult: { steerId: "steer-replace", queued: false },
    });

    renderPane(session);

    const textbox = await screen.findByPlaceholderText("Steer the active turn...");
    fireEvent.change(textbox, { target: { value: "Actually, do this instead." } });
    fireEvent.click(screen.getByRole("button", { name: "More send options" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Interrupt & send/i }));
    expect(steer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Interrupt & send" }));

    await waitFor(() => {
      expect(steer).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.sessionId,
          text: "Actually, do this instead.",
          displayText: "Actually, do this instead.",
          dispatchMode: "interrupt",
        }),
      );
    });
    expect(dispatchSteer).not.toHaveBeenCalled();
  });

  it("restores the draft and surfaces a notice when the steer queue is full", async () => {
    const session = buildSession("session-1", {
      provider: "claude",
      model: "anthropic/claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });
    const { steer, dispatchSteer } = installAdeMocks({
      sessions: [session],
      transcript: buildStatusStartedTranscript(session.sessionId),
      includeClaudeModel: true,
      steerResult: { steerId: "steer-dropped", queued: false, reason: "queue_full" },
    });

    renderPane(session);

    const textbox = (await screen.findByPlaceholderText("Steer the active turn...")) as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: "This one should bounce." } });
    fireEvent.click(screen.getByRole("button", { name: "Send during turn" }));

    await waitFor(() => {
      expect(steer).toHaveBeenCalledTimes(1);
    });

    // The message was rejected: no dispatch, the draft is kept (not cleared as if
    // it sent), and a brief inline notice explains why.
    await waitFor(() => {
      expect(screen.getByText(/the queue is full/i)).toBeTruthy();
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("This one should bounce.");
    expect(dispatchSteer).not.toHaveBeenCalled();
  });

  it("restores the draft on a stale-turn-active race when the fallback steer is queue-full", async () => {
    // Regression: local state thinks the turn is idle (normal Send), but the
    // backend turn is actually active — send() rejects turn-already-active and
    // the pane falls back to steer. If that fallback steer is dropped
    // (queue_full), its result must still flow through the restore/notice path
    // instead of being lost (which cleared the draft as if it had sent).
    const session = buildSession("session-1", {
      provider: "claude",
      model: "anthropic/claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
      status: "idle",
      awaitingInput: false,
    });
    const { send, steer } = installAdeMocks({
      sessions: [session],
      includeClaudeModel: true,
      sendError: new Error("turn is already active"),
      steerResult: { steerId: "steer-dropped", queued: false, reason: "queue_full" },
    });

    renderPane(session);

    const textbox = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: "Bounce me on the race." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(send).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(steer).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText(/the queue is full/i)).toBeTruthy();
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Bounce me on the race.");
  });

  it("keeps active-turn controls when hydrated history starts after the turn-start marker", async () => {
    const session = buildSession("session-1", { status: "active", awaitingInput: false });
    installAdeMocks({
      sessions: [session],
      eventHistory: {
        sessionId: session.sessionId,
        events: [{
          sessionId: session.sessionId,
          timestamp: "2026-03-24T05:57:46.000Z",
          event: {
            type: "text",
            text: "Still packaging the release.",
            turnId: "turn-1",
          },
        }],
        truncated: true,
        windowTruncated: true,
        sessionFound: true,
      },
    });

    renderPane(session);

    expect(await screen.findByText("Still packaging the release.")).toBeTruthy();
    expect(screen.getByPlaceholderText("Steer the active turn...")).toBeTruthy();
    expect(screen.getByLabelText("Stop active turn")).toBeTruthy();
  });

  it("lets terminal history beat a stale active summary and send the next message", async () => {
    const session = buildSession("session-1", { status: "active", awaitingInput: false });
    const terminalEvents: AgentChatEventEnvelope[] = [
      {
        sessionId: session.sessionId,
        timestamp: "2026-07-10T18:18:52.000Z",
        sequence: 1,
        // ADE persists Codex user input before turn/started supplies the
        // provider turn id. Recovery must associate this by turn boundaries.
        event: { type: "user_message", text: "Keep shipping the fix." },
      },
      ...[2, 3].map((sequence) => ({
        sessionId: session.sessionId,
        timestamp: "2026-07-10T18:18:53.000Z",
        sequence,
        event: {
          type: "error" as const,
          message: "Selected model is at capacity. Please try a different model.",
          turnId: "turn-capacity",
          errorInfo: "serverOverloaded",
        },
      })),
      {
        sessionId: session.sessionId,
        timestamp: "2026-07-10T18:18:53.050Z",
        sequence: 4,
        event: {
          type: "status",
          turnStatus: "failed",
          turnId: "turn-capacity",
          message: "Selected model is at capacity. Please try a different model.",
        },
      },
      {
        sessionId: session.sessionId,
        timestamp: "2026-07-10T18:18:53.066Z",
        sequence: 5,
        event: { type: "done", status: "failed", turnId: "turn-capacity", model: "gpt-5.4" },
      },
    ];
    const { emitChatEvent, send } = installAdeMocks({
      sessions: [session],
      eventHistory: {
        sessionId: session.sessionId,
        events: terminalEvents,
        truncated: false,
        sessionFound: true,
      },
    });

    renderPane(session);

    expect(await screen.findByText("Provider capacity")).toBeTruthy();
    expect(screen.getAllByText("Error")).toHaveLength(1);
    expect(screen.getByText("Selected model is at capacity. Please try a different model.")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Steer the active turn...")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();

    const modelTrigger = screen.getByRole("button", { name: /^Select model/ });
    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    await waitFor(() => expect(modelTrigger.getAttribute("aria-expanded")).toBe("true"));
    fireEvent.click(modelTrigger);

    const retryButton = screen.getByRole("button", { name: "Retry turn" }) as HTMLButtonElement;
    const chooseModelButton = screen.getByRole("button", { name: "Choose model" }) as HTMLButtonElement;
    act(() => {
      emitChatEvent({
        sessionId: session.sessionId,
        timestamp: "2026-07-10T18:18:54.000Z",
        sequence: 6,
        event: { type: "status", turnStatus: "started", turnId: "turn-next" },
      });
    });
    await waitFor(() => {
      expect(retryButton.disabled).toBe(true);
      expect(chooseModelButton.disabled).toBe(true);
    });
    fireEvent.click(retryButton);
    expect(send).not.toHaveBeenCalled();

    act(() => {
      emitChatEvent({
        sessionId: session.sessionId,
        timestamp: "2026-07-10T18:18:55.000Z",
        sequence: 7,
        event: { type: "status", turnStatus: "completed", turnId: "turn-next" },
      });
      emitChatEvent({
        sessionId: session.sessionId,
        timestamp: "2026-07-10T18:18:55.001Z",
        sequence: 8,
        event: { type: "done", status: "completed", turnId: "turn-next", model: "gpt-5.4" },
      });
    });
    await waitFor(() => {
      expect(retryButton.disabled).toBe(false);
      expect(chooseModelButton.disabled).toBe(false);
    });

    fireEvent.click(retryButton);
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Keep shipping the fix.",
      }));
    });
    send.mockClear();

    // A later non-terminal live event must use the same invariant as snapshot
    // hydration and cannot revive the already-failed turn from the stale summary.
    act(() => {
      emitChatEvent({
        sessionId: session.sessionId,
        timestamp: "2026-07-10T18:18:56.000Z",
        sequence: 9,
        event: { type: "system_notice", noticeKind: "info", message: "Session metadata refreshed." },
      });
    });
    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Steer the active turn...")).toBeNull();
    });

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Continue in a new turn." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Continue in a new turn.",
      }));
    });
  });

  it("skips steer messages during provider-failure retry and surfaces a rejected resend", async () => {
    const session = buildSession("session-1", { status: "idle", awaitingInput: false });
    const { send } = installAdeMocks({
      sessions: [session],
      sendError: new Error("turn is already active"),
      eventHistory: {
        sessionId: session.sessionId,
        truncated: false,
        sessionFound: true,
        events: [
          {
            sessionId: session.sessionId,
            timestamp: "2026-07-10T18:18:52.000Z",
            sequence: 1,
            event: { type: "user_message", text: "Retry the original prompt." },
          },
          {
            sessionId: session.sessionId,
            timestamp: "2026-07-10T18:18:52.500Z",
            sequence: 2,
            event: { type: "user_message", text: "Do not resend this steer.", steerId: "steer-1" },
          },
          {
            sessionId: session.sessionId,
            timestamp: "2026-07-10T18:18:53.000Z",
            sequence: 3,
            event: {
              type: "error",
              message: "Selected model is at capacity. Please try a different model.",
              errorInfo: "serverOverloaded",
            },
          },
          {
            sessionId: session.sessionId,
            timestamp: "2026-07-10T18:18:53.050Z",
            sequence: 4,
            event: { type: "status", turnStatus: "failed", turnId: "turn-capacity" },
          },
          {
            sessionId: session.sessionId,
            timestamp: "2026-07-10T18:18:53.066Z",
            sequence: 5,
            event: { type: "done", status: "failed", turnId: "turn-capacity", model: "gpt-5.4" },
          },
        ],
      },
    });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Retry turn" }));
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        text: "Retry the original prompt.",
      }));
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "A turn is already active in this thread. Wait for it to finish before retrying.",
    );
  });

  it("does not carry a pending provider-failure model request into another session", async () => {
    const failedSession = buildSession("session-failed", { status: "idle", awaitingInput: false });
    const nextSession = buildSession("session-next", { status: "idle", awaitingInput: false });
    installAdeMocks({
      sessions: [failedSession, nextSession],
      eventHistory: ({ sessionId }) => ({
        sessionId,
        truncated: false,
        sessionFound: true,
        events: sessionId === failedSession.sessionId
          ? [
            {
              sessionId,
              timestamp: "2026-07-10T18:18:53.000Z",
              sequence: 1,
              event: {
                type: "error",
                message: "Selected model is at capacity. Please try a different model.",
                turnId: "turn-capacity",
                errorInfo: "serverOverloaded",
              },
            },
            {
              sessionId,
              timestamp: "2026-07-10T18:18:53.066Z",
              sequence: 2,
              event: { type: "done", status: "failed", turnId: "turn-capacity", model: "gpt-5.4" },
            },
          ]
          : [],
      }),
    });

    const view = render(
      <MemoryRouter>
        <AgentChatPane
          laneId={failedSession.laneId}
          lockSessionId={failedSession.sessionId}
          hideSessionTabs
          initialSessionSummary={failedSession}
          modelSelectionLocked
        />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Choose model" }));
    expect(screen.getByRole("button", { name: /^Select model/ }).getAttribute("aria-expanded")).toBe("false");

    view.rerender(
      <MemoryRouter>
        <AgentChatPane
          laneId={nextSession.laneId}
          lockSessionId={nextSession.sessionId}
          hideSessionTabs
          initialSessionSummary={nextSession}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Select model/ }).getAttribute("aria-expanded")).toBe("false");
    });
  });

  it.each([
    ["claude", "claude-sonnet-5", "anthropic/claude-sonnet-5"],
    ["cursor", "composer", "cursor/composer"],
    ["droid", "claude-sonnet-4-5", "droid/claude-sonnet-4-5"],
    ["opencode", "gpt-5.4-mini", "opencode/openai/gpt-5.4-mini"],
  ] as const)("keeps %s idle when terminal transcript evidence conflicts with an active summary", async (provider, model, modelId) => {
    const session = buildSession(`session-${provider}`, {
      provider,
      model,
      modelId,
      status: "active",
      awaitingInput: false,
    });
    installAdeMocks({
      sessions: [session],
      includeClaudeModel: true,
      cursorModels: [{ id: "composer" }],
      eventHistory: {
        sessionId: session.sessionId,
        truncated: false,
        sessionFound: true,
        events: [
          {
            sessionId: session.sessionId,
            timestamp: "2026-07-10T18:18:53.050Z",
            sequence: 1,
            event: { type: "status", turnStatus: "failed", turnId: `turn-${provider}`, message: "Provider failed." },
          },
          {
            sessionId: session.sessionId,
            timestamp: "2026-07-10T18:18:53.066Z",
            sequence: 2,
            event: { type: "done", status: "failed", turnId: `turn-${provider}`, model },
          },
        ],
      },
    });

    renderPane(session);

    expect(await screen.findByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("Steer the active turn...")).toBeNull();
    expect(screen.queryByLabelText("Stop active turn")).toBeNull();
  });

  it("stops active-turn controls immediately when a terminal event streams", async () => {
    const session = buildSession("session-1", { status: "active", awaitingInput: false });
    const { emitChatEvent } = installAdeMocks({
      sessions: [session],
      transcript: buildStatusStartedTranscript(session.sessionId),
    });

    renderPane(session);

    expect(await screen.findByPlaceholderText("Steer the active turn...")).toBeTruthy();

    act(() => {
      emitChatEvent({
        sessionId: session.sessionId,
        timestamp: "2026-03-24T05:58:00.000Z",
        sequence: 2,
        event: {
          type: "done",
          turnId: "turn-1",
          status: "completed",
          model: "gpt-5.4",
          modelId: "openai/gpt-5.4",
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Steer the active turn...")).toBeNull();
      expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    });

    // The terminal event schedules a locked-session summary refresh. Its stale
    // active snapshot must not revive the turn after that refresh lands.
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(screen.queryByPlaceholderText("Steer the active turn...")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
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
        displayText: "Recover by starting a new turn.",
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
        displayText: "Please keep going.",
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
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
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

    fireEvent.click(await screen.findByRole("button", { name: "Codex permission mode" }));
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
      fastMode: false,
    });
    const sessions = [session];
    const resolveUpdates: Array<() => void> = [];
    const updateSession = vi.fn().mockImplementation((args: any) => new Promise((resolve) => {
      resolveUpdates.push(() => {
        sessions[0] = {
          ...sessions[0]!,
          fastMode: args.fastMode ?? sessions[0]!.fastMode,
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
        fastMode: true,
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
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
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

  it("resyncs model tuning controls when a returned chat finishes hydrating", async () => {
    const session = buildSession("session-1", {
      status: "idle",
      reasoningEffort: "medium",
      fastMode: false,
      executionMode: "focused",
    });
    const sessions = [session];
    const { emitChatEvent } = installAdeMocks({ sessions });

    renderPane(session);

    const fastModeButton = await screen.findByRole("button", { name: "Fast mode" });
    expect(fastModeButton.getAttribute("aria-pressed")).toBe("false");

    sessions[0] = {
      ...session,
      reasoningEffort: "xhigh",
      fastMode: true,
      executionMode: "teams",
    };
    emitChatEvent({
      sessionId: session.sessionId,
      timestamp: "2026-03-24T07:15:00.000Z",
      event: {
        type: "done",
        status: "completed",
        turnId: "turn-hydrated",
        model: "gpt-5.4",
      },
    });

    await waitFor(() => {
      expect(fastModeButton.getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByLabelText("Reasoning effort").textContent).toContain("XH");
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
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
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

  it("shows the Claude login prompt when the loaded chat history contains auth notices", async () => {
    const session = buildSession("session-1", {
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
      status: "idle",
    });
    installAdeMocks({
      sessions: [session],
      includeClaudeModel: true,
      eventHistory: {
        sessionId: session.sessionId,
        sessionFound: true,
        truncated: false,
        events: [
          {
            sessionId: session.sessionId,
            timestamp: "2026-06-22T12:00:00.000Z",
            sequence: 1,
            event: { type: "user_message", text: "hello" },
          },
          {
            sessionId: session.sessionId,
            timestamp: "2026-06-22T12:00:01.000Z",
            sequence: 2,
            event: {
              type: "system_notice",
              noticeKind: "warning",
              severity: "info",
              status: "authentication_failed",
              message: "Claude API retry 2/10: authentication failed",
              detail: "HTTP 401",
            },
          },
          {
            sessionId: session.sessionId,
            timestamp: "2026-06-22T12:00:03.000Z",
            sequence: 3,
            event: { type: "done", turnId: "turn-1", status: "failed" },
          },
        ],
      },
    });

    renderPane(session);

    expect(await screen.findByRole("button", { name: "Login to Claude" })).toBeTruthy();
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
    const nextLabel = getModelById("anthropic/claude-sonnet-5")?.displayName ?? "Claude Sonnet 5";
    const nextLabelPattern = new RegExp(escapeRegExp(nextLabel), "i");
    expect(trigger.textContent ?? "").toContain(currentLabel);

    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(nextLabelPattern);

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        modelId: "anthropic/claude-sonnet-5",
      }));
    });
    expect(screen.getByRole("button", { name: /^Select model/ }).textContent ?? "").toContain(currentLabel);
    expect(warmupModel).not.toHaveBeenCalled();

    const updatedSession: AgentChatSessionSummary = {
      ...session,
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
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
        modelId: "anthropic/claude-sonnet-5",
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
    const nextLabel = getModelById("anthropic/claude-sonnet-5")?.displayName ?? "Claude Sonnet 5";
    const nextLabelPattern = new RegExp(escapeRegExp(nextLabel), "i");
    expect(trigger.textContent ?? "").toContain(currentLabel);

    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(nextLabelPattern);

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.sessionId,
        modelId: "anthropic/claude-sonnet-5",
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
    expect(await screen.findByRole("button", { name: /Hand off locally/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue on another machine/i })).toBeTruthy();

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
    fireEvent.click(await screen.findByRole("button", { name: /Hand off locally/i }));
    // Brief tab has the unconstrained model picker where Cursor models appear.
    fireEvent.click(await screen.findByRole("button", { name: /^Brief$/ }));

    const localView1 = await screen.findByTestId("handoff-local");
    fireEvent.click(within(localView1).getByRole("button", { name: /^Select model/ }));
    fireEvent.click(await screen.findByRole("tab", { name: /^Cursor$/i }));

    await waitFor(() => {
      expect(screen.getByText("Cursor Chat Only")).toBeTruthy();
    });
    expect(screen.getAllByText("Cursor Both").length).toBeGreaterThan(0);
    expect(screen.queryByText("Cursor CLI Only")).toBeNull();
  });

  it("shows authenticated OpenAI handoff models when detected model ids lag auth status", async () => {
    const session = buildSession("session-1", {
      provider: "claude",
      model: "sonnet",
      modelId: "anthropic/claude-sonnet-4-6",
      status: "idle",
    });
    installAdeMocks({
      sessions: [session],
      aiStatus: {
        mode: "subscription",
        availableProviders: {
          claude: {
            binary: { present: true, source: "bundled", path: null },
            auth: { ready: false, mode: "none", detail: null },
          },
          codex: true,
          cursor: false,
          droid: false,
        },
        models: { claude: [], codex: [], cursor: [], droid: [] },
        features: [],
        detectedAuth: [],
        availableModelIds: [],
      },
    });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: /Hand off locally/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Brief$/ }));

    const localView = await screen.findByTestId("handoff-local");
    fireEvent.click(within(localView).getByRole("button", { name: /^Select model/ }));
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));

    const openAiModel = await screen.findByRole("option", { name: "GPT-5.4" });
    expect(openAiModel.getAttribute("data-model-id")).toBe("openai/gpt-5.4");
    expect(openAiModel.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(openAiModel);
    expect(await screen.findByRole("button", { name: /Select model \(current: GPT-5\.4\)/i })).toBeTruthy();
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

  it("greys out both handoff menu cards with a notice while the turn is active", async () => {
    const session = buildSession("session-1");
    installAdeMocks({
      transcript: buildStatusStartedTranscript(session.sessionId),
    });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    const remoteCard = await screen.findByRole("button", { name: /Continue on another machine/i });
    const localCard = await screen.findByRole("button", { name: /Hand off locally/i });
    await waitFor(() => {
      expect((remoteCard as HTMLButtonElement).disabled).toBe(true);
      expect((localCard as HTMLButtonElement).disabled).toBe(true);
    });
    expect(screen.getByText(/A turn is running — wait for it to finish/i)).toBeTruthy();

    // Clicking the disabled local card must not navigate into the local view.
    fireEvent.click(localCard);
    expect(screen.queryByText("Local handoff")).toBeNull();
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
    fireEvent.click(await screen.findByRole("button", { name: /Hand off locally/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Brief$/ }));
    fireEvent.change(await screen.findByLabelText("Extra instructions"), {
      target: { value: "Prioritize the drawer regression before broad cleanup." },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Start brief handoff" }));

    await waitFor(() => {
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        sourceSessionId: session.sessionId,
        targetModelId: "openai/gpt-5.4-mini",
        mode: "brief",
        handoffNote: "Prioritize the drawer regression before broad cleanup.",
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
      expect(onSessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "session-2" }), { source: "handoff" });
    });
  });

  it("tracks an ephemeral sidebar handoff launch job while handoff is in flight", async () => {
    const session = buildSession("session-1", { status: "idle" });
    let resolveHandoff!: (result: { session: AgentChatSession; usedFallbackSummary: boolean }) => void;
    const pendingHandoff = new Promise<{ session: AgentChatSession; usedFallbackSummary: boolean }>((resolve) => {
      resolveHandoff = resolve;
    });
    installAdeMocks({
      handoffResult: pendingHandoff,
    });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: /Hand off locally/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Brief$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Start brief handoff" }));

    await waitFor(() => {
      const jobs = Object.values(useAppStore.getState().handoffLaunchJobsByScope).flat();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toEqual(expect.objectContaining({
        sourceSessionId: session.sessionId,
        laneId: session.laneId,
        targetModelLabel: "GPT-5.4-Mini",
        targetToolType: "codex-chat",
        status: "preparing-summary",
      }));
    });

    await act(async () => {
      resolveHandoff({
        session: buildCreatedSession("session-2"),
        usedFallbackSummary: false,
      });
      await pendingHandoff;
    });

    await waitFor(() => {
      expect(Object.values(useAppStore.getState().handoffLaunchJobsByScope).flat()).toHaveLength(0);
    });
  });

  it("sends the selected handoff model and permission mode", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { handoff } = installAdeMocks({
      includeClaudeModel: true,
      sessions: [session],
      handoffResult: {
        session: buildCreatedSession("session-2", {
          provider: "claude",
          model: "sonnet",
          modelId: "anthropic/claude-sonnet-5",
          interactionMode: "plan",
          permissionMode: "plan",
        }),
        usedFallbackSummary: false,
      },
    });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: /Hand off locally/i }));
    // Cross-provider (codex → Claude) selection is only offered in Brief mode.
    fireEvent.click(await screen.findByRole("button", { name: /^Brief$/ }));

    const localView3 = await screen.findByTestId("handoff-local");
    fireEvent.click(within(localView3).getByRole("button", { name: /^Select model/ }));
    const claudeLabel = getModelById("anthropic/claude-sonnet-5")?.displayName ?? "Claude Sonnet 5";
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(claudeLabel), "i"));

    const permissionSelect = await screen.findByLabelText("Claude permission mode for handoff") as HTMLSelectElement;
    expect(within(permissionSelect).getByRole("option", { name: "Auto" })).toBeTruthy();
    fireEvent.change(permissionSelect, { target: { value: "plan" } });
    fireEvent.click(await screen.findByRole("button", { name: "Start brief handoff" }));

    await waitFor(() => {
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        sourceSessionId: session.sessionId,
        targetModelId: "anthropic/claude-sonnet-5",
        mode: "brief",
        claudePermissionMode: "plan",
        permissionMode: "plan",
      }));
    });
  });

  it("can fork a Claude handoff with full SDK history", async () => {
    const session = buildSession("session-1", {
      provider: "claude",
      model: "sonnet",
      modelId: "anthropic/claude-sonnet-4-6",
      status: "idle",
    });
    const { handoff } = installAdeMocks({
      includeClaudeModel: true,
      sessions: [session],
      handoffResult: {
        session: buildCreatedSession("session-2", {
          provider: "claude",
          model: "sonnet",
          modelId: "anthropic/claude-sonnet-5",
        }),
        usedFallbackSummary: false,
      },
    });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    // Claude source lands on the Fork tab by default; the picker is same-provider.
    fireEvent.click(await screen.findByRole("button", { name: /Hand off locally/i }));

    const localViewFork = await screen.findByTestId("handoff-local");
    fireEvent.click(within(localViewFork).getByRole("button", { name: /^Select model/ }));
    const claudeLabel = getModelById("anthropic/claude-sonnet-5")?.displayName ?? "Claude Sonnet 5";
    fireEvent.click(await screen.findByRole("tab", { name: /^Anthropic$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(claudeLabel), "i"));
    fireEvent.click(await screen.findByRole("button", { name: "Fork chat" }));

    await waitFor(() => {
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        sourceSessionId: session.sessionId,
        targetModelId: "anthropic/claude-sonnet-5",
        mode: "fork",
      }));
    });
  });

  it("disables the fork tab and defaults to brief for a Cursor source", async () => {
    const { bothId } = seedCursorRuntimeModelCatalog();
    const session = buildSession("session-1", {
      provider: "cursor",
      model: "cursor-both",
      modelId: bothId,
      status: "idle",
    });
    installAdeMocks({ cursorModels: [{ id: bothId }], sessions: [session] });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: /Hand off locally/i }));

    const forkTab = await screen.findByRole("button", { name: /^Fork$/ });
    const briefTab = await screen.findByRole("button", { name: /^Brief$/ });
    expect((forkTab as HTMLButtonElement).disabled).toBe(true);
    expect(briefTab.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Cursor can.t fork chat history/i)).toBeTruthy();
    // The brief-only lane selector is present.
    expect(screen.getByRole("button", { name: "Destination lane for handoff" })).toBeTruthy();
  });

  it("constrains the fork model picker to the source provider", async () => {
    const session = buildSession("session-1", { status: "idle" }); // codex source
    installAdeMocks({ includeClaudeModel: true, sessions: [session] });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: /Hand off locally/i }));

    // Fork tab is active for a codex source; its picker excludes cross-provider models.
    const localViewConstrained = await screen.findByTestId("handoff-local");
    fireEvent.click(within(localViewConstrained).getByRole("button", { name: /^Select model/ }));
    const anthropicTab = screen.queryByRole("tab", { name: /^Anthropic$/i });
    if (anthropicTab) fireEvent.click(anthropicTab);
    const claudeForkOptions = screen.queryAllByRole("option", { name: /Claude/i });
    expect(claudeForkOptions.some((option) => option.getAttribute("aria-disabled") !== "true")).toBe(false);
  });

  it("routes a brief handoff into a newly auto-created lane", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { handoff, createLane } = installAdeMocks({ sessions: [session] });

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: /Hand off locally/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Brief$/ }));

    fireEvent.click(await screen.findByRole("button", { name: "Destination lane for handoff" }));
    fireEvent.click(await screen.findByText("Auto-create lane"));
    fireEvent.click(await screen.findByRole("button", { name: "Start brief handoff" }));

    await waitFor(() => {
      expect(createLane).toHaveBeenCalledWith(expect.objectContaining({ name: expect.any(String) }));
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        sourceSessionId: session.sessionId,
        mode: "brief",
        targetLaneId: "lane-created",
      }));
    });
  });

  it("routes a brief handoff into another selected lane", async () => {
    const session = buildSession("session-1", { status: "idle" });
    const { handoff } = installAdeMocks({ sessions: [session] });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
          onSessionCreated={vi.fn()}
          availableLanes={[
            { id: "lane-1", name: "first lane", branchRef: "refs/heads/first-lane" },
            { id: "lane-2", name: "second lane", branchRef: "refs/heads/second-lane" },
          ]}
        />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: /Hand off locally/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Brief$/ }));

    fireEvent.click(await screen.findByRole("button", { name: "Destination lane for handoff" }));
    fireEvent.click(await screen.findByText("second lane"));
    fireEvent.click(await screen.findByRole("button", { name: "Start brief handoff" }));

    await waitFor(() => {
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
        sourceSessionId: session.sessionId,
        mode: "brief",
        targetLaneId: "lane-2",
      }));
    });
  });

  it("opens the cross-machine modal from the remote card without preselecting a model", async () => {
    const session = buildSession("session-1", { status: "idle" });
    installAdeMocks({ sessions: [session] });
    (window.ade as any).remoteRuntime = {
      onConnectionSnapshotChanged: vi.fn().mockReturnValue(() => {}),
      getConnectionSnapshot: vi.fn().mockResolvedValue({ connections: [] }),
    };

    renderPane(session);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat actions drawer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: /Continue on another machine/i }));

    expect(await screen.findByRole("heading", { name: /Continue on another computer/i })).toBeTruthy();
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
    const { send, create, createLane, suggestLaneName, renameLane, writeClipboardText } = installAdeMocks({ sessions: [] });
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
        laneId: "lane-created",
        prompt: "Fix auto create lane routing.",
        modelId: "openai/gpt-5.4",
        fallbackName: "fix-auto-create-lane-routing",
      }));
      // The lane is created instantly with the deterministic name; the AI name is
      // applied in the background via lanes.rename.
      expect(createLane).toHaveBeenCalledWith({
        name: "fix-auto-create-lane-routing",
        baseBranch: "origin/main",
      });
      expect(renameLane).toHaveBeenCalledWith({ laneId: "lane-created", name: "fix-auto-create-flow" });
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

  it("auto-create omits baseBranch when branch discovery finds no remote base", async () => {
    const { createLane, suggestLaneName } = installAdeMocks({ sessions: [] });
    suggestLaneName.mockResolvedValue("fallback-base-flow");
    ((window as any).ade.git.listBranches as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    // Auto-create now names the lane deterministically from the prompt; the AI
    // suggestion is applied later via lanes.rename.

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
    fireEvent.change(textbox, { target: { value: "Use default base when remote refs are unknown." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(createLane).toHaveBeenCalledWith({
        name: "default-base-when-remote-refs",
      });
    });
  });

  it("auto-create skips git fetch when project config selects local lane bases", async () => {
    const { createLane, suggestLaneName } = installAdeMocks({ sessions: [] });
    suggestLaneName.mockResolvedValue("local-base-flow");
    ((window as any).ade.projectConfig.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      local: {
        git: {
          newLaneBaseSource: "local",
        },
      },
      effective: {
        git: {
          autoRebaseOnHeadChange: false,
          newLaneBaseSource: "local",
        },
        ai: {
          chat: {
            sendOnEnter: true,
          },
        },
      },
    });
    ((window as any).ade.git.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    ((window as any).ade.git.listBranches as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "main", isRemote: false, isCurrent: true, upstream: "origin/main" },
    ]);

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
    fireEvent.change(textbox, { target: { value: "Create from local main without fetching." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(createLane).toHaveBeenCalledWith({
        name: "create-local-main-without-fetching",
        baseBranch: "main",
      });
    });
    expect((window as any).ade.git.fetch).not.toHaveBeenCalled();
  });

  it("auto-create keeps launching with a fallback lane name when name suggestion fails", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { create, createLane, suggestLaneName } = installAdeMocks({ sessions: [] });
      suggestLaneName.mockRejectedValue(new Error("lane naming unavailable"));
      createLane.mockImplementation(async ({ name }: { name: string }) => ({
        id: "lane-created",
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
      fireEvent.change(textbox, { target: { value: "Keep going even if naming fails." } });
      fireEvent.click(await screen.findByRole("button", { name: "Send" }));

      await waitFor(() => {
        expect(createLane).toHaveBeenCalledWith({
          name: "keep-going-even-naming-fails",
          baseBranch: "origin/main",
        });
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ laneId: "lane-created" }));
      });
      await waitFor(() => {
        expect(suggestLaneName).toHaveBeenCalledTimes(2);
      });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("auto-create retries background lane naming once before keeping the deterministic name", async () => {
    let attempts = 0;
    const { createLane, suggestLaneName, renameLane } = installAdeMocks({ sessions: [] });
    suggestLaneName.mockImplementation(async () => {
      attempts += 1;
      return attempts === 1 ? "keep-going-even-naming-fails" : "auto-create-lane-fix";
    });
    createLane.mockImplementation(async ({ name }: { name: string }) => ({
      id: "lane-created",
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
    fireEvent.change(textbox, { target: { value: "Keep going even if naming fails." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(createLane).toHaveBeenCalled();
    }, { timeout: 5000 });

    await waitFor(() => {
      expect(suggestLaneName).toHaveBeenCalledTimes(2);
      expect(renameLane).toHaveBeenCalledWith({
        laneId: "lane-created",
        name: "auto-create-lane-fix",
      });
    }, { timeout: 5000 });
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

  it("keeps Auto-create selected while routing Work tools through Primary", async () => {
    installAdeMocks({ sessions: [] });
    const onLaneChange = vi.fn();
    renderAutoCreateDraftPane({ onLaneChange });

    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    fireEvent.click(await screen.findByRole("button", { name: /Auto-create lane/i }));

    expect(onLaneChange).toHaveBeenCalledWith("lane-primary");
    expect(await screen.findByText("Auto-create lane")).toBeTruthy();
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
  });

  it("auto-creates on This Mac from a remote-bound tab without rebinding the project", async () => {
    const { create } = installAdeMocks({ sessions: [] });
    const localBinding = {
      kind: "local" as const,
      key: "local:/tmp/project-under-test",
      rootPath: "/tmp/project-under-test",
      displayName: "project-under-test",
      gitOriginUrl: "git@github.com:acme/project-under-test.git",
    };
    const remoteBinding = {
      kind: "remote" as const,
      key: "remote:target-studio:project-a",
      targetId: "target-studio",
      runtimeName: "Mac Studio (12)",
      projectId: "project-a",
      rootPath: "/Volumes/work/project-under-test",
      displayName: "project-under-test",
      gitOriginUrl: "https://github.com/acme/project-under-test",
    };
    const switchProjectToPath = vi.fn();
    const switchRemoteProject = vi.fn();
    const remoteLanes = [{
      // Primary lane ids are intentionally duplicated across machines. The
      // machine-qualified picker value must still route creation to This Mac.
      id: "primary",
      name: "Primary",
      laneType: "primary",
      branchRef: "refs/heads/main",
      worktreePath: remoteBinding.rootPath,
    }];
    const localLanes = [{
      id: "primary",
      name: "Primary",
      laneType: "primary",
      branchRef: "refs/heads/main",
      worktreePath: localBinding.rootPath,
    }];
    useAppStore.setState({
      project: {
        rootPath: remoteBinding.rootPath,
        displayName: remoteBinding.displayName,
      } as any,
      projectBinding: remoteBinding,
      openProjectTabRoots: [localBinding.rootPath],
      openRemoteProjectTabs: [remoteBinding],
      crossMachineLanesByMachineId: {
        "this-mac": {
          machineId: "this-mac",
          machineName: "This Mac",
          targetId: null,
          projectId: null,
          binding: localBinding,
          online: true,
          lanes: localLanes as any,
          sessions: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
      },
      switchProjectToPath,
      switchRemoteProject,
    });
    (window.ade.project.listRecent as ReturnType<typeof vi.fn>).mockResolvedValue([{
      rootPath: localBinding.rootPath,
      displayName: localBinding.displayName,
      lastOpenedAt: "2026-07-28T12:00:00.000Z",
      exists: true,
      kind: "local",
      gitOriginUrl: localBinding.gitOriginUrl,
    }]);
    window.ade.remoteRuntime = {
      getConnectionSnapshot: vi.fn().mockResolvedValue({
        connections: [{
          state: "connected",
          target: {
            id: remoteBinding.targetId,
            name: remoteBinding.runtimeName,
            hostname: "studio",
          },
          projects: [{
            projectId: remoteBinding.projectId,
            rootPath: remoteBinding.rootPath,
            displayName: remoteBinding.displayName,
            gitOriginUrl: remoteBinding.gitOriginUrl,
          }],
        }],
        connectedCount: 1,
        updatedAt: Date.now(),
      }),
      onConnectionSnapshotChanged: vi.fn(() => () => {}),
    } as any;

    renderAutoCreateDraftPane({ lanes: remoteLanes });
    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Create this on my MacBook." } });
    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const codexLabel = getModelById("openai/gpt-5.4")?.displayName ?? "GPT-5.4";
    fireEvent.pointerDown(modelTrigger, { button: 0 });
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole("tab", { name: /^OpenAI$/i }));
    await clickEnabledModelOption(new RegExp(escapeRegExp(codexLabel), "i"));
    fireEvent.click(await screen.findByRole("button", { name: "Select lane" }));
    const machineRows = await screen.findAllByText("Auto-create lane here");
    fireEvent.click(machineRows.at(-1)!);

    expect(switchProjectToPath).not.toHaveBeenCalled();
    expect(switchRemoteProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().projectBinding).toEqual(remoteBinding);
    expect(await screen.findByRole("button", {
      name: "Choose machine, currently This Mac",
    })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(window.ade.lanes.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: expect.any(String) }),
        localBinding,
      );
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ laneId: "lane-created" }),
        localBinding,
      );
    });
    expect(screen.queryByText(/Open this repository on This Mac first/i)).toBeNull();
  });

  it("keeps orchestrator lead mode on the first Claude draft send", async () => {
    const { send, create } = installAdeMocks({ sessions: [], includeClaudeModel: true });

    renderAutoCreateDraftPane({ orchestratorEnabled: true });

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const claudeLabel = getModelById("anthropic/claude-sonnet-5")?.displayName ?? "Claude Sonnet 5";
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

  it("pins orchestrator bundle allocation to the originating project binding", async () => {
    const binding = {
      kind: "local" as const,
      key: "local:/tmp/project-under-test",
      rootPath: "/tmp/project-under-test",
      displayName: "project-under-test",
    };
    const { send, create } = installAdeMocks({ sessions: [], includeClaudeModel: true });
    useAppStore.setState({ projectBinding: binding as any });

    renderAutoCreateDraftPane({ orchestratorEnabled: true });

    const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
    const claudeLabel = getModelById("anthropic/claude-sonnet-5")?.displayName ?? "Claude Sonnet 5";
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
      }), binding);
      expect(window.ade.orchestration.runCreate).toHaveBeenCalledWith({
        laneId: "lane-1",
        leadSessionId: "created-session",
      }, binding);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "created-session",
        interactionMode: "orchestrator-lead",
      }), binding);
    });
  });

  it("does not send an orchestrator draft prompt when bundle allocation fails", async () => {
    const { send, create, deleteChat } = installAdeMocks({ sessions: [], includeClaudeModel: true });
    vi.mocked(window.ade.orchestration.runCreate).mockRejectedValueOnce(new Error("disk full"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      renderAutoCreateDraftPane({ orchestratorEnabled: true });

      const modelTrigger = await screen.findByRole("button", { name: /^Select model/ });
      const claudeLabel = getModelById("anthropic/claude-sonnet-5")?.displayName ?? "Claude Sonnet 5";
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
      // Orchestrator lead rollback is pinned to the originating project's binding
      // (null in the default test store).
      expect(deleteChat).toHaveBeenCalledWith({ sessionId: "created-session" }, null);
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
      // Rollback is pinned to the originating project's binding (null here in
      // the default test store) so a concurrent project switch can't misroute it.
      expect(deleteChat).toHaveBeenCalledWith({ sessionId: "created-session" }, null);
      expect(deleteLane).toHaveBeenCalledWith({ laneId: "lane-created", force: true }, null);
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
    fireEvent.click(screen.getAllByRole("button", { name: "Restore" })[0]);

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
      expect(deleteLane).toHaveBeenCalledWith({ laneId: "lane-created", force: true }, null);
      expect(deleteChat).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(onSessionCreated).not.toHaveBeenCalled();
    });
  });

  it("keeps an auto-create launch pinned to its originating project after a mid-launch project switch", async () => {
    const onSessionCreated = vi.fn();
    const { send, create, createLane, deleteLane } = installAdeMocks({ sessions: [] });
    // Naming no longer blocks lane creation; branch discovery (git.fetch) is now
    // the async step before the irreversible create, so gate the project switch
    // on it to exercise the pinned background launch path.
    let resolveFetch!: () => void;
    ((window as any).ade.git.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<void>((resolve) => { resolveFetch = () => resolve(undefined); }),
    );
    const binding = {
      kind: "local" as const,
      key: "local:/tmp/project-under-test",
      rootPath: "/tmp/project-under-test",
      displayName: "project-under-test",
    };
    // The originating project's binding is captured when the launch starts.
    useAppStore.setState({ projectBinding: binding as any });

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
    fireEvent.change(textbox, { target: { value: "Switch projects mid-launch." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect((window as any).ade.git.fetch).toHaveBeenCalledWith({ laneId: "lane-primary" }, binding);
    });

    // Switch the active project to a different one, then let branch discovery
    // resolve. The launch should keep routing through the captured binding.
    await act(async () => {
      useAppStore.setState({
        projectBinding: {
          kind: "local",
          key: "local:/tmp/other-project",
          rootPath: "/tmp/other-project",
          displayName: "other-project",
        } as any,
      });
      resolveFetch();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(createLane).toHaveBeenCalledWith({
        name: "switch-projects-mid-launch",
        baseBranch: "origin/main",
      }, binding);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ laneId: "lane-created" }), binding);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "created-session",
        text: "Switch projects mid-launch.",
      }), binding);
      const jobs = Object.values(useAppStore.getState().draftLaunchJobsByScope).flat();
      expect(jobs.find((job) => job.status === "failed")).toBeFalsy();
      const readyJob = jobs.find((job) => job.sessionId === "created-session");
      expect(readyJob?.status).toBe("ready");
      expect(readyJob?.autoOpen).toBe(false);
      expect(onSessionCreated).not.toHaveBeenCalled();
    });
    expect(screen.getByTestId("location").textContent).toBe("/work");
    expect(deleteLane).not.toHaveBeenCalled();
  });

  it("pins the rollback delete to the originating project's binding", async () => {
    const binding = {
      kind: "local" as const,
      key: "local:/tmp/project-under-test",
      rootPath: "/tmp/project-under-test",
      displayName: "project-under-test",
    };
    const { createLane, suggestLaneName, deleteLane } = installAdeMocks({
      sessions: [],
      sendError: new Error("send failed"),
    });
    suggestLaneName.mockResolvedValue("pinned-rollback-lane");
    createLane.mockResolvedValue({
      id: "lane-created",
      name: "pinned-rollback-lane",
      laneType: "worktree",
      branchRef: "refs/heads/pinned-rollback-lane",
      worktreePath: "/tmp/project-under-test/pinned-rollback-lane",
      parentLaneId: "lane-primary",
    });
    useAppStore.setState({ projectBinding: binding as any });

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
    fireEvent.change(textbox, { target: { value: "Roll back to the right project." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      // Same project throughout, so the lane is created, the send fails, and the
      // rollback is routed at the captured binding (not the global one).
      expect(deleteLane).toHaveBeenCalledWith({ laneId: "lane-created", force: true }, binding);
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
      fastMode: false,
      executionMode: "focused",
      controls: {},
      attachments: [{ path: "/tmp/project-under-test/spec.md", type: "file" }],
      contextAttachments: [],
      iosContextItems: [],
      appControlContextItems: [],
      builtInBrowserContextItems: [],
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

  it("hydrates persisted draft context without keeping screenshot data URLs in storage", async () => {
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
      fastMode: false,
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
      draftLaunchTargetId: null,
      updatedAt: "2026-05-27T00:00:00.000Z",
    }));

    renderAutoCreateDraftPane();

    const textbox = await screen.findByRole("textbox");
    await waitFor(() => {
      expect(textbox.textContent).toContain("Persisted with visual context.");
    });
    await waitFor(() => {
      const raw = window.localStorage.getItem(storageKey);
      expect(raw).toBeTruthy();
      expect(raw).not.toContain("data:image/png;base64");
      const stored = JSON.parse(raw!);
      expect(stored.text.trim()).toBe("Persisted with visual context.");
      expect(stored.iosContextItems[0]).not.toHaveProperty("screenshotDataUrl");
      expect(stored.appControlContextItems[0]).not.toHaveProperty("screenshotDataUrl");
      expect(stored.builtInBrowserContextItems[0].screenshotDataUrl).toBeNull();
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
    }));

    renderAutoCreateDraftPane();

    expect(await screen.findByDisplayValue("Persisted with bad refs.")).toBeTruthy();
    expect(screen.getByText("valid.md")).toBeTruthy();
    expect(screen.queryByText("undefined")).toBeNull();
  });

  it("clears the submitted draft and keeps the composer usable while auto-create launch is pending", async () => {
    const { createLane } = installAdeMocks({ sessions: [] });
    // Naming is background now; gate on lane creation to hold the launch pending.
    let resolveCreateLane!: () => void;
    createLane.mockImplementation(({ name }: { name: string }) => new Promise((resolve) => {
      resolveCreateLane = () => resolve({
        id: `lane-${name}`,
        name,
        laneType: "worktree",
        branchRef: `refs/heads/${name}`,
        worktreePath: `/tmp/project-under-test/${name}`,
        parentLaneId: "lane-primary",
      });
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
      expect(createLane).toHaveBeenCalled();
      expect(screen.getByText(/Creating lane for chat/i)).toBeTruthy();
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Auto-create in background" }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect((textbox as HTMLTextAreaElement).disabled).toBe(false);
    expect((textbox as HTMLTextAreaElement).value).toBe("");

    fireEvent.change(textbox, { target: { value: "Next thought while it launches." } });
    expect((textbox as HTMLTextAreaElement).value).toBe("Next thought while it launches.");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Auto-create in background" }) as HTMLButtonElement).disabled).toBe(false);

    resolveCreateLane();
    await waitFor(() => {
      expect(screen.getByText(/Launch this and let me keep typing\./i)).toBeTruthy();
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Next thought while it launches.");
    });
  });

  it("keeps a pending auto-create launch visible after the new chat pane remounts", async () => {
    const { createLane } = installAdeMocks({ sessions: [] });
    // Naming is background now; lane creation is the pending step that holds the
    // "Creating lane…" status, which must survive a remount.
    let resolveCreateLane!: () => void;
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
      expect(createLane).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/^Creating lane for chat\.\.\.$/i)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Dismiss launch status" })).toBeNull();

    rendered.unmount();
    renderAutoCreateDraftPane();

    expect(await screen.findByText(/^Creating lane for chat\.\.\.$/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss launch status" })).toBeNull();

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
          namingModelId: null,
          error: null,
          warning: null,
          autoOpen: false,
          createdAtMs: Date.now() - DRAFT_LAUNCH_JOB_STALE_AFTER_MS - 1,
          snapshot: {
            text: "Recover from a stuck launch.",
            draft: "Recover from a stuck launch.",
            modelId: "openai/gpt-5.4",
            reasoningEffort: null,
            fastMode: false,
            executionMode: "focused",
            interactionMode: "native",
            nativeControls: {},
            attachments: [],
            contextAttachments: [],
            iosContextItems: [],
            appControlContextItems: [],
            builtInBrowserContextItems: [],
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
    const { createLane } = installAdeMocks({ sessions: [] });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let rejectCreateLane!: (error: Error) => void;
    try {
      // Lane creation is the pending step now; fail it late to simulate the
      // launch failing after its row was hidden.
      createLane.mockImplementation(() => new Promise((_resolve, reject) => {
        rejectCreateLane = reject;
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
        expect(createLane).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/Creating lane for chat/i)).toBeTruthy();
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
        rejectCreateLane(new Error("hidden stale launch failed"));
      });

      expect(screen.queryByText(/hidden stale launch failed/i)).toBeNull();
      expect(screen.queryByTestId("draft-launch-job")).toBeNull();
    } finally {
      consoleWarn.mockRestore();
    }
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
      expect(screen.getAllByRole("button", { name: "Restore" }).length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "Dismiss failed launch" })).toBeTruthy();
    });
  });

  it("ignores duplicate auto-create submits for the same draft while lane creation is pending", async () => {
    const { createLane } = installAdeMocks({ sessions: [] });
    createLane.mockImplementation(() => new Promise(() => {
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
      expect(createLane).toHaveBeenCalledTimes(1);
      expect(screen.getAllByText(/Creating lane for chat/i)).toHaveLength(1);
    });
  });

  it("keeps draft launch rows scoped to the lane pane that launched them", async () => {
    const { createLane } = installAdeMocks({ sessions: [] });
    createLane.mockImplementation(() => new Promise(() => {
      // Keep the launch in-flight (pending lane creation) so the row stays visible.
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
      expect(createLane).toHaveBeenCalledTimes(1);
      expect(within(paneOne).getByText(/Creating lane for chat/i)).toBeTruthy();
    });
    expect(within(paneTwo).queryByText(/Creating lane for chat/i)).toBeNull();
    expect(within(paneTwo).queryByTestId("draft-launch-job")).toBeNull();
  });

  it("keeps every in-flight background draft launch visible past the completed-notice cap", async () => {
    const { createLane } = installAdeMocks({ sessions: [] });
    createLane.mockImplementation(() => new Promise(() => {
      // keep the launch in-flight (pending lane creation)
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
        expect(createLane).toHaveBeenCalledTimes(index);
      });
    }

    expect(screen.getAllByTestId("draft-launch-job")).toHaveLength(9);
    expect(screen.getAllByText(/Creating lane for chat/i)).toHaveLength(9);
  });

  it("allows multiple background auto-create launches to stay pending at the same time", async () => {
    const { createLane, create, send } = installAdeMocks({ sessions: [] });
    // Lane creation is the pending step now; hold each launch there until resolved.
    const createLaneResolvers: Array<() => void> = [];
    createLane.mockImplementation(({ name }: { name: string; parentLaneId: string }) => new Promise((resolve) => {
      createLaneResolvers.push(() => resolve({
        id: `lane-${name}`,
        name,
        laneType: "worktree",
        branchRef: `refs/heads/${name}`,
        worktreePath: `/tmp/project-under-test/${name}`,
        parentLaneId: "lane-primary",
      }));
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
      expect(createLane).toHaveBeenCalledTimes(1);
      expect((textbox as HTMLTextAreaElement).value).toBe("");
    });

    fireEvent.change(textbox, { target: { value: "Second auto lane." } });
    fireEvent.click(await screen.findByRole("button", { name: "Auto-create in background" }));
    await waitFor(() => {
      expect(createLane).toHaveBeenCalledTimes(2);
      expect(screen.getAllByText(/Creating lane for chat/i)).toHaveLength(2);
    });

    await act(async () => {
      createLaneResolvers[0]?.();
      createLaneResolvers[1]?.();
    });

    await waitFor(() => {
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

  it("preserves typed Work draft text and attachments when switching target lanes", async () => {
    installAdeMocks({ sessions: [] });
    const draftContextTargetId = "work-draft-under-test";

    const view = render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-1"
          forceDraftMode
          embeddedWorkLayout
          draftContextTargetId={draftContextTargetId}
        />
      </MemoryRouter>,
    );

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Keep this draft while I switch lanes." } });
    act(() => {
      window.dispatchEvent(new CustomEvent("ade:agent-chat:add-attachment", {
        detail: {
          draftTargetId: draftContextTargetId,
          attachment: { path: "/tmp/project-under-test/spec.md", type: "file" },
        },
      }));
    });

    expect(await screen.findByText("spec.md")).toBeTruthy();

    view.rerender(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-2"
          forceDraftMode
          embeddedWorkLayout
          draftContextTargetId={draftContextTargetId}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Keep this draft while I switch lanes.");
      expect(screen.getByText("spec.md")).toBeTruthy();
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
      fastMode: false,
      executionMode: "focused",
      controls: {},
      attachments: [],
      contextAttachments: [],
      iosContextItems: [],
      appControlContextItems: [],
      builtInBrowserContextItems: [],
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
      fastMode: false,
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

    fireEvent.click(await screen.findByRole("button", { name: "Codex permission mode" }));
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
    expect(launchArgs.args).toEqual(expect.arrayContaining(["-c", "service_tier=\"default\""]));
    expect(launchArgs.args).not.toContain("workspace-write");
    expect(launchArgs.startupCommand).toContain("codex --no-alt-screen");
    expect(launchArgs.startupCommand).toContain("service_tier");
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
      fastMode: false,
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

    fireEvent.click(await screen.findByRole("button", { name: "Codex permission mode" }));
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
      fastMode: true,
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
    expect(launchArgs.startupCommand).not.toContain("Run Cursor in fast mode.");
    expect(launchArgs.args).not.toContain(expect.stringContaining("Run Cursor in fast mode."));
    expect(launchArgs.initialInput).toContain("Run Cursor in fast mode.");
    expect(launchArgs.initialInputDelayMs).toBe(750);
  });

  it("uses the OpenCode fast variant when launching a fast Work draft CLI session", async () => {
    const modelId = seedFastOpenCodeRuntimeModelCatalog();
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
      modelId,
      reasoningEffort: null,
      fastMode: true,
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
    fireEvent.change(textbox, { target: { value: "Run OpenCode in fast mode." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(onLaunchCliSession).toHaveBeenCalledWith(expect.objectContaining({
        profile: "opencode",
        tracked: true,
      }));
    });
    const launchArgs = onLaunchCliSession.mock.calls[0]?.[0];
    expect(launchArgs.startupCommand).toContain("opencode run --interactive");
    expect(launchArgs.startupCommand).toContain("--variant fast");
    expect(launchArgs.args).toEqual(expect.arrayContaining([expect.stringContaining("Run OpenCode in fast mode.")]));
  });

  it("does not forward stale fast mode when launching an unsupported Claude CLI model", async () => {
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
      modelId: "anthropic/claude-sonnet-5",
      reasoningEffort: null,
      fastMode: true,
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

    await screen.findByRole("button", { name: /current: Claude Sonnet 5/i });
    expect(screen.queryByRole("button", { name: /Fast mode/i })).toBeNull();

    const textbox = await screen.findByRole("textbox");
    fireEvent.change(textbox, { target: { value: "Run Claude without stale fast mode." } });
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(onLaunchCliSession).toHaveBeenCalledWith(expect.objectContaining({
        profile: "claude",
        tracked: true,
      }));
    });
    const launchArgs = onLaunchCliSession.mock.calls[0]?.[0];
    expect(launchArgs.args).toEqual(expect.arrayContaining([
      "--settings",
      JSON.stringify({ fastMode: false }),
    ]));
    expect(launchArgs.startupCommand).toContain("fastMode");
    expect(launchArgs.startupCommand).not.toContain("\"fastMode\":true");
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
      fastMode: true,
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
    expect(launchArgs.startupCommand).not.toContain("Run Cursor with medium fast thinking.");
    expect(launchArgs.args).not.toContain(expect.stringContaining("Run Cursor with medium fast thinking."));
    expect(launchArgs.initialInput).toContain("Run Cursor with medium fast thinking.");
    expect(launchArgs.initialInputDelayMs).toBe(750);
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
        laneId: "lane-created",
        prompt: "Launch a CLI agent on a new lane.",
        modelId: "openai/gpt-5.4",
      }));
      expect(createLane).toHaveBeenCalledWith({
        name: "launch-cli-agent-new-lane",
        baseBranch: "origin/main",
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
    const { send, createLane, suggestLaneName } = installAdeMocks({ sessions: [] });
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

  it("keeps Claude prompt suggestions scoped to the selected chat", async () => {
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

    renderTabbedPane(primarySession);

    const primaryTab = await screen.findByRole("button", { name: /Primary chat/i });
    const backgroundTab = await screen.findByRole("button", { name: /Background chat/i });
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");

    act(() => {
      emitChatEvent({
        sessionId: "session-1",
        timestamp: "2026-03-24T06:00:00.000Z",
        sequence: 1,
        event: {
          type: "prompt_suggestion",
          suggestion: "Continue primary work",
        },
      } as AgentChatEventEnvelope);
      emitChatEvent({
        sessionId: "session-2",
        timestamp: "2026-03-24T06:00:01.000Z",
        sequence: 1,
        event: {
          type: "prompt_suggestion",
          suggestion: "Continue background work",
        },
      } as AgentChatEventEnvelope);
    });
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 16)).toBe(false);
    setTimeoutSpy.mockRestore();

    await waitFor(() => {
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toBe("Continue primary work");
    });

    fireEvent.click(backgroundTab);
    await waitFor(() => {
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toBe("Continue background work");
    });

    fireEvent.click(primaryTab);
    await waitFor(() => {
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toBe("Continue primary work");
    });
  });

  it("persists the first view without showing historical scheduled wakes as away activity", async () => {
    const openedAtMs = Date.parse("2026-07-10T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(openedAtMs);
    const session = buildSession("session-1", { title: "First view" });
    installAdeMocks({
      sessions: [session],
      eventHistory: {
        sessionId: session.sessionId,
        truncated: false,
        sessionFound: true,
        events: [{
          sessionId: session.sessionId,
          timestamp: "2026-07-10T11:59:00.000Z",
          sequence: 1,
          event: {
            type: "user_message",
            text: "Check PR CI",
            deliveryState: "delivered",
            turnId: "turn-wake-1",
            metadata: {
              scheduledWake: {
                scheduleId: "wake-1",
                kind: "wakeup",
                firedAt: "2026-07-10T11:59:00.000Z",
                reason: "CI follow-up",
              },
            },
          },
        }],
      },
    });

    renderPane(session);

    expect(await screen.findByText("Check PR CI")).toBeTruthy();
    expect(screen.queryByText(/While you were away:/)).toBeNull();
    expect(window.localStorage.getItem(`ade.chat.lastViewed.v1:${session.sessionId}`))
      .toBe(String(openedAtMs));
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

  it("rehydrates a newly-created idle chat when its first history snapshot is temporarily empty", async () => {
    const session = buildSession("session-1", { title: "New headless chat", status: "idle" });
    let historyReads = 0;
    installAdeMocks({
      sessions: [session],
      eventHistory: async () => {
        historyReads += 1;
        return {
          sessionId: session.sessionId,
          events: historyReads === 1 ? [] : [{
            sessionId: session.sessionId,
            timestamp: "2026-07-10T12:00:00.000Z",
            sequence: 1,
            event: { type: "user_message" as const, text: "Start the attached Linear issue." },
          }],
          truncated: false,
          sessionFound: true,
        };
      },
    });

    renderPane(session);

    expect(await screen.findByText("Start the attached Linear issue.", {}, { timeout: 2_000 })).toBeTruthy();
    expect(historyReads).toBeGreaterThanOrEqual(2);
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

  it("keeps the rendered transcript when a later history read cannot reach the runtime", async () => {
    const session = buildSession("session-1", { title: "Remote chat" });
    let historyReads = 0;
    installAdeMocks({
      sessions: [session],
      eventHistory: async () => {
        historyReads += 1;
        if (historyReads === 1) {
          return {
            sessionId: session.sessionId,
            events: [{
              sessionId: session.sessionId,
              timestamp: "2026-07-10T12:00:00.000Z",
              sequence: 1,
              event: { type: "user_message" as const, text: "Ship the release" },
            }],
            truncated: false,
            sessionFound: true,
          };
        }
        // The runtime could not be reached. This is NOT "the chat is gone", so
        // the transcript already on screen must survive it.
        return {
          sessionId: session.sessionId,
          events: [],
          truncated: false,
          sessionFound: false,
          unavailable: true,
        };
      },
    });

    renderPane(session);

    expect(await screen.findByText("Ship the release")).toBeTruthy();
    await waitFor(() => expect(historyReads).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    // The unavailable read also clears the loaded flag, so the pane keeps
    // retrying instead of latching a permanently stale view. The recovery loop
    // is a ~10s stall detector now (the live subscription is the transport), so
    // the third read is a full interval out.
    await waitFor(() => expect(historyReads).toBeGreaterThanOrEqual(3), { timeout: 14_000 });
    expect(screen.getByText("Ship the release")).toBeTruthy();
  }, 25_000);

  it("keeps a rendered transcript when an authoritative history miss arrives after events are on screen", async () => {
    const session = buildSession("session-1", { title: "Existing chat" });
    let historyReads = 0;
    installAdeMocks({
      sessions: [session],
      eventHistory: async () => {
        historyReads += 1;
        if (historyReads === 1) {
          return {
            sessionId: session.sessionId,
            events: [{
              sessionId: session.sessionId,
              timestamp: "2026-07-10T12:00:00.000Z",
              sequence: 1,
              event: { type: "user_message" as const, text: "Rebase onto main" },
            }],
            truncated: false,
            sessionFound: true,
          };
        }
        return {
          sessionId: session.sessionId,
          events: [],
          truncated: false,
          sessionFound: false,
        };
      },
    });

    renderPane(session);

    expect(await screen.findByText("Rebase onto main")).toBeTruthy();
    await waitFor(() => expect(historyReads).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    // One full ~10s stall-detector interval — see the sibling test above.
    await waitFor(() => expect(historyReads).toBeGreaterThanOrEqual(3), { timeout: 14_000 });
    expect(screen.getByText("Rebase onto main")).toBeTruthy();
  }, 25_000);

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

  it("keeps the Claude login prompt pinned in compact grid tiles", async () => {
    const session = buildSession("grid-claude-auth", {
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
      status: "idle",
      title: "Claude auth grid tile",
    });
    const transcript = `${JSON.stringify({
      sessionId: session.sessionId,
      timestamp: "2026-03-24T06:00:00.000Z",
      sequence: 1,
      event: {
        type: "error",
        message: "Authentication failed for Claude Sonnet 5.",
        turnId: "turn-grid-auth",
        errorInfo: {
          category: "agent_cli_auth",
          agentCli: {
            agent: "claude",
            displayName: "Claude Code",
            category: "unauthenticated",
            installCommand: "npm install -g @anthropic-ai/claude-code",
            authCommand: "claude auth login",
          },
        },
      },
    })}\n`;
    installAdeMocks({ sessions: [session], transcript, includeClaudeModel: true });

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          lockSessionId={session.sessionId}
          hideSessionTabs
          initialSessionSummary={session}
          layoutVariant="grid-tile"
          isTileActive
          isTileVisible
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("button", { name: "Login to Claude" })).toBeTruthy();
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
    const { send, suggestLaneName, renameLane, parallelLaunchStateSet, writeClipboardText } = installAdeMocks({ sessions: [], includeClaudeModel: true });
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
        "anthropic/claude-sonnet-5",
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
    const claudeLabel = getModelById("anthropic/claude-sonnet-5")?.displayName ?? "Claude Sonnet 5";
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
        fallbackName: "fix-login-bug",
      }));
      expect(createChild).toHaveBeenCalledTimes(2);
    });
    // Child lanes are created instantly with the deterministic base name…
    expect(createChild.mock.calls.map(([args]) => args.name)).toEqual([
      "fix-login-bug-codex-gpt-5-4",
      "fix-login-bug-claude-sonnet-5",
    ]);
    // …then renamed to the AI base name in the background.
    await waitFor(() => {
      expect(renameLane).toHaveBeenCalledWith({ laneId: "lane-child-1", name: "fix-login-codex-gpt-5-4" });
      expect(renameLane).toHaveBeenCalledWith({ laneId: "lane-child-2", name: "fix-login-claude-sonnet-5" });
    });

    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(2);
    }, { timeout: 5000 });
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
      modelId: "anthropic/claude-sonnet-5",
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
        "anthropic/claude-sonnet-5",
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
    await clickEnabledModelOption(/Claude Sonnet 5/i);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix the login bug" } });
    fireEvent.click(await screen.findByRole("button", { name: /Send to lanes/i }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(deleteLane).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(await screen.findByText(/Lane 2 failed to send\./i, {}, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByText(/Cleanup could not delete lane lane-child-1/i, {}, { timeout: 5000 })).toBeTruthy();
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

describe("correlated parent turn messages", () => {
  it("keeps a fresh idle-steer parent retryable without promoting child steers", () => {
    const parent = {
      type: "user_message" as const,
      text: "Retry this parent turn",
      steerId: "idle-steer-correlation",
      messageId: "durable-parent-message",
      deliveryState: "delivered" as const,
      turnId: "turn-parent",
    };
    const childSteer = {
      type: "user_message" as const,
      text: "Adjust the active turn",
      steerId: "active-steer-correlation",
      deliveryState: "delivered" as const,
      turnId: "turn-parent",
    };
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-parent",
        timestamp: "2026-07-12T12:00:00.000Z",
        sequence: 1,
        event: parent,
      },
      {
        sessionId: "session-parent",
        timestamp: "2026-07-12T12:00:01.000Z",
        sequence: 2,
        event: childSteer,
      },
    ];

    expect(isParentUserMessage(parent)).toBe(true);
    expect(isParentUserMessage(childSteer)).toBe(false);
    expect(findUserMessageForTurn(events, "turn-parent")).toMatchObject({
      text: "Retry this parent turn",
      steerId: "idle-steer-correlation",
      messageId: "durable-parent-message",
    });
  });
});

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
      nextWakeAt: null,
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

describe("deriveRuntimeState", () => {
  it("clears a staged steer when Claude reports that its command started", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-07-16T12:00:00.000Z",
        sequence: 1,
        event: { type: "user_message", text: "queued", steerId: "steer-1", deliveryState: "queued" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-07-16T12:00:01.000Z",
        sequence: 2,
        event: {
          type: "command_lifecycle",
          commandUuid: "command-1",
          status: "started",
          steerId: "steer-1",
        },
      },
    ];

    expect(deriveRuntimeState(events).pendingSteers).toEqual([]);
  });

  it("restores cancelled Claude queue entries after the user chooses Undo", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-07-16T12:00:00.000Z",
        sequence: 1,
        event: {
          type: "user_message",
          text: "queued",
          steerId: "steer-1",
          deliveryState: "queued",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-07-16T12:00:01.000Z",
        sequence: 2,
        event: {
          type: "system_notice",
          noticeKind: "info",
          message: "Queued message cancelled because the current turn was interrupted.",
          steerId: "steer-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-07-16T12:00:02.000Z",
        sequence: 3,
        event: {
          type: "queue_recovery",
          recoveryId: "recovery-1",
          state: "restored",
          messageCount: 1,
          expiresAt: "2026-07-16T12:00:10.000Z",
          stopMode: "stop_and_clear",
          restoredSteers: [{ steerId: "steer-1", text: "queued" }],
        },
      },
    ];

    expect(deriveRuntimeState(events).pendingSteers).toEqual([
      {
        steerId: "steer-1",
        text: "queued",
        attachments: [],
        contextAttachments: [],
      },
    ]);
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

  it("preserves already-paged older rows when a fresh bounded tail snapshot overlaps", () => {
    const older = envelope("2026-04-30T23:10:00.000Z", 1002, "already paged older");
    const firstTail = envelope("2026-04-30T23:14:47.751Z", 1003, "tail first");
    const secondTail = envelope("2026-04-30T23:19:57.083Z", 1004, "tail second");
    const parsedFirstTail = envelope("2026-04-30T23:14:47.751Z", 1003, "tail first");
    const parsedSecondTail = envelope("2026-04-30T23:19:57.083Z", 1004, "tail second refreshed");

    const merged = mergeChatHistorySnapshot(
      [parsedFirstTail, parsedSecondTail],
      [older, firstTail, secondTail],
    );

    expect(merged.map((entry) => entry.event.type === "text" ? entry.event.text : "")).toEqual([
      "already paged older",
      "tail first",
      "tail second refreshed",
    ]);
    expect(merged[0]).toBe(older);
    expect(merged[1]).toBe(firstTail);
  });

  it("preserves already-paged older rows when only a later tail row overlaps", () => {
    const older = envelope("2026-04-30T23:10:00.000Z", 1001, "already paged older");
    const firstTail = envelope("2026-04-30T23:14:47.751Z", 1002, "tail first");
    const secondTail = envelope("2026-04-30T23:19:57.083Z", 1003, "tail second");
    const recoveredBeforeOverlap = envelope("2026-04-30T23:14:40.000Z", 1004, "recovered before overlap");
    const parsedSecondTail = envelope("2026-04-30T23:19:57.083Z", 1003, "tail second");

    const merged = mergeChatHistorySnapshot(
      [recoveredBeforeOverlap, parsedSecondTail],
      [older, firstTail, secondTail],
    );

    expect(merged.map((entry) => entry.event.type === "text" ? entry.event.text : "")).toEqual([
      "already paged older",
      "tail first",
      "recovered before overlap",
      "tail second",
    ]);
    expect(merged[0]).toBe(older);
    expect(merged[1]).toBe(firstTail);
    expect(merged[3]).toBe(secondTail);
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

describe("prependOlderChatHistoryPage", () => {
  function envelope(timestamp: string, sequence: number, text: string): AgentChatEventEnvelope {
    return {
      sessionId: "session-1",
      timestamp,
      sequence,
      event: { type: "text", text },
    };
  }

  it("prepends older events ahead of the loaded list", () => {
    const olderA = envelope("2026-06-10T09:00:00.000Z", 1, "older-a");
    const olderB = envelope("2026-06-10T09:01:00.000Z", 2, "older-b");
    const loaded = envelope("2026-06-10T10:00:00.000Z", 3, "loaded");

    const merged = prependOlderChatHistoryPage([olderA, olderB], [loaded]);

    expect(merged.map((entry) => (entry.event.type === "text" ? entry.event.text : ""))).toEqual([
      "older-a",
      "older-b",
      "loaded",
    ]);
    // Existing envelope identity is preserved (the message list relies on it
    // to keep row measurements across the prepend).
    expect(merged[2]).toBe(loaded);
  });

  it("drops page entries that duplicate the seam of the loaded list", () => {
    // The hydrated tail merges the disk transcript with the live ring buffer,
    // so a byte-window page ending at the cursor can overlap the oldest
    // loaded entries — duplicates at the seam must be dropped.
    const older = envelope("2026-06-10T09:00:00.000Z", 1, "older");
    const seam = envelope("2026-06-10T09:30:00.000Z", 2, "seam");
    const seamFromDisk = envelope("2026-06-10T09:30:00.000Z", 2, "seam");
    const tail = envelope("2026-06-10T10:00:00.000Z", 3, "tail");

    const existing = [seam, tail];
    const merged = prependOlderChatHistoryPage([older, seamFromDisk], existing);

    expect(merged.map((entry) => (entry.event.type === "text" ? entry.event.text : ""))).toEqual([
      "older",
      "seam",
      "tail",
    ]);
    expect(merged[1]).toBe(seam);
  });

  it("returns the existing array unchanged when the page contributes nothing", () => {
    const seam = envelope("2026-06-10T09:30:00.000Z", 2, "seam");
    const seamFromDisk = envelope("2026-06-10T09:30:00.000Z", 2, "seam");
    const existing = [seam];

    expect(prependOlderChatHistoryPage([], existing)).toBe(existing);
    expect(prependOlderChatHistoryPage([seamFromDisk], existing)).toBe(existing);
  });

  it("keeps same-millisecond fragments with distinct payloads", () => {
    const fragmentA = envelope("2026-06-10T09:30:00.000Z", 1, "fragment-a");
    const fragmentB = envelope("2026-06-10T09:30:00.000Z", 2, "fragment-b");

    const merged = prependOlderChatHistoryPage([fragmentA], [fragmentB]);

    expect(merged.map((entry) => (entry.event.type === "text" ? entry.event.text : ""))).toEqual([
      "fragment-a",
      "fragment-b",
    ]);
  });
});

describe("mergeOlderChatHistoryPageWithCap", () => {
  function envelope(timestamp: string, sequence: number, text: string): AgentChatEventEnvelope {
    return {
      sessionId: "session-1",
      timestamp,
      sequence,
      event: { type: "text", text },
    };
  }

  it("keeps the existing event list when an older page is only a seam duplicate", () => {
    const seam = envelope("2026-06-10T09:30:00.000Z", 2, "seam");
    const seamFromDisk = envelope("2026-06-10T09:30:00.000Z", 2, "seam");
    const existing = [seam];

    const merged = mergeOlderChatHistoryPageWithCap({
      older: [seamFromDisk],
      existing,
      maxEvents: 10,
    });

    expect(merged.events).toBe(existing);
    expect(merged.hitResidentCap).toBe(false);
  });

  it("reports when a prepended page would exceed the resident history cap", () => {
    const older = envelope("2026-06-10T09:00:00.000Z", 1, "older");
    const loadedA = envelope("2026-06-10T10:00:00.000Z", 2, "loaded-a");
    const loadedB = envelope("2026-06-10T10:01:00.000Z", 3, "loaded-b");
    const loadedC = envelope("2026-06-10T10:02:00.000Z", 4, "loaded-c");

    const merged = mergeOlderChatHistoryPageWithCap({
      older: [older],
      existing: [loadedA, loadedB, loadedC],
      maxEvents: 3,
    });

    expect(merged.events.map((entry) => (entry.event.type === "text" ? entry.event.text : ""))).toEqual([
      "older",
      "loaded-a",
      "loaded-b",
    ]);
    expect(merged.hitResidentCap).toBe(true);
  });

  it("bounds resident history by bytes even when the event count is small", () => {
    const older = envelope("2026-06-10T09:00:00.000Z", 1, `older-${"x".repeat(700_000)}`);
    const loadedA = envelope("2026-06-10T10:00:00.000Z", 2, `loaded-a-${"x".repeat(700_000)}`);
    const loadedB = envelope("2026-06-10T10:01:00.000Z", 3, `loaded-b-${"x".repeat(700_000)}`);

    const merged = mergeOlderChatHistoryPageWithCap({
      older: [older],
      existing: [loadedA, loadedB],
      maxEvents: 10,
      maxBytes: 2_000_000,
    });

    expect(merged.events).toEqual([older]);
    expect(merged.hitResidentCap).toBe(true);
  });

  it("keeps prepended history when the loaded snapshot has reached the initial hydration cap", () => {
    const older = envelope("2026-06-10T08:59:00.000Z", 0, "older-page");
    const existing = Array.from({ length: 20_000 }, (_, index) =>
      envelope(
        new Date(Date.UTC(2026, 5, 10, 9, 0, index % 60)).toISOString(),
        index + 1,
        `loaded-${index}`,
      ));

    const merged = mergeOlderChatHistoryPageWithCap({
      older: [older],
      existing,
      maxEvents: 60_000,
    });

    expect(merged.hitResidentCap).toBe(false);
    expect(merged.events).toHaveLength(existing.length + 1);
    expect(merged.events[0]).toBe(older);
  });
});

describe("shouldCacheAgentChatSessionView", () => {
  const MB = 1024 * 1024;

  it("admits a real selected chat (20k events / ~20MB) instead of refusing every non-trivial transcript", () => {
    // The old 1,000-event ceiling was below the selected-chat resident limit,
    // so no chat a user actually reads was ever cacheable and every switch
    // paid a full transcript re-read.
    expect(shouldCacheAgentChatSessionView(20_000, 20_000, 20 * MB)).toBe(true);
    expect(shouldCacheAgentChatSessionView(1_001, 20_000, 2 * MB)).toBe(true);
    expect(shouldCacheAgentChatSessionView(60_000, 60_000, 31 * MB)).toBe(true);
  });

  it("does not cache a trimmed view with a cursor that could skip uncached events", () => {
    expect(shouldCacheAgentChatSessionView(1_001, 1_000, 0)).toBe(false);
  });

  it("rejects a view over the 32MB per-session byte budget", () => {
    expect(shouldCacheAgentChatSessionView(2, 20_000, 32 * MB)).toBe(true);
    expect(shouldCacheAgentChatSessionView(2, 20_000, 32 * MB + 1)).toBe(false);
  });

  // Detachment is no longer this predicate's concern: the writer returns early
  // for a detached view, so the predicate never sees one.
});

describe("selectDepartedChatSessionViewCacheSessions", () => {
  it("reports only sessions that left this pane's roster", () => {
    // The module-level view cache outlives every pane, so a chat that is
    // deleted (or whose project closed) must be named explicitly or its whole
    // transcript stays resident until newer chats push it out.
    expect(selectDepartedChatSessionViewCacheSessions(
      ["gone", "still-here"],
      new Set(["still-here", "brand-new"]),
    )).toEqual(["gone"]);
  });

  it("never reports the session the user is currently reading", () => {
    // A roster refresh can land momentarily empty; evicting the selected chat's
    // cache on that would blank-then-refetch the transcript in front of them.
    expect(selectDepartedChatSessionViewCacheSessions(
      ["selected", "locked", "other"],
      new Set<string>(),
      ["selected", "locked", null],
    )).toEqual(["other"]);
  });

  it("reports nothing when the roster only grew", () => {
    expect(selectDepartedChatSessionViewCacheSessions(
      ["a"],
      new Set(["a", "b"]),
    )).toEqual([]);
  });
});

describe("selectAgentChatSessionViewEvictions", () => {
  const MB = 1024 * 1024;

  it("keeps everything under both ceilings", () => {
    expect(selectAgentChatSessionViewEvictions([
      { sessionId: "a", estimatedBytes: 10 * MB },
      { sessionId: "b", estimatedBytes: 10 * MB },
    ])).toEqual([]);
  });

  it("evicts oldest-first until the 128MB total is respected", () => {
    // 4 x 45MB = 180MB: dropping the two oldest brings the total to 90MB.
    const entries = ["a", "b", "c", "d"].map((sessionId) => ({ sessionId, estimatedBytes: 45 * MB }));
    expect(selectAgentChatSessionViewEvictions(entries)).toEqual(["a", "b"]);
  });

  it("evicts oldest-first until the entry ceiling is respected", () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      sessionId: `s${index}`,
      estimatedBytes: 1_024,
    }));
    expect(selectAgentChatSessionViewEvictions(entries)).toEqual(["s0", "s1"]);
  });
});

describe("resolveSnapshotHistoryCursor", () => {
  it("reports no older history when the runtime says so, whatever the tail offset", () => {
    // The false-banner fix: a truncated-looking tail offset must not offer a
    // "load earlier messages" affordance the service can never satisfy.
    expect(resolveSnapshotHistoryCursor({ hasOlderHistory: false, tailStartOffset: 1_048_576 })).toBe(0);
    expect(resolveSnapshotHistoryCursor({ hasOlderHistory: false, tailStartOffset: 1 })).toBe(0);
    expect(resolveSnapshotHistoryCursor({ hasOlderHistory: false })).toBe(0);
  });

  it("seeds the cursor from the tail offset when older history exists", () => {
    expect(resolveSnapshotHistoryCursor({ hasOlderHistory: true, tailStartOffset: 4_096 })).toBe(4_096);
    expect(resolveSnapshotHistoryCursor({ hasOlderHistory: true, tailStartOffset: 0 })).toBe(0);
    expect(resolveSnapshotHistoryCursor({ hasOlderHistory: true, tailStartOffset: -3 })).toBe(0);
    expect(resolveSnapshotHistoryCursor({ hasOlderHistory: true })).toBe(0);
  });

  it("falls back to legacy offset-only behaviour for runtimes that omit the field", () => {
    expect(resolveSnapshotHistoryCursor({ tailStartOffset: 4_096 })).toBe(4_096);
    expect(resolveSnapshotHistoryCursor({ tailStartOffset: 0 })).toBe(0);
    expect(resolveSnapshotHistoryCursor({})).toBe(0);
  });
});

describe("resolveRenderedChatSessionId", () => {
  it("renders the locked chat even while the selection state still trails it", () => {
    // The stale-frame fix: the outgoing chat's transcript must never be
    // visible once the pane has been pointed at a different chat.
    expect(resolveRenderedChatSessionId({
      lockSessionId: "incoming",
      appliedInitialSessionId: null,
      selectedSessionId: "outgoing",
    })).toBe("incoming");
  });

  it("renders an initial session id the sync effect has not applied yet", () => {
    expect(resolveRenderedChatSessionId({
      initialSessionId: "incoming",
      appliedInitialSessionId: "outgoing",
      selectedSessionId: "outgoing",
    })).toBe("incoming");
  });

  it("hands the selection back to in-pane state once the prop has been applied", () => {
    expect(resolveRenderedChatSessionId({
      initialSessionId: "opened-with",
      appliedInitialSessionId: "opened-with",
      selectedSessionId: "picked-in-pane",
    })).toBe("picked-in-pane");
  });

  it("renders nothing for a draft composer", () => {
    expect(resolveRenderedChatSessionId({
      appliedInitialSessionId: null,
      selectedSessionId: null,
    })).toBeNull();
  });
});

describe("resolveChatHistoryMissAction", () => {
  it("never destroys state when the runtime was merely unreachable", () => {
    expect(resolveChatHistoryMissAction({ unavailable: true, hasRenderedEvents: true })).toBe("sync-pending");
    expect(resolveChatHistoryMissAction({ unavailable: true, hasRenderedEvents: false })).toBe("sync-pending");
  });

  it("keeps a rendered transcript even for an authoritative miss", () => {
    expect(resolveChatHistoryMissAction({ hasRenderedEvents: true })).toBe("keep-missing");
    expect(resolveChatHistoryMissAction({ unavailable: false, hasRenderedEvents: true })).toBe("keep-missing");
  });

  it("only clears when the miss is authoritative and nothing is on screen", () => {
    expect(resolveChatHistoryMissAction({ hasRenderedEvents: false })).toBe("clear");
    expect(resolveChatHistoryMissAction({ unavailable: false, hasRenderedEvents: false })).toBe("clear");
  });
});

describe("advanceOlderHistoryCursor", () => {
  it("follows a strictly decreasing cursor while more history exists", () => {
    expect(advanceOlderHistoryCursor(10_000, { startOffset: 4_000, hasMore: true })).toBe(4_000);
  });

  it("returns 0 when the head is reached", () => {
    expect(advanceOlderHistoryCursor(10_000, { startOffset: 0, hasMore: false })).toBe(0);
    expect(advanceOlderHistoryCursor(10_000, { startOffset: 4_000, hasMore: false })).toBe(0);
  });

  it("rejects malformed (non-decreasing or invalid) cursors without claiming the head was reached", () => {
    expect(advanceOlderHistoryCursor(10_000, { startOffset: 10_000, hasMore: true })).toBeNull();
    expect(advanceOlderHistoryCursor(10_000, { startOffset: 12_000, hasMore: true })).toBeNull();
    expect(advanceOlderHistoryCursor(10_000, { startOffset: -5, hasMore: true })).toBeNull();
    expect(advanceOlderHistoryCursor(10_000, { startOffset: Number.NaN, hasMore: true })).toBeNull();
  });
});

describe("resolveMergedSnapshotHistoryCursor", () => {
  const event = (sequence: number, text: string) => ({
    sessionId: "session-1",
    sequence,
    timestamp: `2026-07-28T12:00:0${sequence}.000Z`,
    event: { type: "assistant", text },
  } as unknown as AgentChatEventEnvelope);

  it("keeps a completed cursor at the head when a bounded refresh overlaps the resident transcript", () => {
    const existing = [event(1, "oldest"), event(2, "middle"), event(3, "latest")];
    expect(resolveMergedSnapshotHistoryCursor({
      snapshotCursor: 8_192,
      currentCursor: 0,
      snapshotEvents: existing.slice(1),
      existingEvents: existing,
      mergedEvents: existing,
      detached: false,
    })).toBe(0);
  });

  it("re-arms paging for a detached or replaced transcript", () => {
    const existing = [event(1, "oldest"), event(2, "latest")];
    const replacement = [event(9, "replacement")];
    expect(resolveMergedSnapshotHistoryCursor({
      snapshotCursor: 8_192,
      currentCursor: 0,
      snapshotEvents: existing.slice(1),
      existingEvents: existing,
      mergedEvents: existing,
      detached: true,
    })).toBe(8_192);
    expect(resolveMergedSnapshotHistoryCursor({
      snapshotCursor: 8_192,
      currentCursor: 0,
      snapshotEvents: replacement,
      existingEvents: existing,
      mergedEvents: replacement,
      detached: false,
    })).toBe(8_192);
  });

  it("re-arms paging when refresh trimming evicted the previously loaded head", () => {
    const existing = [event(1, "oldest"), event(2, "middle"), event(3, "latest")];
    expect(resolveMergedSnapshotHistoryCursor({
      snapshotCursor: 8_192,
      currentCursor: 0,
      snapshotEvents: existing.slice(1),
      existingEvents: existing,
      mergedEvents: existing.slice(1),
      detached: false,
    })).toBe(8_192);
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
    const freshKey = getChatActionsAutoOpenStorageKey("fresh-session");
    const staleKey = getChatActionsAutoOpenStorageKey("stale-session");
    const legacyKey = getChatActionsAutoOpenStorageKey("legacy-session");
    const storage = createStorageShim();

    storage.setItem(freshKey, JSON.stringify({ firedAt: now - 60_000 }));
    storage.setItem(staleKey, JSON.stringify({ firedAt: now - 8 * 24 * 60 * 60 * 1000 }));
    storage.setItem(legacyKey, "1");
    storage.setItem("ade.chat.other", "keep");

    cleanupChatActionsAutoOpenStorage(storage, now);

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

// Companion-state persistence, migration and pruning are the module's own
// contract and live in `chatCompanionUiState.test.ts`. Only the two cases with
// no equivalent there are kept here.
describe("older transcript paging retries", () => {
  const historySnapshotWithOlderPages = (sessionId: string): AgentChatEventHistorySnapshot => ({
    sessionId,
    events: [{
      sessionId,
      timestamp: "2026-07-10T12:00:00.000Z",
      sequence: 1,
      event: { type: "user_message" as const, text: "newest visible message" },
    }],
    truncated: false,
    sessionFound: true,
    hasOlderHistory: true,
    tailStartOffset: 4_096,
  } as AgentChatEventHistorySnapshot);

  /**
   * Ask for the next older page the way a reader does. The transcript's own
   * "underfilled viewport" backfill runs inside `requestAnimationFrame`, which
   * jsdom does not reliably drive across a whole suite run, so drive the
   * scroll-driven path instead — same `maybeRequestOlderHistory` entry point.
   */
  async function requestOlderHistoryByScroll() {
    const pane = await waitFor(() => {
      const el = document.querySelector(".ade-chat-timeline-pane");
      if (!el) throw new Error("transcript scroller not mounted");
      return el;
    });
    fireEvent.scroll(pane, { target: { scrollTop: 0 } });
  }

  it("retries a failing page twice with backoff before latching a visible error", async () => {
    const session = buildSession("session-1", { title: "Long chat" });
    let pageAttempts = 0;
    let resolveManualPage!: (page: AgentChatEventHistoryPage) => void;
    const manualPage = new Promise<AgentChatEventHistoryPage>((resolve) => {
      resolveManualPage = resolve;
    });
    installAdeMocks({
      sessions: [session],
      eventHistory: historySnapshotWithOlderPages(session.sessionId),
      eventHistoryPage: async () => {
        pageAttempts += 1;
        if (pageAttempts <= 3) throw new Error("remote hop dropped");
        return manualPage;
      },
    });

    renderPane(session);

    expect(await screen.findByText("newest visible message")).toBeTruthy();
    await requestOlderHistoryByScroll();

    await waitFor(() => expect(pageAttempts).toBeGreaterThanOrEqual(1), { timeout: 4_000 });
    // The two backoff retries (800ms, 2400ms) run silently — no retry control
    // is offered to the reader while the ladder is still going.
    expect(screen.queryByLabelText("Retry loading earlier messages")).toBeNull();

    await waitFor(() => expect(pageAttempts).toBe(3), { timeout: 8_000 });
    expect(await screen.findByLabelText("Retry loading earlier messages", {}, { timeout: 4_000 })).toBeTruthy();
    // The ladder is bounded: a latched error stops it rather than hammering on.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    });
    expect(pageAttempts).toBe(3);

    fireEvent.click(screen.getByLabelText("Retry loading earlier messages"));
    await waitFor(() => expect(pageAttempts).toBe(4));
    expect((screen.getByLabelText("Loading earlier messages") as HTMLButtonElement).disabled).toBe(true);

    resolveManualPage({
      sessionId: session.sessionId,
      events: [{
        sessionId: session.sessionId,
        timestamp: "2026-07-10T11:59:00.000Z",
        sequence: 0,
        event: { type: "user_message", text: "older message recovered" },
      }],
      startOffset: 2_048,
      hasMore: true,
      sessionFound: true,
    });
    expect(await screen.findByText("older message recovered")).toBeTruthy();
    expect(screen.queryByLabelText("Retry loading earlier messages")).toBeNull();
  }, 25_000);

  it("retries an unreachable page instead of treating it as a missing session", async () => {
    const session = buildSession("session-1", { title: "Long chat" });
    let pageAttempts = 0;
    installAdeMocks({
      sessions: [session],
      eventHistory: historySnapshotWithOlderPages(session.sessionId),
      // Exactly what preload synthesises when the runtime can't be reached:
      // `sessionFound: false` AND `unavailable: true`. Read as a plain miss it
      // zeroes the cursor, which unmounts the "load older" sentinel for good —
      // scroll-back stays dead until a forced re-hydrate, and because nothing
      // threw, the retry ladder never engaged.
      eventHistoryPage: async (args) => {
        pageAttempts += 1;
        return {
          sessionId: args.sessionId,
          events: [],
          startOffset: 0,
          hasMore: false,
          sessionFound: false,
          unavailable: true,
        };
      },
    });

    renderPane(session);

    expect(await screen.findByText("newest visible message")).toBeTruthy();
    await requestOlderHistoryByScroll();

    // The ladder runs: one attempt plus its two retries.
    await waitFor(() => expect(pageAttempts).toBe(3), { timeout: 8_000 });
    // And the cursor survives, so the reader still has a way back — a zeroed
    // cursor would have removed this control along with the sentinel.
    expect(await screen.findByLabelText("Retry loading earlier messages", {}, { timeout: 4_000 })).toBeTruthy();
  }, 25_000);

  it("keeps Retry available when a page claims more history without advancing its cursor", async () => {
    const session = buildSession("session-1", { title: "Long chat" });
    let pageAttempts = 0;
    installAdeMocks({
      sessions: [session],
      eventHistory: historySnapshotWithOlderPages(session.sessionId),
      eventHistoryPage: async (args) => {
        pageAttempts += 1;
        return {
          sessionId: args.sessionId,
          events: [],
          startOffset: args.beforeOffset,
          hasMore: true,
          sessionFound: true,
        };
      },
    });

    renderPane(session);
    expect(await screen.findByText("newest visible message")).toBeTruthy();
    await requestOlderHistoryByScroll();

    await waitFor(() => expect(pageAttempts).toBe(3), { timeout: 8_000 });
    expect(await screen.findByLabelText("Retry loading earlier messages", {}, { timeout: 4_000 })).toBeTruthy();
  }, 25_000);

  it("drops a successful older page that arrives after the selected chat changes", async () => {
    const sessionA = buildSession("session-1", { title: "Chat A" });
    const sessionB = buildSession("session-2", { title: "Chat B" });
    let resolveSessionAPage!: (page: AgentChatEventHistoryPage) => void;
    const sessionAPage = new Promise<AgentChatEventHistoryPage>((resolve) => {
      resolveSessionAPage = resolve;
    });
    let sessionAPageRequested = false;
    let sessionAPageCalls = 0;
    const laterSessionAPage = new Promise<AgentChatEventHistoryPage>(() => {});
    installAdeMocks({
      sessions: [sessionA, sessionB],
      eventHistory: (args) => historySnapshotWithOlderPages(args.sessionId),
      eventHistoryPage: async (args) => {
        if (args.sessionId === sessionA.sessionId) {
          sessionAPageCalls += 1;
          sessionAPageRequested = true;
          return sessionAPageCalls === 1 ? sessionAPage : laterSessionAPage;
        }
        return {
          sessionId: args.sessionId,
          events: [],
          startOffset: 0,
          hasMore: false,
          sessionFound: true,
        };
      },
    });

    const view = render(
      <MemoryRouter>
        <AgentChatPane
          laneId={sessionA.laneId}
          lockSessionId={sessionA.sessionId}
          hideSessionTabs
          initialSessionSummary={sessionA}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByText("newest visible message");
    await requestOlderHistoryByScroll();
    await waitFor(() => expect(sessionAPageRequested).toBe(true));

    view.rerender(
      <MemoryRouter>
        <AgentChatPane
          laneId={sessionB.laneId}
          lockSessionId={sessionB.sessionId}
          hideSessionTabs
          initialSessionSummary={sessionB}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByText("newest visible message");
    await act(async () => {
      resolveSessionAPage({
        sessionId: sessionA.sessionId,
        events: [{
          sessionId: sessionA.sessionId,
          timestamp: "2026-07-10T11:59:00.000Z",
          sequence: 0,
          event: { type: "user_message", text: "stale older message" },
        }],
        startOffset: 0,
        hasMore: false,
        sessionFound: true,
      });
    });

    view.rerender(
      <MemoryRouter>
        <AgentChatPane
          laneId={sessionA.laneId}
          lockSessionId={sessionA.sessionId}
          hideSessionTabs
          initialSessionSummary={sessionA}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByText("newest visible message");
    expect(screen.queryByText("stale older message")).toBeNull();
  });

  it("does not latch an interactive retry error after the selected chat changes", async () => {
    const sessionA = buildSession("session-1", { title: "Chat A" });
    const sessionB = buildSession("session-2", { title: "Chat B" });
    let pageAttempts = 0;
    let rejectInteractivePage!: (error: Error) => void;
    const interactivePage = new Promise<AgentChatEventHistoryPage>((_resolve, reject) => {
      rejectInteractivePage = reject;
    });
    installAdeMocks({
      sessions: [sessionA, sessionB],
      eventHistory: (args) => historySnapshotWithOlderPages(args.sessionId),
      eventHistoryPage: async () => {
        pageAttempts += 1;
        if (pageAttempts <= 3) throw new Error("remote hop dropped");
        return interactivePage;
      },
    });

    const view = render(
      <MemoryRouter>
        <AgentChatPane
          laneId={sessionA.laneId}
          lockSessionId={sessionA.sessionId}
          hideSessionTabs
          initialSessionSummary={sessionA}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByText("newest visible message");
    await requestOlderHistoryByScroll();
    const retry = await screen.findByLabelText("Retry loading earlier messages", {}, { timeout: 8_000 });
    fireEvent.click(retry);
    await waitFor(() => expect(pageAttempts).toBe(4));

    view.rerender(
      <MemoryRouter>
        <AgentChatPane
          laneId={sessionB.laneId}
          lockSessionId={sessionB.sessionId}
          hideSessionTabs
          initialSessionSummary={sessionB}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );
    await act(async () => {
      rejectInteractivePage(new Error("late remote failure"));
    });

    view.rerender(
      <MemoryRouter>
        <AgentChatPane
          laneId={sessionA.laneId}
          lockSessionId={sessionA.sessionId}
          hideSessionTabs
          initialSessionSummary={sessionA}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText("Retry loading earlier messages")).toBeNull();
  }, 25_000);

  it("cancels pending paging retries when the session switches", async () => {
    const sessionA = buildSession("session-1", { title: "Chat A" });
    const sessionB = buildSession("session-2", { title: "Chat B" });
    const pageAttemptsBySession = new Map<string, number>();
    const attemptsFor = (sessionId: string) => pageAttemptsBySession.get(sessionId) ?? 0;
    installAdeMocks({
      sessions: [sessionA, sessionB],
      eventHistory: (args) => historySnapshotWithOlderPages(args.sessionId),
      eventHistoryPage: async (args) => {
        pageAttemptsBySession.set(args.sessionId, attemptsFor(args.sessionId) + 1);
        throw new Error("remote hop dropped");
      },
    });

    const view = render(
      <MemoryRouter>
        <AgentChatPane
          laneId={sessionA.laneId}
          lockSessionId={sessionA.sessionId}
          hideSessionTabs
          initialSessionSummary={sessionA}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByText("newest visible message");
    await requestOlderHistoryByScroll();
    await waitFor(() => expect(attemptsFor(sessionA.sessionId)).toBe(1), { timeout: 4_000 });

    // Switching chats cancels the backoff waiters, so the ladder must not keep
    // firing against the chat nobody is looking at any more.
    view.rerender(
      <MemoryRouter>
        <AgentChatPane
          laneId={sessionB.laneId}
          lockSessionId={sessionB.sessionId}
          hideSessionTabs
          initialSessionSummary={sessionB}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByText("newest visible message");
    const sessionAAttemptsAtSwitch = attemptsFor(sessionA.sessionId);

    // Comfortably past both backoff steps (800ms + 2400ms) of chat A's ladder.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    });

    expect(attemptsFor(sessionA.sessionId)).toBe(sessionAAttemptsAtSwitch);
    // Control: chat B's own ladder DOES run its retries in the same window when
    // asked, so the assertion above is proving cancellation, not a short wait.
    await requestOlderHistoryByScroll();
    await waitFor(() => expect(attemptsFor(sessionB.sessionId)).toBe(3), { timeout: 8_000 });
    expect(attemptsFor(sessionA.sessionId)).toBe(sessionAAttemptsAtSwitch);
  }, 30_000);
});

describe("AgentChatPane per-chat runtime routing", () => {
  const emptyHistory = (sessionId: string): AgentChatEventHistorySnapshot => ({
    sessionId,
    events: [],
    truncated: false,
    sessionFound: true,
  });
  const machineA = {
    kind: "local" as const,
    key: "local:/repo-a",
    rootPath: "/repo-a",
    displayName: "Machine A",
  };
  const machineB = {
    kind: "remote" as const,
    key: "remote:target-b:project-b",
    targetId: "target-b",
    runtimeName: "machine-b",
    projectId: "project-b",
    rootPath: "/repo-b",
    displayName: "Machine B",
  };

  function bindWindowToMachineA(options?: { includeMachineB?: boolean; laneOnB?: string }) {
    useAppStore.setState({
      project: { rootPath: "/repo-a", displayName: "Machine A" } as any,
      projectBinding: machineA as any,
      openProjectTabRoots: ["/repo-a"],
      openRemoteProjectTabs: (options?.includeMachineB === false ? [] : [machineB]) as any,
      projectInfoByRoot: { "/repo-a": { rootPath: "/repo-a", displayName: "Machine A" } } as any,
      lanes: [{ id: "lane-a", name: "lane on A" }] as any,
      laneCacheByProject: {
        [machineB.key]: {
          lanes: [{ id: options?.laneOnB ?? "lane-b", name: "lane on B" }],
          laneSnapshots: [],
        },
      } as any,
    });
  }

  function bindWindowToMachineB() {
    useAppStore.setState({
      project: { rootPath: "/repo-b", displayName: "Machine B" } as any,
      projectBinding: machineB as any,
      openProjectTabRoots: ["/repo-a"],
      openRemoteProjectTabs: [machineB] as any,
      projectInfoByRoot: { "/repo-a": { rootPath: "/repo-a", displayName: "Machine A" } } as any,
      lanes: [{ id: "lane-b", name: "lane on B" }] as any,
      laneCacheByProject: {
        [machineA.rootPath]: {
          lanes: [{ id: "lane-a", name: "lane on A" }],
          laneSnapshots: [],
        },
      } as any,
    });
  }

  it("streams a chat whose lane lives on another machine from THAT machine, without rebinding the tab", async () => {
    bindWindowToMachineA();
    const session = buildSession("chat-on-b", { laneId: "lane-b", title: "Foreign chat" });
    useAppStore.setState({ focusedSessionId: session.sessionId });
    installAdeMocks({ sessions: [session], eventHistory: emptyHistory("chat-on-b") });

    renderPane(session);

    const getEventHistory = window.ade.agentChat.getEventHistory as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(getEventHistory.mock.calls.length).toBeGreaterThan(0));
    // The chat's history read is pinned to machine B's binding...
    expect(getEventHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chat-on-b" }),
      machineB,
    );
    expect(window.ade.agentChat.onEvent).toHaveBeenCalledWith(
      expect.any(Function),
      machineB,
    );
    await waitFor(() => expect(window.ade.agentChat.slashCommands).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chat-on-b" }),
      machineB,
    ));
    // ...and the window's project tab is STILL bound to machine A.
    expect(useAppStore.getState().projectBinding).toEqual(machineA);
  });

  it("pins This Mac history and live events while the project tab stays remote-bound", async () => {
    bindWindowToMachineB();
    const session = buildSession("chat-on-a", { laneId: "lane-a", title: "This Mac chat" });
    installAdeMocks({ sessions: [session], eventHistory: emptyHistory("chat-on-a") });

    renderPane(session);

    const getEventHistory = window.ade.agentChat.getEventHistory as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(getEventHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chat-on-a" }),
      machineA,
    ));
    expect(window.ade.agentChat.onEvent).toHaveBeenCalledWith(
      expect.any(Function),
      machineA,
    );
    expect(useAppStore.getState().projectBinding).toEqual(machineB);
  });

  it("leaves a chat on the active binding on the unpinned path", async () => {
    bindWindowToMachineA();
    const session = buildSession("chat-on-a", { laneId: "lane-a", title: "Local chat" });
    installAdeMocks({ sessions: [session], eventHistory: emptyHistory("chat-on-a") });

    renderPane(session);

    const getEventHistory = window.ade.agentChat.getEventHistory as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(getEventHistory.mock.calls.length).toBeGreaterThan(0));
    // No pin argument at all — byte-for-byte the pre-routing call.
    expect(getEventHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chat-on-a" }),
    );
    expect(useAppStore.getState().projectBinding).toEqual(machineA);
  });

  it("passes the effective remote project binding to prompt stashes when the chat pin is null", async () => {
    bindWindowToMachineB();
    const session = buildSession("chat-on-b", { laneId: "lane-b", title: "Remote-bound chat" });
    installAdeMocks({ sessions: [session], eventHistory: emptyHistory("chat-on-b") });

    renderPane(session);

    await waitFor(() => expect(window.ade.agentChat.promptStashes.list).toHaveBeenCalledWith(
      machineB,
    ));
    expect(useAppStore.getState().projectBinding).toEqual(machineB);
  });

  it("routes a prop-driven incoming local chat independently of the outgoing remote selection", async () => {
    bindWindowToMachineA();
    const outgoing = buildSession("chat-on-b", { laneId: "lane-b", title: "Outgoing remote chat" });
    const incoming = buildSession("chat-on-a", { laneId: "lane-a", title: "Incoming local chat" });
    installAdeMocks({
      sessions: [outgoing, incoming],
      eventHistory: (args) => emptyHistory(args.sessionId),
    });

    const view = render(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-b"
          initialSessionId={outgoing.sessionId}
          initialSessionSummary={outgoing}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );
    const getEventHistory = window.ade.agentChat.getEventHistory as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(getEventHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: outgoing.sessionId }),
      machineB,
    ));

    getEventHistory.mockClear();
    view.rerender(
      <MemoryRouter>
        <AgentChatPane
          laneId="lane-b"
          initialSessionId={incoming.sessionId}
          initialSessionSummary={incoming}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getEventHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: incoming.sessionId }),
    ));
    expect(getEventHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: incoming.sessionId }),
      machineB,
    );
    expect(useAppStore.getState().projectBinding).toEqual(machineA);
  });

  it("does not pin when the lane's machine is not open in this window", async () => {
    bindWindowToMachineA({ includeMachineB: false });
    const session = buildSession("chat-on-b", { laneId: "lane-b", title: "Unreachable machine" });
    installAdeMocks({ sessions: [session], eventHistory: emptyHistory("chat-on-b") });

    renderPane(session);

    const getEventHistory = window.ade.agentChat.getEventHistory as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(getEventHistory.mock.calls.length).toBeGreaterThan(0));
    expect(getEventHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chat-on-b" }),
    );
  });

  it("pins a union chat even when its machine has no project tab", async () => {
    bindWindowToMachineA({ includeMachineB: false });
    useAppStore.setState({
      crossMachineLanesByMachineId: {
        "target-b": {
          machineId: "target-b",
          machineName: "machine-b",
          targetId: "target-b",
          projectId: "project-b",
          binding: machineB,
          online: true,
          lanes: [{ id: "lane-b", name: "lane on B" }],
          sessions: [],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
      },
    } as any);
    const session = buildSession("chat-on-b", { laneId: "lane-b", title: "Union chat" });
    installAdeMocks({ sessions: [session], eventHistory: emptyHistory("chat-on-b") });

    renderPane(session);

    const getEventHistory = window.ade.agentChat.getEventHistory as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(getEventHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chat-on-b" }),
      machineB,
    ));
    expect(useAppStore.getState().projectBinding).toEqual(machineA);
  });

  it("pins deletion of the selected foreign chat to its owning machine", async () => {
    bindWindowToMachineA();
    const session = buildSession("chat-on-b", { laneId: "lane-b", title: "Foreign chat" });
    const mocks = installAdeMocks({ sessions: [session], eventHistory: emptyHistory("chat-on-b") });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <MemoryRouter>
        <AgentChatPane
          laneId={session.laneId}
          initialSessionSummary={session}
          onSessionCreated={vi.fn()}
        />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Foreign chat/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete chat" }));
    await waitFor(() => {
      expect(mocks.deleteChat).toHaveBeenCalledWith(
        { sessionId: "chat-on-b" },
        machineB,
      );
    });
    expect(useAppStore.getState().projectBinding).toEqual(machineA);
    confirmSpy.mockRestore();
  });

  it("pins selected-chat transcripts, goals, schedules, and handoff as one control class", async () => {
    bindWindowToMachineA();
    const schedule = {
      id: "schedule-1",
      sessionId: "chat-on-b",
      kind: "wakeup" as const,
      status: "scheduled" as const,
      title: "Nightly wake",
      prompt: "continue",
      nextRunAt: "2026-07-28T03:00:00.000Z",
      createdAt: "2026-07-27T18:00:00.000Z",
      durable: true,
      cancellable: true,
    };
    const session = buildSession("chat-on-b", {
      laneId: "lane-b",
      title: "Foreign controls",
      status: "idle",
      codexGoal: {
        objective: "Ship clean",
        status: "active",
      },
      scheduledWork: [schedule],
    });
    const mocks = installAdeMocks({ sessions: [session], eventHistory: emptyHistory(session.sessionId) });

    renderPane(session);
    const openActions = screen.queryByRole("button", { name: "Open chat actions drawer" });
    if (openActions) fireEvent.click(openActions);
    await waitFor(() => expect(window.ade.agentChat.getEventHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chat-on-b" }),
      machineB,
    ));
    await screen.findByText("Ship clean");

    fireEvent.click(screen.getByRole("button", { name: "Edit goal" }));
    const goalInput = screen.getByRole("textbox", { name: "Edit goal objective" });
    fireEvent.change(goalInput, { target: { value: "Ship cleaner" } });
    fireEvent.blur(goalInput);
    await waitFor(() => expect(mocks.setCodexGoal).toHaveBeenCalledWith(
      { sessionId: "chat-on-b", objective: "Ship cleaner" },
      machineB,
    ));

    fireEvent.click(screen.getByRole("button", { name: "Pause goal" }));
    await waitFor(() => expect(mocks.setCodexGoalStatus).toHaveBeenCalledWith(
      { sessionId: "chat-on-b", status: "paused" },
      machineB,
    ));
    fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
    await waitFor(() => expect(mocks.clearCodexGoal).toHaveBeenCalledWith(
      { sessionId: "chat-on-b" },
      machineB,
    ));

    fireEvent.click(screen.getByRole("button", { name: "Pause scheduled work for this chat" }));
    await waitFor(() => expect(mocks.setScheduledWorkPaused).toHaveBeenCalledWith(
      { sessionId: "chat-on-b", paused: true },
      machineB,
    ));
    fireEvent.click(screen.getByRole("button", { name: "Cancel Nightly wake" }));
    await waitFor(() => expect(mocks.cancelScheduledWork).toHaveBeenCalledWith(
      { sessionId: "chat-on-b", scheduleId: "schedule-1" },
      machineB,
    ));

    fireEvent.click(screen.getByRole("button", { name: "Handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: /Hand off locally/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Brief$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Start brief handoff" }));
    await waitFor(() => expect(mocks.handoff).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSessionId: "chat-on-b", mode: "brief" }),
      machineB,
    ));
    expect(useAppStore.getState().projectBinding).toEqual(machineA);
  });
});
