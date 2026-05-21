import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import {
  getDefaultModelDescriptor,
  getModelById,
  listModelDescriptorsForProvider,
  modelSupportsFastMode,
  resolveModelDescriptor,
  resolveProviderGroupForModel,
  type ModelProviderGroup,
} from "../../../desktop/src/shared/modelRegistry";
import { resolveClaudeCliModelForLaunch } from "../../../desktop/src/shared/cliLaunch";
import { CURSOR_AVAILABLE_MODE_IDS, CURSOR_MODE_LABELS } from "../../../desktop/src/shared/cursorModes";
import { getAdeAgentSkillRootCandidates } from "../../../desktop/src/shared/agentSkillRoots";
import type {
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatClaudePlugin,
  AgentChatReloadClaudePluginsResult,
  AgentChatContextUsage,
	  AgentChatEventEnvelope,
	  AgentChatFileRef,
	  AgentChatModelCatalog,
	  AgentChatModelCatalogModel,
	  AgentChatModelCatalogRefreshProvider,
	  AgentChatModelInfo,
  AgentChatPermissionMode,
  AgentChatSessionSummary,
  AgentChatSlashCommand,
  CodexThreadGoal,
} from "../../../desktop/src/shared/types/chat";
import type { AiSettingsStatus, OpenCodeRuntimeSnapshot } from "../../../desktop/src/shared/types/config";
import type { DiffLineStats } from "../../../desktop/src/shared/types/git";
import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import type { FeedbackPreparedDraft, FeedbackSubmission } from "../../../desktop/src/shared/types/feedback";
import type { ChatTerminalPreviewResult, ChatTerminalSession } from "../../../desktop/src/shared/types";
import {
  DEFAULT_CODEX_REASONING_EFFORT,
  approveToolUse,
  cancelSteerMessage,
  createChatSession,
  discoverProjectSlashCommands,
  dispatchSteerMessage,
  editSteerMessage,
  getAvailableModels,
  getAiSettingsStatus,
  getChatHistory,
	  getContextUsage,
	  getModelCatalog,
	  getModelPickerFavorites,
  getModelPickerRecents,
  pushModelPickerRecent,
  toggleModelPickerFavorite,
  getOpenCodeRuntimeDiagnostics,
  getSlashCommands,
  getStoredApiKeyProviders,
  interruptChat,
  latestGoal,
  latestTokenStats,
  listLaneDiffStats,
  listClaudePlugins,
  listClaudeOutputStyles,
  listChatSessions,
  listTerminalSessions,
  listLanes,
  listPrsByLane,
  navigateDesktop,
  newestSession,
  normalizeChatTerminalSession,
  previewTerminal,
  renameChat,
  resizeTerminal,
  reloadClaudePlugins,
  respondToInput,
  sendChatMessage,
  sendToTerminalSession,
  signalTerminal,
  setClaudeOutputStyle,
  startClaudeTerminalSession,
  steerChatMessage,
  tagChat,
  updateChatModel,
  writeTerminal,
  type TokenStats,
} from "./adeApi";
import { derivePendingSteers } from "./aggregate";
import { deriveChatInfoSnapshot } from "./chatInfo";
import { paletteCommands, parseCommand } from "./commands";
import { hasFirstUserMessage, isPlanMode } from "./planMode";
import { connectToAde } from "./connection";
import { Drawer, visibleDrawerChatCount, visibleDrawerLaneCount, type DrawerPrSummary } from "./components/Drawer";
import {
  ChatView,
  computeChatScrollMaxOffset,
  renderChatSelectableRowTexts,
  renderChatVisibleSelectionRows,
  selectedTextFromChatRows,
  type ChatVisibleSelectionRow,
  type ChatTextSelection,
} from "./components/ChatView";
import { TerminalPane, clampTerminalPaneCols } from "./components/TerminalPane";
import { Header } from "./components/Header";
import { computeLaneChatCounts, LANE_DETAIL_ACTIONS, RightPane } from "./components/RightPane";
import { buildModelPickerLayout, defaultSelectionFor } from "./components/ModelPicker/modelPickerLayout";
import { SlashPalette, SLASH_PALETTE_ROWS } from "./components/SlashPalette";
import { MentionPalette, MENTION_PALETTE_ROWS } from "./components/MentionPalette";
import { ApprovalPrompt } from "./components/ApprovalPrompt";
import { ModelStatus } from "./components/ModelStatus";
import { FooterControls } from "./components/FooterControls";
import { theme } from "./theme";
import { resolveTuiChatRefreshTarget } from "./project";
import { resolveDrawerChatSelection } from "./drawerSelection";
import { sortLanesForStackGraph } from "./laneTree";
import { latestExpandableFailureId, renderObject, summarizeDiffChanges } from "./format";
import { startTuiHeartbeat, type TuiHeartbeat } from "./heartbeat";
import { isImageFilePath, latestOpenableImageTarget, readClipboardImageAttachment, readImageDimensions } from "./imageTargets";
import { appendReservedTuiEvent, reserveTuiEventDedupKey, syncTuiEventDedupKeys } from "./eventDedup";
import { loadAdeCodeState, saveAdeCodeProjectState, scopedAdeCodeState } from "./state";
import { SpinTickProvider } from "./spinTick";
import { buildLinearToolRequest } from "./linearCommands";
import {
  buildFeedbackDraftInput,
  buildFeedbackEnvironment,
  feedbackFormFields,
  feedbackSubmissionNotice,
  type FeedbackFormValues,
} from "./feedback";
import { buildPendingInputAnswers, latestPendingApproval } from "./pendingInput";
import { claudeHomePath, defaultKeybindingsPath, dispatchKeybinding, openKeybindingsFile, readClaudeKeybindingsFile, type KeybindingDispatchState, type TuiKeybindingAction } from "./keybindings";
import {
  buildSubagentPaneRows,
  buildSubagentTranscriptEvents,
  subagentIndexForPaneLine,
  subagentPaneContentFromRightPane,
  type SubagentPaneRow,
} from "./subagentPane";
import { readClaudeStatusLineConfig, runClaudeStatusLineCommand } from "./statusline";
import type {
  AdeCodeConnection,
  AdeCodeProvider,
  AdeCodeModelState,
  LocalNotice,
  MentionSuggestion,
  PendingApproval,
  ProviderReadinessRow,
  ProjectLaunchContext,
  RightPaneContent,
  SetupPaneRow,
  SubagentSnapshot,
  RuntimeMode,
} from "./types";

const PURPLE = theme.color.accent;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PROVIDER_OPTIONS: Array<{ value: AdeCodeProvider; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
  { value: "droid", label: "Droid" },
  { value: "opencode", label: "OpenCode" },
  { value: "ollama", label: "Ollama" },
  { value: "lmstudio", label: "LM Studio" },
];
const PROVIDERS = new Set<AdeCodeProvider>(PROVIDER_OPTIONS.map((provider) => provider.value));
const CODEX_PRESETS = ["default", "plan", "full-auto", "config-toml"] as const;
const MODEL_CATALOG_CLIENT_REFRESH_TTL_MS = 5 * 60_000;
const MODEL_CATALOG_LOCAL_CLIENT_REFRESH_TTL_MS = 30_000;
const CLAUDE_PERMISSION_OPTIONS = ["default", "auto", "plan", "acceptEdits", "bypassPermissions"] as const;
const OPENCODE_PERMISSION_OPTIONS = ["plan", "edit", "full-auto"] as const;
const DROID_PERMISSION_OPTIONS = ["read-only", "auto-low", "auto-medium", "auto-high"] as const;
const SETTINGS_AI_ROUTE = "/settings?tab=ai#ai-providers";
type PaneFocus = "drawer" | "chat" | "details";
export type FooterControl = "drawer" | "details" | "agents";
type DrawerLaneAction = "new-lane";
type DrawerChatAction = "new-chat";

export function footerControlsForAvailability(agentsAvailable: boolean): FooterControl[] {
  return agentsAvailable ? ["agents", "drawer", "details"] : ["drawer", "details"];
}

function terminalSessionToChatSummary(session: ChatTerminalSession): AgentChatSessionSummary {
  const status: AgentChatSessionSummary["status"] = session.status === "running"
    ? session.runtimeState === "idle" ? "idle" : "active"
    : "ended";
  return {
    sessionId: session.terminalId,
    laneId: session.laneId,
    provider: "claude",
    model: "claude-code",
    title: session.title,
    goal: session.goal,
    permissionMode: session.resumeMetadata?.launch?.permissionMode ?? "default",
    status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    lastActivityAt: session.endedAt ?? session.startedAt,
    lastOutputPreview: session.lastOutputPreview,
    summary: session.summary,
    surface: "work",
  };
}

const DESKTOP_COMMAND_ROUTES: Record<string, string> = {
  "/app-control": "/app-control",
  "/browser": "/browser",
  "/computer": "/proof",
  "/computer-use": "/proof",
  "/ios": "/ios-sim",
  "/ios-sim": "/ios-sim",
  "/macos-vm": "/macos-vm",
  "/mission": "/missions",
  "/missions": "/missions",
  "/pencil": "/pencil",
  "/proof": "/proof",
};

type AdeCodeAppProps = {
  project: ProjectLaunchContext;
  forceEmbedded?: boolean;
  requireSocket?: boolean;
  socketPath?: string | null;
};

type RefreshStateOptions = {
  hydrateHistory?: boolean;
};

export function shouldHydrateRefreshHistory(args: {
  hydrateHistory?: boolean;
  currentSessionId: string | null;
  loadedSessionId: string | null;
  nextSessionId: string;
}): boolean {
  return args.hydrateHistory !== false
    || args.currentSessionId !== args.nextSessionId
    || args.loadedSessionId !== args.nextSessionId;
}

function initialModelState(): AdeCodeModelState {
  const descriptor = getDefaultModelDescriptor("codex");
  return {
    provider: "codex",
    model: descriptor?.providerModelId ?? "gpt-5.5",
    modelId: descriptor?.id ?? null,
    displayName: descriptor?.displayName ?? "GPT-5.5",
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    codexFastMode: false,
    permissionMode: "default",
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    opencodePermissionMode: "edit",
    droidPermissionMode: "auto-low",
    cursorModeId: "agent",
    cursorConfigValues: {},
  };
}

type CodexPreset = (typeof CODEX_PRESETS)[number];

function providerLabel(provider: AdeCodeProvider): string {
  return PROVIDER_OPTIONS.find((entry) => entry.value === provider)?.label ?? provider;
}

function normalizeProvider(value: string | null | undefined): AdeCodeProvider {
  return PROVIDERS.has(value as AdeCodeProvider) ? value as AdeCodeProvider : "codex";
}

function runtimeProviderForUiProvider(provider: AdeCodeProvider): ModelProviderGroup {
  return provider === "ollama" || provider === "lmstudio" ? "opencode" : provider;
}

function modelCatalogClientRefreshTtlMs(provider?: AgentChatModelCatalogRefreshProvider): number {
  return provider === "lmstudio" || provider === "ollama"
    ? MODEL_CATALOG_LOCAL_CLIENT_REFRESH_TTL_MS
    : MODEL_CATALOG_CLIENT_REFRESH_TTL_MS;
}

function firstReasoningEffortForModel(model: AgentChatModelInfo | null | undefined, provider: AdeCodeProvider): string | null {
  const efforts = model?.reasoningEfforts?.map((entry) => entry.effort).filter(Boolean) ?? [];
  if (efforts.includes(DEFAULT_CODEX_REASONING_EFFORT)) return DEFAULT_CODEX_REASONING_EFFORT;
  if (efforts.length) return efforts[0] ?? null;
  const descriptor = model?.modelId || model?.id ? getModelById(model.modelId ?? model.id) : undefined;
  const descriptorEfforts = descriptor?.reasoningTiers ?? [];
  if (descriptorEfforts.includes(DEFAULT_CODEX_REASONING_EFFORT)) return DEFAULT_CODEX_REASONING_EFFORT;
  if (descriptorEfforts.length) return descriptorEfforts[0] ?? null;
  return provider === "codex" ? DEFAULT_CODEX_REASONING_EFFORT : null;
}

function modelStatePatchForModel(provider: AdeCodeProvider, model: AgentChatModelInfo): Pick<AdeCodeModelState, "provider" | "model" | "modelId" | "displayName" | "reasoningEffort"> {
  const modelId = model.modelId ?? model.id;
  const descriptor = getModelById(modelId);
  const resolvedProvider = descriptor ? normalizeProvider(resolveProviderGroupForModel(descriptor)) : provider;
  return {
    provider: resolvedProvider,
    model: model.id,
    modelId,
    displayName: model.displayName,
    reasoningEffort: firstReasoningEffortForModel(model, resolvedProvider),
  };
}

function fallbackModelStatePatch(provider: AdeCodeProvider): Pick<AdeCodeModelState, "provider" | "model" | "modelId" | "displayName" | "reasoningEffort"> {
  const registryProvider = provider === "ollama" || provider === "lmstudio" ? "opencode" : provider;
  const descriptor = getDefaultModelDescriptor(registryProvider)
    ?? listModelDescriptorsForProvider(registryProvider)[0]
    ?? getDefaultModelDescriptor("codex");
  return {
    provider,
    model: descriptor?.providerModelId ?? descriptor?.shortId ?? descriptor?.id ?? "gpt-5.5",
    modelId: descriptor?.id ?? null,
    displayName: descriptor?.displayName ?? providerLabel(provider),
    reasoningEffort: descriptor?.reasoningTiers?.[0] ?? (provider === "codex" ? DEFAULT_CODEX_REASONING_EFFORT : null),
  };
}

function registryModelsForProvider(provider: AdeCodeProvider): AgentChatModelInfo[] {
  if (provider === "ollama" || provider === "lmstudio") return [];
  return listModelDescriptorsForProvider(provider).map((descriptor) => ({
    id: descriptor.id,
    modelId: descriptor.id,
    displayName: descriptor.displayName,
    isDefault: descriptor.id === getDefaultModelDescriptor(provider)?.id,
    reasoningEfforts: descriptor.reasoningTiers?.map((effort) => ({ effort, description: effort })),
    ...(descriptor.serviceTiers?.length ? { serviceTiers: descriptor.serviceTiers } : {}),
  }));
}

function modelReasoningEfforts(modelState: AdeCodeModelState, models: AgentChatModelInfo[]): string[] {
  const model = models.find((entry) => entry.id === modelState.modelId || entry.modelId === modelState.modelId);
  const fromModel = model?.reasoningEfforts?.map((entry) => entry.effort).filter(Boolean) ?? [];
  if (fromModel.length) return fromModel;
  const descriptor = modelState.modelId ? getModelById(modelState.modelId) : undefined;
  if (descriptor?.reasoningTiers?.length) return descriptor.reasoningTiers;
  return modelState.provider === "codex" ? EFFORTS : [];
}

function resolveCodexPreset(modelState: AdeCodeModelState): CodexPreset | "custom" {
  if (modelState.codexConfigSource === "config-toml") return "config-toml";
  if (modelState.codexApprovalPolicy === "never" && modelState.codexSandbox === "danger-full-access") return "full-auto";
  if (
    (modelState.codexApprovalPolicy === "on-request" || modelState.codexApprovalPolicy === "untrusted")
    && modelState.codexSandbox === "read-only"
  ) return "plan";
  if (
    (modelState.codexApprovalPolicy === "on-request" || modelState.codexApprovalPolicy === "on-failure" || modelState.codexApprovalPolicy === "untrusted")
    && modelState.codexSandbox === "workspace-write"
  ) return "default";
  return "custom";
}

function codexPresetPatch(preset: CodexPreset): Pick<AdeCodeModelState, "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "permissionMode"> {
  if (preset === "full-auto") {
    return {
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
      codexConfigSource: "flags",
      permissionMode: "full-auto",
    };
  }
  if (preset === "plan") {
    return {
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
      permissionMode: "plan",
    };
  }
  if (preset === "config-toml") {
    return {
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "config-toml",
      permissionMode: "config-toml",
    };
  }
  return {
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    permissionMode: "default",
  };
}

function droidPermissionToLegacy(mode: AdeCodeModelState["droidPermissionMode"]): AgentChatPermissionMode {
  if (mode === "read-only") return "plan";
  if (mode === "auto-low") return "edit";
  if (mode === "auto-medium") return "default";
  return "full-auto";
}

function cursorModeLabel(modeId: string | null | undefined): string {
  const normalized = modeId?.trim().toLowerCase() || "agent";
  return CURSOR_MODE_LABELS[normalized] ?? normalized;
}

function permissionSummary(modelState: AdeCodeModelState): string {
  if (modelState.provider === "codex") return resolveCodexPreset(modelState);
  if (modelState.provider === "claude") {
    if (modelState.interactionMode === "plan" || modelState.claudePermissionMode === "plan") return "plan";
    if (modelState.claudePermissionMode === "auto") return "auto";
    if (modelState.claudePermissionMode === "acceptEdits") return "accept edits";
    if (modelState.claudePermissionMode === "bypassPermissions") return "bypass";
    return "default";
  }
  if (modelState.provider === "opencode") return modelState.opencodePermissionMode;
  if (modelState.provider === "droid") return modelState.droidPermissionMode;
  return cursorModeLabel(modelState.cursorModeId);
}

const MODE_DESCRIPTIONS: Record<string, string> = {
  plan: "read-only deliberation",
  default: "ask before acting",
  auto: "auto-approve safe actions",
  "accept edits": "auto-approve file edits",
  bypass: "skip permission checks",
  "full-auto": "no approvals required",
  edit: "edit-mode operations",
  agent: "agent-driven actions",
  ask: "confirm each action",
  "read-only": "no edits or execution",
  "auto-low": "low-autonomy ops",
  "auto-medium": "medium-autonomy ops",
  "auto-high": "high-autonomy ops",
  "config-toml": "config-defined mode",
};

function modeDescription(summary: string): string {
  return MODE_DESCRIPTIONS[summary] ?? "permission mode";
}

function modeAccentColor(summary: string): string {
  if (summary === "plan" || summary === "read-only") return theme.color.planMode;
  if (summary === "bypass" || summary === "full-auto" || summary === "auto-high") return theme.color.warning;
  return theme.color.accent;
}

function permissionOptionsDetail(modelState: AdeCodeModelState): string {
  if (modelState.provider === "codex") return CODEX_PRESETS.join(" · ");
  if (modelState.provider === "claude") return "default · plan · auto · bypass";
  if (modelState.provider === "opencode") return OPENCODE_PERMISSION_OPTIONS.join(" · ");
  if (modelState.provider === "droid") return DROID_PERMISSION_OPTIONS.join(" · ");
  return CURSOR_AVAILABLE_MODE_IDS.map((modeId) => cursorModeLabel(modeId)).join(" · ");
}

function applyProviderPermissionMode(modelState: AdeCodeModelState): Partial<AdeCodeModelState> {
  if (modelState.provider === "codex") {
    const preset = resolveCodexPreset(modelState);
    return { permissionMode: preset === "custom" ? modelState.permissionMode : preset };
  }
  if (modelState.provider === "claude") {
    if (modelState.interactionMode === "plan" || modelState.claudePermissionMode === "plan") {
      return { permissionMode: "plan", interactionMode: "plan", claudePermissionMode: "plan" };
    }
    if (modelState.claudePermissionMode === "auto") return { permissionMode: "auto", interactionMode: "default" };
    if (modelState.claudePermissionMode === "acceptEdits") return { permissionMode: "edit", interactionMode: "default" };
    if (modelState.claudePermissionMode === "bypassPermissions") return { permissionMode: "full-auto", interactionMode: "default" };
    return { permissionMode: "default", interactionMode: "default" };
  }
  if (modelState.provider === "opencode") return { permissionMode: modelState.opencodePermissionMode };
  if (modelState.provider === "droid") return { permissionMode: droidPermissionToLegacy(modelState.droidPermissionMode) };
  if (modelState.provider === "cursor") {
    if (modelState.cursorModeId === "plan") return { permissionMode: "plan" };
    if (modelState.cursorModeId === "ask") return { permissionMode: "edit" };
    if (modelState.cursorModeId === "full-auto") return { permissionMode: "full-auto" };
    return { permissionMode: "default" };
  }
  return {};
}

function noticeId(): string {
  return `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function routeRows(value: unknown): string[] {
  if (Array.isArray(value)) return value.slice(0, 16).map((entry) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return String(record.title ?? record.name ?? record.branchRef ?? record.id ?? JSON.stringify(entry)).slice(0, 90);
  });
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const list = Object.values(record).find(Array.isArray);
  return Array.isArray(list) ? routeRows(list) : renderObject(value, 12).split(/\r?\n/);
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatTokenSummary(stats: ReturnType<typeof latestTokenStats>): string | null {
  // Compact last-turn breakdown: `+2.3k/1.1k (450✶)` — input / output (cached marker).
  const parts: string[] = [];
  if (stats.inputTokens != null || stats.outputTokens != null) {
    const left = stats.inputTokens != null ? `+${compactNumber(stats.inputTokens)}` : "+0";
    const right = stats.outputTokens != null ? compactNumber(stats.outputTokens) : "0";
    parts.push(`${left}/${right}`);
  }
  if (stats.cacheReadTokens != null && stats.cacheReadTokens > 0) {
    parts.push(`(${compactNumber(stats.cacheReadTokens)}✶)`);
  }
  if (stats.costUsd != null) parts.push(`$${stats.costUsd.toFixed(2)}`);
  return parts.length ? parts.join(" ") : null;
}

function formatGoalBannerLine(goal: CodexThreadGoal | null): string | null {
  if (!goal?.objective) return null;
  const objective = goal.objective.trim();
  if (!objective) return null;
  const right: string[] = [];
  const used = goal.tokensUsed ?? null;
  if (used != null) {
    right.push(`${compactNumber(used)} tokens`);
  }
  if (typeof goal.timeUsedSeconds === "number" && goal.timeUsedSeconds > 0) {
    const seconds = Math.round(goal.timeUsedSeconds);
    const mins = Math.floor(seconds / 60);
    right.push(mins > 0 ? `${mins}m ${seconds % 60}s` : `${seconds}s`);
  }
  const visibleStatus = goal.status === "budget_limited" ? "active" : goal.status;
  if (visibleStatus) right.push(visibleStatus.replace(/_/g, " "));
  return right.length ? `◎ ${objective}   ${right.join(" · ")}` : `◎ ${objective}`;
}

function formatContextUsage(usage: AgentChatContextUsage | null): string {
  if (!usage) return "Context usage is not available for this session yet.";
  const total = compactNumber(usage.totalTokens);
  const max = compactNumber(usage.maxTokens);
  const header = `Context usage: ${total} / ${max} tokens (${usage.percentage.toFixed(0)}%)`;
  const rows = usage.categories.map((category) => {
    const pct = category.percentage < 10 && category.percentage > 0
      ? category.percentage.toFixed(1)
      : category.percentage.toFixed(0);
    return `${category.name.padEnd(22)} ${compactNumber(category.tokens).padStart(7)}  ${pct.padStart(5)}%`;
  });
  const extras: string[] = [];
  if (usage.memoryFiles?.length) extras.push(`${usage.memoryFiles.length} memory file${usage.memoryFiles.length === 1 ? "" : "s"}`);
  return [header, usage.model ? `Model: ${usage.model}` : null, "", ...rows, extras.length ? `\n${extras.join(" · ")}` : null]
    .filter((line): line is string => line != null)
    .join("\n");
}

import { subagentSnapshotsFromEvents } from "../../../desktop/src/shared/chatSubagents";
export { subagentSnapshotsFromEvents };

function isLaneWorktreeAvailable(lane: LaneSummary | null | undefined): boolean {
  const root = lane?.worktreePath?.trim();
  if (!root) return false;
  try {
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

function laneWorktreeUnavailableMessage(lane: LaneSummary | null | undefined): string | null {
  if (!lane) return "No active lane is available.";
  if (isLaneWorktreeAvailable(lane)) return null;
  const pathLabel = lane.worktreePath?.trim() || "unknown path";
  return `Lane "${lane.name}" is missing its worktree at ${pathLabel}. Restore or recreate the lane before starting a chat.`;
}

function collectDescendantLaneIds(rootId: string, lanes: LaneSummary[]): Set<string> {
  const childrenByParent = new Map<string, LaneSummary[]>();
  for (const lane of lanes) {
    if (!lane.parentLaneId) continue;
    const children = childrenByParent.get(lane.parentLaneId) ?? [];
    children.push(lane);
    childrenByParent.set(lane.parentLaneId, children);
  }
  const descendants = new Set<string>();
  const stack = [...(childrenByParent.get(rootId) ?? [])];
  while (stack.length) {
    const lane = stack.pop();
    if (!lane || descendants.has(lane.id)) continue;
    descendants.add(lane.id);
    stack.push(...(childrenByParent.get(lane.id) ?? []));
  }
  return descendants;
}

function reparentTargetsForLane(lane: LaneSummary, lanes: LaneSummary[]): LaneSummary[] {
  const descendants = collectDescendantLaneIds(lane.id, lanes);
  return lanes
    .filter((candidate) => !candidate.archivedAt && candidate.id !== lane.id && !descendants.has(candidate.id))
    .sort((left, right) => {
      const leftPrimary = left.laneType === "primary" ? 0 : 1;
      const rightPrimary = right.laneType === "primary" ? 0 : 1;
      if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;
      return left.name.localeCompare(right.name);
    });
}

function resolveLaneReference(lanes: LaneSummary[], reference: string): LaneSummary | null {
  const normalized = reference.trim().toLowerCase();
  if (!normalized) return null;
  const exact = lanes.find((lane) => (
    lane.id.toLowerCase() === normalized || lane.name.toLowerCase() === normalized
  ));
  if (exact) return exact;
  // Only accept partial-name matches when they resolve uniquely. The previous
  // implementation picked the first `includes()` hit, which could silently
  // pick the wrong lane (and target the wrong rebase) for `/reparent`.
  const partialMatches = lanes.filter((lane) => lane.name.toLowerCase().includes(normalized));
  return partialMatches.length === 1 ? partialMatches[0] ?? null : null;
}

function seedLaneDetails(
  lane: LaneSummary,
  worktreeAvailable = isLaneWorktreeAvailable(lane),
  chats: Extract<RightPaneContent, { kind: "lane-details" }>["chats"] = { active: 0, closed: 0, killed: 0 },
): Extract<RightPaneContent, { kind: "lane-details" }> {
  return {
    kind: "lane-details",
    lane,
    git: { staged: 0, unstaged: 0, total: 0, ahead: 0, behind: 0, remote: null, additions: 0, deletions: 0 },
    files: [],
    pr: null,
    chats,
    showFiles: false,
    selectedActionIndex: 0,
    worktreeAvailable,
  };
}

function deriveDrawerPreviewChatInfo(
  session: AgentChatSessionSummary,
  previewEvents: AgentChatEventEnvelope[],
  laneLabel: string | null,
): Extract<RightPaneContent, { kind: "chat-info" }>["info"] {
  const snapshots = subagentSnapshotsFromEvents(previewEvents);
  const fallbackContext = session.modelId ? getModelById(session.modelId)?.contextWindow ?? null : null;
  const stats = latestTokenStats(previewEvents, fallbackContext);
  return deriveChatInfoSnapshot({
    events: previewEvents,
    activeSession: session,
    provider: normalizeProvider(session.provider),
    modelLabel: session.model ?? normalizeProvider(session.provider),
    laneLabel,
    snapshots,
    tokenStats: stats,
    goal: latestGoal(previewEvents),
    streaming: session.status === "active",
    inspectedSubagentId: null,
  });
}

type DrawerNavTarget =
  | { kind: "lane"; lane: LaneSummary }
  | { kind: "chat"; info: Extract<RightPaneContent, { kind: "chat-info" }>["info"] }
  | { kind: "new-chat"; laneId: string; laneLabel: string; rows: SetupPaneRow[] };

type ContextDefaultArgs = {
  draftChatActive: boolean;
  activeSession: AgentChatSessionSummary | null;
  activeLane: LaneSummary | null;
  liveAgentCount: number;
  highlightedDrawerLane: LaneSummary | null;
  drawerMode: "chats" | "lanes";
  drawerNav: DrawerNavTarget | null;
  chatInfo: Extract<RightPaneContent, { kind: "chat-info" }>["info"];
  subagentSnapshots: SubagentSnapshot[];
  provider: AdeCodeProvider;
  newChatSetup: { laneId: string; laneLabel: string; rows: SetupPaneRow[] } | null;
  unavailableLaneIds: ReadonlySet<string>;
};

function resolveContextDefault(args: ContextDefaultArgs): RightPaneContent {
  const nav = args.drawerNav;
  if (nav) {
    switch (nav.kind) {
      case "lane":
        return seedLaneDetails(nav.lane, !args.unavailableLaneIds.has(nav.lane.id));
      case "new-chat":
        return {
          kind: "new-chat-setup",
          laneId: nav.laneId,
          laneLabel: nav.laneLabel,
          rows: nav.rows,
        };
      case "chat":
        return { kind: "chat-info", info: nav.info };
    }
  }
  if (args.drawerMode === "lanes" && args.highlightedDrawerLane) {
    return seedLaneDetails(args.highlightedDrawerLane, !args.unavailableLaneIds.has(args.highlightedDrawerLane.id));
  }
  if (
    args.draftChatActive
    && args.newChatSetup
    && !args.unavailableLaneIds.has(args.newChatSetup.laneId)
  ) {
    return {
      kind: "new-chat-setup",
      laneId: args.newChatSetup.laneId,
      laneLabel: args.newChatSetup.laneLabel,
      rows: args.newChatSetup.rows,
    };
  }
  if (args.activeSession) {
    return {
      kind: "chat-info",
      info: args.chatInfo,
    };
  }
  if (args.activeLane) {
    return seedLaneDetails(args.activeLane, !args.unavailableLaneIds.has(args.activeLane.id));
  }
  return { kind: "empty" };
}

function formatOutputStyles(styles: Awaited<ReturnType<typeof listClaudeOutputStyles>>, activeStyle?: string | null): string {
  if (!styles.length) return "No Claude output styles were found.";
  const activeKey = activeStyle?.trim().toLowerCase() ?? "";
  return [
    "Claude output styles:",
    "",
    ...styles.map((style) => {
      const marker = style.name.trim().toLowerCase() === activeKey ? "*" : "-";
      const description = style.description ? ` - ${style.description}` : "";
      return `${marker} ${style.name} (${style.source})${description}`;
    }),
  ].join("\n");
}

function formatClaudePlugins(plugins: AgentChatClaudePlugin[]): string {
  if (!plugins.length) return "No local Claude plugins were discovered for this chat.";
  return [
    "Claude plugins:",
    "",
    ...plugins.map((plugin) => {
      const suffix = [plugin.version, plugin.description].filter(Boolean).join(" - ");
      return `- ${plugin.name}${suffix ? ` (${suffix})` : ""}\n  ${plugin.path}`;
    }),
  ].join("\n");
}

function formatPluginReload(result: AgentChatReloadClaudePluginsResult): string {
  return [
    `Reloaded ${result.plugins.length} plugin${result.plugins.length === 1 ? "" : "s"} with ${result.errorCount} error${result.errorCount === 1 ? "" : "s"}.`,
    result.commands.length ? `${result.commands.length} command${result.commands.length === 1 ? "" : "s"}` : null,
    result.agents.length ? `${result.agents.length} agent${result.agents.length === 1 ? "" : "s"}` : null,
    "",
    ...result.plugins.map((plugin) => `- ${plugin.name}\n  ${plugin.path}`),
  ].filter((line): line is string => line != null).join("\n");
}

function titleFromMarkdown(filePath: string, fallback: string): string {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const heading = text.split(/\r?\n/).find((line) => line.startsWith("# "));
    return heading?.replace(/^#\s+/, "").trim() || fallback;
  } catch {
    return fallback;
  }
}

function listClaudeCompatMarkdownEntries(workspaceRoot: string, kind: "agents" | "skills"): string {
  const roots = kind === "agents"
    ? [
        { label: "project", dir: path.join(workspaceRoot, ".claude", "agents") },
        { label: "user", dir: claudeHomePath("agents") },
      ]
    : [
        { label: "project", dir: path.join(workspaceRoot, ".claude", "skills") },
        { label: "ADE", dir: path.join(workspaceRoot, ".ade", "skills") },
        { label: "user", dir: claudeHomePath("skills") },
        ...getAdeAgentSkillRootCandidates({ includeDeepSourceFallbacks: true })
          .map((dir) => ({ label: "bundled", dir })),
      ];
  const rows: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    for (const entry of fs.readdirSync(root.dir, { withFileTypes: true })) {
      const filePath = entry.isDirectory()
        ? path.join(root.dir, entry.name, "SKILL.md")
        : path.join(root.dir, entry.name);
      if (!filePath.endsWith(".md") || !fs.existsSync(filePath)) continue;
      const name = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/i, "");
      const title = titleFromMarkdown(filePath, name);
      rows.push(`- ${title} (${root.label})\n  ${filePath}`);
    }
  }
  if (!rows.length) return `No Claude ${kind} were found in project or user config.`;
  return [`Claude ${kind}:`, "", ...rows].join("\n");
}

function ensureClaudeInitFiles(workspaceRoot: string): string {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const agentsPath = path.join(workspaceRoot, "AGENTS.md");
  const claudePath = path.join(workspaceRoot, "CLAUDE.md");
  const rows: string[] = [];
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(
      agentsPath,
      [
        "# Project instructions",
        "",
        "Add coding-agent instructions for this project here. ADE, Claude Code, and other agent runtimes can use this file as the canonical project guide.",
        "",
      ].join("\n"),
      "utf8",
    );
    rows.push(`created ${agentsPath}`);
  } else {
    rows.push(`kept existing ${agentsPath}`);
  }
  if (!fs.existsSync(claudePath)) {
    fs.writeFileSync(claudePath, "@include AGENTS.md\n", "utf8");
    rows.push(`created ${claudePath}`);
  } else {
    rows.push(`kept existing ${claudePath}`);
  }
  return ["Initialized Claude-compatible project files:", "", ...rows].join("\n");
}

function readClaudeVimMode(workspaceRoot: string): boolean {
  const candidates = [
    claudeHomePath("settings.json"),
    path.join(workspaceRoot, ".claude", "settings.json"),
    path.join(workspaceRoot, ".claude", "settings.local.json"),
  ];
  let enabled = false;
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const vimMode = (value as { vimMode?: unknown }).vimMode;
      if (typeof vimMode === "boolean") enabled = vimMode;
    } catch {
      // Invalid Claude settings are reported by /doctor; keep input usable.
    }
  }
  return enabled;
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    shell: process.platform !== "win32",
    stdio: "ignore",
  });
  return result.status === 0;
}

function readClipboardText(): string | null {
  const candidates = process.platform === "darwin"
    ? [["pbpaste"]]
    : process.platform === "win32"
      ? [["powershell", "-NoProfile", "-Command", "Get-Clipboard"]]
      : [["wl-paste", "--no-newline"], ["xclip", "-selection", "clipboard", "-o"]];
  for (const [command, ...args] of candidates) {
    if (!commandAvailable(command)) continue;
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return null;
}

function writeClipboardText(text: string): boolean {
  const candidates = process.platform === "darwin"
    ? [["pbcopy"]]
    : process.platform === "win32"
      ? [["clip"]]
      : [["wl-copy"], ["xclip", "-selection", "clipboard"]];
  for (const [command, ...args] of candidates) {
    if (!commandAvailable(command)) continue;
    const result = spawnSync(command, args, {
      input: text,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (result.status === 0) return true;
  }
  return false;
}

function editPromptInExternalEditor(initialText: string): string | null {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-code-prompt-"));
  const filePath = path.join(dir, "prompt.md");
  try {
    fs.writeFileSync(filePath, initialText, "utf8");
    const result = spawnSync(editor, [filePath], {
      stdio: "inherit",
      shell: true,
      env: process.env,
    });
    if (result.error || (typeof result.status === "number" && result.status !== 0)) {
      return null;
    }
    return fs.readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  }
}

function formatClaudeStatusLineConfig(workspaceRoot: string): string {
  return readClaudeStatusLineConfig(workspaceRoot).diagnostics;
}

function formatDoctorReport(args: {
  workspaceRoot: string;
  activeProvider?: string | null;
  pluginCount: number | null;
}): string {
  const keybindings = readClaudeKeybindingsFile({ create: false });
  const statusLine = formatClaudeStatusLineConfig(args.workspaceRoot);
  return [
    "ADE Code doctor:",
    "",
    `provider: ${args.activeProvider ?? "none"}`,
    `keybindings: ${keybindings.warnings.length ? `${keybindings.warnings.length} warning${keybindings.warnings.length === 1 ? "" : "s"}` : "ok"}`,
    args.pluginCount == null ? "plugins: not checked" : `plugins: ${args.pluginCount}`,
    "",
    statusLine,
  ].join("\n");
}

function buildSetupRows(args: {
  modelState: AdeCodeModelState;
  models: AgentChatModelInfo[];
  includeRefresh: boolean;
  includeApply: boolean;
  outputStyle?: string | null;
  outputStyleEditable?: boolean;
}): SetupPaneRow[] {
  const efforts = modelReasoningEfforts(args.modelState, args.models);
  const descriptor = args.modelState.modelId ? getModelById(args.modelState.modelId) : undefined;
  const activeModel = args.models.find((entry) => entry.id === args.modelState.modelId || entry.modelId === args.modelState.modelId);
  const fastSupported =
    Boolean(activeModel?.serviceTiers?.some((tier) => tier.trim().toLowerCase() === "fast"))
    || modelSupportsFastMode(descriptor);
  const rows: SetupPaneRow[] = [
    {
      kind: "provider",
      label: "Provider",
      value: providerLabel(args.modelState.provider),
      cyclable: true,
    },
    {
      kind: "model",
      label: "Model",
      value: args.modelState.displayName,
      detail: args.models.length ? `${args.models.length} available` : "using registry default",
      cyclable: true,
    },
    {
      kind: "reasoning",
      label: "Reasoning",
      value: args.modelState.reasoningEffort ?? "none",
      detail: efforts.length ? efforts.join(", ") : "not exposed by this model",
      disabled: !efforts.length,
      cyclable: true,
    },
    {
      kind: "permission",
      label: "Permissions",
      value: permissionSummary(args.modelState),
      detail: permissionOptionsDetail(args.modelState),
      cyclable: true,
    },
  ];
  rows.push({
    kind: "codex-fast",
    label: "Fast mode",
    value: fastSupported && args.modelState.codexFastMode ? "on" : "off",
    detail: "on · off",
    disabled: !fastSupported,
    cyclable: true,
  });
  if (args.modelState.provider === "claude") {
    rows.push({
      kind: "output-style",
      label: "Output style",
      value: args.outputStyle?.trim() || "default",
      detail: args.outputStyleEditable === false
        ? "active Claude chat only"
        : "default · concise · verbose",
      disabled: args.outputStyleEditable === false,
      cyclable: true,
    });
  }
  if (args.includeRefresh) {
    rows.push({
      kind: "refresh-status",
      label: "Refresh status",
      value: "run",
      detail: "checks provider auth/runtime state",
    });
  }
  rows.push({
    kind: "open-settings",
    label: "Full settings",
    value: "open desktop",
    detail: "Settings > AI Providers",
  });
  if (args.includeApply) {
    rows.push({
      kind: "apply",
      label: "Use these settings",
      value: "ready",
      detail: "returns focus to the chat composer",
    });
  }
  return rows;
}

function setupRowsForRuntime(rows: SetupPaneRow[], mode: RuntimeMode | "connecting"): SetupPaneRow[] {
  if (mode === "attached") return rows;
  return rows.map((row) => row.kind === "open-settings"
    ? {
        ...row,
        value: "unavailable",
        detail: "use /login for Claude, Codex, or OpenCode; open ADE desktop for full settings",
        disabled: true,
      }
    : row);
}

function defaultSetupSelectionIndex(rows: SetupPaneRow[]): number {
  const applyIndex = rows.findIndex((row) => row.kind === "apply");
  return applyIndex >= 0 ? applyIndex : 0;
}

function defaultModelPickerSelectionIndex(rows: SetupPaneRow[]): number {
  const modelIndex = rows.findIndex((row) => row.kind === "model" && !row.disabled);
  if (modelIndex >= 0) return modelIndex;
  const reasoningIndex = rows.findIndex((row) => row.kind === "reasoning" && !row.disabled);
  if (reasoningIndex >= 0) return reasoningIndex;
  return defaultSetupSelectionIndex(rows);
}

type ConnectionStatusProvider = Extract<AdeCodeProvider, "claude" | "codex" | "cursor" | "droid">;

function providerConnectionDetail(status: AiSettingsStatus | null, provider: ConnectionStatusProvider): ProviderReadinessRow {
  const connection = status?.providerConnections?.[provider];
  const modelCount = status?.models?.[provider]?.length ?? 0;
  if (connection?.runtimeAvailable) {
    return {
      provider,
      label: providerLabel(provider),
      status: "ready",
      detail: connection.path ? `ready at ${connection.path}` : "runtime and auth ready",
      modelCount,
    };
  }
  if (connection?.runtimeDetected || connection?.authAvailable) {
    return {
      provider,
      label: providerLabel(provider),
      status: "unknown",
      detail: connection.blocker ?? "detected but not fully ready",
      modelCount,
    };
  }
  return {
    provider,
    label: providerLabel(provider),
    status: "unavailable",
    detail: connection?.blocker ?? "not detected",
    modelCount,
  };
}

function buildProviderReadinessRows(
  status: AiSettingsStatus | null,
  storedApiKeyProviders: string[],
  openCodeDiagnostics: OpenCodeRuntimeSnapshot | null,
): ProviderReadinessRow[] {
  const rows: ProviderReadinessRow[] = [
    providerConnectionDetail(status, "codex"),
    providerConnectionDetail(status, "claude"),
    providerConnectionDetail(status, "cursor"),
    providerConnectionDetail(status, "droid"),
  ];
  const opencodeProviders = status?.opencodeProviders ?? [];
  const opencodeModelCount = opencodeProviders.reduce((sum, provider) => sum + provider.modelCount, 0);
  rows.push({
    provider: "opencode",
    label: "OpenCode",
    status: status?.opencodeBinaryInstalled ? "ready" : "unavailable",
    detail: status?.opencodeInventoryError
      ?? (status?.opencodeBinaryInstalled
        ? `${status.opencodeBinarySource ?? "installed"} · ${openCodeDiagnostics?.sharedCount ?? 0} shared runtime`
        : "binary missing"),
    modelCount: opencodeModelCount,
  });
  if (storedApiKeyProviders.includes("cursor")) {
    const cursor = rows.find((row) => row.provider === "cursor");
    if (cursor && cursor.status !== "ready") {
      cursor.detail = `${cursor.detail} · Cursor key stored`;
    }
  }
  return rows;
}

function desktopRouteForCommand(commandName: string | null | undefined): string | null {
  if (!commandName) return null;
  return DESKTOP_COMMAND_ROUTES[commandName] ?? null;
}

function splitFirstArg(input: string): { first: string; rest: string } {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return {
    first: match?.[1] ?? "",
    rest: match?.[2]?.trim() ?? "",
  };
}

type ParsedAdeActionPayload =
  | { args: Record<string, unknown> }
  | { argsList: unknown[] }
  | { arg: unknown };

function parseAdeActionPayload(input: string): ParsedAdeActionPayload {
  const trimmed = input.trim();
  if (!trimmed) return { args: {} };
  const parsed = JSON.parse(trimmed) as unknown;
  if (Array.isArray(parsed)) {
    return { argsList: parsed };
  }
  if (parsed && typeof parsed === "object") {
    return { args: parsed as Record<string, unknown> };
  }
  return { arg: parsed };
}

function parseLinearIssueListArgs(input: string): Record<string, unknown> {
  const projectSlugs: string[] = [];
  const stateTypes: string[] = [];
  let limit: number | undefined;
  const tokens = input.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g)?.map((token) => (
    token.startsWith("\"") && token.endsWith("\"")
      ? token.slice(1, -1).replace(/\\"/g, "\"")
      : token.startsWith("'") && token.endsWith("'")
        ? token.slice(1, -1)
        : token
  )) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const next = tokens[index + 1];
    if ((token === "--project" || token === "--project-slug" || token === "--projects") && next) {
      projectSlugs.push(...next.split(",").map((entry) => entry.trim()).filter(Boolean));
      index += 1;
    } else if ((token === "--state" || token === "--states" || token === "--state-type") && next) {
      stateTypes.push(...next.split(",").map((entry) => entry.trim()).filter(Boolean));
      index += 1;
    } else if (token === "--limit" && next && Number.isFinite(Number(next))) {
      limit = Math.max(1, Math.min(100, Math.floor(Number(next))));
      index += 1;
    } else if (!token.startsWith("--")) {
      projectSlugs.push(token);
    }
  }
  return {
    projectSlugs,
    stateTypes,
    ...(limit ? { limit } : {}),
  };
}

function printableInput(input: string): string {
  return input.replace(/[\u0000-\u001f\u007f]/g, "");
}

function printablePromptInput(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
}

export function deletePreviousPromptWord(value: string): string {
  let index = value.length;
  while (index > 0 && /\s/.test(value[index - 1] ?? "")) index -= 1;
  while (index > 0 && !/\s/.test(value[index - 1] ?? "")) index -= 1;
  return value.slice(0, index);
}

export function deletePreviousPromptLine(value: string): string {
  if (!value) return "";
  if (/\r?\n$/.test(value)) return value.replace(/\r?\n$/, "");
  if (/\r$/.test(value)) return value.slice(0, -1);
  const index = value.lastIndexOf("\n");
  return index === -1 ? "" : value.slice(0, index + 1);
}

export function isPromptWordBackspace(input: string, key: { ctrl?: boolean; meta?: boolean; backspace?: boolean; delete?: boolean }): boolean {
  if (key.ctrl && input === "w") return true;
  if (key.ctrl && (key.backspace || key.delete)) return true;
  if (key.meta && (key.backspace || key.delete)) return true;
  if (key.meta && (input === "\u007f" || input === "\b" || input === "\x1b\u007f" || input === "\x1b\b")) return true;
  if (key.ctrl && (input === "\u007f" || input === "\b" || input === "h")) return true;
  return false;
}

export function isPromptLineBackspace(input: string, key: { ctrl?: boolean; meta?: boolean; backspace?: boolean; delete?: boolean }): boolean {
  if (key.ctrl && !key.meta && input === "u") return true;
  return false;
}

function inputBeforeLineBreak(input: string): string | null {
  const index = input.search(/[\r\n]/);
  return index === -1 ? null : input.slice(0, index);
}

const PROMPT_MAX_ROWS = 5;

export function promptDisplayRows(value: string, width: number, maxRows = PROMPT_MAX_ROWS): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const chars = [...rawLine];
    if (!chars.length) {
      rows.push("");
      continue;
    }
    for (let index = 0; index < chars.length; index += safeWidth) {
      rows.push(chars.slice(index, index + safeWidth).join(""));
    }
  }
  const nonEmptyRows = rows.length ? rows : [""];
  return nonEmptyRows.slice(-Math.max(1, maxRows));
}

function runInteractiveTerminalCommand(command: string, args: string[], cwd: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean; setRawMode?: (mode: boolean) => void };
    const wasRaw = Boolean(stdin.isRaw);
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
    process.stdout.write("\n");
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    const restore = () => {
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(wasRaw);
      }
    };
    child.once("error", (error) => {
      restore();
      reject(error);
    });
    child.once("close", (code) => {
      restore();
      process.stdout.write("\n");
      resolve(code);
    });
  });
}

type ProviderLoginCommand = { command: string; args: string[]; label: string };

function loginCommandsForProvider(provider: AdeCodeProvider): ProviderLoginCommand[] {
  if (provider === "claude") return [{ command: "claude", args: ["auth", "login"], label: "claude auth login" }];
  if (provider === "codex") return [{ command: "codex", args: ["login"], label: "codex login" }];
  if (provider === "opencode") return [{ command: "opencode", args: ["auth", "login"], label: "opencode auth login" }];
  return [];
}

function loginUnavailableHint(provider: AdeCodeProvider): string {
  if (provider === "cursor") {
    return "ADE Cursor chat uses @cursor/sdk, which requires a Cursor API key. Open Settings > AI Providers, use ADE's encrypted key store, or set CURSOR_API_KEY before launching ADE.";
  }
  if (provider === "droid") {
    return "ADE Droid chat uses the Factory Droid SDK. Set FACTORY_API_KEY before launching ADE, or run `droid` and use its interactive `/login`.";
  }
  return "No terminal login command is known for this provider.";
}

function activeMention(value: string): { start: number; query: string } | null {
  const match = value.match(/(^|\s)@([^\s@]*)$/);
  if (!match || match.index == null) return null;
  return {
    start: match.index + match[1].length,
    query: match[2] ?? "",
  };
}

function useTerminalDimensions(): [number, number] {
  const read = (): [number, number] => [
    process.stdout.columns ?? 120,
    process.stdout.rows ?? 40,
  ];
  const [dimensions, setDimensions] = useState<[number, number]>(read);
  useEffect(() => {
    const handleResize = () => setDimensions(read());
    process.stdout.on("resize", handleResize);
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);
  return dimensions;
}

function useTerminalAlternateScroll(): void {
  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    process.stdout.write("\x1b[?1007h");
    return () => {
      process.stdout.write("\x1b[?1007l");
    };
  }, []);
}

type TerminalMouseInput = {
  kind: "wheel" | "click" | "drag" | "release" | "other";
  x: number | null;
  y: number | null;
  direction?: "up" | "down" | "left" | "right";
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
};

export type ChatSelectionState = ChatTextSelection & { active: boolean };
export type ChatSelectionPoint = { row: number; column: number };
type ChatSelectionEdgeDirection = "older" | "newer";

const CTRL_C_EXIT_ARM_MS = 1500;
const CHAT_SELECTION_EDGE_SCROLL_MS = 90;

function withMouseModifiers(input: Omit<TerminalMouseInput, "shift" | "alt" | "ctrl">, code: number): TerminalMouseInput {
  return {
    ...input,
    ...(code & 4 ? { shift: true } : {}),
    ...(code & 8 ? { alt: true } : {}),
    ...(code & 16 ? { ctrl: true } : {}),
  };
}

function decodeMouseButton(code: number, x: number | null, y: number | null, pressed: boolean): TerminalMouseInput {
  if (!pressed) {
    return withMouseModifiers({ kind: "release", x, y }, code);
  }
  if (code & 64) {
    const wheelButton = code & 3;
    if (wheelButton === 0) return withMouseModifiers({ kind: "wheel", direction: "up", x, y }, code);
    if (wheelButton === 1) return withMouseModifiers({ kind: "wheel", direction: "down", x, y }, code);
    if (wheelButton === 2) return withMouseModifiers({ kind: "wheel", direction: "left", x, y }, code);
    return withMouseModifiers({ kind: "wheel", direction: "right", x, y }, code);
  }
  if ((code & 32) && (code & 3) === 0) return withMouseModifiers({ kind: "drag", x, y }, code);
  if ((code & 3) === 0) return withMouseModifiers({ kind: "click", x, y }, code);
  return withMouseModifiers({ kind: "other", x, y }, code);
}

export function parseTerminalMouseInput(input: string): TerminalMouseInput | null {
  const normalized = input.replace(/^\x1b+/, "");
  const sgr = normalized.match(/\[<(\d+);(\d+);(\d+)([mM])/);
  if (sgr) {
    return decodeMouseButton(
      Number(sgr[1]),
      Number(sgr[2]),
      Number(sgr[3]),
      sgr[4] === "M",
    );
  }
  const rxvt = normalized.match(/\[(\d+);(\d+);(\d+)M/);
  if (rxvt) {
    return decodeMouseButton(
      Number(rxvt[1]),
      Number(rxvt[2]),
      Number(rxvt[3]),
      true,
    );
  }
  const x10Index = normalized.indexOf("[M");
  if (x10Index !== -1 && normalized.length >= x10Index + 5) {
    return decodeMouseButton(
      normalized.charCodeAt(x10Index + 2) - 32,
      normalized.charCodeAt(x10Index + 3) - 32,
      normalized.charCodeAt(x10Index + 4) - 32,
      true,
    );
  }
  return null;
}

export function clampChatScrollOffsetRows(value: number, maxOffset: number): number {
  const safeMax = Number.isFinite(maxOffset) ? Math.max(0, Math.floor(maxOffset)) : 0;
  if (Number.isNaN(value)) return 0;
  if (!Number.isFinite(value)) return value > 0 ? safeMax : 0;
  return Math.max(0, Math.min(Math.floor(value), safeMax));
}

export function isChatTextSelectionRange(selection: ChatTextSelection | null | undefined): selection is ChatTextSelection {
  if (!selection) return false;
  return selection.startRow !== selection.endRow || selection.startColumn !== selection.endColumn;
}

export function isCtrlCCopyPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function chatSelectionPointFromVisibleRows(
  rows: ChatVisibleSelectionRow[],
  visibleRow: number,
  column: number,
  clampToSelectable: boolean,
): ChatSelectionPoint | null {
  if (!rows.length) return null;
  const safeVisibleRow = Math.max(0, Math.min(Math.floor(visibleRow), rows.length - 1));
  const safeColumn = Math.max(0, Math.floor(column));
  const exact = rows[safeVisibleRow];
  if (exact && exact.sourceRow != null) {
    return { row: exact.sourceRow, column: safeColumn };
  }
  if (!clampToSelectable) return null;
  for (let distance = 1; distance < rows.length; distance += 1) {
    const before = rows[safeVisibleRow - distance];
    if (before?.sourceRow != null) return { row: before.sourceRow, column: safeColumn };
    const after = rows[safeVisibleRow + distance];
    if (after?.sourceRow != null) return { row: after.sourceRow, column: safeColumn };
  }
  return null;
}

export function moveChatSelectionFocusByRows(
  selection: ChatSelectionState,
  rowDelta: number,
  rowCount: number,
  column: number,
): ChatSelectionState {
  const maxRow = Math.max(0, rowCount - 1);
  return {
    ...selection,
    endRow: Math.max(0, Math.min(maxRow, selection.endRow + rowDelta)),
    endColumn: Math.max(0, Math.floor(column)),
  };
}

export function chatSelectionFromAnchor(
  anchor: ChatSelectionPoint,
  point: ChatSelectionPoint,
  active: boolean,
): ChatSelectionState {
  return {
    startRow: anchor.row,
    startColumn: anchor.column,
    endRow: point.row,
    endColumn: point.column,
    active,
  };
}

export function chatSelectionEdgeDirectionForMouseY({
  y,
  topRow,
  rowBudget,
  scrollOffsetRows,
  maxScrollOffsetRows,
}: {
  y: number | null;
  topRow: number;
  rowBudget: number;
  scrollOffsetRows: number;
  maxScrollOffsetRows: number;
}): ChatSelectionEdgeDirection | null {
  if (y == null) return null;
  const bottomRow = topRow + Math.max(1, rowBudget) - 1;
  if (y < topRow && scrollOffsetRows < maxScrollOffsetRows) return "older";
  if (y > bottomRow && scrollOffsetRows > 0) return "newer";
  return null;
}

export function isTerminalMouseTrackingEnabled(value?: string): boolean {
  return !/^(0|false|no|off)$/i.test((value ?? "").trim());
}

function disableTerminalMouseTracking(): void {
  process.stdout.write("\x1b[?1015l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l");
}

function useTerminalMouseTracking(): void {
  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    disableTerminalMouseTracking();
    if (!isTerminalMouseTrackingEnabled(process.env.ADE_TUI_MOUSE)) return;
    process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1015h");
    return () => {
      disableTerminalMouseTracking();
    };
  }, []);
}

const DRAWER_PANE_WIDTH = 32;
const MIN_CENTER_PANE_WIDTH = 24;
const MIN_RIGHT_PANE_WIDTH = 30;
const RIGHT_PANE_MAX_WIDTH = 42;
const CLAUDE_TERMINAL_HIDDEN_INPUT_ROWS = 3;

function finiteFloor(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function safeCenterWidth(centerWidth: number): number {
  return Math.max(MIN_CENTER_PANE_WIDTH, finiteFloor(centerWidth, MIN_CENTER_PANE_WIDTH));
}

export function resolveChatWrapWidth(centerWidth: number, _drawerOpen: boolean, _rightPaneWidth: number): number {
  return safeCenterWidth(centerWidth);
}

export function resolveTerminalPaneWidth(centerWidth: number): number {
  return safeCenterWidth(centerWidth);
}

export function encodeTerminalPromptSubmit(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.includes("\n")) return `\x1b[200~${normalized}\x1b[201~\r`;
  return `${normalized}\r`;
}

export function isTerminalControlToggle(input: string, key: { ctrl?: boolean }): boolean {
  return input === "\x14" || (key.ctrl === true && input.toLowerCase() === "t");
}

export function splitTerminalControlInput(raw: string): { detach: boolean; forwarded: string } {
  const forwarded = raw.replace(/[\x14\x1d]/g, "");
  return { detach: forwarded.length !== raw.length, forwarded };
}

function claudeTerminalRowsForPane(rows: number): number {
  const safeRows = finiteFloor(rows, 4);
  return Math.max(
    4,
    Math.min(120, safeRows + CLAUDE_TERMINAL_HIDDEN_INPUT_ROWS),
  );
}

function terminalSessionProvider(session: ChatTerminalSession | null | undefined): AdeCodeProvider | null {
  const provider = session?.resumeMetadata?.provider ?? null;
  if (provider && PROVIDERS.has(provider as AdeCodeProvider)) return provider as AdeCodeProvider;
  const toolType = session?.toolType ?? "";
  if (toolType.startsWith("codex")) return "codex";
  if (toolType.startsWith("cursor")) return "cursor";
  if (toolType.startsWith("droid")) return "droid";
  if (toolType.startsWith("opencode")) return "opencode";
  if (toolType.startsWith("claude")) return "claude";
  return session ? "claude" : null;
}

function promptTextForTerminal(text: string, attachments: AgentChatFileRef[]): string {
  const attachmentPaths = attachments.map((attachment) => attachment.path).filter(Boolean);
  if (!attachmentPaths.length) return text;
  const attachmentBlock = ["Attached files:", ...attachmentPaths.map((filePath) => `- ${filePath}`)].join("\n");
  return text ? `${text}\n\n${attachmentBlock}` : attachmentBlock;
}

function terminalPromptNeedle(value: string): string | null {
  const lines = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return last.length ? last.slice(0, 96) : null;
}

function terminalHiddenRowsContainPrompt(preview: ChatTerminalPreviewResult | null, value: string): boolean {
  const needle = terminalPromptNeedle(value);
  const rows = preview?.snapshot?.visibleRows ?? [];
  if (!needle || !rows.length) return false;
  const hiddenText = rows
    .slice(-CLAUDE_TERMINAL_HIDDEN_INPUT_ROWS)
    .map((row) => row.text)
    .join("\n")
    .trim();
  return hiddenText.includes(needle);
}

function signalTerminalWithCliSync(args: {
  projectRoot: string;
  socketPath?: string | null;
  terminalId: string;
  signal: "SIGTERM" | "SIGKILL";
}): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint || !fs.existsSync(entrypoint)) return false;
  const env = { ...process.env };
  const socketPath = args.socketPath?.trim() || process.env.ADE_RUNTIME_SOCKET_PATH?.trim() || null;
  if (socketPath) {
    env.ADE_RUNTIME_SOCKET_PATH = socketPath;
    env.ADE_RPC_SOCKET_PATH = socketPath;
  }
  const result = spawnSync(process.execPath, [
    entrypoint,
    "--project-root",
    args.projectRoot,
    "--socket",
    "terminal",
    "signal",
    "--terminal",
    args.terminalId,
    "--signal",
    args.signal,
    "--json",
  ], {
    env,
    stdio: "ignore",
    timeout: 1_000,
  });
  return !result.error && result.status === 0;
}

function modelInfoFromDescriptor(modelRef: string): AgentChatModelInfo | null {
  const descriptor = resolveModelDescriptor(modelRef);
  if (!descriptor) return null;
  return {
    id: descriptor.id,
    modelId: descriptor.id,
    displayName: descriptor.displayName,
    isDefault: false,
    reasoningEfforts: descriptor.reasoningTiers?.map((effort) => ({ effort, description: effort })),
  };
}

function findModelForArg(provider: AdeCodeProvider, currentModels: AgentChatModelInfo[], value: string): AgentChatModelInfo | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  const descriptorModel = modelInfoFromDescriptor(trimmed);
  const pool = [
    ...currentModels,
    ...registryModelsForProvider(provider),
    ...(descriptorModel ? [descriptorModel] : []),
  ];
  return pool.find((entry) => (
    entry.id.toLowerCase() === normalized
    || (entry.modelId ?? "").toLowerCase() === normalized
    || entry.displayName.toLowerCase() === normalized
  )) ?? descriptorModel ?? null;
}

function modelStatePatchForArg(
  provider: AdeCodeProvider,
  currentModels: AgentChatModelInfo[],
  value: string,
): Pick<AdeCodeModelState, "provider" | "model" | "modelId" | "displayName" | "reasoningEffort"> {
  const model = findModelForArg(provider, currentModels, value);
  if (model) return modelStatePatchForModel(provider, model);
  return {
    provider,
    model: value,
    modelId: value,
    displayName: value,
    reasoningEffort: provider === "codex" ? DEFAULT_CODEX_REASONING_EFFORT : null,
  };
}

function resolveRightPaneWidth(columns: number, rightOpen: boolean, drawerOpen: boolean, maxWidth = RIGHT_PANE_MAX_WIDTH): number {
  if (!rightOpen) return 0;
  const drawerWidth = drawerOpen ? DRAWER_PANE_WIDTH : 0;
  const maxRightWidth = columns - drawerWidth - MIN_CENTER_PANE_WIDTH;
  if (maxRightWidth < MIN_RIGHT_PANE_WIDTH) return 0;
  const widthFraction = maxWidth > RIGHT_PANE_MAX_WIDTH ? 0.56 : 0.24;
  return Math.max(
    MIN_RIGHT_PANE_WIDTH,
    Math.min(maxWidth, Math.floor(columns * widthFraction), maxRightWidth),
  );
}

function resolveCenterPaneWidth(columns: number, drawerOpen: boolean, rightPaneWidth: number): number {
  return Math.max(
    MIN_CENTER_PANE_WIDTH,
    columns - (drawerOpen ? DRAWER_PANE_WIDTH : 0) - rightPaneWidth,
  );
}

export function AdeCodeApp({ project, forceEmbedded, requireSocket, socketPath }: AdeCodeAppProps) {
  const { exit } = useApp();
  const [columns, rows] = useTerminalDimensions();
  useTerminalAlternateScroll();
  useTerminalMouseTracking();
  const [connection, setConnection] = useState<AdeCodeConnection | null>(null);
  const [mode, setMode] = useState<RuntimeMode | "connecting">("connecting");
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [prByLaneId, setPrByLaneId] = useState<Record<string, DrawerPrSummary>>({});
  const [diffByLaneId, setDiffByLaneId] = useState<Record<string, DiffLineStats>>({});
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [terminalSessions, setTerminalSessions] = useState<ChatTerminalSession[]>([]);
  const [terminalPreview, setTerminalPreview] = useState<ChatTerminalPreviewResult | null>(null);
  const [attachedTerminalId, setAttachedTerminalId] = useState<string | null>(null);
  const [terminalLiveChunks, setTerminalLiveChunks] = useState<Record<string, string[]>>({});
  const [activeLaneId, setActiveLaneId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentChatEventEnvelope[]>([]);
  const [notices, setNotices] = useState<LocalNotice[]>([]);
  const [slashCommands, setSlashCommands] = useState<AgentChatSlashCommand[]>([]);
  const [keybindings, setKeybindings] = useState(() => readClaudeKeybindingsFile({ create: false }).bindings);
  const [models, setModels] = useState<AgentChatModelInfo[]>([]);
  const [modelState, setModelState] = useState<AdeCodeModelState>(initialModelState);
  const [modeChangeNotice, setModeChangeNotice] = useState<{ summary: string; key: string } | null>(null);
  const lastPermissionSummaryRef = useRef<string | null>(null);
  const modeNoticeTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Only user-initiated mode changes (Shift+Tab, /plan, inline-row edit, picker)
  // fire the banner. Session-load background syncs do not.
  const userInitiatedModeChangeRef = useRef<boolean>(false);
  const [draftChatActive, setDraftChatActive] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiSettingsStatus | null>(null);
  const [aiStatusCheckedAt, setAiStatusCheckedAt] = useState<string | null>(null);
  const [storedApiKeyProviders, setStoredApiKeyProviders] = useState<string[]>([]);
  const [openCodeDiagnostics, setOpenCodeDiagnostics] = useState<OpenCodeRuntimeSnapshot | null>(null);
  const [rightPane, setRightPane] = useState<RightPaneContent>({ kind: "empty" });
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [formFieldIndex, setFormFieldIndex] = useState(0);
  const [rightSelectionIndex, setRightSelectionIndex] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [activePane, setActivePane] = useState<PaneFocus>("chat");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [contextPercent, setContextPercent] = useState<number | null>(null);
  const [tokenSummary, setTokenSummary] = useState<string | null>(null);
  const [statusLineStats, setStatusLineStats] = useState<TokenStats | null>(null);
  const [statusLineText, setStatusLineText] = useState<string | null>(null);
  const [currentGoal, setCurrentGoal] = useState<CodexThreadGoal | null>(null);
  const [vimModeEnabled, setVimModeEnabled] = useState(() => readClaudeVimMode(project.workspaceRoot));
  const [vimMode, setVimMode] = useState<"insert" | "normal">("insert");
  const [hideVimModeIndicator, setHideVimModeIndicator] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [chatMouseSelection, setChatMouseSelection] = useState<ChatSelectionState | null>(null);
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [expandedLineIds, setExpandedLineIds] = useState<Set<string>>(() => new Set());
  const [chatScrollOffsetRows, setChatScrollOffsetRows] = useState(0);
  const [inspectedSubagentId, setInspectedSubagentId] = useState<string | null>(null);
  const [mentionSuggestions, setMentionSuggestions] = useState<MentionSuggestion[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [selectedMentions, setSelectedMentions] = useState<MentionSuggestion[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [drawerSection, setDrawerSection] = useState<"lanes" | "chats">("lanes");
  const [drawerPreviewSessionId, setDrawerPreviewSessionId] = useState<string | null>(null);
  const [drawerPreviewEvents, setDrawerPreviewEvents] = useState<AgentChatEventEnvelope[]>([]);
  const [drawerLaneId, setDrawerLaneId] = useState<string | null>(null);
  const [selectedDrawerLaneId, setSelectedDrawerLaneId] = useState<string | null>(null);
  const [selectedDrawerChatId, setSelectedDrawerChatId] = useState<string | null>(null);
  const [selectedDrawerLaneAction, setSelectedDrawerLaneAction] = useState<DrawerLaneAction | null>(null);
  const [selectedDrawerChatAction, setSelectedDrawerChatAction] = useState<DrawerChatAction | null>(null);
  const [formDiscardArmed, setFormDiscardArmed] = useState(false);
  const [footerControl, setFooterControl] = useState<FooterControl | null>(null);
  const [inlineRowFocus, setInlineRowFocus] = useState<{ cell: 'provider' | 'model' | 'reasoning' | 'permission' | 'subagents' | null }>({ cell: null });
  const inlineRowFocused = inlineRowFocus.cell !== null;
  // Cross-surface model picker favorites/recents — authoritative copy lives in ade-cli.
	  const [modelPickerFavorites, setModelPickerFavorites] = useState<string[]>([]);
	  const [modelPickerRecents, setModelPickerRecents] = useState<string[]>([]);
	  const [modelCatalog, setModelCatalog] = useState<AgentChatModelCatalog | null>(null);

  const connectionRef = useRef<AdeCodeConnection | null>(null);
  const activeLaneIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const draftChatActiveRef = useRef(false);
  const activePaneRef = useRef<PaneFocus>("chat");
  const keybindingDispatchStateRef = useRef<KeybindingDispatchState>({ prefix: null, prefixAt: 0 });
  const footerControlRef = useRef<FooterControl | null>(null);
  const paneBeforeDetailsRef = useRef<PaneFocus>("chat");
  const chatDraftRef = useRef("");
  const promptRef = useRef("");
  const promptHistoryRef = useRef<string[]>([]);
  const promptHistoryIndexRef = useRef<number | null>(null);
  const promptHistoryDraftRef = useRef("");
  const rightPaneKindRef = useRef<RightPaneContent["kind"]>("empty");
  const lastLocalSendAtRef = useRef<number>(0);
  const eventCountRef = useRef<number>(0);
  const eventDedupKeysRef = useRef<Set<string>>(new Set());
  const eventDedupKeyOrderRef = useRef<string[]>([]);
  const refreshGenerationRef = useRef(0);
  const chatScrollOffsetRowsRef = useRef(0);
  const chatScrollMaxOffsetRef = useRef(0);
  const lastSeenAtBottomEventCountRef = useRef(0);
  const newChatPreviewLaneIdRef = useRef<string | null>(null);
  const heartbeatRef = useRef<TuiHeartbeat | null>(null);
  const draftSeededFromHistoryRef = useRef(false);
  const initialNewChatPreviewRef = useRef(true);
  const attachProbeInFlightRef = useRef(false);
  const [initialAdeCodeState] = useState(() => scopedAdeCodeState(loadAdeCodeState(), project.projectRoot));
  const lastChatByLaneRef = useRef<Map<string, string>>(new Map(Object.entries(initialAdeCodeState.lastChatByLane)));
  const lastLaneIdRef = useRef<string | null>(initialAdeCodeState.lastLaneId);
  const lastChatByLaneWriteTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingNewChatTitleRef = useRef<string | null>(null);
  const lastUserOpenedPaneRef = useRef<RightPaneContent["kind"] | null>(null);
  const userDismissedRightPaneRef = useRef(false);
  const activeSessionRef = useRef<AgentChatSessionSummary | null>(null);
  const activeTerminalSessionRef = useRef<ChatTerminalSession | null>(null);
  const terminalSessionsRef = useRef<ChatTerminalSession[]>([]);
  const attachedTerminalIdRef = useRef<string | null>(null);
  const claudeTerminalSubmitQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const exitRequestedRef = useRef(false);
  const modelStateRef = useRef<AdeCodeModelState>(initialModelState());
  const chatMouseSelectionRef = useRef<ChatSelectionState | null>(null);
  const chatSelectionAnchorRef = useRef<ChatSelectionPoint | null>(null);
  const selectableChatRowTextsRef = useRef<string[]>([]);
  const drawerPreviewGenerationRef = useRef(0);
  const drawerOpenRef = useRef(false);
  const drawerSectionRef = useRef<"lanes" | "chats">("lanes");
  const drawerLaneIdRef = useRef<string | null>(null);
  const selectedDrawerChatIdRef = useRef<string | null>(null);
  const selectedDrawerChatActionRef = useRef<DrawerChatAction | null>(null);
  const clearedAtRef = useRef<string | null>(null);
  const chatSelectionEdgeScrollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const chatSelectionEdgeScrollRef = useRef<{ direction: ChatSelectionEdgeDirection; column: number } | null>(null);
  const ctrlCExitArmedUntilRef = useRef(0);
  const ctrlCExitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const loadedSessionIdRef = useRef<string | null>(null);
	  const providerModelsCacheRef = useRef<Map<AdeCodeProvider, AgentChatModelInfo[]>>(new Map());
	  const modelCatalogRef = useRef<AgentChatModelCatalog | null>(null);
	  const modelCatalogProviderRefreshedAtRef = useRef<Map<AgentChatModelCatalogRefreshProvider, number>>(new Map());
  const pendingModelCommitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingModelCommitStateRef = useRef<AdeCodeModelState | null>(null);

  const persistAdeCodeState = useCallback(() => {
    if (lastChatByLaneWriteTimerRef.current) {
      clearTimeout(lastChatByLaneWriteTimerRef.current);
    }
    lastChatByLaneWriteTimerRef.current = setTimeout(() => {
      lastChatByLaneWriteTimerRef.current = null;
      const lastChatByLane: Record<string, string> = {};
      for (const [laneId, sessionId] of lastChatByLaneRef.current) {
        lastChatByLane[laneId] = sessionId;
      }
      saveAdeCodeProjectState(project.projectRoot, { lastChatByLane, lastLaneId: lastLaneIdRef.current });
    }, 500);
  }, [project.projectRoot]);

  const setChatScrollOffset = useCallback((value: number | ((previous: number) => number)) => {
    setChatScrollOffsetRows((previous) => {
      const raw = typeof value === "function" ? value(previous) : value;
      const next = clampChatScrollOffsetRows(raw, chatScrollMaxOffsetRef.current);
      chatScrollOffsetRowsRef.current = next;
      return next;
    });
  }, []);

  const clearTranscriptPreview = useCallback(() => {
    eventDedupKeysRef.current.clear();
    eventDedupKeyOrderRef.current = [];
    eventCountRef.current = 0;
    setEvents([]);
    setClearedAt(null);
    setCurrentGoal(null);
    setContextPercent(null);
    setTokenSummary(null);
    setStatusLineStats(null);
    setStreaming(false);
    setInterrupted(false);
  }, []);

  const selectActiveLaneId = useCallback((laneId: string | null) => {
    if (activeLaneIdRef.current !== laneId) {
      setChatScrollOffset(0);
      chatSelectionAnchorRef.current = null;
      chatMouseSelectionRef.current = null;
      setChatMouseSelection(null);
    }
    activeLaneIdRef.current = laneId;
    setActiveLaneId(laneId);
    if (laneId && lastLaneIdRef.current !== laneId) {
      lastLaneIdRef.current = laneId;
      persistAdeCodeState();
    }
  }, [persistAdeCodeState, setChatScrollOffset]);

  const selectActiveSessionId = useCallback((sessionId: string | null) => {
    if (activeSessionIdRef.current !== sessionId) {
      setChatScrollOffset(0);
      setCurrentGoal(null);
      lastUserOpenedPaneRef.current = null;
      chatSelectionAnchorRef.current = null;
      chatMouseSelectionRef.current = null;
      setChatMouseSelection(null);
    }
    if (!sessionId) {
      activeTerminalSessionRef.current = null;
      clearTranscriptPreview();
      setAttachedTerminalId(null);
    }
    if (sessionId) {
      newChatPreviewLaneIdRef.current = null;
      draftChatActiveRef.current = false;
      setDraftChatActive(false);
      setSelectedDrawerChatAction(null);
      const laneId = activeLaneIdRef.current;
      if (laneId && lastChatByLaneRef.current.get(laneId) !== sessionId) {
        lastChatByLaneRef.current.set(laneId, sessionId);
        persistAdeCodeState();
      }
    }
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
  }, [clearTranscriptPreview, persistAdeCodeState, setChatScrollOffset]);

  const setDraftChatMode = useCallback((active: boolean) => {
    setChatScrollOffset(0);
    draftChatActiveRef.current = active;
    setDraftChatActive(active);
  }, [setChatScrollOffset]);

  const setPaneFocus = useCallback((pane: PaneFocus) => {
    activePaneRef.current = pane;
    setActivePane(pane);
  }, []);

  const selectFooterControl = useCallback((control: FooterControl | null) => {
    footerControlRef.current = control;
    setFooterControl(control);
  }, []);

  useEffect(() => {
    clearedAtRef.current = clearedAt;
    drawerOpenRef.current = drawerOpen;
    drawerSectionRef.current = drawerSection;
    drawerLaneIdRef.current = drawerLaneId;
    selectedDrawerChatIdRef.current = selectedDrawerChatId;
    selectedDrawerChatActionRef.current = selectedDrawerChatAction;
  }, [
    clearedAt,
    drawerLaneId,
    drawerOpen,
    drawerSection,
    selectedDrawerChatAction,
    selectedDrawerChatId,
  ]);

  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  useEffect(() => {
    chatMouseSelectionRef.current = chatMouseSelection;
  }, [chatMouseSelection]);

  useEffect(() => {
    const summary = permissionSummary(modelState);
    const previous = lastPermissionSummaryRef.current;
    lastPermissionSummaryRef.current = summary;
    if (previous == null || previous === summary) return;
    if (!userInitiatedModeChangeRef.current) return;
    userInitiatedModeChangeRef.current = false;
    const key = `${Date.now()}:${summary}`;
    setModeChangeNotice({ summary, key });
    if (modeNoticeTimerRef.current) clearTimeout(modeNoticeTimerRef.current);
    modeNoticeTimerRef.current = setTimeout(() => {
      setModeChangeNotice((prev) => (prev?.key === key ? null : prev));
      modeNoticeTimerRef.current = null;
    }, 3000);
  }, [modelState]);

  const updateChatMouseSelection = useCallback((selection: ChatSelectionState | null) => {
    chatMouseSelectionRef.current = selection;
    setChatMouseSelection(selection);
  }, []);

  const stopChatSelectionEdgeScroll = useCallback(() => {
    chatSelectionEdgeScrollRef.current = null;
    if (chatSelectionEdgeScrollTimerRef.current) {
      clearInterval(chatSelectionEdgeScrollTimerRef.current);
      chatSelectionEdgeScrollTimerRef.current = null;
    }
  }, []);

  const stepChatSelectionEdgeScroll = useCallback(() => {
    const edge = chatSelectionEdgeScrollRef.current;
    const selection = chatMouseSelectionRef.current;
    if (!edge || !selection?.active) {
      stopChatSelectionEdgeScroll();
      return;
    }
    const rowCount = selectableChatRowTextsRef.current.length;
    if (!rowCount) {
      stopChatSelectionEdgeScroll();
      return;
    }
    if (
      (edge.direction === "older" && selection.endRow <= 0 && chatScrollOffsetRowsRef.current >= chatScrollMaxOffsetRef.current)
      || (edge.direction === "newer" && selection.endRow >= rowCount - 1 && chatScrollOffsetRowsRef.current <= 0)
    ) {
      stopChatSelectionEdgeScroll();
      return;
    }
    const rowDelta = edge.direction === "older" ? -1 : 1;
    updateChatMouseSelection(moveChatSelectionFocusByRows(selection, rowDelta, rowCount, edge.column));
    setChatScrollOffset((offset) => offset + (edge.direction === "older" ? 1 : -1));
  }, [setChatScrollOffset, stopChatSelectionEdgeScroll, updateChatMouseSelection]);

  const startChatSelectionEdgeScroll = useCallback((direction: ChatSelectionEdgeDirection, column: number) => {
    chatSelectionEdgeScrollRef.current = { direction, column };
    if (chatSelectionEdgeScrollTimerRef.current) return;
    stepChatSelectionEdgeScroll();
    chatSelectionEdgeScrollTimerRef.current = setInterval(stepChatSelectionEdgeScroll, CHAT_SELECTION_EDGE_SCROLL_MS);
  }, [stepChatSelectionEdgeScroll]);

  useEffect(() => () => {
    stopChatSelectionEdgeScroll();
    if (ctrlCExitTimerRef.current) clearTimeout(ctrlCExitTimerRef.current);
  }, [stopChatSelectionEdgeScroll]);

  const stashActiveInput = useCallback(() => {
    const pane = activePaneRef.current;
    if (pane === "chat") {
      chatDraftRef.current = promptRef.current;
      return;
    }
    if (pane === "details" && rightPane.kind === "form") {
      const field = rightPane.fields[formFieldIndex] ?? rightPane.fields[0];
      if (field) {
        setFormValues((prev) => ({ ...prev, [field.name]: promptRef.current }));
      }
    }
  }, [formFieldIndex, rightPane]);

  const focusChat = useCallback(() => {
    stashActiveInput();
    setFormDiscardArmed(false);
    selectFooterControl(null);
    setPrompt(chatDraftRef.current);
    setPaneFocus("chat");
  }, [selectFooterControl, setPaneFocus, stashActiveInput]);

  const focusDrawer = useCallback(() => {
    stashActiveInput();
    setFormDiscardArmed(false);
    selectFooterControl(null);
    setPrompt("");
    setDrawerOpen(true);
    setPaneFocus("drawer");
  }, [selectFooterControl, setPaneFocus, stashActiveInput]);

  const focusDrawerOnly = useCallback(() => {
    stashActiveInput();
    setFormDiscardArmed(false);
    selectFooterControl(null);
    setPrompt("");
    setPaneFocus("drawer");
  }, [selectFooterControl, setPaneFocus, stashActiveInput]);

  const focusDetails = useCallback(() => {
    const previousPane = activePaneRef.current;
    stashActiveInput();
    selectFooterControl(null);
    if (previousPane !== "details") {
      paneBeforeDetailsRef.current = previousPane;
    }
    setFormDiscardArmed(false);
    userDismissedRightPaneRef.current = false;
    setRightOpen(true);
    if (rightPane.kind === "form") {
      const field = rightPane.fields[formFieldIndex] ?? rightPane.fields[0];
      setPrompt(field ? formValues[field.name] ?? field.initialValue ?? "" : "");
    } else {
      setPrompt("");
    }
    setPaneFocus("details");
  }, [formFieldIndex, formValues, rightPane, selectFooterControl, setPaneFocus, stashActiveInput]);

  const focusDetailsOnly = useCallback(() => {
    const previousPane = activePaneRef.current;
    stashActiveInput();
    selectFooterControl(null);
    if (previousPane !== "details") {
      paneBeforeDetailsRef.current = previousPane;
    }
    setFormDiscardArmed(false);
    if (rightPane.kind === "form") {
      const field = rightPane.fields[formFieldIndex] ?? rightPane.fields[0];
      setPrompt(field ? formValues[field.name] ?? field.initialValue ?? "" : "");
    } else {
      setPrompt("");
    }
    setPaneFocus("details");
  }, [formFieldIndex, formValues, rightPane, selectFooterControl, setPaneFocus, stashActiveInput]);

  const clearChatPromptDraft = useCallback(() => {
    setPrompt("");
    promptRef.current = "";
    chatDraftRef.current = "";
  }, []);

  const toggleDrawerPane = useCallback(() => {
    selectFooterControl(null);
    if (drawerOpen) {
      setDrawerOpen(false);
      focusChat();
      return;
    }
    focusDrawer();
  }, [drawerOpen, focusChat, focusDrawer, selectFooterControl]);

  const toggleDetailsPane = useCallback(() => {
    selectFooterControl(null);
    if (rightOpen) {
      userDismissedRightPaneRef.current = true;
      if (rightPane.kind === "form") {
        setFormDiscardArmed(false);
        setFormValues({});
        setFormFieldIndex(0);
        setPrompt("");
        setRightPane({ kind: "empty" });
      }
      setRightOpen(false);
      lastUserOpenedPaneRef.current = null;
      focusChat();
      return;
    }
    focusDetails();
  }, [focusChat, focusDetails, rightOpen, rightPane.kind, selectFooterControl]);

  const cyclePaneFocus = useCallback(() => {
    const order: PaneFocus[] = [
      ...(drawerOpen ? (["drawer"] as PaneFocus[]) : []),
      "chat",
      ...(rightOpen ? (["details"] as PaneFocus[]) : []),
    ];
    const currentIndex = order.indexOf(activePaneRef.current);
    const nextPane = order[(currentIndex >= 0 ? currentIndex + 1 : 0) % order.length] ?? "chat";
    if (nextPane === "drawer") {
      focusDrawerOnly();
    } else if (nextPane === "details") {
      focusDetailsOnly();
    } else {
      focusChat();
    }
  }, [drawerOpen, focusChat, focusDetailsOnly, focusDrawerOnly, rightOpen]);

  const focusAfterDetails = useCallback(() => {
    if (paneBeforeDetailsRef.current === "drawer" && drawerOpen) {
      focusDrawerOnly();
      return;
    }
    focusChat();
  }, [drawerOpen, focusChat, focusDrawerOnly]);

  const projectName = path.basename(project.projectRoot);
  const activeLane = useMemo(
    () => lanes.find((lane) => lane.id === activeLaneId) ?? null,
    [activeLaneId, lanes],
  );
  const unavailableLaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const lane of lanes) {
      if (!isLaneWorktreeAvailable(lane)) ids.add(lane.id);
    }
    return ids;
  }, [lanes]);
  const drawerLane = useMemo(
    () => lanes.find((lane) => lane.id === drawerLaneId) ?? null,
    [drawerLaneId, lanes],
  );
  const activeSession = useMemo(
    () => sessions.find((session) => session.sessionId === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );
  const activeTerminalSession = useMemo(
    () => terminalSessions.find((session) => session.terminalId === activeSessionId) ?? null,
    [activeSessionId, terminalSessions],
  );
  const activeTerminalProvider = terminalSessionProvider(activeTerminalSession);
  const displaySessions = useMemo(
    () => [...sessions, ...terminalSessions.map(terminalSessionToChatSummary)]
      .sort((left, right) => {
        const rightMs = Date.parse(right.lastActivityAt ?? right.startedAt);
        const leftMs = Date.parse(left.lastActivityAt ?? left.startedAt);
        return (Number.isFinite(rightMs) ? rightMs : 0) - (Number.isFinite(leftMs) ? leftMs : 0);
      }),
    [sessions, terminalSessions],
  );
  const claudeTerminalControlAvailable = Boolean(
    activeTerminalSession
      && activeTerminalSession.status === "running"
      && activeTerminalProvider === "claude",
  );
  const claudeTerminalControlActive = claudeTerminalControlAvailable
    && attachedTerminalId === activeTerminalSession?.terminalId;
  const activeCommandProvider = activeTerminalProvider ?? activeSession?.provider ?? modelState.provider;
  // Once a chat has any sent user message, the provider is locked — swapping
  // mid-thread breaks runtime continuity. Derived from events; persists across reloads.
  const providerLocked = useMemo(() => Boolean(activeSession) && hasFirstUserMessage(events), [activeSession, events]);
  const providerLockedRef = useRef<boolean>(false);
  useEffect(() => {
    providerLockedRef.current = providerLocked;
  }, [providerLocked]);
  const latestFailedLineId = useMemo(() => latestExpandableFailureId(events), [events]);
  const subagentSnapshots = useMemo(() => subagentSnapshotsFromEvents(events), [events]);
  const liveAgentCount = useMemo(
    () => subagentSnapshots.filter((snap) => snap.status === "running").length,
    [subagentSnapshots],
  );
  const chatInfo = useMemo(() => deriveChatInfoSnapshot({
    events,
    activeSession,
    provider: modelState.provider,
    modelLabel: modelState.displayName || modelState.model || modelState.provider,
    laneLabel: activeLane?.name ?? null,
    snapshots: subagentSnapshots,
    tokenStats: statusLineStats,
    goal: currentGoal,
    streaming,
    inspectedSubagentId,
  }), [
    activeLane?.name,
    activeSession,
    currentGoal,
    events,
    inspectedSubagentId,
    modelState.displayName,
    modelState.model,
    modelState.provider,
    statusLineStats,
    streaming,
    subagentSnapshots,
  ]);
  const chatInfoRef = useRef(chatInfo);
  useEffect(() => {
    chatInfoRef.current = chatInfo;
  }, [chatInfo]);
  // Chat info is available for any active chat; subagent rows fill in when
  // the provider emits agent lifecycle events.
  const subagentPaneCommandAvailable = Boolean(activeSession && !draftChatActive);
  const subagentsButtonVisibleRef = useRef<boolean>(false);
  useEffect(() => {
    subagentsButtonVisibleRef.current = subagentPaneCommandAvailable;
  }, [subagentPaneCommandAvailable]);
  const footerControls = useMemo<FooterControl[]>(
    () => footerControlsForAvailability(subagentPaneCommandAvailable),
    [subagentPaneCommandAvailable],
  );
  const cycleFooterControl = useCallback((direction: 1 | -1) => {
    const controls: FooterControl[] = footerControls.length ? footerControls : ["drawer", "details"];
    const current = footerControlRef.current;
    const currentIndex = current ? controls.indexOf(current) : -1;
    const startIndex = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0;
    const nextIndex = (startIndex + direction + controls.length) % controls.length;
    selectFooterControl(controls[nextIndex] ?? "drawer");
  }, [footerControls, selectFooterControl]);
  useEffect(() => {
    if (footerControl === "agents" && !subagentPaneCommandAvailable) {
      selectFooterControl(null);
    }
  }, [footerControl, selectFooterControl, subagentPaneCommandAvailable]);
  useEffect(() => {
    if (rightPaneKindRef.current !== rightPane.kind) {
      if (rightPane.kind === "chat-info") {
        setRightSelectionIndex(0);
      }
      rightPaneKindRef.current = rightPane.kind;
    }
  }, [rightPane.kind]);
  useEffect(() => {
    const content = subagentPaneContentFromRightPane(rightPane);
    if (!content) return;
    // Chat-info exposes (snapshot count + 1) selectable rows: main row at 0,
    // subagents at 1..N. Clamp prior selection back into range when the
    // roster shrinks (e.g., a subagent finishes and is reaped).
    const rowCount = buildSubagentPaneRows(content).filter((row) => row.kind === "snapshot").length;
    setRightSelectionIndex((index) => Math.max(0, Math.min(Number.isFinite(index) ? Math.floor(index) : 0, rowCount)));
  }, [rightPane]);
  useEffect(() => {
    if (!inspectedSubagentId) return;
    if (rightPane.kind !== "chat-info" || !rightOpen || !subagentSnapshots.some((snap) => snap.id === inspectedSubagentId)) {
      setInspectedSubagentId(null);
    }
  }, [inspectedSubagentId, rightOpen, rightPane.kind, subagentSnapshots]);
  useEffect(() => {
    setInspectedSubagentId(null);
  }, [activeSessionId]);
  const openSubagentsPane = useCallback((): boolean => {
    if (!subagentPaneCommandAvailable) return false;
    const previousPane = activePaneRef.current;
    stashActiveInput();
    selectFooterControl(null);
    if (previousPane !== "details") {
      paneBeforeDetailsRef.current = previousPane;
    }
    setFormDiscardArmed(false);
    setPrompt("");
    setInlineRowFocus({ cell: null });
    setRightPane({
      kind: "chat-info",
      info: chatInfo,
    });
    setRightSelectionIndex(0);
    setRightOpen(true);
    setPaneFocus("details");
    lastUserOpenedPaneRef.current = "chat-info";
    return true;
  }, [
    chatInfo,
    selectFooterControl,
    setPaneFocus,
    stashActiveInput,
    subagentPaneCommandAvailable,
  ]);
  const toggleSubagentsPane = useCallback((): boolean => {
    if (!subagentPaneCommandAvailable) return true;
    selectFooterControl(null);
    if (rightOpen && rightPane.kind === "chat-info") {
      setRightOpen(false);
      lastUserOpenedPaneRef.current = null;
      setInspectedSubagentId(null);
      focusChat();
      return true;
    }
    openSubagentsPane();
    return true;
  }, [
    focusChat,
    openSubagentsPane,
    rightOpen,
    rightPane.kind,
    selectFooterControl,
    subagentPaneCommandAvailable,
  ]);
  const promptHistory = useMemo(() => events
    .map((envelope) => envelope.event)
    .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "user_message" }> => event.type === "user_message")
    .map((event) => (event.displayText || event.text || "").trim())
    .filter(Boolean)
    .slice(-200), [events]);
  useEffect(() => {
    promptHistoryRef.current = promptHistory;
    promptHistoryIndexRef.current = null;
  }, [promptHistory]);
  useEffect(() => {
    setVimModeEnabled(readClaudeVimMode(project.workspaceRoot));
    setVimMode("insert");
  }, [project.workspaceRoot]);
  const orderedDrawerLanes = useMemo(
    () => sortLanesForStackGraph(lanes),
    [lanes],
  );
  const drawerLaneRows = useMemo(
    () => orderedDrawerLanes.slice(0, visibleDrawerLaneCount(rows, orderedDrawerLanes.length)),
    [orderedDrawerLanes, rows],
  );
  const diffLaneIdsKey = useMemo(
    () => lanes.filter((lane) => !lane.archivedAt).map((lane) => lane.id).sort().join("\n"),
    [lanes],
  );
  const drawerLaneSessions = useMemo(
    () => displaySessions.filter((session) => session.laneId === drawerLaneId),
    [displaySessions, drawerLaneId],
  );
  const drawerVisibleLaneSessions = useMemo(
    () => drawerLaneSessions.slice(0, visibleDrawerChatCount(drawerLaneSessions.length)),
    [drawerLaneSessions],
  );
  const selectedLaneIndex = useMemo(() => {
    if (selectedDrawerLaneAction === "new-lane") return drawerLaneRows.length;
    const targetId = selectedDrawerLaneId ?? drawerLaneId ?? activeLaneId;
    const index = drawerLaneRows.findIndex((lane) => lane.id === targetId);
    return index >= 0 ? index : 0;
  }, [activeLaneId, drawerLaneId, drawerLaneRows, selectedDrawerLaneAction, selectedDrawerLaneId]);
  const selectedChatIndex = useMemo(() => {
    if (selectedDrawerChatAction === "new-chat") return drawerVisibleLaneSessions.length;
    const targetId = selectedDrawerChatId
      ?? (drawerLaneId === activeLaneId ? activeSessionId : null);
    const index = drawerVisibleLaneSessions.findIndex((session) => session.sessionId === targetId);
    return index >= 0 ? index : 0;
  }, [activeLaneId, activeSessionId, drawerLaneId, drawerVisibleLaneSessions, selectedDrawerChatAction, selectedDrawerChatId]);
  const applyDrawerChatSelection = useCallback((
    selection: { session: AgentChatSessionSummary | null; action: DrawerChatAction | null },
  ) => {
    const clearLoadedTranscript = (): void => {
      loadedSessionIdRef.current = null;
      eventCountRef.current = 0;
      setEvents([]);
      setStreaming(false);
      setInterrupted(false);
      setCurrentGoal(null);
      setContextPercent(null);
      setTokenSummary(null);
      setStatusLineStats(null);
    };

    if (selection.action === "new-chat") {
      const laneId = drawerLaneIdRef.current ?? activeLaneIdRef.current;
      newChatPreviewLaneIdRef.current = laneId;
      draftChatActiveRef.current = true;
      setDraftChatMode(true);
      selectActiveSessionId(null);
      clearLoadedTranscript();
      return;
    }

    if (!selection.session) {
      draftChatActiveRef.current = false;
      setDraftChatMode(false);
      selectActiveSessionId(null);
      clearLoadedTranscript();
      return;
    }

    const session = selection.session;
    newChatPreviewLaneIdRef.current = null;
    draftChatActiveRef.current = false;
    setDraftChatMode(false);
    if (session.laneId !== activeLaneIdRef.current) {
      selectActiveLaneId(session.laneId);
    }
    const sessionId = session.sessionId;
    if (activeSessionIdRef.current !== sessionId) {
      selectActiveSessionId(sessionId);
    }
    if (loadedSessionIdRef.current === sessionId) return;

    const conn = connectionRef.current;
    if (!conn) return;

    const generation = drawerPreviewGenerationRef.current + 1;
    drawerPreviewGenerationRef.current = generation;
    void (async () => {
      try {
        const history = await getChatHistory(conn, sessionId);
        if (generation !== drawerPreviewGenerationRef.current) return;
        if (activeSessionIdRef.current !== sessionId) return;
        if (selectedDrawerChatIdRef.current !== sessionId) return;

        if (history.sessionFound === false) {
          loadedSessionIdRef.current = sessionId;
          eventCountRef.current = 0;
          setEvents([]);
          setCurrentGoal(null);
          setContextPercent(null);
          setTokenSummary(null);
          setStatusLineStats(null);
          setStreaming(false);
          setInterrupted(false);
          return;
        }

        const clearedAtValue = clearedAtRef.current;
        const historyEvents = clearedAtValue
          ? history.events.filter((event) => event.timestamp > clearedAtValue)
          : history.events;
        loadedSessionIdRef.current = sessionId;
        eventCountRef.current = history.events.length;
        eventDedupKeyOrderRef.current = syncTuiEventDedupKeys(eventDedupKeysRef.current, historyEvents);
        setEvents(historyEvents);
        setCurrentGoal(latestGoal(history.events));
        const fallbackContext = session.modelId ? getModelById(session.modelId)?.contextWindow ?? null : null;
        const stats = latestTokenStats(history.events, fallbackContext);
        setContextPercent(stats.percent);
        setTokenSummary(formatTokenSummary(stats));
        setStatusLineStats(stats);
        setStreaming(session.status === "active");
        if (session.status === "active") setInterrupted(false);
      } catch {
        // Best-effort preview hydration; leave prior content on transient errors.
      }
    })();
  }, [selectActiveLaneId, selectActiveSessionId, setDraftChatMode]);
  const enterDrawerChatListForLane = useCallback((lane: LaneSummary) => {
    const laneSessions = displaySessions.filter((entry) => entry.laneId === lane.id);
    const visibleSessions = laneSessions.slice(0, visibleDrawerChatCount(laneSessions.length));
    const lastSessionId = lastChatByLaneRef.current.get(lane.id);
    const session =
      visibleSessions.find((entry) => entry.sessionId === lastSessionId)
      ?? newestSession(visibleSessions);
    const action: DrawerChatAction | null = session ? null : "new-chat";
    setDrawerSection("chats");
    setDrawerLaneId(lane.id);
    setSelectedDrawerLaneId(lane.id);
    setSelectedDrawerLaneAction(null);
    selectActiveLaneId(lane.id);
    setSelectedDrawerChatId(session?.sessionId ?? null);
    setSelectedDrawerChatAction(action);
    applyDrawerChatSelection({ session: session ?? null, action });
  }, [applyDrawerChatSelection, displaySessions, selectActiveLaneId]);
  const activeMentionRange = useMemo(() => (
    activePane === "chat" ? activeMention(prompt) : null
  ), [activePane, prompt]);
  const slashRows = useMemo(() => (
    activePane === "chat" && prompt.startsWith("/")
      ? paletteCommands(prompt, slashCommands, { provider: activeCommandProvider })
      : []
  ), [activeCommandProvider, activePane, prompt, slashCommands]);
  const pendingApproval = useMemo(() => latestPendingApproval(events), [events]);
  const pendingSteers = useMemo(() => derivePendingSteers(events), [events]);
  const goalBannerText = useMemo(() => formatGoalBannerLine(currentGoal), [currentGoal]);
  const activeFormField = rightPane.kind === "form"
    ? rightPane.fields[formFieldIndex] ?? rightPane.fields[0] ?? null
    : null;
  const statusLineRows = statusLineText ? Math.min(3, statusLineText.split(/\r?\n/).filter(Boolean).length || 1) : 0;
  const statusRows = statusLineRows;
  const goalBannerRows = goalBannerText ? 1 : 0;
  const rightPaneMaxWidth = RIGHT_PANE_MAX_WIDTH;
  const rightPaneWidth = resolveRightPaneWidth(columns, rightOpen, drawerOpen, rightPaneMaxWidth);
  const centerWidth = resolveCenterPaneWidth(columns, drawerOpen, rightPaneWidth);
  const promptPaneWidth = Math.max(MIN_CENTER_PANE_WIDTH, finiteFloor(columns, MIN_CENTER_PANE_WIDTH));
  const promptRows = promptDisplayRows(prompt, Math.max(1, promptPaneWidth - 5), PROMPT_MAX_ROWS);
  const chatRowBudget = Math.max(4, rows - 8 - (promptRows.length - 1) - statusRows - goalBannerRows);
  // Only cap the prose chat wrap width. Embedded CLI terminals should track the
  // center pane so PTYs resize when panes or the host window resize.
  const chatWrapWidth = resolveChatWrapWidth(centerWidth, drawerOpen, rightPaneWidth);
  const terminalPaneWidth = resolveTerminalPaneWidth(centerWidth);
  const selectedAgentSnapshot = useMemo(() => {
    if (!rightOpen || rightPane.kind !== "chat-info" || !inspectedSubagentId) return null;
    return subagentSnapshots.find((snapshot) => snapshot.id === inspectedSubagentId) ?? null;
  }, [inspectedSubagentId, rightOpen, rightPane.kind, subagentSnapshots]);
  const displayEvents = useMemo(() => (
    selectedAgentSnapshot
      ? buildSubagentTranscriptEvents({ events, activeSession, snapshot: selectedAgentSnapshot })
      : events
  ), [activeSession, events, selectedAgentSnapshot]);
  const displayNotices = useMemo(() => (selectedAgentSnapshot ? [] : notices), [notices, selectedAgentSnapshot]);
  const displayStreaming = selectedAgentSnapshot ? selectedAgentSnapshot.status === "running" : streaming;
  const displayInterrupted = selectedAgentSnapshot ? false : interrupted && !displayStreaming;
  useEffect(() => {
    chatSelectionAnchorRef.current = null;
    stopChatSelectionEdgeScroll();
    updateChatMouseSelection(null);
  }, [selectedAgentSnapshot?.id, stopChatSelectionEdgeScroll, updateChatMouseSelection]);
  const spinTickActive = displayStreaming
    || mode === "connecting"
    || sessions.some((session) => session.status === "active")
    || terminalSessions.some((session) => session.status === "running")
    || liveAgentCount > 0
    || (rightPane.kind === "lane-details" && rightPane.chats.active > 0);
  const chatScrollMaxOffset = useMemo(() => computeChatScrollMaxOffset({
    events: displayEvents,
    notices: displayNotices,
    activeSession,
    expandedLineIds,
    maxRows: chatRowBudget,
    streaming: displayStreaming,
    interrupted: displayInterrupted,
    width: chatWrapWidth,
  }), [activeSession, chatRowBudget, chatWrapWidth, displayEvents, displayInterrupted, displayNotices, displayStreaming, expandedLineIds]);
  chatScrollMaxOffsetRef.current = chatScrollMaxOffset;
  const effectiveChatScrollOffsetRows = clampChatScrollOffsetRows(chatScrollOffsetRows, chatScrollMaxOffset);
  chatScrollOffsetRowsRef.current = effectiveChatScrollOffsetRows;
  // Track the event-count snapshot at the moment the user was last anchored to
  // the bottom of the transcript. When they scroll up and new messages arrive,
  // the delta becomes the "↓ N new messages" pill count.
  if (effectiveChatScrollOffsetRows === 0) {
    lastSeenAtBottomEventCountRef.current = displayEvents.length;
  }
  const unseenMessageCount = effectiveChatScrollOffsetRows > 0
    ? Math.max(0, displayEvents.length - lastSeenAtBottomEventCountRef.current)
    : 0;
  const visibleChatSelectionRows = useMemo(() => renderChatVisibleSelectionRows({
    events: displayEvents,
    notices: displayNotices,
    activeSession,
    expandedLineIds,
    maxRows: chatRowBudget,
    scrollOffsetRows: effectiveChatScrollOffsetRows,
    unseenMessageCount,
    width: chatWrapWidth,
    streaming: displayStreaming,
    interrupted: displayInterrupted,
  }), [
    activeSession,
    chatRowBudget,
    chatWrapWidth,
    displayEvents,
    displayInterrupted,
    displayNotices,
    displayStreaming,
    effectiveChatScrollOffsetRows,
    expandedLineIds,
    unseenMessageCount,
  ]);
  const selectableChatRowTexts = useMemo(() => renderChatSelectableRowTexts({
    events: displayEvents,
    notices: displayNotices,
    activeSession,
    expandedLineIds,
    width: chatWrapWidth,
    streaming: displayStreaming,
    interrupted: displayInterrupted,
  }), [
    activeSession,
    chatWrapWidth,
    displayEvents,
    displayInterrupted,
    displayNotices,
    displayStreaming,
    expandedLineIds,
  ]);
  useEffect(() => {
    selectableChatRowTextsRef.current = selectableChatRowTexts;
  }, [selectableChatRowTexts]);
  const providerReadinessRows = useMemo(
    () => buildProviderReadinessRows(aiStatus, storedApiKeyProviders, openCodeDiagnostics),
    [aiStatus, openCodeDiagnostics, storedApiKeyProviders],
  );
  const newChatSetupRows = useMemo(
    () => setupRowsForRuntime(buildSetupRows({
      modelState,
      models,
      includeRefresh: false,
      includeApply: true,
      outputStyle: "default",
      outputStyleEditable: false,
    }), mode),
    [mode, modelState, models],
  );
  const modelSetupRows = useMemo(
    () => setupRowsForRuntime(buildSetupRows({
      modelState,
      models,
      includeRefresh: true,
      includeApply: true,
      outputStyle: activeSession?.claudeOutputStyle ?? "default",
      outputStyleEditable: Boolean(activeSession?.sessionId && activeSession.provider === "claude"),
    }), mode),
    [activeSession?.claudeOutputStyle, activeSession?.provider, activeSession?.sessionId, mode, modelState, models],
  );
  const modelPickerRows = useMemo(() => {
    if (!providerLocked) return modelSetupRows;
    return modelSetupRows.map((row) => row.kind === "provider"
      ? {
          ...row,
          disabled: true,
          cyclable: false,
          detail: "locked for this chat · /new chat to switch provider",
        }
      : row);
  }, [modelSetupRows, providerLocked]);

  useEffect(() => {
    activeLaneIdRef.current = activeLaneId;
  }, [activeLaneId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  useEffect(() => {
    activeTerminalSessionRef.current = activeTerminalSession;
  }, [activeTerminalSession]);

  useEffect(() => {
    eventCountRef.current = events.length;
    if (!activeSessionId || activeTerminalSession) return;
    const fallbackContext = activeSession?.modelId
      ? getModelById(activeSession.modelId)?.contextWindow ?? null
      : null;
    const stats = latestTokenStats(events, fallbackContext);
    setCurrentGoal(latestGoal(events));
    setContextPercent(stats.percent);
    setTokenSummary(formatTokenSummary(stats));
    setStatusLineStats(stats);
  }, [activeSession?.modelId, activeSessionId, activeTerminalSession, events]);

  useEffect(() => {
    terminalSessionsRef.current = terminalSessions;
  }, [terminalSessions]);

  useEffect(() => {
    if (!activeTerminalSession) setTerminalPreview(null);
  }, [activeTerminalSession]);

  useEffect(() => {
    attachedTerminalIdRef.current = attachedTerminalId;
  }, [attachedTerminalId]);

  useEffect(() => {
    if (!connection || !activeTerminalSession) return;
    const cols = clampTerminalPaneCols(claudeTerminalControlActive ? terminalPaneWidth - 2 : terminalPaneWidth);
    const terminalRows = claudeTerminalControlActive
      ? Math.max(4, chatRowBudget - 1)
      : claudeTerminalRowsForPane(chatRowBudget);
    let cancelled = false;
    void resizeTerminal(connection, activeTerminalSession.terminalId, cols, terminalRows)
      .then(() => previewTerminal(connection, activeTerminalSession.terminalId))
      .then((preview) => {
        if (!cancelled && activeSessionIdRef.current === activeTerminalSession.terminalId) {
          setTerminalPreview(preview);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeTerminalSession, chatRowBudget, claudeTerminalControlActive, connection, terminalPaneWidth]);

  useEffect(() => {
    if (!connection || !activeTerminalSession) return;
    let cancelled = false;
    const refreshPreview = () => {
      void previewTerminal(connection, activeTerminalSession.terminalId)
        .then((preview) => {
          if (!cancelled && activeSessionIdRef.current === activeTerminalSession.terminalId) {
            setTerminalPreview(preview);
          }
        })
        .catch(() => {
          if (!cancelled && activeSessionIdRef.current === activeTerminalSession.terminalId) {
            setTerminalPreview(null);
          }
        });
    };
    refreshPreview();
    const timer = setInterval(refreshPreview, 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeTerminalSession, chatRowBudget, connection, terminalPaneWidth]);

  useEffect(() => {
    modelStateRef.current = modelState;
  }, [modelState]);

  useEffect(() => {
    chatScrollMaxOffsetRef.current = chatScrollMaxOffset;
    setChatScrollOffsetRows((previous) => {
      const next = clampChatScrollOffsetRows(previous, chatScrollMaxOffset);
      chatScrollOffsetRowsRef.current = next;
      return next;
    });
  }, [chatScrollMaxOffset]);

  // Context-aware default for the right pane. Runs whenever one of the inputs
  // changes — but leaves the pane alone while a slash command (sticky) or any
  // other non-default content is showing. The sticky marker is cleared on chat
  // switch (in selectActiveSessionId) and on explicit close (Esc / pane:close).
  const highlightedDrawerLane = useMemo(() => {
    if (drawerSection !== "lanes") return null;
    const id = selectedDrawerLaneId ?? drawerLaneId ?? activeLaneId;
    if (!id) return null;
    return lanes.find((lane) => lane.id === id) ?? null;
  }, [activeLaneId, drawerLaneId, drawerSection, lanes, selectedDrawerLaneId]);

  const drawerPreviewSession = useMemo(() => {
    if (drawerSection !== "chats" || selectedDrawerChatAction === "new-chat" || !selectedDrawerChatId) {
      return null;
    }
    return displaySessions.find((session) => session.sessionId === selectedDrawerChatId) ?? null;
  }, [displaySessions, drawerSection, selectedDrawerChatAction, selectedDrawerChatId]);

  const drawerPreviewChatInfo = useMemo(() => {
    if (!drawerPreviewSession) return null;
    let previewEvents: AgentChatEventEnvelope[] = [];
    if (drawerPreviewSession.sessionId === activeSessionId) {
      previewEvents = events;
    } else if (drawerPreviewSessionId === drawerPreviewSession.sessionId) {
      previewEvents = drawerPreviewEvents;
    }
    const lane = lanes.find((entry) => entry.id === drawerPreviewSession.laneId) ?? null;
    return deriveDrawerPreviewChatInfo(
      drawerPreviewSession,
      previewEvents,
      lane?.name ?? drawerLane?.name ?? null,
    );
  }, [
    activeSessionId,
    drawerLane?.name,
    drawerPreviewEvents,
    drawerPreviewSession,
    drawerPreviewSessionId,
    events,
    lanes,
  ]);

  const drawerNavTarget = useMemo((): DrawerNavTarget | null => {
    if (!drawerOpen) return null;
    if (drawerSection === "lanes") {
      const lane = highlightedDrawerLane ?? drawerLane ?? activeLane;
      return lane ? { kind: "lane", lane } : null;
    }
    if (selectedDrawerChatAction === "new-chat") {
      const laneId = drawerLaneId ?? activeLaneId;
      const lane = lanes.find((entry) => entry.id === laneId) ?? drawerLane ?? activeLane;
      if (!laneId || !lane || unavailableLaneIds.has(laneId)) return null;
      return {
        kind: "new-chat",
        laneId,
        laneLabel: lane.name,
        rows: newChatSetupRows,
      };
    }
    if (drawerPreviewSession && drawerPreviewChatInfo) {
      return { kind: "chat", info: drawerPreviewChatInfo };
    }
    return null;
  }, [
    activeLane,
    drawerLane,
    drawerLaneId,
    drawerOpen,
    drawerPreviewChatInfo,
    drawerPreviewSession,
    drawerSection,
    highlightedDrawerLane,
    lanes,
    newChatSetupRows,
    selectedDrawerChatAction,
    unavailableLaneIds,
    activeLaneId,
  ]);

  useEffect(() => {
    if (rightPane.kind !== "chat-info") return;
    if (drawerOpen && drawerPreviewSession && drawerPreviewChatInfo) return;
    setRightPane({ kind: "chat-info", info: chatInfo });
  }, [chatInfo, drawerOpen, drawerPreviewChatInfo, drawerPreviewSession, rightPane.kind]);

  useEffect(() => {
    if (!drawerOpen || activePane !== "drawer" || drawerSection !== "chats") {
      setDrawerPreviewSessionId(null);
      setDrawerPreviewEvents([]);
      return;
    }
    if (selectedDrawerChatAction === "new-chat" || !selectedDrawerChatId) {
      setDrawerPreviewSessionId(null);
      setDrawerPreviewEvents([]);
      return;
    }
    if (selectedDrawerChatId === activeSessionId) {
      setDrawerPreviewSessionId(selectedDrawerChatId);
      setDrawerPreviewEvents([]);
      return;
    }
    let cancelled = false;
    const sessionId = selectedDrawerChatId;
    const loadPreview = async () => {
      const conn = connectionRef.current;
      if (!conn) return;
      try {
        const history = await getChatHistory(conn, sessionId);
        if (cancelled || selectedDrawerChatId !== sessionId) return;
        setDrawerPreviewSessionId(sessionId);
        setDrawerPreviewEvents(history.sessionFound === false ? [] : history.events);
      } catch {
        if (!cancelled) {
          setDrawerPreviewSessionId(sessionId);
          setDrawerPreviewEvents([]);
        }
      }
    };
    void loadPreview();
    const session = displaySessions.find((entry) => entry.sessionId === sessionId);
    const poll = session?.status === "active"
      ? setInterval(() => {
          void loadPreview();
        }, 2_000)
      : null;
    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
    };
  }, [
    activePane,
    activeSessionId,
    displaySessions,
    drawerOpen,
    drawerSection,
    selectedDrawerChatAction,
    selectedDrawerChatId,
  ]);

  useEffect(() => {
    // If the user explicitly opened a pane via a slash command, leave it alone.
    if (lastUserOpenedPaneRef.current !== null) return;
    // Form panes (rename, new-lane, pr-open) are user-driven; never overwrite.
    if (rightPane.kind === "form") return;
    const next = resolveContextDefault({
      draftChatActive: draftChatActiveRef.current,
      activeSession,
      activeLane,
      liveAgentCount,
      highlightedDrawerLane,
      drawerMode: drawerSection,
      drawerNav: drawerNavTarget,
      chatInfo,
      subagentSnapshots,
      provider: (activeSession?.provider ?? modelState.provider) as AdeCodeProvider,
      unavailableLaneIds,
      newChatSetup: (drawerLaneId ?? activeLaneId)
        ? {
            laneId: drawerLaneId ?? activeLaneId!,
            laneLabel: drawerLane?.name ?? activeLane?.name ?? drawerLaneId ?? activeLaneId!,
            rows: newChatSetupRows,
          }
        : null,
    });
    setRightPane((prev) => {
      if (prev.kind === "chat-info" && next.kind === "chat-info") {
        return next;
      }
      if (prev.kind === "new-chat-setup" && next.kind === "new-chat-setup") {
        return next;
      }
      // Avoid stomping on lane-details that has been hydrated with git data;
      // only refresh when the lane reference itself changed.
      if (
        prev.kind === "lane-details"
        && next.kind === "lane-details"
        && prev.lane.id === next.lane.id
        && prev.worktreeAvailable === next.worktreeAvailable
      ) {
        return prev;
      }
      if (prev.kind === next.kind && next.kind === "empty") return prev;
      return next;
    });
  }, [
    activeLane,
    activeLaneId,
    activeSession,
    chatInfo,
    draftChatActive,
    drawerLane,
    drawerLaneId,
    drawerNavTarget,
    drawerSection,
    highlightedDrawerLane,
    liveAgentCount,
    modelState.provider,
    newChatSetupRows,
    rightPane.kind,
    selectedDrawerChatAction,
    subagentSnapshots,
    unavailableLaneIds,
  ]);

  useEffect(() => {
    if (rightPane.kind === "new-chat-setup") {
      setRightPane((prev) => {
        if (prev.kind !== "new-chat-setup") return prev;
        if (drawerNavTarget?.kind === "new-chat") {
          return {
            ...prev,
            laneId: drawerNavTarget.laneId,
            laneLabel: drawerNavTarget.laneLabel,
            rows: drawerNavTarget.rows,
          };
        }
        return {
          ...prev,
          laneId: activeLaneId ?? prev.laneId,
          laneLabel: activeLane?.name ?? prev.laneLabel,
          rows: newChatSetupRows,
        };
      });
    } else if (rightPane.kind === "lane-details") {
      setRightPane((prev) => prev.kind === "lane-details"
        ? {
            ...prev,
            chats: computeLaneChatCounts(displaySessions, prev.lane.id),
          }
        : prev);
    } else if (rightPane.kind === "model-setup") {
      setRightPane((prev) => prev.kind === "model-setup"
        ? { ...prev, rows: providerLocked ? modelPickerRows : modelSetupRows }
        : prev);
    }
  }, [activeLane?.name, activeLaneId, displaySessions, drawerNavTarget, modelPickerRows, modelSetupRows, newChatSetupRows, providerLocked, rightPane.kind]);

  useEffect(() => {
    const { config } = readClaudeStatusLineConfig(project.workspaceRoot);
    if (!config) {
      setStatusLineText(null);
      setHideVimModeIndicator(false);
      return;
    }
    setHideVimModeIndicator(config.hideVimModeIndicator);
    let cancelled = false;
    const refresh = async () => {
      const totalInputTokens = statusLineStats?.inputTokens ?? null;
      const totalOutputTokens = statusLineStats?.outputTokens ?? null;
      const cacheCreationTokens = statusLineStats?.cacheCreationTokens ?? null;
      const cacheReadTokens = statusLineStats?.cacheReadTokens ?? null;
      const contextWindowSize = statusLineStats?.contextWindow ?? null;
      const contextUsed = totalInputTokens != null || totalOutputTokens != null
        ? (totalInputTokens ?? 0) + (totalOutputTokens ?? 0)
        : null;
      const contextUsedPercentage = contextPercent ?? (
        contextUsed != null && contextWindowSize != null && contextWindowSize > 0
          ? Math.round((contextUsed / contextWindowSize) * 100)
          : null
      );
      const rateLimitWindow = statusLineStats?.rateLimit
        ? {
            used_percentage: statusLineStats.rateLimit.usedPercentage,
            resets_at: statusLineStats.rateLimit.resetsAt,
          }
        : null;
      const result = await runClaudeStatusLineCommand(config, {
        cwd: project.workspaceRoot,
        workspaceRoot: project.workspaceRoot,
        projectRoot: project.projectRoot,
        model: {
          id: modelState.modelId,
          displayName: modelState.displayName,
          display_name: modelState.displayName,
          provider: modelState.provider,
          fastMode: modelState.codexFastMode,
          supportsEffort: modelReasoningEfforts(modelState, models).length > 0,
        },
        workspace: {
          current_dir: project.workspaceRoot,
          project_dir: project.projectRoot,
          added_dirs: [],
          git_worktree: activeLane?.branchRef ?? null,
          gitBranch: activeLane?.branchRef ?? null,
        },
        session: {
          id: activeSession?.sessionId ?? activeSessionId,
          title: activeSession?.title ?? null,
        },
        session_id: activeSession?.sessionId ?? activeSessionId,
        session_name: activeSession?.title ?? null,
        lane: activeLane?.name ?? activeLaneId,
        permission_mode: modelState.provider === "claude"
          ? modelState.claudePermissionMode
          : modelState.permissionMode,
        context: {
          percent: contextUsedPercentage,
          tokenSummary,
        },
        context_window: {
          used: contextUsed,
          total: contextWindowSize,
          percentage: contextUsedPercentage,
          used_percentage: contextUsedPercentage,
          remaining_percentage: contextUsedPercentage == null ? null : Math.max(0, 100 - contextUsedPercentage),
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          context_window_size: contextWindowSize,
          current_usage: {
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            cache_creation_input_tokens: cacheCreationTokens,
            cache_read_input_tokens: cacheReadTokens,
          },
        },
        rate_limits: rateLimitWindow
          ? {
              reset_at: rateLimitWindow.resets_at ? new Date(rateLimitWindow.resets_at * 1000).toISOString() : null,
              remaining: rateLimitWindow.used_percentage == null ? null : Math.max(0, 100 - rateLimitWindow.used_percentage),
              five_hour: rateLimitWindow,
              seven_day: rateLimitWindow,
            }
          : { five_hour: null, seven_day: null, reset_at: null, remaining: null },
        cost: {
          total_cost_usd: statusLineStats?.costUsd ?? null,
          total_duration_ms: null,
          total_api_duration_ms: null,
          total_lines_added: null,
          total_lines_removed: null,
        },
        output_style: {
          name: activeSession?.claudeOutputStyle ?? null,
        },
        effort: {
          level: activeSession?.reasoningEffort ?? modelState.reasoningEffort ?? null,
        },
        thinking: {
          enabled: Boolean(activeSession?.reasoningEffort ?? modelState.reasoningEffort),
        },
        vim: {
          mode: vimModeEnabled ? (vimMode === "normal" ? "NORMAL" : "INSERT") : "INSERT",
        },
        transcript_path: null,
        version: "ade-code",
      });
      if (cancelled) return;
      const padding = " ".repeat(config.padding);
      setStatusLineText(result.ok && result.text
        ? result.text.split(/\r?\n/).map((line) => `${padding}${line}`).join("\n")
        : null);
    };
    void refresh();
    const timer = config.refreshIntervalSeconds == null
      ? null
      : setInterval(() => {
          void refresh();
        }, config.refreshIntervalSeconds * 1000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [activeLane?.branchRef, activeLane?.name, activeLaneId, activeSession?.claudeOutputStyle, activeSession?.reasoningEffort, activeSession?.sessionId, activeSession?.title, activeSessionId, contextPercent, modelState, models, project.projectRoot, project.workspaceRoot, statusLineStats, tokenSummary, vimMode, vimModeEnabled]);

  const rightPaneLaneId = rightPane.kind === "lane-details" ? rightPane.lane.id : null;

  useEffect(() => {
    if (!rightOpen) return;
    if (rightPane.kind !== "empty" && rightPane.kind !== "lane-details") return;
    const lane = rightPane.kind === "lane-details"
      ? lanes.find((candidate) => candidate.id === rightPane.lane.id) ?? rightPane.lane
      : highlightedDrawerLane ?? activeLane;
    if (!lane) return;

    let cancelled = false;
    const laneId = lane.id;

    const refresh = async () => {
      const conn = connectionRef.current;
      if (!conn) return;
      try {
        const [syncRes, changesRes, prsRes] = await Promise.all([
          conn.action<{ ahead?: number; behind?: number; upstreamRef?: string | null }>("git", "getSyncStatus", { laneId }).catch(() => null),
          conn.actionList<{ staged: { path: string; kind: string }[]; unstaged: { path: string; kind: string }[] }>("diff", "getChanges", [laneId]).catch(() => null),
          conn.action<Array<Record<string, unknown>>>("pr", "listAll", { laneId }).catch(() => [] as Array<Record<string, unknown>>),
        ]);
        if (cancelled) return;

        const ahead = typeof syncRes?.ahead === "number" ? syncRes.ahead : 0;
        const behind = typeof syncRes?.behind === "number" ? syncRes.behind : 0;
        const remote = typeof syncRes?.upstreamRef === "string" ? syncRes.upstreamRef : null;

        const staged = changesRes?.staged ?? [];
        const unstaged = changesRes?.unstaged ?? [];
        const fileMap = new Map<string, { path: string; status: "M" | "A" | "D" | "?"; staged: boolean }>();
        const toStatus = (kind: string): "M" | "A" | "D" | "?" => {
          if (kind === "added" || kind === "untracked") return kind === "untracked" ? "?" : "A";
          if (kind === "deleted") return "D";
          if (kind === "modified" || kind === "renamed") return "M";
          return "?";
        };
        for (const file of staged) {
          fileMap.set(file.path, { path: file.path, status: toStatus(file.kind), staged: true });
        }
        for (const file of unstaged) {
          if (!fileMap.has(file.path)) {
            fileMap.set(file.path, { path: file.path, status: toStatus(file.kind), staged: false });
          }
        }
        const files = [...fileMap.values()];
        const laneDiffStats = diffByLaneId[laneId];

        const activePr = prsRes[0] ?? null;
        let pr: {
          number: number;
          state: "open" | "closed" | "merged";
          url: string;
          checksPassed: number;
          checksTotal: number;
          checksPending: number;
          checksFailed: number;
        } | null = null;
        if (activePr) {
          const number = typeof activePr.githubPrNumber === "number"
            ? activePr.githubPrNumber
            : typeof activePr.number === "number"
              ? activePr.number
              : null;
          const url = typeof activePr.githubUrl === "string"
            ? activePr.githubUrl
            : typeof activePr.url === "string"
              ? activePr.url
              : "";
          const rawState = typeof activePr.state === "string" ? activePr.state : "open";
          const state: "open" | "closed" | "merged" =
            rawState === "merged" ? "merged" : rawState === "closed" ? "closed" : "open";
          const prId = typeof activePr.id === "string" ? activePr.id : typeof activePr.prId === "string" ? activePr.prId : "";
          let checksPassed = 0;
          let checksTotal = 0;
          let checksPending = 0;
          let checksFailed = 0;
          if (prId) {
            const checks = await conn.actionList<Array<{ status?: string; conclusion?: string | null }>>("pr", "getChecks", [prId]).catch(() => null);
            if (!cancelled && Array.isArray(checks)) {
              checksTotal = checks.length;
              checksPassed = checks.filter((check) => check.status === "completed" && check.conclusion === "success").length;
              checksFailed = checks.filter((check) => check.conclusion === "failure").length;
              checksPending = checks.filter((check) => check.status !== "completed").length;
            }
          }
          if (number != null && url) {
            pr = { number, state, url, checksPassed, checksTotal, checksPending, checksFailed };
          }
        }

        if (cancelled) return;
        const chatCounts = computeLaneChatCounts(displaySessions, laneId);
        setRightPane((prev) => {
          if (cancelled) return prev;
          if (prev.kind !== "lane-details" && prev.kind !== "empty") return prev;
          if (prev.kind === "lane-details" && prev.lane.id !== laneId) return prev;
          const previousIndex = prev.kind === "lane-details" ? prev.selectedActionIndex : 0;
          const previousShowFiles = prev.kind === "lane-details" ? prev.showFiles : false;
          const maxIndex = LANE_DETAIL_ACTIONS.length - 1 + (pr ? 1 : 0);
          return {
            kind: "lane-details",
            lane,
            git: {
              staged: staged.length,
              unstaged: unstaged.length,
              total: laneDiffStats?.files ?? files.length,
              ahead,
              behind,
              remote,
              additions: laneDiffStats?.additions ?? 0,
              deletions: laneDiffStats?.deletions ?? 0,
            },
            files,
            pr,
            chats: chatCounts,
            showFiles: previousShowFiles,
            selectedActionIndex: Math.max(0, Math.min(previousIndex, maxIndex)),
            worktreeAvailable: !unavailableLaneIds.has(lane.id),
          };
        });
      } catch {
        // best-effort — leave the existing pane content alone on transient errors
      }
    };

    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeLane, diffByLaneId, displaySessions, highlightedDrawerLane, lanes, rightOpen, rightPane.kind, rightPaneLaneId, unavailableLaneIds]);

  useEffect(() => {
    if (!drawerLaneId || !lanes.some((lane) => lane.id === drawerLaneId)) {
      setDrawerLaneId(activeLaneId);
    }
  }, [activeLaneId, drawerLaneId, lanes]);

  useEffect(() => {
    if (selectedDrawerLaneAction) return;
    if (selectedDrawerLaneId && drawerLaneRows.some((lane) => lane.id === selectedDrawerLaneId)) return;
    setSelectedDrawerLaneId(drawerLaneId ?? activeLaneId ?? drawerLaneRows[0]?.id ?? null);
  }, [activeLaneId, drawerLaneId, drawerLaneRows, selectedDrawerLaneAction, selectedDrawerLaneId]);

  useEffect(() => {
    const next = resolveDrawerChatSelection({
      activeLaneId,
      activeSessionId,
      draftChatActive,
      drawerLaneId,
      drawerVisibleLaneSessions,
      selectedDrawerChatAction,
      selectedDrawerChatId,
    });
    if (!next) return;
    setSelectedDrawerChatId(next.selectedDrawerChatId);
    setSelectedDrawerChatAction(next.selectedDrawerChatAction);
  }, [activeLaneId, activeSessionId, draftChatActive, drawerLaneId, drawerVisibleLaneSessions, selectedDrawerChatAction, selectedDrawerChatId]);

  useEffect(() => {
    setSlashIndex(0);
  }, [prompt]);

  const addNotice = useCallback((text: string, tone: LocalNotice["tone"] = "info") => {
    setNotices((prev) => [
      ...prev.slice(-10),
      { id: noticeId(), timestamp: new Date().toISOString(), text, tone },
    ]);
  }, []);

  useEffect(() => {
    if (!connection || !attachedTerminalId) return;
    const handleRawInput = (chunk: Buffer | string) => {
      const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (!raw) return;
      const terminalControlInput = splitTerminalControlInput(raw);
      if (terminalControlInput.detach) {
        setAttachedTerminalId(null);
        if (terminalControlInput.forwarded) {
          void writeTerminal(connection, attachedTerminalId, terminalControlInput.forwarded).catch((err) => {
            addNotice(err instanceof Error ? err.message : String(err), "error");
          });
        }
        return;
      }
      void writeTerminal(connection, attachedTerminalId, raw).catch((err) => {
        addNotice(err instanceof Error ? err.message : String(err), "error");
      });
    };
    process.stdin.on("data", handleRawInput);
    return () => {
      process.stdin.off("data", handleRawInput);
    };
  }, [addNotice, attachedTerminalId, connection]);

  const reloadKeybindings = useCallback((announce = false) => {
    const diagnostics = readClaudeKeybindingsFile({ create: false });
    setKeybindings(diagnostics.bindings);
    if (announce) {
      addNotice(
        diagnostics.warnings.length
          ? `Keybindings reloaded with ${diagnostics.warnings.length} warning${diagnostics.warnings.length === 1 ? "" : "s"}.`
          : "Keybindings reloaded.",
        diagnostics.warnings.length ? "error" : "success",
      );
    }
  }, [addNotice]);

  useEffect(() => {
    const filePath = defaultKeybindingsPath();
    const dir = path.dirname(filePath);
    let timer: NodeJS.Timeout | null = null;
    let watcher: fs.FSWatcher | null = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, (_event, filename) => {
        if (filename && filename.toString() !== path.basename(filePath)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          reloadKeybindings(true);
        }, 150);
      });
    } catch {
      return undefined;
    }
    return () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    };
  }, [reloadKeybindings]);

  const refreshAiSetupStatus = useCallback(async (options: { force?: boolean } = {}) => {
    const conn = connectionRef.current;
    if (!conn) return;
    const [status, storedProviders, diagnostics] = await Promise.all([
      getAiSettingsStatus(conn, {
        force: options.force === true,
        refreshOpenCodeInventory: true,
      }),
      getStoredApiKeyProviders(conn).catch(() => []),
      getOpenCodeRuntimeDiagnostics(conn).catch(() => null),
    ]);
    setAiStatus(status);
    setStoredApiKeyProviders(storedProviders.map((provider) => provider.trim().toLowerCase()).filter(Boolean));
    setOpenCodeDiagnostics(diagnostics);
    setAiStatusCheckedAt(new Date().toISOString());
  }, []);

	  const loadProviderModels = useCallback(async (provider: AdeCodeProvider, options: { applyDefault?: boolean; force?: boolean } = {}) => {
    const conn = connectionRef.current;
    const cached = providerModelsCacheRef.current.get(provider);
    let nextModels = cached ?? registryModelsForProvider(provider);
    if (options.force === true || !cached) {
      try {
        nextModels = conn ? await getAvailableModels(conn, provider) : registryModelsForProvider(provider);
        providerModelsCacheRef.current.set(provider, nextModels);
      } catch {
        nextModels = cached ?? registryModelsForProvider(provider);
      }
    }
    setModels(nextModels);
    if (options.applyDefault !== false) {
      const model = nextModels.find((entry) => entry.isDefault) ?? nextModels[0] ?? null;
      setModelState((prev) => ({
        ...prev,
        ...(model ? modelStatePatchForModel(provider, model) : fallbackModelStatePatch(provider)),
      }));
    }
	    return nextModels;
	  }, []);

	  const refreshModelCatalog = useCallback(async (options: { refreshProvider?: AgentChatModelCatalogRefreshProvider } = {}) => {
	    const conn = connectionRef.current;
	    if (!conn) return modelCatalogRef.current;
	    if (!options.refreshProvider && modelCatalogRef.current) {
	      setModelCatalog(modelCatalogRef.current);
	      return modelCatalogRef.current;
	    }
	    if (options.refreshProvider && modelCatalogRef.current) {
	      const refreshedAt = modelCatalogProviderRefreshedAtRef.current.get(options.refreshProvider);
	      if (refreshedAt && Date.now() - refreshedAt <= modelCatalogClientRefreshTtlMs(options.refreshProvider)) {
	        setModelCatalog(modelCatalogRef.current);
	        return modelCatalogRef.current;
	      }
	    }
	    try {
	      const catalog = await getModelCatalog(conn, {
	        mode: options.refreshProvider ? "refresh-stale" : "cached",
	        ...(options.refreshProvider ? { refreshProvider: options.refreshProvider } : {}),
	      });
	      modelCatalogRef.current = catalog;
	      setModelCatalog(catalog);
	      if (options.refreshProvider && catalog.stale !== true) {
	        modelCatalogProviderRefreshedAtRef.current.set(options.refreshProvider, Date.now());
	      }
	      if (options.refreshProvider && catalog.stale === true) {
	        void getModelCatalog(conn, {
	          mode: "force",
	          refreshProvider: options.refreshProvider,
	        }).then((freshCatalog) => {
	          if (connectionRef.current !== conn) return;
	          modelCatalogRef.current = freshCatalog;
	          modelCatalogProviderRefreshedAtRef.current.set(options.refreshProvider!, Date.now());
	          setModelCatalog(freshCatalog);
	        }).catch(() => undefined);
	      }
	      return catalog;
	    } catch {
	      return modelCatalogRef.current;
	    }
	  }, []);

  const openForm = useCallback((content: Extract<RightPaneContent, { kind: "form" }>) => {
    const previousPane = activePaneRef.current;
    stashActiveInput();
    if (previousPane !== "details") {
      paneBeforeDetailsRef.current = previousPane;
    }
    const nextValues = Object.fromEntries(content.fields.map((field) => [field.name, field.initialValue ?? ""]));
    setFormValues(nextValues);
    setFormFieldIndex(0);
    setFormDiscardArmed(false);
    setPrompt(content.fields[0]?.initialValue ?? "");
    setRightPane(content);
    setRightOpen(true);
    // Forms are explicit user actions; mark sticky so the context default
    // resolver doesn't overwrite them.
    lastUserOpenedPaneRef.current = "form";
    setPaneFocus("details");
  }, [setPaneFocus, stashActiveInput]);

  const openNewLaneForm = useCallback(() => {
    openForm({
      kind: "form",
      title: "New lane",
      command: "new-lane",
      fields: [
        { name: "name", label: "Name", required: true, placeholder: "feature-name" },
        { name: "baseBranch", label: "Base branch", placeholder: "default" },
      ],
    });
  }, [openForm]);

  const openFeedbackForm = useCallback(() => {
    openForm({
      kind: "form",
      title: "Feedback",
      command: "feedback",
      fields: feedbackFormFields(buildFeedbackEnvironment(project, activeLane ?? null)),
    });
  }, [activeLane, openForm, project]);

  const openNewChatSetup = useCallback((title?: string | null) => {
    const laneId = activeLaneIdRef.current;
    const lane = lanes.find((entry) => entry.id === laneId) ?? activeLane;
    if (!laneId || !lane) {
      setRightPane({ kind: "details", title: "New chat", body: "No active lane is available." });
      focusDetails();
      return;
    }
    const unavailableMessage = laneWorktreeUnavailableMessage(lane);
    if (unavailableMessage) {
      setDraftChatMode(false);
      selectActiveSessionId(null);
      setSelectedDrawerChatId(null);
      setSelectedDrawerChatAction(null);
      setRightPane(seedLaneDetails(lane, false));
      setRightOpen(true);
      addNotice(unavailableMessage, "error");
      return;
    }
    const trimmedTitle = title?.trim() || null;
    pendingNewChatTitleRef.current = trimmedTitle;
    newChatPreviewLaneIdRef.current = laneId;
    draftSeededFromHistoryRef.current = true;
    const previousPane = activePaneRef.current;
    stashActiveInput();
    if (previousPane !== "details") {
      paneBeforeDetailsRef.current = previousPane;
    }
    setDraftChatMode(true);
    selectActiveSessionId(null);
    setAttachedTerminalId(null);
    // New-chat-setup is part of the context default; let the resolver drive it.
    lastUserOpenedPaneRef.current = null;
    eventDedupKeysRef.current.clear();
    eventDedupKeyOrderRef.current = [];
    eventCountRef.current = 0;
    setEvents([]);
    setClearedAt(null);
    chatDraftRef.current = "";
    setPrompt("");
    setRightSelectionIndex(defaultSetupSelectionIndex(newChatSetupRows));
    setFormDiscardArmed(false);
    setRightPane({
      kind: "new-chat-setup",
      laneId,
      laneLabel: lane.name,
      rows: newChatSetupRows,
    });
    setRightOpen(true);
    setPaneFocus("details");
    void refreshAiSetupStatus().catch(() => undefined);
    void loadProviderModels(modelState.provider, { applyDefault: false }).catch(() => undefined);
  }, [activeLane, addNotice, focusDetails, lanes, loadProviderModels, modelState.provider, newChatSetupRows, refreshAiSetupStatus, selectActiveSessionId, setDraftChatMode, setPaneFocus, stashActiveInput]);

  // /model opens the right-pane model picker. Provider stays editable on a fresh
  // chat; once the thread has user messages the provider row is locked to the
  // active chat family.
  const openModelRow = useCallback((options: { forceRefresh?: boolean } = {}) => {
    const rows = providerLockedRef.current ? modelPickerRows : modelSetupRows;
    userDismissedRightPaneRef.current = false;
    lastUserOpenedPaneRef.current = "details";
    setRightSelectionIndex(defaultModelPickerSelectionIndex(rows));
    setRightPane({ kind: "model-setup", rows });
    setRightOpen(true);
    focusDetails();
    void refreshAiSetupStatus({ force: options.forceRefresh === true }).catch((err) => {
      addNotice(err instanceof Error ? err.message : String(err), "error");
    });
    void loadProviderModels(
      (activeSessionRef.current?.provider ?? modelState.provider) as AdeCodeProvider,
      { applyDefault: false },
    ).catch(() => undefined);
  }, [addNotice, focusDetails, loadProviderModels, modelPickerRows, modelSetupRows, modelState.provider, refreshAiSetupStatus]);

  // Hydrate favorites/recents from the ade-cli RPC once the connection is up.
  useEffect(() => {
    const conn = connectionRef.current;
    if (!conn) return;
    let cancelled = false;
    void (async () => {
      try {
        const [favorites, recents] = await Promise.all([
          getModelPickerFavorites(conn).catch(() => [] as string[]),
          getModelPickerRecents(conn).catch(() => [] as string[]),
        ]);
        if (cancelled) return;
        setModelPickerFavorites(favorites);
        setModelPickerRecents(recents);
      } catch {
        // Best-effort hydration — picker still functions with empty state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [socketPath]);

  // Right-pane model picker — replaces the inline-row focus path when launched
  // via /model or new-chat. Reuses the same data the inline row uses (models)
  // plus favorites/recents sourced from ade-cli for cross-surface sync.
	  const openModelPicker = useCallback(
	    (options: { surface?: "chat" | "new-chat" } = {}) => {
	      void refreshModelCatalog();
	      const surface = options.surface ?? "chat";
      // Build a starter selection from current activeModelId/recents so the
      // picker opens with relevant content already filtered.
      const provider = modelState.provider;
	      const layoutSeed = buildModelPickerLayout({
	        models,
	        catalog: modelCatalogRef.current ?? modelCatalog,
	        favorites: modelPickerFavorites,
        recents: modelPickerRecents,
        activeModelId: modelState.modelId,
	        query: "",
	        selection: { kind: "provider", provider },
	        providerTabKey: null,
	        focusedIndex: 0,
        searchMode: false,
      });
      const selection = defaultSelectionFor(
        modelState.modelId,
        modelPickerRecents,
        layoutSeed.railEntries,
      );
      setRightPane({
        kind: "model-picker",
        surface,
        query: "",
	        searchMode: false,
	        selection,
	        providerTabKey: null,
	        focusedIndex: 0,
      });
      setRightOpen(true);
      setPaneFocus("details");
      lastUserOpenedPaneRef.current = "model-picker";
	      void refreshAiSetupStatus().catch(() => undefined);
	      void loadProviderModels(provider, { applyDefault: false }).catch(() => undefined);
	      if (provider === "opencode" || provider === "cursor" || provider === "droid" || provider === "lmstudio" || provider === "ollama") {
	        void refreshModelCatalog({ refreshProvider: provider });
	      }
	    },
    [
      loadProviderModels,
      modelPickerFavorites,
      modelPickerRecents,
      modelState.modelId,
	      modelState.provider,
	      models,
	      modelCatalog,
	      refreshAiSetupStatus,
	      refreshModelCatalog,
	      setPaneFocus,
    ],
  );

  const toggleModelPickerFavoriteId = useCallback(
    (modelId: string) => {
      if (!modelId) return;
      // Optimistic toggle so the UI updates instantly.
      setModelPickerFavorites((prev) =>
        prev.includes(modelId) ? prev.filter((entry) => entry !== modelId) : [...prev, modelId],
      );
      const conn = connectionRef.current;
      if (!conn) return;
      void toggleModelPickerFavorite(conn, modelId)
        .then((result) => {
          if (Array.isArray(result.favorites)) setModelPickerFavorites(result.favorites);
        })
        .catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    const range = activeMentionRange;
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    if (!range) {
      setMentionSuggestions([]);
      setMentionIndex(0);
      return;
    }
    let cancelled = false;
    const query = range.query.toLowerCase();
    const localSuggestions: MentionSuggestion[] = [
      ...lanes.map((lane) => ({
        kind: "lane" as const,
        label: lane.name,
        insertText: `@lane:${lane.id}`,
        detail: lane.branchRef ?? lane.id,
      })),
      ...displaySessions.slice(0, 30).map((session) => ({
        kind: "chat" as const,
        label: session.title ?? session.sessionId,
        insertText: `@chat:${session.sessionId}`,
        detail: session.laneId,
      })),
    ].filter((suggestion) => (
      !query
      || suggestion.label.toLowerCase().includes(query)
      || suggestion.insertText.toLowerCase().includes(query)
      || suggestion.detail?.toLowerCase().includes(query)
    ));
    const attachedSuggestions = selectedMentions
      .filter((suggestion) => suggestion.attachment && suggestion.filePath)
      .filter((suggestion) => (
        !query
        || suggestion.label.toLowerCase().includes(query)
        || suggestion.insertText.toLowerCase().includes(query)
        || suggestion.detail?.toLowerCase().includes(query)
      ));

    const loadRemoteSuggestions = async () => {
      const remote: MentionSuggestion[] = [];
      if (conn && laneId) {
        const [files, commits, prs] = await Promise.all([
          query
            ? conn.action<Array<{ path: string }>>("file", "quickOpen", {
                workspaceId: laneId,
                query,
                limit: 5,
              }).catch(() => [])
            : Promise.resolve([]),
          conn.action<Array<Record<string, unknown>>>("git", "listRecentCommits", {
            laneId,
            limit: 8,
          }).catch(() => []),
          conn.action<Array<Record<string, unknown>>>("pr", "listAll", { laneId }).catch(() => []),
        ]);
        remote.push(...files.map((file) => ({
          kind: "file" as const,
          label: file.path,
          insertText: `@file:${file.path}`,
          detail: "file",
          filePath: file.path,
        })));
        remote.push(...commits
          .filter((commit) => {
            const subject = String(commit.subject ?? commit.message ?? "");
            const sha = String(commit.shortSha ?? commit.sha ?? "");
            return !query || subject.toLowerCase().includes(query) || sha.toLowerCase().includes(query);
          })
          .slice(0, 5)
          .map((commit) => {
            const sha = String(commit.shortSha ?? commit.sha ?? "commit");
            return {
              kind: "commit" as const,
              label: String(commit.subject ?? commit.message ?? sha),
              insertText: `@commit:${sha}`,
              detail: sha,
            };
          }));
        remote.push(...prs
          .filter((pr) => {
            const title = String(pr.title ?? "");
            const number = String(pr.number ?? pr.prNumber ?? "");
            return !query || title.toLowerCase().includes(query) || number.includes(query);
          })
          .slice(0, 5)
          .map((pr) => {
            const id = String(pr.id ?? pr.prId ?? pr.number ?? "pr");
            return {
              kind: "pr" as const,
              label: String(pr.title ?? `PR ${id}`),
              insertText: `@pr:${id}`,
              detail: pr.number != null ? `#${String(pr.number)}` : id,
            };
          }));
      }
      if (cancelled) return;
      const next = [...localSuggestions, ...remote, ...attachedSuggestions].slice(0, 10);
      setMentionSuggestions(next);
      setMentionIndex((index) => Math.min(index, Math.max(0, next.length - 1)));
    };
    void loadRemoteSuggestions();
    return () => {
      cancelled = true;
    };
  }, [activeMentionRange, displaySessions, lanes, selectedMentions]);

  const refreshState = useCallback(async (options: RefreshStateOptions = {}) => {
    const conn = connectionRef.current;
    if (!conn) return;
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    const isCurrentRefresh = () =>
      refreshGenerationRef.current === generation && connectionRef.current === conn;
    const nextLanes = await listLanes(conn);
    const nextSessions = await listChatSessions(conn);
    const nextTerminalSessions = await listTerminalSessions(conn).catch(() => []);
    const nextDisplaySessions = [...nextSessions, ...nextTerminalSessions.map(terminalSessionToChatSummary)];
    const draftMode = draftChatActiveRef.current;
    const target = resolveTuiChatRefreshTarget({
      lanes: nextLanes,
      sessions: nextDisplaySessions,
      context: project,
      lastLaneId: lastLaneIdRef.current,
      activeLaneId: activeLaneIdRef.current,
      activeSessionId: activeSessionIdRef.current,
      draftChatActive: draftMode,
      initialNewChatPreview: initialNewChatPreviewRef.current,
      newChatPreviewLaneId: newChatPreviewLaneIdRef.current,
      selectedDrawerChatAction,
      drawerLaneId,
      drawerBrowsingChatId: drawerOpenRef.current && drawerSectionRef.current === "chats"
        ? selectedDrawerChatIdRef.current
        : null,
      drawerBrowsingNewChat: drawerOpenRef.current
        && drawerSectionRef.current === "chats"
        && selectedDrawerChatActionRef.current === "new-chat",
    });
    const nextLane = target.lane;
    const nextLaneId = target.laneId;
    const nextSession = target.session;
    const nextSessionId = nextSession?.sessionId ?? null;
    const nextTerminalSession = nextSessionId
      ? nextTerminalSessions.find((session) => session.terminalId === nextSessionId) ?? null
      : null;
    const seedSession = target.seedSession;
    const launchToNewChatPreview = target.launchToNewChatPreview;
    const previewMode = target.previewMode;
    if (previewMode) {
      newChatPreviewLaneIdRef.current = nextLaneId;
    }
    let nextEvents: AgentChatEventEnvelope[] | null = null;
    let selectedSessionFound = true;
    if (nextSessionId && !nextTerminalSession) {
      const shouldHydrateHistory = shouldHydrateRefreshHistory({
        hydrateHistory: options.hydrateHistory,
        currentSessionId: activeSessionIdRef.current,
        loadedSessionId: loadedSessionIdRef.current,
        nextSessionId,
      });
      if (shouldHydrateHistory) {
        const history = await getChatHistory(conn, nextSessionId);
        if (!isCurrentRefresh()) return;
        if (history.sessionFound === false) {
          selectedSessionFound = false;
          setCurrentGoal(null);
          setContextPercent(null);
          setTokenSummary(null);
          setStatusLineStats(null);
          // The replacement view should not carry stale interrupted state from
          // a previously-selected chat that we've now lost track of.
          setInterrupted(false);
          eventCountRef.current = 0;
          loadedSessionIdRef.current = null;
          nextEvents = [];
        } else {
          setCurrentGoal(latestGoal(history.events));
          nextEvents = clearedAt
            ? history.events.filter((event) => event.timestamp > clearedAt)
            : history.events;
          const activeModelId = nextSession?.modelId ?? null;
          const fallbackContext = activeModelId ? getModelById(activeModelId)?.contextWindow ?? null : null;
          const stats = latestTokenStats(history.events, fallbackContext);
          setContextPercent(stats.percent);
          setTokenSummary(formatTokenSummary(stats));
          setStatusLineStats(stats);
          eventCountRef.current = history.events.length;
          loadedSessionIdRef.current = nextSessionId;
        }
      }
      setStreaming(selectedSessionFound && nextSession?.status === "active");
      if (selectedSessionFound && nextSession?.status === "active") setInterrupted(false);
    } else {
      setContextPercent(null);
      setTokenSummary(null);
      setStatusLineStats(null);
      setCurrentGoal(null);
      setStreaming(false);
      setInterrupted(false);
      eventCountRef.current = 0;
      loadedSessionIdRef.current = null;
      nextEvents = [];
    }
    const configSession = nextTerminalSession ? null : nextSession ?? (!draftSeededFromHistoryRef.current ? seedSession : null);
    const nextProvider = terminalSessionProvider(nextTerminalSession) ?? configSession?.provider ?? modelState.provider ?? "codex";
    const commandSessionId = nextTerminalSession ? null : nextSessionId ?? configSession?.sessionId ?? null;
    const commandArgs = commandSessionId
      ? { sessionId: commandSessionId }
      : nextLaneId
        ? { laneId: nextLaneId, provider: nextProvider }
        : null;
    const remoteCommands = commandArgs ? await getSlashCommands(conn, commandArgs).catch(() => []) : [];
    if (!isCurrentRefresh()) return;
    const projectCommands = discoverProjectSlashCommands(nextLane?.worktreePath || project.workspaceRoot);
    const nextCommands = remoteCommands.length ? remoteCommands : projectCommands;
    const provider = normalizeProvider(nextProvider);
    const cachedModels = providerModelsCacheRef.current.get(provider);
    const nextModels = cachedModels ?? registryModelsForProvider(provider);
    if (!cachedModels) {
      void loadProviderModels(provider, { applyDefault: false }).catch(() => undefined);
    }
    const activeModel = nextModels.find((model) => model.modelId === configSession?.modelId || model.id === configSession?.modelId)
      ?? nextModels.find((model) => model.isDefault)
      ?? null;
    setLanes(nextLanes);
    setSessions(nextSessions);
    terminalSessionsRef.current = nextTerminalSessions;
    setTerminalSessions(nextTerminalSessions);
    const attachedId = attachedTerminalIdRef.current;
    if (attachedId && !nextTerminalSessions.some((session) => session.terminalId === attachedId)) {
      setAttachedTerminalId(null);
    }
    selectActiveLaneId(nextLaneId);
    selectActiveSessionId(nextSessionId);
    if (nextEvents !== null) {
      eventDedupKeyOrderRef.current = syncTuiEventDedupKeys(eventDedupKeysRef.current, nextEvents);
      setEvents(nextEvents);
    }
    setSlashCommands(nextCommands);
    setModels(nextModels);
    if (launchToNewChatPreview) {
      initialNewChatPreviewRef.current = false;
      newChatPreviewLaneIdRef.current = nextLaneId;
      setDraftChatMode(false);
      setDrawerSection("chats");
      setDrawerLaneId(nextLaneId);
      setSelectedDrawerLaneId(nextLaneId);
      setSelectedDrawerLaneAction(null);
      setSelectedDrawerChatId(null);
      setSelectedDrawerChatAction(nextLaneId ? "new-chat" : null);
      setRightOpen(true);
    }
    if (nextTerminalSession && nextSessionId) {
      void previewTerminal(conn, nextSessionId)
        .then((preview) => {
          if (activeSessionIdRef.current === nextSessionId) setTerminalPreview(preview);
        })
        .catch(() => {
          if (activeSessionIdRef.current === nextSessionId) setTerminalPreview(null);
        });
    } else {
      setTerminalPreview(null);
    }
    if (nextTerminalSession) {
      const current = modelStateRef.current;
      if (current.provider !== "claude") {
        setModelState((prev) => {
          const next = {
            ...prev,
            ...fallbackModelStatePatch("claude"),
            permissionMode: nextTerminalSession.resumeMetadata?.launch?.permissionMode ?? prev.permissionMode,
            claudePermissionMode: nextTerminalSession.resumeMetadata?.launch?.claudePermissionMode ?? prev.claudePermissionMode,
          };
          modelStateRef.current = next;
          return next;
        });
      }
    } else if (configSession && (!draftMode || !draftSeededFromHistoryRef.current)) {
      setModelState((prev) => ({
        ...prev,
        provider,
        model: configSession.model ?? activeModel?.id ?? prev.model,
        modelId: configSession.modelId ?? activeModel?.modelId ?? activeModel?.id ?? prev.modelId,
        displayName: activeModel?.displayName ?? configSession.model ?? prev.displayName,
        reasoningEffort: configSession.reasoningEffort ?? prev.reasoningEffort,
        codexFastMode: configSession.codexFastMode === true,
        permissionMode: configSession.permissionMode ?? prev.permissionMode,
        interactionMode: configSession.interactionMode ?? prev.interactionMode,
        claudePermissionMode: configSession.claudePermissionMode ?? prev.claudePermissionMode,
        codexApprovalPolicy: configSession.codexApprovalPolicy ?? prev.codexApprovalPolicy,
        codexSandbox: configSession.codexSandbox ?? prev.codexSandbox,
        codexConfigSource: configSession.codexConfigSource ?? prev.codexConfigSource,
        opencodePermissionMode: configSession.opencodePermissionMode ?? prev.opencodePermissionMode,
        droidPermissionMode: configSession.droidPermissionMode ?? prev.droidPermissionMode,
        cursorModeId: configSession.cursorModeId ?? configSession.cursorModeSnapshot?.currentModeId ?? prev.cursorModeId,
        cursorConfigValues: configSession.cursorConfigValues ?? prev.cursorConfigValues,
      }));
      if (draftMode) draftSeededFromHistoryRef.current = true;
    }
  }, [clearedAt, drawerLaneId, loadProviderModels, modelState.provider, project, selectActiveLaneId, selectActiveSessionId, selectedDrawerChatAction, setDraftChatMode]);

  const commitModelStateToSession = useCallback(async (nextState: AdeCodeModelState) => {
    const conn = connectionRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!conn || !sessionId || draftChatActiveRef.current) return;
    if (activeTerminalSessionRef.current) return;
    const normalized = { ...nextState, ...applyProviderPermissionMode(nextState) };
    await updateChatModel({
      connection: conn,
      sessionId,
      modelId: normalized.modelId,
      reasoningEffort: normalized.reasoningEffort,
      codexFastMode: normalized.provider === "codex" ? normalized.codexFastMode : undefined,
      permissionMode: normalized.permissionMode,
      interactionMode: normalized.provider === "claude" ? normalized.interactionMode : undefined,
      claudePermissionMode: normalized.provider === "claude" ? normalized.claudePermissionMode : undefined,
      codexApprovalPolicy: normalized.provider === "codex" ? normalized.codexApprovalPolicy : undefined,
      codexSandbox: normalized.provider === "codex" ? normalized.codexSandbox : undefined,
      codexConfigSource: normalized.provider === "codex" ? normalized.codexConfigSource : undefined,
      opencodePermissionMode: normalized.provider === "opencode" ? normalized.opencodePermissionMode : undefined,
      droidPermissionMode: normalized.provider === "droid" ? normalized.droidPermissionMode : undefined,
      cursorModeId: normalized.provider === "cursor" ? normalized.cursorModeId : undefined,
      cursorConfigValues: normalized.provider === "cursor" ? normalized.cursorConfigValues : undefined,
    });
    await refreshState();
  }, [refreshState]);

  const scheduleModelStateCommit = useCallback((nextState: AdeCodeModelState) => {
    pendingModelCommitStateRef.current = nextState;
    if (pendingModelCommitTimerRef.current) {
      clearTimeout(pendingModelCommitTimerRef.current);
    }
    pendingModelCommitTimerRef.current = setTimeout(() => {
      pendingModelCommitTimerRef.current = null;
      const pending = pendingModelCommitStateRef.current;
      pendingModelCommitStateRef.current = null;
      if (!pending) return;
      void commitModelStateToSession(pending).catch((err) => {
        addNotice(err instanceof Error ? err.message : String(err), "error");
      });
    }, 200);
  }, [addNotice, commitModelStateToSession]);

  const resolveActiveTerminalForExit = useCallback((): ChatTerminalSession | null => {
    const activeId = activeSessionIdRef.current;
    const current = activeTerminalSessionRef.current;
    if (current && (current.status === "running" || current.terminalId === activeId)) {
      return current;
    }
    const fromList = activeId
      ? terminalSessionsRef.current.find((session) => session.terminalId === activeId) ?? null
      : null;
    if (fromList && (fromList.status === "running" || fromList.terminalId === activeId)) {
      return fromList;
    }
    const activeLane = activeLaneIdRef.current;
    return terminalSessionsRef.current.find((session) => (
      session.status === "running"
      && terminalSessionProvider(session) === "claude"
      && (!activeLane || session.laneId === activeLane)
    )) ?? null;
  }, []);

  const signalActiveTerminalForExitSync = useCallback(() => {
    const terminal = resolveActiveTerminalForExit();
    if (!terminal) return;
    const conn = connectionRef.current;
    const socket = conn?.socketPath ?? socketPath ?? null;
    signalTerminalWithCliSync({
      projectRoot: project.projectRoot,
      socketPath: socket,
      terminalId: terminal.terminalId,
      signal: "SIGTERM",
    });
    signalTerminalWithCliSync({
      projectRoot: project.projectRoot,
      socketPath: socket,
      terminalId: terminal.terminalId,
      signal: "SIGKILL",
    });
  }, [project.projectRoot, resolveActiveTerminalForExit, socketPath]);

  const signalActiveTerminalForExit = useCallback(async () => {
    const conn = connectionRef.current;
    const terminal = resolveActiveTerminalForExit();
    if (!conn || !terminal) return;
    await signalTerminal(conn, terminal.terminalId, "SIGTERM").catch(() => undefined);
    await delay(350);
    await signalTerminal(conn, terminal.terminalId, "SIGKILL").catch(() => undefined);
  }, [resolveActiveTerminalForExit]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const conn = await connectToAde({ project, forceEmbedded, requireSocket, socketPath });
        if (cancelled) {
          await conn.close();
          return;
        }
        heartbeatRef.current = startTuiHeartbeat(project.projectRoot, {
          beforeSignalExit: () => {
            signalActiveTerminalForExitSync();
            return signalActiveTerminalForExit();
          },
        });
        connectionRef.current = conn;
        setConnection(conn);
        setMode(conn.mode);
        draftSeededFromHistoryRef.current = false;
        newChatPreviewLaneIdRef.current = null;
        setDraftChatMode(false);
        selectActiveSessionId(null);
        eventDedupKeysRef.current.clear();
        eventDedupKeyOrderRef.current = [];
        eventCountRef.current = 0;
        setEvents([]);
        await refreshState();
      } catch (err) {
        heartbeatRef.current?.stop();
        heartbeatRef.current = null;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      heartbeatRef.current?.stop();
      heartbeatRef.current = null;
      if (lastChatByLaneWriteTimerRef.current) {
        clearTimeout(lastChatByLaneWriteTimerRef.current);
        lastChatByLaneWriteTimerRef.current = null;
        const lastChatByLane: Record<string, string> = {};
        for (const [laneId, sessionId] of lastChatByLaneRef.current) {
          lastChatByLane[laneId] = sessionId;
        }
        saveAdeCodeProjectState(project.projectRoot, { lastChatByLane, lastLaneId: lastLaneIdRef.current });
      }
      if (pendingModelCommitTimerRef.current) {
        clearTimeout(pendingModelCommitTimerRef.current);
        pendingModelCommitTimerRef.current = null;
      }
      pendingModelCommitStateRef.current = null;
      const conn = connectionRef.current;
      connectionRef.current = null;
      void conn?.close().catch(() => {});
    };
  }, [forceEmbedded, project, requireSocket, signalActiveTerminalForExit, signalActiveTerminalForExitSync, socketPath]);

  useEffect(() => {
    if (!connection) return;
    return connection.onChatEvent((envelope) => {
      if (envelope.sessionId !== activeSessionIdRef.current) {
        void refreshState({ hydrateHistory: false }).catch(() => undefined);
        return;
      }
      if (clearedAt && envelope.timestamp <= clearedAt) return;
      const event = envelope.event as Record<string, unknown>;
      const reservedKey = reserveTuiEventDedupKey(envelope, eventDedupKeysRef.current);
      if (reservedKey !== null) {
        setEvents((prev) => {
          const next = appendReservedTuiEvent(
            prev,
            envelope,
            eventDedupKeysRef.current,
            eventDedupKeyOrderRef.current,
            reservedKey,
          );
          eventDedupKeyOrderRef.current = next.eventKeys;
          eventCountRef.current = next.events.length;
          return next.events;
        });
      }
      if (event.type === "status" && event.turnStatus === "started") {
        setStreaming(true);
        setInterrupted(false);
        if (activePaneRef.current !== "drawer") {
          setRightPane((prev) => {
            if (prev.kind === "chat-info") return { kind: "chat-info", info: chatInfoRef.current };
            if (prev.kind !== "empty" && prev.kind !== "lane-details") return prev;
            setRightOpen(true);
            return { kind: "chat-info", info: chatInfoRef.current };
          });
        }
      }
      if (event.type === "status" && event.turnStatus === "interrupted") {
        setStreaming(false);
        setInterrupted(true);
      }
      if (event.type === "done") {
        setStreaming(false);
        setInterrupted(event.status === "interrupted");
      }
      if (event.type === "status" && (event.turnStatus === "completed" || event.turnStatus === "failed")) {
        setStreaming(false);
        setInterrupted(false);
      }
      if (event.type === "subagent_started" || event.type === "subagent.started") {
        // Auto-open chat info only when the user is in the chat surface.
        // Drawer navigation keeps lane details in the right pane.
        if (activePaneRef.current === "drawer") return;
        setRightPane((prev) => {
          if (prev.kind === "chat-info") return { kind: "chat-info", info: chatInfoRef.current };
          if (prev.kind !== "empty" && prev.kind !== "lane-details") return prev;
          setRightOpen(true);
          return {
            kind: "chat-info",
            info: chatInfoRef.current,
          };
        });
      }
    });
  }, [clearedAt, connection, refreshState, setPaneFocus]);

  useEffect(() => {
    if (!connection) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void connection.subscribeRuntimeEvents({ category: "runtime", cursor: 0, limit: 50, replay: false }, (event) => {
      const payload = event.payload as { type?: unknown; event?: unknown };
      const terminalEvent = payload.event as { sessionId?: unknown; data?: unknown } | undefined;
      const sessionId = typeof terminalEvent?.sessionId === "string" ? terminalEvent.sessionId : null;
      if (!sessionId) return;
      if (payload.type === "pty_data" && typeof terminalEvent?.data === "string") {
        setTerminalLiveChunks((prev) => {
          const nextChunks = [...(prev[sessionId] ?? []), terminalEvent.data as string].slice(-500);
          return { ...prev, [sessionId]: nextChunks };
        });
        return;
      }
      if (payload.type === "pty_exit") {
        void refreshState({ hydrateHistory: false }).catch(() => undefined);
      }
    }).then((stop) => {
      if (disposed) {
        stop();
        return;
      }
      unsubscribe = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [connection, refreshState]);

  useEffect(() => {
    if (!connection || !activeSessionId) {
      loadedSessionIdRef.current = activeSessionId;
      return;
    }
    if (loadedSessionIdRef.current === activeSessionId) return;
    void refreshState({ hydrateHistory: true }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [activeSessionId, connection, refreshState]);

  const chatRefreshPollActive = streaming
    || sessions.some((session) => session.status === "active")
    || terminalSessions.some((session) => session.status === "running");

  useEffect(() => {
    if (!connection) return;
    const intervalMs = chatRefreshPollActive ? 1_000 : 15_000;
    const timer = setInterval(() => {
      void refreshState({ hydrateHistory: false }).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [chatRefreshPollActive, connection, refreshState]);

  useEffect(() => {
    if (!connection) {
      setDiffByLaneId({});
      return;
    }
    const laneIds = diffLaneIdsKey.split("\n").filter(Boolean);
    if (laneIds.length === 0) {
      setDiffByLaneId({});
      return;
    }

    let cancelled = false;
    const refreshDiffStats = async () => {
      try {
        const next = await listLaneDiffStats(connection, laneIds);
        if (!cancelled) setDiffByLaneId(next);
      } catch {
        // Diff stats can be expensive and transiently fail while lanes are moving.
        // Keep the previous cache rather than flickering the drawer.
      }
    };
    void refreshDiffStats();
    const timer = setInterval(() => {
      void refreshDiffStats();
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection, diffLaneIdsKey]);

  useEffect(() => {
    if (!connection) {
      setPrByLaneId({});
      return;
    }
    let cancelled = false;
    const refreshPrsByLane = async () => {
      try {
        const prs = await listPrsByLane(connection);
        if (cancelled) return;
        const next: Record<string, DrawerPrSummary> = {};
        for (const pr of prs) {
          next[pr.laneId] = {
            number: pr.number,
            state: pr.state,
            checksPassed: pr.checksPassed,
            checksTotal: pr.checksTotal,
          };
        }
        setPrByLaneId(next);
      } catch {
        // PR checks are rate-limit sensitive; keep the previous cache on transient failures.
      }
    };
    void refreshPrsByLane();
    const timer = setInterval(() => {
      void refreshPrsByLane();
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection]);

  useEffect(() => {
    if (!connection || mode === "attached" || forceEmbedded) return;
    const timer = setInterval(() => {
      if (streaming || attachProbeInFlightRef.current) return;
      attachProbeInFlightRef.current = true;
      void (async () => {
        let attached: AdeCodeConnection | null = null;
        try {
          attached = await connectToAde({
            project,
            forceEmbedded: false,
            requireSocket: true,
            socketPath,
          });
          if (attached.mode !== "attached") {
            await attached.close().catch(() => {});
            return;
          }
          const previous = connectionRef.current;
          connectionRef.current = attached;
          setConnection(attached);
          setMode(attached.mode);
          await previous?.close().catch(() => {});
          await refreshState();
        } catch {
          await attached?.close().catch(() => {});
        } finally {
          attachProbeInFlightRef.current = false;
        }
      })();
    }, 3_000);
    return () => clearInterval(timer);
  }, [connection, forceEmbedded, mode, project, refreshState, socketPath, streaming]);

  const ensureActiveSession = useCallback(async (): Promise<string | null> => {
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    if (!conn || !laneId) return null;
    const currentSessionId = activeSessionIdRef.current;
    if (currentSessionId) {
      if (sessions.some((entry) => entry.sessionId === currentSessionId)) return currentSessionId;
      selectActiveSessionId(null);
      setAttachedTerminalId(null);
    }
    const lane = lanes.find((entry) => entry.id === laneId) ?? null;
    const unavailableMessage = laneWorktreeUnavailableMessage(lane);
    if (unavailableMessage) {
      if (lane) {
        setRightPane(seedLaneDetails(lane, false));
        setRightOpen(true);
      }
      setDraftChatMode(false);
      addNotice(unavailableMessage, "error");
      return null;
    }
    const normalized = { ...modelState, ...applyProviderPermissionMode(modelState) };
    const runtimeProvider = runtimeProviderForUiProvider(normalized.provider);
    const created = await createChatSession({
      connection: conn,
      laneId,
      title: pendingNewChatTitleRef.current,
      provider: runtimeProvider,
      modelId: normalized.modelId,
      reasoningEffort: normalized.reasoningEffort,
      codexFastMode: normalized.codexFastMode,
      permissionMode: normalized.permissionMode,
      interactionMode: normalized.interactionMode,
      claudePermissionMode: normalized.claudePermissionMode,
      codexApprovalPolicy: normalized.codexApprovalPolicy,
      codexSandbox: normalized.codexSandbox,
      codexConfigSource: normalized.codexConfigSource,
      opencodePermissionMode: normalized.opencodePermissionMode,
      droidPermissionMode: normalized.droidPermissionMode,
      cursorModeId: normalized.cursorModeId,
      cursorConfigValues: normalized.cursorConfigValues,
    });
    pendingNewChatTitleRef.current = null;
    setDraftChatMode(false);
    selectActiveSessionId(created.id);
    await refreshState();
    return created.id;
  }, [addNotice, lanes, modelState, refreshState, selectActiveSessionId, sessions, setDraftChatMode]);

  const resolvePendingApproval = useCallback(async (
    approval: PendingApproval,
    decision: "accept" | "decline" | "cancel" | "accept_for_session",
    responseText?: string | null,
  ) => {
    const conn = connectionRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!conn || !sessionId) return;
    await approveToolUse({
      connection: conn,
      sessionId,
      itemId: approval.itemId,
      decision,
      responseText,
    });
    addNotice(decision === "accept" || decision === "accept_for_session" ? "Approved request." : "Declined request.", "info");
    await refreshState();
  }, [addNotice, refreshState]);

  const answerPendingInput = useCallback(async (approval: PendingApproval, text: string) => {
    const conn = connectionRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!conn || !sessionId) return;
    const trimmed = text.trim();
    const lowered = trimmed.toLowerCase();
    if (lowered === "deny" || lowered === "decline" || lowered === "cancel") {
      await respondToInput({
        connection: conn,
        sessionId,
        itemId: approval.itemId,
        decision: lowered === "cancel" ? "cancel" : "decline",
      });
      addNotice("Declined request.", "info");
      await refreshState();
      return;
    }
    await respondToInput({
      connection: conn,
      sessionId,
      itemId: approval.itemId,
      decision: "accept",
      answers: buildPendingInputAnswers(approval.request, trimmed),
      responseText: trimmed,
    });
    addNotice("Answered request.", "success");
    await refreshState();
  }, [addNotice, refreshState]);

  const refreshTerminalPreview = useCallback(async (
    conn: AdeCodeConnection,
    terminalId: string,
  ): Promise<ChatTerminalPreviewResult | null> => {
    try {
      const preview = await previewTerminal(conn, terminalId);
      if (activeSessionIdRef.current === terminalId) setTerminalPreview(preview);
      return preview;
    } catch {
      if (activeSessionIdRef.current === terminalId) setTerminalPreview(null);
      return null;
    }
  }, []);

  const applyLocalModelArg = useCallback((value: string, providerOverride?: AdeCodeProvider) => {
    const provider = providerOverride ?? modelStateRef.current.provider;
    const availableModels = providerModelsCacheRef.current.get(provider) ?? models;
    const patch = modelStatePatchForArg(provider, availableModels, value);
    const next = { ...modelStateRef.current, ...patch };
    modelStateRef.current = next;
    setModelState(next);
    return next;
  }, [models]);

  const submitClaudePromptToTerminal = useCallback(async (terminal: ChatTerminalSession, text: string) => {
    const conn = connectionRef.current;
    const trimmed = text.trim();
    if (!conn || !trimmed) return false;
    const run = async (): Promise<boolean> => {
      lastLocalSendAtRef.current = Date.now();
      const cols = clampTerminalPaneCols(terminalPaneWidth);
      const terminalRows = claudeTerminalRowsForPane(chatRowBudget);
      if (terminal.status === "running") {
        await writeTerminal(conn, terminal.terminalId, encodeTerminalPromptSubmit(text));
        await delay(250);
        let preview = await refreshTerminalPreview(conn, terminal.terminalId);
        if (terminalHiddenRowsContainPrompt(preview, text)) {
          await writeTerminal(conn, terminal.terminalId, "\r");
          await delay(150);
          preview = await refreshTerminalPreview(conn, terminal.terminalId);
        }
        return true;
      }
      const created = await sendToTerminalSession({
        connection: conn,
        sessionId: terminal.terminalId,
        text,
        cols,
        rows: terminalRows,
      });
      pendingNewChatTitleRef.current = null;
      setDraftChatMode(false);
      activeTerminalSessionRef.current = normalizeChatTerminalSession(created.session);
      selectActiveSessionId(created.sessionId);
      await refreshState();
      return true;
    };
    const queued = claudeTerminalSubmitQueueRef.current
      .catch(() => undefined)
      .then(run);
    claudeTerminalSubmitQueueRef.current = queued;
    return await queued;
  }, [addNotice, chatRowBudget, refreshState, refreshTerminalPreview, selectActiveSessionId, setDraftChatMode, terminalPaneWidth]);

  const startClaudeTerminalForPrompt = useCallback(async (text: string): Promise<string | null> => {
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    if (!conn || !laneId) return null;
    const lane = lanes.find((entry) => entry.id === laneId) ?? null;
    const unavailableMessage = laneWorktreeUnavailableMessage(lane);
    if (unavailableMessage) {
      if (lane) {
        setRightPane(seedLaneDetails(lane, false));
        setRightOpen(true);
      }
      setDraftChatMode(false);
      addNotice(unavailableMessage, "error");
      return null;
    }
    const normalized = { ...modelStateRef.current, ...applyProviderPermissionMode(modelStateRef.current) };
    const cols = clampTerminalPaneCols(terminalPaneWidth);
    const terminalRows = claudeTerminalRowsForPane(chatRowBudget);
    const activeClaudeChat = activeSessionRef.current?.provider === "claude" ? activeSessionRef.current : null;
    const title = pendingNewChatTitleRef.current
      ?? activeClaudeChat?.title
      ?? "Claude Code";
    const created = await startClaudeTerminalSession({
      connection: conn,
      laneId,
      title,
      model: normalized.modelId ?? normalized.model,
      permissionMode: normalized.permissionMode,
      initialInput: text.trim() ? text : null,
      cols,
      rows: terminalRows,
    });
    pendingNewChatTitleRef.current = null;
    setDraftChatMode(false);
    if (created.session) activeTerminalSessionRef.current = created.session;
    selectActiveSessionId(created.sessionId);
    await refreshState();
    return created.sessionId;
  }, [addNotice, chatRowBudget, lanes, refreshState, selectActiveSessionId, setDraftChatMode, terminalPaneWidth]);

  const sendClaudeModelCommandToTerminal = useCallback(async (modelRef?: string | null): Promise<boolean> => {
    const terminal = activeTerminalSessionRef.current;
    if (!terminal || modelStateRef.current.provider !== "claude") return false;
    const resolved = resolveClaudeCliModelForLaunch(modelRef ?? modelStateRef.current.modelId ?? modelStateRef.current.model);
    if (!resolved) {
      addNotice("No Claude model is selected.", "error");
      return false;
    }
    const sent = await submitClaudePromptToTerminal(terminal, `/model ${resolved}`);
    if (sent) addNotice(`Claude Code model change sent: ${resolved}.`, "success");
    return sent;
  }, [addNotice, submitClaudePromptToTerminal]);

  const requestAppExit = useCallback(() => {
    if (exitRequestedRef.current) return;
    exitRequestedRef.current = true;
    signalActiveTerminalForExitSync();
    void signalActiveTerminalForExit()
      .finally(() => exit());
  }, [exit, signalActiveTerminalForExit, signalActiveTerminalForExitSync]);

  const requestCtrlCExit = useCallback(() => {
    const now = Date.now();
    if (now <= ctrlCExitArmedUntilRef.current) {
      ctrlCExitArmedUntilRef.current = 0;
      if (ctrlCExitTimerRef.current) {
        clearTimeout(ctrlCExitTimerRef.current);
        ctrlCExitTimerRef.current = null;
      }
      requestAppExit();
      return;
    }
    ctrlCExitArmedUntilRef.current = now + CTRL_C_EXIT_ARM_MS;
    if (ctrlCExitTimerRef.current) clearTimeout(ctrlCExitTimerRef.current);
    ctrlCExitTimerRef.current = setTimeout(() => {
      ctrlCExitArmedUntilRef.current = 0;
      ctrlCExitTimerRef.current = null;
    }, CTRL_C_EXIT_ARM_MS);
    addNotice("Press Ctrl+C again to exit ADE Code.", "info");
  }, [addNotice, requestAppExit]);

  const copyChatSelection = useCallback((selection: ChatTextSelection | null | undefined = chatMouseSelectionRef.current): boolean => {
    if (!isChatTextSelectionRange(selection)) {
      addNotice("No chat text selected.", "info");
      return false;
    }
    const text = selectedTextFromChatRows(selectableChatRowTextsRef.current, selection);
    if (text.length === 0) {
      addNotice("No chat text selected.", "info");
      return false;
    }
    if (!writeClipboardText(text)) {
      addNotice("Could not find a clipboard command for this terminal.", "error");
      return true;
    }
    addNotice("Copied selected chat text.", "success");
    return true;
  }, [addNotice]);

  const sendOrSteerChatMessage = useCallback(async (
    sessionId: string,
    text: string,
    attachments: AgentChatFileRef[] = [],
  ) => {
    const conn = connectionRef.current;
    if (!conn) return;
    const steerActiveTurn = async (): Promise<void> => {
      const result = await steerChatMessage(conn, sessionId, text, attachments);
      if (result.queued) {
        addNotice("Staged message — sends after the current turn.", "info");
      }
    };
    const activeTurnVisible = (
      (streaming && sessionId === activeSessionIdRef.current)
      || sessions.some((session) => session.sessionId === sessionId && session.status === "active")
    );
    if (activeTurnVisible) {
      setStreaming(true);
      try {
        await steerActiveTurn();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/No active turn to steer/i.test(message)) throw error;
        try {
          await sendChatMessage(conn, sessionId, text, attachments);
        } catch (sendError) {
          const sendMessage = sendError instanceof Error ? sendError.message : String(sendError);
          if (!/turn is already active|already active/i.test(sendMessage)) throw sendError;
          await steerActiveTurn();
        }
      }
      await refreshState();
      return;
    }
    setStreaming(true);
    try {
      await sendChatMessage(conn, sessionId, text, attachments);
      await refreshState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/turn is already active|already active/i.test(message)) {
        await steerActiveTurn();
        await refreshState();
        return;
      }
      throw error;
    }
  }, [addNotice, refreshState, sessions, streaming]);

  const runRightCommand = useCallback(async (name: string, args: string) => {
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    const sessionId = activeSessionIdRef.current;
    focusDetails();
    // Slash-opened panes are sticky: mark before dispatching so the
    // context-default effect won't overwrite. Cleared on chat switch or
    // explicit close (Esc / pane:close). Commands like /new chat and
    // /new lane re-enter their own flows below which clear this marker.
    lastUserOpenedPaneRef.current = "details";

    if (!conn) {
      if (name === "/help") {
        setRightPane({ kind: "help", title: "Help" });
        return;
      }
      if (name === "/status") {
        setRightPane({
          kind: "status",
          rows: [
            ["project", project.projectRoot],
            ["workspace", project.workspaceRoot],
            ["lane", activeLane?.name ?? laneId ?? "none"],
            ["chat", activeSession?.title ?? activeSession?.sessionId ?? "none"],
            ["ADE", mode],
          ],
        });
        return;
      }
      if (name === "/feedback") {
        openFeedbackForm();
        return;
      }
      if (name === "/model") {
        openModelPicker();
        return;
      }
      if (name === "/info") {
        if (!subagentPaneCommandAvailable) {
          addNotice("Open a chat first to inspect chat info.", "info");
          return;
        }
        openSubagentsPane();
        return;
      }
      if (name === "/system") {
        setRightPane({
          kind: "details",
          title: "System",
          body: renderObject({ project, pid: process.pid, mode }, 24),
        });
        return;
      }
      setRightPane({
        kind: "details",
        title: name.replace(/^\//, "") || "ADE",
        body: "ADE runtime is still connecting. Try again when the connection is ready.",
      });
      return;
    }

    if (name === "/help") {
      setRightPane({ kind: "help", title: "Help" });
      return;
    }
    if (name === "/keybindings") {
      const keybindings = readClaudeKeybindingsFile({ create: true });
      setKeybindings(keybindings.bindings);
      try {
        openKeybindingsFile(keybindings.filePath);
        addNotice("Opening Claude keybindings config.", "info");
      } catch (error) {
        addNotice(error instanceof Error ? error.message : String(error), "error");
      }
      setRightPane({ kind: "details", title: "Keybindings", body: keybindings.body });
      return;
    }
    if (name === "/statusline") {
      setRightPane({ kind: "details", title: "Status line", body: formatClaudeStatusLineConfig(project.workspaceRoot) });
      return;
    }
    if (name === "/doctor") {
      let pluginCount: number | null = null;
      if (sessionId && activeSession?.provider === "claude") {
        try {
          pluginCount = (await listClaudePlugins(conn, sessionId)).length;
        } catch {
          pluginCount = null;
        }
      }
      setRightPane({
        kind: "details",
        title: "Doctor",
        body: formatDoctorReport({
          workspaceRoot: project.workspaceRoot,
          activeProvider: activeSession?.provider ?? modelState.provider,
          pluginCount,
        }),
      });
      return;
    }
    if (name === "/status") {
      setRightPane({
        kind: "status",
        rows: [
          ["project", project.projectRoot],
          ["workspace", project.workspaceRoot],
          ["lane", activeLane?.name ?? laneId ?? "none"],
          ["chat", activeSession?.title ?? activeSession?.sessionId ?? "none"],
          ["ADE", "ready"],
        ],
      });
      return;
    }
    if (name === "/context") {
      if (!sessionId) {
        setRightPane({ kind: "details", title: "Context", body: "No active chat is selected." });
        return;
      }
      if (activeSession?.provider !== "claude") {
        setRightPane({ kind: "details", title: "Context", body: "/context is only available for Claude chats." });
        return;
      }
      const usage = await getContextUsage(conn, sessionId);
      setRightPane({ kind: "details", title: "Context", body: formatContextUsage(usage) });
      return;
    }
    if (name === "/agents") {
      if (activeSession?.provider !== "claude") {
        setRightPane({ kind: "details", title: "Agents", body: "/agents is only available for Claude chats." });
        return;
      }
      setRightPane({ kind: "details", title: "Agents", body: listClaudeCompatMarkdownEntries(project.workspaceRoot, "agents") });
      return;
    }
    if (name === "/skills") {
      if (activeSession?.provider !== "claude") {
        setRightPane({ kind: "details", title: "Skills", body: "/skills is only available for Claude chats." });
        return;
      }
      setRightPane({ kind: "details", title: "Skills", body: listClaudeCompatMarkdownEntries(project.workspaceRoot, "skills") });
      return;
    }
    if (name === "/init") {
      try {
        const body = ensureClaudeInitFiles(project.workspaceRoot);
        setRightPane({ kind: "details", title: "Init", body });
        addNotice("Initialized Claude-compatible project files.", "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRightPane({ kind: "details", title: "Init", body: message });
        addNotice(message, "error");
      }
      return;
    }
    if (name === "/output-style") {
      if (!sessionId) {
        setRightPane({ kind: "details", title: "Output style", body: "No active chat is selected." });
        return;
      }
      if (activeSession?.provider !== "claude") {
        setRightPane({ kind: "details", title: "Output style", body: "/output-style is only available for Claude chats." });
        return;
      }
      if (!args.trim()) {
        const styles = await listClaudeOutputStyles(conn, sessionId);
        setRightPane({ kind: "details", title: "Output style", body: formatOutputStyles(styles, activeSession?.claudeOutputStyle) });
        return;
      }
      const updated = await setClaudeOutputStyle(conn, sessionId, args.trim());
      addNotice(`Claude output style set to ${updated.claudeOutputStyle ?? args.trim()}.`, "success");
      await refreshState();
      return;
    }
    if (name === "/plugin") {
      if (!sessionId) {
        setRightPane({ kind: "details", title: "Plugins", body: "No active chat is selected." });
        return;
      }
      if (activeSession?.provider !== "claude") {
        setRightPane({ kind: "details", title: "Plugins", body: "/plugin is only available for Claude chats." });
        return;
      }
      if (args.trim().toLowerCase() === "reload") {
        const result = await reloadClaudePlugins(conn, sessionId);
        setRightPane({ kind: "details", title: "Plugins", body: formatPluginReload(result) });
        return;
      }
      if (args.trim()) {
        const command = `/plugin ${args.trim()}`;
        setRightPane({ kind: "details", title: "Plugins", body: `Running ${command} in the active Claude session.` });
        lastLocalSendAtRef.current = Date.now();
        await sendOrSteerChatMessage(sessionId, command);
        return;
      }
      const plugins = await listClaudePlugins(conn, sessionId);
      setRightPane({ kind: "details", title: "Plugins", body: formatClaudePlugins(plugins) });
      return;
    }
    if (name === "/new chat") {
      if (!laneId) {
        setRightPane({ kind: "details", title: "New chat", body: "No active lane is available." });
        return;
      }
      openNewChatSetup(args);
      return;
    }
    if (name === "/steer") {
      const body = pendingSteers.length
        ? pendingSteers
            .map((steer, index) => `${index + 1}. ${steer.text}`)
            .join("\n")
        : "No staged steer messages are waiting.";
      setRightPane({ kind: "details", title: "Staged messages", body });
      return;
    }
    if (name === "/new lane") {
      if (!args) {
        openNewLaneForm();
        return;
      }
      const created = await conn.action<LaneSummary>("lane", "create", { name: args });
      selectActiveLaneId(created.id);
      selectActiveSessionId(null);
      setDrawerLaneId(created.id);
      setSelectedDrawerLaneId(created.id);
      setSelectedDrawerChatId(null);
      setSelectedDrawerLaneAction(null);
      setSelectedDrawerChatAction(null);
      setDrawerSection("lanes");
      setRightPane({ kind: "details", title: "New lane", body: renderObject(created, 20) });
      await refreshState();
      setDrawerLaneId(created.id);
      setSelectedDrawerLaneId(created.id);
      setSelectedDrawerLaneAction(null);
      return;
    }
    if (name === "/rename") {
      if (!sessionId) {
        setRightPane({ kind: "details", title: "Rename chat", body: "No active chat is selected." });
        return;
      }
      if (!args) {
        openForm({
          kind: "form",
          title: "Rename chat",
          command: "rename",
          fields: [
            { name: "title", label: "Title", required: true, initialValue: activeSession?.title ?? "" },
          ],
        });
        return;
      }
      await renameChat(conn, sessionId, args);
      addNotice(`Renamed chat to "${args}".`, "success");
      await refreshState();
      return;
    }
    if (name === "/tag") {
      if (!sessionId) {
        setRightPane({ kind: "details", title: "Tag chat", body: "No active chat is selected." });
        return;
      }
      if (activeSession?.provider !== "claude") {
        setRightPane({ kind: "details", title: "Tag chat", body: "/tag is only available for Claude chats." });
        return;
      }
      if (!args) {
        setRightPane({ kind: "details", title: "Tag chat", body: "Usage: /tag <tag|clear>" });
        return;
      }
      const normalizedTag = ["clear", "none", "null", "remove"].includes(args.trim().toLowerCase())
        ? null
        : args.trim();
      await tagChat(conn, sessionId, normalizedTag);
      addNotice(normalizedTag ? `Tagged chat "${normalizedTag}".` : "Cleared chat tag.", "success");
      await refreshState();
      return;
    }
    if (name === "/diff") {
      if (!laneId) {
        setRightPane({ kind: "details", title: "Diff", body: "No active lane is selected." });
        return;
      }
      const diff = await conn.actionList("diff", "getChanges", [laneId]);
      setRightPane({ kind: "diff", title: "Diff", files: summarizeDiffChanges(diff) });
      return;
    }
    if (name === "/log") {
      if (!laneId) {
        setRightPane({ kind: "details", title: "Recent commits", body: "No active lane is selected." });
        return;
      }
      const log = await conn.action("git", "listRecentCommits", { laneId, limit: 12 });
      setRightPane({ kind: "list", title: "Recent commits", rows: routeRows(log), emptyText: "No commits." });
      return;
    }
    if (name === "/reparent") {
      const showReparentDetails = (body: string): void => {
        setRightPane({ kind: "details", title: "Reparent lane", body });
      };
      if (!laneId) {
        showReparentDetails("No active lane is selected.");
        return;
      }
      const lane = lanes.find((entry) => entry.id === laneId) ?? null;
      if (!lane) {
        showReparentDetails(`Lane ${laneId} is not loaded.`);
        return;
      }
      if (lane.laneType === "primary") {
        showReparentDetails("Primary lane cannot be reparented.");
        return;
      }
      const targets = reparentTargetsForLane(lane, lanes);
      const parsed = splitFirstArg(args);
      if (!parsed.first) {
        const rows = targets.map((target) => {
          const current = target.id === (lane.parentLaneId ?? "") ? "current" : target.laneType;
          return `${target.id.padEnd(18)} ${target.name} · ${target.branchRef} · ${current}`;
        });
        showReparentDetails([
          "Usage: /reparent <parent-lane-id|parent-name> [stack-base-ref]",
          "",
          "Moves the active lane under another parent and runs git rebase. The optional stack-base-ref overrides the parent branch, for example origin/main.",
          "",
          rows.length ? rows.join("\n") : "No valid parent lanes are available.",
        ].join("\n"));
        return;
      }
      const parent = resolveLaneReference(targets, parsed.first);
      if (!parent) {
        showReparentDetails(`No valid parent lane matched "${parsed.first}". Run /reparent to list targets.`);
        return;
      }
      const stackBaseBranchRef = parsed.rest.trim();
      const result = await conn.action("lane", "reparent", {
        laneId,
        newParentLaneId: parent.id,
        ...(stackBaseBranchRef ? { stackBaseBranchRef } : {}),
      });
      showReparentDetails(renderObject(result, 20));
      addNotice(
        `Reparented ${lane.name} under ${parent.name}${stackBaseBranchRef ? ` using ${stackBaseBranchRef}` : ""}.`,
        "success",
      );
      await refreshState();
      return;
    }
    if (name.startsWith("/pr")) {
      if (!laneId) {
        setRightPane({ kind: "details", title: name.slice(1) || "PR", body: "No active lane is selected." });
        return;
      }
      const prs = await conn.action<Array<Record<string, unknown>>>("pr", "listAll", laneId ? { laneId } : {});
      const activePr = prs[0] ?? null;
      const prId = activePr ? String(activePr.id ?? activePr.prId ?? "") : "";
      if (name === "/pr") {
        const ahead = activeLane?.status?.ahead ?? 0;
        setRightPane({
          kind: "details",
          title: "PR",
          body: activePr
            ? renderObject(activePr, 24)
            : `No PR is linked to this lane yet.\n${ahead > 0 ? `${ahead} commit${ahead === 1 ? "" : "s"} ahead of base.\n` : ""}Run /pr open <title> to create a draft.`,
        });
        return;
      }
      if (name === "/pr open") {
        if (activePr) {
          await navigateDesktop(conn, {
            source: "ade-code",
            target: {
              kind: "pr",
              prId,
              laneId,
              prNumber: typeof activePr.number === "number" ? activePr.number : null,
            },
          });
          setRightPane({ kind: "details", title: "PR open", body: renderObject(activePr, 24) });
          return;
        }
        if (!args) {
          openForm({
            kind: "form",
            title: "Open PR",
            command: "pr-open",
            fields: [
              { name: "title", label: "Title", required: true, placeholder: activeLane?.name ?? "Draft PR" },
              { name: "body", label: "Body", placeholder: "Optional" },
            ],
          });
          return;
        }
        const created = await conn.action("pr", "createFromLane", {
          laneId,
          title: args,
          body: "",
          draft: true,
        });
        setRightPane({ kind: "details", title: "PR open", body: renderObject(created, 24) });
        return;
      }
      if (!prId) {
        setRightPane({ kind: "details", title: name.slice(1), body: "No PR is linked to this lane yet." });
        return;
      }
      const pr = name === "/pr checks"
        ? await conn.actionList("pr", "getChecks", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
        : name === "/pr comments"
          ? await conn.tool("pr_get_review_comments", { prId }).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
          : await Promise.all([
              conn.actionList("pr", "getReviews", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
              conn.actionList("pr", "getReviewThreads", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
              conn.actionList("pr", "getComments", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
            ]).then(([reviews, threads, comments]) => ({ reviews, threads, comments }));
      setRightPane({ kind: "details", title: name.slice(1), body: renderObject(pr, 24) });
      return;
    }
    if (name === "/linear list") {
      const linear = await conn.action("linear_issue_tracker", "listIssues", parseLinearIssueListArgs(args || "--limit 20"));
      setRightPane({ kind: "list", title: "Linear", rows: routeRows(linear), emptyText: "No Linear issues." });
      return;
    }
    if (name === "/linear status") {
      const status = await conn.action("linear_issue_tracker", "getStatus", {});
      setRightPane({ kind: "details", title: "Linear status", body: renderObject(status, 24) });
      return;
    }
    if (name === "/linear pull") {
      if (!args) {
        setRightPane({ kind: "details", title: "Linear pull", body: "Usage: /linear pull <issue-id>" });
        return;
      }
      const issue = await conn.actionList("linear_issue_tracker", "fetchIssueById", [args]);
      if (!issue) {
        setRightPane({ kind: "details", title: "Linear pull", body: `Linear issue ${args} was not found.` });
        return;
      }
      const targetSessionId = await ensureActiveSession();
      const issueContext = `Linear issue context:\n${renderObject(issue, 28)}`;
      if (targetSessionId) {
        await sendOrSteerChatMessage(targetSessionId, issueContext);
      }
      setRightPane({ kind: "details", title: "Linear pull", body: issueContext });
      return;
    }
    if (name === "/linear comment") {
      const parsed = splitFirstArg(args);
      if (!parsed.first || !parsed.rest) {
        setRightPane({ kind: "details", title: "Linear comment", body: "Usage: /linear comment <issue-id> <text>" });
        return;
      }
      const result = await conn.actionList("linear_issue_tracker", "createComment", [parsed.first, parsed.rest]);
      setRightPane({ kind: "details", title: "Linear comment", body: renderObject(result, 12) });
      addNotice(`Commented on ${parsed.first}.`, "success");
      return;
    }
    if (name === "/linear assign") {
      const parsed = splitFirstArg(args);
      if (!parsed.first || !parsed.rest) {
        setRightPane({ kind: "details", title: "Linear assign", body: "Usage: /linear assign <issue-id> <user-id|none>" });
        return;
      }
      const normalizedAssignee = parsed.rest.toLowerCase();
      const assigneeId = normalizedAssignee === "none" || normalizedAssignee === "null" || normalizedAssignee === "unassigned"
        ? null
        : parsed.rest;
      await conn.actionList("linear_issue_tracker", "updateIssueAssignee", [parsed.first, assigneeId]);
      setRightPane({
        kind: "details",
        title: "Linear assign",
        body: assigneeId ? `Assigned ${parsed.first} to ${assigneeId}.` : `Cleared assignee for ${parsed.first}.`,
      });
      addNotice(`Updated ${parsed.first}.`, "success");
      return;
    }
    if (name === "/linear" || name.startsWith("/linear ")) {
      const linearInput = `${name.slice("/linear".length)} ${args}`.trim();
      const request = buildLinearToolRequest(linearInput);
      if (request.kind === "usage") {
        setRightPane({ kind: "details", title: request.title, body: request.body });
        return;
      }
      const result = await conn.tool(request.toolName, request.args);
      setRightPane({ kind: "details", title: request.title, body: renderObject(result, 24) });
      return;
    }
    if (name === "/feedback") {
      openFeedbackForm();
      return;
    }
    if (name === "/memory") {
      const query = args || "project";
      const result = await conn.tool("memory_search", { query, scope: "project", limit: 10 });
      setRightPane({ kind: "details", title: "Memory", body: renderObject(result, 24) });
      return;
    }
    if (name === "/forget") {
      setRightPane({ kind: "details", title: "Forget", body: "Memory lifecycle controls are available in desktop. Run /open to continue there." });
      return;
    }
    if (name === "/chats") {
      const laneSessions = displaySessions.filter((session) => session.laneId === laneId);
      const selectedIndex = Math.max(0, laneSessions.findIndex((session) => session.sessionId === sessionId));
      setRightSelectionIndex(selectedIndex);
      setRightPane({
        kind: "list",
        title: "Chats",
        rows: laneSessions.map((session) => `${session.sessionId === sessionId ? "●" : "○"} ${session.title ?? session.sessionId}`),
        emptyText: "No chats in this lane.",
        action: { kind: "switch-chat", ids: laneSessions.map((session) => session.sessionId) },
      });
      return;
    }
    if (name === "/switch") {
      const query = args.toLowerCase();
      if (!query) {
        const selectedIndex = Math.max(0, lanes.findIndex((lane) => lane.id === laneId));
        setRightSelectionIndex(selectedIndex);
        setRightPane({
          kind: "list",
          title: "Switch",
          rows: lanes.map((lane) => `${lane.id === laneId ? "●" : "○"} ${lane.name}`),
          emptyText: "No lanes.",
          action: { kind: "switch-lane", ids: lanes.map((lane) => lane.id) },
        });
        return;
      }
      const lane = lanes.find((entry) => entry.id.toLowerCase() === query || entry.name.toLowerCase().includes(query));
      if (lane) {
        selectActiveLaneId(lane.id);
        setDrawerLaneId(lane.id);
        setSelectedDrawerLaneId(lane.id);
        const session = newestSession(displaySessions.filter((entry) => entry.laneId === lane.id));
        selectActiveSessionId(session?.sessionId ?? null);
        setSelectedDrawerChatId(session?.sessionId ?? null);
        addNotice(`Switched to lane ${lane.name}.`, "success");
      } else {
        setRightPane({ kind: "details", title: "Switch", body: `No lane matched "${args}".` });
      }
      return;
    }
    if (name === "/model") {
      openModelPicker();
      return;
    }
    if (name === "/info") {
      if (!subagentPaneCommandAvailable) {
        addNotice("Open a chat first to inspect chat info.", "info");
        return;
      }
      openSubagentsPane();
      return;
    }
    if (name === "/system") {
      setRightPane({
        kind: "details",
        title: "System",
        body: renderObject({ project, pid: process.pid }, 24),
      });
      return;
    }
    if (name === "/ade") {
      const parsed = splitFirstArg(args);
      const possibleBuiltin = parsed.first.startsWith("/") ? parsed.first : `/${parsed.first}`;
      const alias = possibleBuiltin !== "/ade"
        ? parseCommand(`${possibleBuiltin}${parsed.rest ? ` ${parsed.rest}` : ""}`, [])
        : null;
      if (alias?.spec?.placement === "right") {
        await runRightCommand(alias.name, alias.args);
        return;
      }
      if (alias?.spec?.placement === "inline") {
        setRightPane({
          kind: "details",
          title: "ADE command",
          body: `/${parsed.first.replace(/^\//, "")} is an inline TUI command. Run it before creating a runtime chat, or use the keyboard shortcut when available.`,
        });
        return;
      }
      const [domain, action] = parsed.first.split(".", 2);
      if (!domain || !action) {
        setRightPane({
          kind: "details",
          title: "ADE action",
          body: "Usage: /ade <domain.action|status|diff|model|effort|help> [json-object|json-array|json-scalar]",
        });
        return;
      }
      const result = await conn.tool("run_ade_action", {
        domain,
        action,
        ...parseAdeActionPayload(parsed.rest),
      });
      const body = result && typeof result === "object" && "result" in result
        ? (result as { result?: unknown }).result
        : result;
      setRightPane({ kind: "details", title: `ADE ${domain}.${action}`, body: renderObject(body, 24) });
    }
  }, [activeLane?.name, activeSession?.provider, activeSession?.sessionId, activeSession?.title, addNotice, ensureActiveSession, focusDetails, lanes, mode, modelState.modelId, modelState.reasoningEffort, models, openFeedbackForm, openForm, openModelRow, openNewChatSetup, openNewLaneForm, openSubagentsPane, pendingSteers, project, refreshState, selectActiveLaneId, selectActiveSessionId, sendOrSteerChatMessage, sessions, setChatScrollOffset, subagentPaneCommandAvailable]);

  const runInlineCommand = useCallback(async (name: string, args: string) => {
    if (name === "/quit") {
      requestAppExit();
      return;
    }
    if (name === "/clear") {
      setClearedAt(new Date().toISOString());
      eventDedupKeysRef.current.clear();
      eventDedupKeyOrderRef.current = [];
      eventCountRef.current = 0;
      setEvents([]);
      setChatScrollOffset(0);
      addNotice("Local transcript view cleared. The durable chat remains in ADE.", "info");
      return;
    }
    const conn = connectionRef.current;
    if (!conn) return;
    const laneId = activeLaneIdRef.current;
    const sessionId = activeSessionIdRef.current;
    if (name === "/login") {
      const provider = normalizeProvider(activeSession?.provider ?? modelState.provider);
      const loginCommands = loginCommandsForProvider(provider);
      if (!loginCommands.length) {
        addNotice(`/login is not available for ${providerLabel(provider)}. ${loginUnavailableHint(provider)}`, "error");
        return;
      }
      let selectedLogin: ProviderLoginCommand | null = null;
      let code: number | null = null;
      let ranLogin = false;
      for (const login of loginCommands) {
        selectedLogin = login;
        addNotice(`Starting \`${login.label}\` in this terminal.`, "info");
        try {
          code = await runInteractiveTerminalCommand(login.command, login.args, project.projectRoot);
          ranLogin = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          throw error;
        }
      }
      if (!selectedLogin || !ranLogin) {
        addNotice(`Could not find a ${providerLabel(provider)} login command on PATH.`, "error");
        return;
      }
      if (code === 0) {
        addNotice(`${providerLabel(provider)} auth completed. Refreshing provider status.`, "success");
        await refreshAiSetupStatus({ force: true });
        await loadProviderModels(provider, { applyDefault: false });
      } else {
        addNotice(`${providerLabel(provider)} login exited with code ${code ?? "unknown"}.`, "error");
      }
      return;
    }
    if (name === "/commit") {
      if (!laneId) {
        addNotice("No active lane is selected.", "error");
        return;
      }
      if (!args) {
        addNotice("Usage: /commit <message>", "error");
        return;
      }
      const result = await conn.action("git", "commit", { laneId, message: args });
      addNotice(`Commit complete: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name === "/push") {
      if (!laneId) {
        addNotice("No active lane is selected.", "error");
        return;
      }
      const result = await conn.action("git", "push", { laneId });
      addNotice(`Push complete: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name === "/pull") {
      if (!laneId) {
        addNotice("No active lane is selected.", "error");
        return;
      }
      const result = await conn.action("git", "pull", { laneId });
      addNotice(`Pull complete: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name === "/stage all") {
      if (!laneId) {
        addNotice("No active lane is selected.", "error");
        return;
      }
      const result = await conn.action("git", "stageAll", { laneId });
      addNotice(`Stage all complete: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name === "/remember") {
      if (!args) {
        addNotice("Usage: /remember <durable fact>", "error");
        return;
      }
      const result = await conn.tool("memory_add", {
        content: args,
        scope: "project",
        category: "decision",
        importance: "medium",
      });
      addNotice(`Memory saved: ${renderObject(result, 4).replace(/\n/g, " ")}`, "success");
      return;
    }
    if (name.startsWith("/steer")) {
      if (!sessionId) {
        addNotice("No active chat is selected.", "error");
        return;
      }
      const latestSteer = pendingSteers[pendingSteers.length - 1] ?? null;
      if (!latestSteer) {
        addNotice("No staged steer message is waiting.", "info");
        return;
      }
      if (name === "/steer cancel") {
        await cancelSteerMessage(conn, sessionId, latestSteer.steerId);
        addNotice("Removed staged steer message.", "success");
        await refreshState();
        return;
      }
      if (name === "/steer edit") {
        if (!args.trim()) {
          addNotice("Usage: /steer edit <text>", "error");
          return;
        }
        await editSteerMessage(conn, sessionId, latestSteer.steerId, args.trim());
        addNotice("Updated staged steer message.", "success");
        await refreshState();
        return;
      }
      if (name === "/steer send" || name === "/steer interrupt") {
        if (activeSession?.provider !== "claude") {
          addNotice("Only Claude staged messages support send-now and interrupt dispatch.", "error");
          return;
        }
        await dispatchSteerMessage(conn, sessionId, latestSteer.steerId, name === "/steer send" ? "inline" : "interrupt");
        addNotice(name === "/steer send" ? "Sent staged message into the active Claude turn." : "Interrupting Claude to run the staged message.", "info");
        await refreshState();
        return;
      }
    }
    if (name === "/open") {
      const target = sessionId
        ? { kind: "chat" as const, sessionId, laneId }
        : laneId
          ? { kind: "lane" as const, laneId }
          : { kind: "work" as const };
      const result = await navigateDesktop(conn, { source: "ade-code", target });
      if (result.ok) {
        addNotice("Opened ADE desktop at this context.", "success");
        return;
      }
      if (process.platform === "darwin") {
        spawn("open", [
          "-a",
          "ADE",
          "--env",
          `ADE_PROJECT_ROOT=${project.projectRoot}`,
          project.projectRoot,
        ], { stdio: "ignore", detached: true }).unref();
        addNotice(result.message ?? "Desktop route unavailable; launched ADE.", "info");
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await delay(750);
          const attached = await connectToAde({ project, forceEmbedded: false, socketPath }).catch(() => null);
          if (!attached || attached.mode !== "attached") {
            await attached?.close().catch(() => {});
            continue;
          }
          const retry = await navigateDesktop(attached, { source: "ade-code", target }).catch(() => null);
          if (!retry?.ok) {
            await attached.close().catch(() => {});
            continue;
          }
          const previous = connectionRef.current;
          connectionRef.current = attached;
          setConnection(attached);
          setMode(attached.mode);
          await previous?.close().catch(() => {});
          addNotice("Opened ADE desktop at this context.", "success");
          await refreshState();
          return;
        }
      } else {
        addNotice(result.message ?? "Desktop route unavailable from this runtime.", "error");
      }
    }
  }, [activeSession?.provider, addNotice, applyLocalModelArg, displaySessions, loadProviderModels, modelState.provider, pendingSteers, project, refreshAiSetupStatus, refreshState, requestAppExit, scheduleModelStateCommit, sendClaudeModelCommandToTerminal, setChatScrollOffset, socketPath]);

  const submitRightForm = useCallback(async (
    form: Extract<RightPaneContent, { kind: "form" }>,
    values: Record<string, string>,
  ) => {
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!conn) return;

    const requireField = (name: string, label: string): string | null => {
      const value = values[name]?.trim() ?? "";
      if (value) return value;
      addNotice(`${label} is required.`, "error");
      return null;
    };

    if (form.command === "new-lane") {
      const name = requireField("name", "Name");
      if (!name) return;
      const baseBranch = values.baseBranch?.trim();
      const created = await conn.action<LaneSummary>("lane", "create", {
        name,
        ...(baseBranch ? { baseBranch } : {}),
      });
      selectActiveLaneId(created.id);
      selectActiveSessionId(null);
      setDrawerLaneId(created.id);
      setSelectedDrawerLaneId(created.id);
      setSelectedDrawerChatId(null);
      setSelectedDrawerLaneAction(null);
      setSelectedDrawerChatAction(null);
      setDrawerSection("lanes");
      setRightOpen(false);
      setRightPane({ kind: "empty" });
      lastUserOpenedPaneRef.current = null;
      focusAfterDetails();
      addNotice(`Created lane ${created.name}.`, "success");
      await refreshState();
      setDrawerLaneId(created.id);
      setSelectedDrawerLaneId(created.id);
      setSelectedDrawerLaneAction(null);
      return;
    }

    if (form.command === "rename") {
      if (!sessionId) return;
      const title = requireField("title", "Title");
      if (!title) return;
      await renameChat(conn, sessionId, title);
      setRightOpen(false);
      setRightPane({ kind: "empty" });
      lastUserOpenedPaneRef.current = null;
      focusAfterDetails();
      addNotice(`Renamed chat to "${title}".`, "success");
      await refreshState();
      return;
    }

    if (form.command === "pr-open") {
      if (!laneId) return;
      const title = requireField("title", "Title");
      if (!title) return;
      const body = values.body?.trim() ?? "";
      const created = await conn.action("pr", "createFromLane", {
        laneId,
        title,
        body,
        draft: true,
      });
      setRightPane({ kind: "details", title: "PR open", body: renderObject(created, 24) });
      addNotice("Created draft PR.", "success");
      await refreshState();
    }

    if (form.command === "feedback") {
      const summary = requireField("summary", "Summary");
      if (!summary) return;
      const draftInput = buildFeedbackDraftInput({ ...values, summary } as FeedbackFormValues);
      setRightPane({ kind: "details", title: "Feedback", body: "Posting feedback to GitHub..." });
      try {
        const draft = await conn.action<FeedbackPreparedDraft>("feedback", "prepareDraft", {
          draftInput,
          modelId: null,
          reasoningEffort: null,
        });
        const submission = await conn.action<FeedbackSubmission>("feedback", "submitPreparedDraft", {
          draft,
          title: draft.title,
          body: draft.body,
          labels: draft.labels,
        });
        setFormDiscardArmed(false);
        setFormValues({});
        setFormFieldIndex(0);
        setPrompt("");
        setRightOpen(false);
        setRightPane({ kind: "empty" });
        lastUserOpenedPaneRef.current = null;
        focusAfterDetails();
        const notice = feedbackSubmissionNotice(submission);
        addNotice(notice.text, notice.tone);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setFormDiscardArmed(false);
        setFormValues({});
        setFormFieldIndex(0);
        setPrompt("");
        setRightOpen(false);
        setRightPane({ kind: "empty" });
        lastUserOpenedPaneRef.current = null;
        focusAfterDetails();
        addNotice(`Feedback failed: ${message}`, "error");
      }
    }
  }, [addNotice, focusAfterDetails, refreshState, selectActiveLaneId, selectActiveSessionId]);

  const openLatestImage = useCallback(() => {
    const target = latestOpenableImageTarget(events);
    if (!target) {
      addNotice("No image to open in the recent history.", "info");
      return;
    }
    const openTarget = target;
    try {
      const child = process.platform === "darwin"
        ? spawn("open", [openTarget], { stdio: "ignore", detached: true })
        : process.platform === "win32"
          ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", openTarget], { stdio: "ignore", detached: true })
          : spawn("xdg-open", [openTarget], { stdio: "ignore", detached: true });
      child.once("error", (err) => {
        addNotice(err instanceof Error ? err.message : String(err), "error");
      });
      child.once("spawn", () => {
        addNotice(`Opening ${path.basename(openTarget)}…`, "info");
      });
      child.unref();
    } catch (err) {
      addNotice(err instanceof Error ? err.message : String(err), "error");
    }
  }, [addNotice, events]);

  // Slash commands typed while a turn is streaming or rate-limited used to slip
  // past the dispatcher and get queued/sent as plain text. interceptLocalSlashCommand
  // routes any recognized inline/right slash before any send path runs.
  const interceptLocalSlashCommand = useCallback(async (text: string): Promise<boolean> => {
    if (!text.startsWith("/")) return false;
    const parsed = parseCommand(text, slashCommands);
    if (!parsed?.spec) return false;
    if (parsed.spec.providers?.length && !parsed.spec.providers.includes(activeCommandProvider)) {
      clearChatPromptDraft();
      addNotice(`${parsed.name} is only available for ${parsed.spec.providers.join(", ")} chats.`, "error");
      return true;
    }
    if (parsed.spec.placement === "inline") {
      clearChatPromptDraft();
      await runInlineCommand(parsed.name, parsed.args);
      return true;
    }
    if (parsed.spec.placement === "right") {
      clearChatPromptDraft();
      await runRightCommand(parsed.name, parsed.args);
      return true;
    }
    return false;
  }, [activeCommandProvider, addNotice, clearChatPromptDraft, runInlineCommand, runRightCommand, slashCommands]);

  const submitPrompt = useCallback(async (value: string) => {
    const text = value.trim();
    const submittedValue = value;
    const promptAttachments: AgentChatFileRef[] = selectedMentions
      .filter((mention) => (
        mention.kind === "file"
        && mention.filePath
        && (mention.attachment || (mention.insertText.length > 0 && text.includes(mention.insertText)))
      ))
      .map((mention) => ({ type: isImageFilePath(mention.filePath!) ? "image" : "file", path: mention.filePath! }));
    if (!text && rightPane.kind !== "form" && !promptAttachments.length) return;
    // Intercept ADE-owned slash commands before the connection gate so /model and
    // /plan work pre-chat (splash screen) where connectionRef.current is null.
    try {
      if (text.startsWith("/") && rightPane.kind !== "form" && !pendingApproval) {
        if (await interceptLocalSlashCommand(text)) {
          clearChatPromptDraft();
          return;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addNotice(message, "error");
      return;
    }
    const conn = connectionRef.current;
    if (!conn) return;
    try {
      setInterrupted(false);
      setPrompt("");
      promptRef.current = "";
      setChatScrollOffset(0);
      if (activePaneRef.current === "chat") {
        chatDraftRef.current = "";
      }
      setError(null);
      if (pendingApproval?.mode === "approval") {
        const lowered = text.toLowerCase();
        if (pendingApproval.highStakes) {
          if (lowered === "approve" || lowered === "deny") {
            await resolvePendingApproval(pendingApproval, lowered === "approve" ? "accept" : "decline");
            return;
          }
          addNotice("Type approve or deny to resolve the high-stakes request.", "error");
          return;
        }
        if (lowered === "approve" || lowered === "a" || lowered === "deny" || lowered === "d") {
          await resolvePendingApproval(pendingApproval, lowered === "approve" || lowered === "a" ? "accept" : "decline");
          return;
        }
        addNotice("Press a to approve or d to deny this request.", "error");
        return;
      }
      if (pendingApproval?.mode === "question") {
        await answerPendingInput(pendingApproval, value);
        return;
      }
      if (rightPane.kind === "form" && !text.startsWith("/")) {
        const field = activeFormField;
        const values = field ? { ...formValues, [field.name]: value } : formValues;
        setFormValues(values);
        await submitRightForm(rightPane, values);
        return;
      }
      const parsed = parseCommand(text, slashCommands);
      if (parsed?.spec?.providers?.length && !parsed.spec.providers.includes(activeCommandProvider)) {
        addNotice(`${parsed.name} is only available for ${parsed.spec.providers.join(", ")} chats.`, "error");
        return;
      }
      if (text.startsWith("/") && parsed && !parsed.spec && !parsed.userCommand && slashRows.length) {
        const selected = slashRows[slashIndex] ?? slashRows[0];
        if (selected) {
          const selectedCommand = parseCommand(selected.name, slashCommands);
          if (selectedCommand?.spec?.placement === "inline") {
            await runInlineCommand(selectedCommand.name, selectedCommand.args);
            return;
          }
          if (selectedCommand?.spec?.placement === "right") {
            await runRightCommand(selectedCommand.name, selectedCommand.args);
            return;
          }
          const activeTerminal = activeTerminalSessionRef.current;
          if (activeTerminal) {
            await submitClaudePromptToTerminal(activeTerminal, selected.name);
            return;
          }
          const sessionId = await ensureActiveSession();
          if (sessionId) {
            await sendOrSteerChatMessage(sessionId, selected.name);
          }
          return;
        }
      }
      if (parsed?.spec?.placement === "inline") {
        await runInlineCommand(parsed.name, parsed.args);
        return;
      }
      if (parsed?.spec?.placement === "right") {
        await runRightCommand(parsed.name, parsed.args);
        return;
      }
      const desktopRoute = desktopRouteForCommand(parsed?.name);
      if (desktopRoute) {
        const result = await navigateDesktop(conn, {
          source: "ade-code",
          target: { kind: "route", route: desktopRoute },
        });
        if (result.ok) {
          addNotice(`Opened ADE desktop for ${parsed?.name}.`, "success");
          return;
        }
        await runInlineCommand("/open", "");
        addNotice(`${parsed?.name} is a desktop-only surface; opened ADE desktop.`, "info");
        return;
      }
      const terminalPrompt = promptTextForTerminal(text, promptAttachments);
      const activeTerminal = activeTerminalSessionRef.current;
      if (activeTerminal) {
        if (await submitClaudePromptToTerminal(activeTerminal, terminalPrompt)) {
          setSelectedMentions((prev) => prev.filter((mention) => !mention.attachment));
        }
        return;
      }
      if (modelStateRef.current.provider === "claude") {
        const terminalId = await startClaudeTerminalForPrompt(terminalPrompt || " ");
        if (terminalId) {
          setSelectedMentions((prev) => prev.filter((mention) => !mention.attachment));
        }
        return;
      }
      const sessionId = await ensureActiveSession();
      if (!sessionId) {
        addNotice("No active lane is available for chat.", "error");
        return;
      }
      lastLocalSendAtRef.current = Date.now();
      await sendOrSteerChatMessage(sessionId, text || "Use the attached image.", promptAttachments);
      setSelectedMentions((prev) => prev.filter((mention) => !mention.attachment));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStreaming(false);
      setError(message);
      if (submittedValue.trim() || promptAttachments.length) {
        setPrompt(submittedValue);
        promptRef.current = submittedValue;
        if (activePaneRef.current === "chat") chatDraftRef.current = submittedValue;
      }
      addNotice(message, "error");
    }
  }, [activeCommandProvider, activeFormField, addNotice, answerPendingInput, clearChatPromptDraft, ensureActiveSession, formValues, interceptLocalSlashCommand, pendingApproval, resolvePendingApproval, rightPane, runInlineCommand, runRightCommand, selectedMentions, sendOrSteerChatMessage, setChatScrollOffset, slashCommands, slashIndex, slashRows, startClaudeTerminalForPrompt, submitClaudePromptToTerminal, submitRightForm]);

  const launchPromptInBackground = useCallback(async (value: string) => {
    const text = value.trim();
    const submittedValue = value;
    const promptAttachments: AgentChatFileRef[] = selectedMentions
      .filter((mention) => (
        mention.kind === "file"
        && mention.filePath
        && (mention.attachment || (mention.insertText.length > 0 && text.includes(mention.insertText)))
      ))
      .map((mention) => ({ type: isImageFilePath(mention.filePath!) ? "image" : "file", path: mention.filePath! }));
    if (!text && !promptAttachments.length) return;
    const conn = connectionRef.current;
    const laneId = activeLaneIdRef.current;
    if (!conn || !laneId) {
      addNotice("No active lane is available for background chat.", "error");
      return;
    }
    if (!draftChatActiveRef.current || activeSessionIdRef.current) {
      addNotice("Background launch is only available from New Chat.", "info");
      return;
    }
    const lane = lanes.find((entry) => entry.id === laneId) ?? null;
    const unavailableMessage = laneWorktreeUnavailableMessage(lane);
    if (unavailableMessage) {
      if (lane) {
        setRightPane(seedLaneDetails(lane, false));
        setRightOpen(true);
      }
      addNotice(unavailableMessage, "error");
      return;
    }
    let launched = false;
    try {
      setInterrupted(false);
      setPrompt("");
      promptRef.current = "";
      chatDraftRef.current = "";
      setChatScrollOffset(0);
      setError(null);
      const normalized = { ...modelStateRef.current, ...applyProviderPermissionMode(modelStateRef.current) };
      const runtimeProvider = runtimeProviderForUiProvider(normalized.provider);
      if (runtimeProvider === "claude") {
        const cols = clampTerminalPaneCols(terminalPaneWidth);
        const terminalRows = claudeTerminalRowsForPane(chatRowBudget);
        const terminalPrompt = promptTextForTerminal(text, promptAttachments);
        await startClaudeTerminalSession({
          connection: conn,
          laneId,
          title: pendingNewChatTitleRef.current ?? "Claude Code",
          model: normalized.modelId ?? normalized.model,
          permissionMode: normalized.permissionMode,
          initialInput: terminalPrompt.trim() ? terminalPrompt : null,
          cols,
          rows: terminalRows,
        });
        launched = true;
      } else {
        const created = await createChatSession({
          connection: conn,
          laneId,
          title: pendingNewChatTitleRef.current,
          provider: runtimeProvider,
          modelId: normalized.modelId,
          reasoningEffort: normalized.reasoningEffort,
          codexFastMode: normalized.codexFastMode,
          permissionMode: normalized.permissionMode,
          interactionMode: normalized.interactionMode,
          claudePermissionMode: normalized.claudePermissionMode,
          codexApprovalPolicy: normalized.codexApprovalPolicy,
          codexSandbox: normalized.codexSandbox,
          codexConfigSource: normalized.codexConfigSource,
          opencodePermissionMode: normalized.opencodePermissionMode,
          droidPermissionMode: normalized.droidPermissionMode,
          cursorModeId: normalized.cursorModeId,
          cursorConfigValues: normalized.cursorConfigValues,
        });
        lastLocalSendAtRef.current = Date.now();
        await sendChatMessage(conn, created.id, text || "Use the attached image.", promptAttachments);
        launched = true;
      }
      pendingNewChatTitleRef.current = null;
      setSelectedMentions((prev) => prev.filter((mention) => !mention.attachment));
      await refreshState().catch((refreshError) => {
        addNotice(`Launched chat, but refresh failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`, "error");
      });
      setDraftChatMode(true);
      addNotice(`Launched chat in ${lane?.name ?? "lane"}.`, "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!launched) {
        setPrompt(submittedValue);
        promptRef.current = submittedValue;
        chatDraftRef.current = submittedValue;
      } else {
        setDraftChatMode(true);
      }
      setError(message);
      addNotice(launched ? `Launched chat, but follow-up failed: ${message}` : message, "error");
    }
  }, [addNotice, chatRowBudget, lanes, refreshState, selectedMentions, setChatScrollOffset, setDraftChatMode, terminalPaneWidth]);

  const insertMention = useCallback((suggestion: MentionSuggestion) => {
    const range = activeMention(prompt);
    if (!range) return;
    setPrompt(`${prompt.slice(0, range.start)}${suggestion.insertText} ${prompt.slice(range.start + range.query.length + 1)}`);
    setSelectedMentions((prev) => {
      if (prev.some((entry) => entry.insertText === suggestion.insertText)) return prev;
      return [...prev, suggestion].slice(-12);
    });
    setMentionSuggestions([]);
    setMentionIndex(0);
  }, [prompt]);

  const insertSlashCommand = useCallback(() => {
    const selected = slashRows[slashIndex] ?? slashRows[0];
    if (!selected) return;
    setPrompt(`${selected.name}${selected.argumentHint ? " " : ""}`);
  }, [slashIndex, slashRows]);

  const applyModelState = useCallback((updater: (prev: AdeCodeModelState) => AdeCodeModelState) => {
    setModelState((prev) => {
      const next = updater(prev);
      scheduleModelStateCommit(next);
      return next;
    });
  }, [scheduleModelStateCommit]);

  // Commit a model picked in the right-pane ModelPicker into the current chat
  // model state and push it onto the cross-surface recents list. Defined here
  // (after applyModelState) so the closure captures a live binding.
	  const commitModelPickerSelection = useCallback(
	    (modelId: string) => {
	      let catalogModel: AgentChatModelCatalogModel | null = null;
	      let catalogProvider: AdeCodeProvider | null = null;
	      for (const group of modelCatalogRef.current?.groups ?? modelCatalog?.groups ?? []) {
	        for (const provider of group.providers) {
	          for (const subsection of provider.subsections) {
	            const found = subsection.models.find((entry) => entry.id === modelId || entry.modelId === modelId);
	            if (found) {
	              catalogModel = found;
	              catalogProvider = normalizeProvider(group.key as AdeCodeProvider);
	              break;
	            }
	          }
	          if (catalogModel) break;
	        }
	        if (catalogModel) break;
	      }
	      const target = models.find((entry) => (entry.modelId ?? entry.id) === modelId)
	        ?? (catalogModel?.isAvailable === true ? catalogModel as AgentChatModelInfo : null);
	      if (!target) {
	        addNotice(`Model ${modelId} is not available right now.`, "error");
	        return;
	      }
      const descriptor = getModelById(modelId);
      const provider: AdeCodeProvider = descriptor
        ? normalizeProvider(resolveProviderGroupForModel(descriptor))
        : catalogProvider ?? modelState.provider;
      applyModelState((prev) => ({
        ...prev,
        ...modelStatePatchForModel(provider, target),
        codexFastMode: (target.serviceTiers?.some((tier) => tier.trim().toLowerCase() === "fast") || modelSupportsFastMode(descriptor))
          ? prev.codexFastMode
          : false,
      }));
      setModelPickerRecents((prev) => {
        const filtered = prev.filter((entry) => entry !== modelId);
        return [modelId, ...filtered].slice(0, 10);
      });
      const conn = connectionRef.current;
      if (conn) {
        void pushModelPickerRecent(conn, modelId)
          .then((recents) => setModelPickerRecents(recents))
          .catch(() => undefined);
      }
      // If we were picking for a new-chat draft, return to the setup pane so
      // the user can finish configuring and dispatch. Otherwise close the pane.
      let restoreSetup = false;
      setRightPane((prev) => {
        if (prev.kind === "model-picker" && prev.surface === "new-chat") {
          const laneId = activeLaneIdRef.current;
          const lane = laneId ? lanes.find((entry) => entry.id === laneId) : null;
          if (lane) {
            restoreSetup = true;
            return {
              kind: "new-chat-setup",
              laneId: lane.id,
              laneLabel: lane.name,
              rows: newChatSetupRows,
            };
          }
        }
        return { kind: "empty" };
      });
      if (restoreSetup) {
        setRightOpen(true);
        setPaneFocus("details");
      } else {
        setRightOpen(false);
        setPaneFocus("chat");
      }
      addNotice(`Model set to ${target.displayName}.`, "success");
    },
	    [addNotice, applyModelState, lanes, models, modelCatalog, modelState.provider, newChatSetupRows, setPaneFocus],
	  );

  const selectProvider = useCallback((provider: AdeCodeProvider) => {
    if (providerLockedRef.current) {
      addNotice("Provider is locked for this chat. /new chat to switch.", "info");
      return;
    }
    const immediateModels = providerModelsCacheRef.current.get(provider) ?? registryModelsForProvider(provider);
    setModels(immediateModels);
    const model = immediateModels.find((entry) => entry.isDefault) ?? immediateModels[0] ?? null;
    applyModelState((prev) => ({
      ...prev,
      ...(model ? modelStatePatchForModel(provider, model) : fallbackModelStatePatch(provider)),
    }));
    void loadProviderModels(provider, { applyDefault: false }).catch(() => undefined);
  }, [addNotice, applyModelState, loadProviderModels]);

  const cycleProvider = useCallback((delta: number) => {
    if (providerLockedRef.current) {
      addNotice("Provider is locked for this chat. /new chat to switch.", "info");
      return;
    }
    const index = Math.max(0, PROVIDER_OPTIONS.findIndex((entry) => entry.value === modelState.provider));
    const next = PROVIDER_OPTIONS[(index + delta + PROVIDER_OPTIONS.length) % PROVIDER_OPTIONS.length]?.value ?? "codex";
    selectProvider(next);
  }, [addNotice, modelState.provider, selectProvider]);

  const cycleModel = useCallback((delta: number) => {
    const candidates = models.length
      ? models
      : registryModelsForProvider(modelState.provider);
    if (!candidates.length) return;
    const index = Math.max(0, candidates.findIndex((entry) => entry.id === modelState.modelId || entry.modelId === modelState.modelId));
    const nextModel = candidates[(index + delta + candidates.length) % candidates.length] ?? candidates[0]!;
    applyModelState((prev) => ({
      ...prev,
      ...modelStatePatchForModel(modelState.provider, nextModel),
      codexFastMode: (nextModel.serviceTiers?.some((tier) => tier.trim().toLowerCase() === "fast") || modelSupportsFastMode(getModelById(nextModel.modelId ?? nextModel.id)))
        ? prev.codexFastMode
        : false,
    }));
  }, [applyModelState, modelState.modelId, modelState.provider, models]);

  const cycleReasoning = useCallback((delta: number) => {
    const efforts = modelReasoningEfforts(modelState, models);
    if (!efforts.length) return;
    const index = Math.max(0, efforts.findIndex((effort) => effort === modelState.reasoningEffort));
    const nextEffort = efforts[(index + delta + efforts.length) % efforts.length] ?? efforts[0]!;
    applyModelState((prev) => ({ ...prev, reasoningEffort: nextEffort }));
  }, [applyModelState, modelState, models]);

  const cyclePermission = useCallback((delta: number) => {
    userInitiatedModeChangeRef.current = true;
    if (modelState.provider === "codex") {
      const current = resolveCodexPreset(modelState);
      const index = Math.max(0, CODEX_PRESETS.findIndex((entry) => entry === current));
      const next = CODEX_PRESETS[(index + delta + CODEX_PRESETS.length) % CODEX_PRESETS.length] ?? "default";
      applyModelState((prev) => ({ ...prev, ...codexPresetPatch(next) }));
      return;
    }
    if (modelState.provider === "claude") {
      const current = modelState.interactionMode === "plan" ? "plan" : modelState.claudePermissionMode;
      const index = Math.max(0, CLAUDE_PERMISSION_OPTIONS.findIndex((entry) => entry === current));
      const next = CLAUDE_PERMISSION_OPTIONS[(index + delta + CLAUDE_PERMISSION_OPTIONS.length) % CLAUDE_PERMISSION_OPTIONS.length] ?? "default";
      applyModelState((prev) => ({
        ...prev,
        interactionMode: next === "plan" ? "plan" : "default",
        claudePermissionMode: next,
        permissionMode: next === "plan"
          ? "plan"
          : next === "auto"
            ? "auto"
            : next === "acceptEdits"
              ? "edit"
              : next === "bypassPermissions"
                ? "full-auto"
                : "default",
      }));
      return;
    }
    if (modelState.provider === "opencode") {
      const index = Math.max(0, OPENCODE_PERMISSION_OPTIONS.findIndex((entry) => entry === modelState.opencodePermissionMode));
      const next = OPENCODE_PERMISSION_OPTIONS[(index + delta + OPENCODE_PERMISSION_OPTIONS.length) % OPENCODE_PERMISSION_OPTIONS.length] ?? "edit";
      applyModelState((prev) => ({ ...prev, opencodePermissionMode: next, permissionMode: next }));
      return;
    }
    if (modelState.provider === "droid") {
      const index = Math.max(0, DROID_PERMISSION_OPTIONS.findIndex((entry) => entry === modelState.droidPermissionMode));
      const next = DROID_PERMISSION_OPTIONS[(index + delta + DROID_PERMISSION_OPTIONS.length) % DROID_PERMISSION_OPTIONS.length] ?? "auto-low";
      applyModelState((prev) => ({ ...prev, droidPermissionMode: next, permissionMode: droidPermissionToLegacy(next) }));
      return;
    }
    const index = Math.max(0, CURSOR_AVAILABLE_MODE_IDS.findIndex((entry) => entry === modelState.cursorModeId));
    const next = CURSOR_AVAILABLE_MODE_IDS[(index + delta + CURSOR_AVAILABLE_MODE_IDS.length) % CURSOR_AVAILABLE_MODE_IDS.length] ?? "agent";
    applyModelState((prev) => ({
      ...prev,
      cursorModeId: next,
      permissionMode: next === "plan"
        ? "plan"
        : next === "ask"
          ? "edit"
          : next === "full-auto"
            ? "full-auto"
            : "default",
    }));
  }, [applyModelState, modelState]);

  const handleSetupRow = useCallback((row: SetupPaneRow, direction = 1) => {
    const conn = connectionRef.current;
    if (row.disabled) return;
    if (row.kind === "provider") {
      cycleProvider(direction);
      return;
    }
    if (row.kind === "model") {
      cycleModel(direction);
      return;
    }
    if (row.kind === "reasoning") {
      cycleReasoning(direction);
      return;
    }
    if (row.kind === "permission") {
      cyclePermission(direction);
      return;
    }
    if (row.kind === "codex-fast") {
      applyModelState((prev) => ({ ...prev, codexFastMode: !prev.codexFastMode }));
      return;
    }
    if (row.kind === "output-style") {
      const sessionId = activeSessionIdRef.current;
      if (!conn || !sessionId) return;
      void (async () => {
        const styles = await listClaudeOutputStyles(conn, sessionId);
        const names = styles.map((style) => style.name).filter(Boolean);
        if (!names.length) {
          addNotice("No Claude output styles were found.", "info");
          return;
        }
        const current = activeSessionRef.current?.claudeOutputStyle ?? row.value ?? "default";
        const index = Math.max(0, names.findIndex((name) => name.toLowerCase() === current.toLowerCase()));
        const next = names[(index + direction + names.length) % names.length] ?? names[0]!;
        await setClaudeOutputStyle(conn, sessionId, next);
        addNotice(`Claude output style set to ${next}.`, "success");
        await refreshState();
      })().catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (row.kind === "refresh-status") {
      void refreshAiSetupStatus({ force: true })
        .then(() => addNotice("AI provider status refreshed.", "success"))
        .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (row.kind === "open-settings") {
      if (!conn) return;
      void navigateDesktop(conn, { source: "ade-code", target: { kind: "route", route: SETTINGS_AI_ROUTE } })
        .then((result) => {
          addNotice(result.ok ? "Opened ADE Settings > AI Providers." : result.message ?? "Desktop settings are unavailable.", result.ok ? "success" : "error");
        })
        .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return;
    }
    if (row.kind === "apply") {
      if (activeTerminalSessionRef.current && modelStateRef.current.provider === "claude") {
        void sendClaudeModelCommandToTerminal()
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      }
      setRightOpen(false);
      setRightPane({ kind: "empty" });
      lastUserOpenedPaneRef.current = null;
      focusChat();
    }
  }, [addNotice, applyModelState, cycleModel, cyclePermission, cycleProvider, cycleReasoning, focusChat, refreshAiSetupStatus, refreshState, sendClaudeModelCommandToTerminal]);

  const recallPromptHistory = useCallback((direction: "previous" | "next"): boolean => {
    const history = promptHistoryRef.current;
    if (!history.length) {
      addNotice("No prompt history in this chat yet.", "info");
      return true;
    }
    if (activePaneRef.current !== "chat") {
      focusChat();
    }
    let index = promptHistoryIndexRef.current;
    if (index == null) {
      promptHistoryDraftRef.current = promptRef.current || chatDraftRef.current;
      index = history.length;
    }
    const nextIndex = direction === "previous"
      ? Math.max(0, index - 1)
      : Math.min(history.length, index + 1);
    promptHistoryIndexRef.current = nextIndex >= history.length ? null : nextIndex;
    const nextPrompt = nextIndex >= history.length ? promptHistoryDraftRef.current : history[nextIndex] ?? "";
    chatDraftRef.current = nextPrompt;
    promptRef.current = nextPrompt;
    setPrompt(nextPrompt);
    if (vimModeEnabled) setVimMode("insert");
    return true;
  }, [addNotice, focusChat, vimModeEnabled]);

  const openHistorySearch = useCallback(() => {
    const query = (promptRef.current || chatDraftRef.current).trim().toLowerCase();
    const rows = [...promptHistoryRef.current]
      .reverse()
      .filter((entry) => !query || entry.toLowerCase().includes(query))
      .slice(0, 20)
      .map((entry) => {
        const compact = entry.replace(/\s+/g, " ");
        return compact.length > 34 ? `${compact.slice(0, 33)}…` : compact;
      });
    setRightPane({
      kind: "list",
      title: "History search",
      rows,
      emptyText: query ? `No prompt history matched "${query}".` : "No prompt history in this chat yet.",
    });
    setRightOpen(true);
    setPaneFocus("details");
  }, [setPaneFocus]);

  const attachClipboardImage = useCallback((): boolean => {
    const attachment = readClipboardImageAttachment(project.workspaceRoot);
    if (!attachment) {
      addNotice("No clipboard image was found. On macOS, copy an image or image file path; ADE Code checks pngpaste and pbpaste.", "error");
      return true;
    }
    if (activePaneRef.current !== "chat") {
      focusChat();
    }
    const insertText = `@${path.basename(attachment.path)}`;
    setSelectedMentions((prev) => {
      if (prev.some((entry) => entry.filePath === attachment.path)) return prev;
      return [...prev, {
        kind: "file" as const,
        label: path.basename(attachment.path),
        insertText,
        detail: attachment.path,
        filePath: attachment.path,
        attachment: true,
      }].slice(-12);
    });
    addNotice("Attached clipboard image.", "success");
    return true;
  }, [addNotice, focusChat, project.workspaceRoot]);

  const runKeybindingAction = useCallback((action: TuiKeybindingAction): boolean => {
    const reportUnavailable = (label = action): true => {
      addNotice(`${label} is recognized, but there is no active ADE Code control for it right now.`, "info");
      return true;
    };
    if (action === "app:interrupt") {
      const conn = connectionRef.current;
      const sessionId = activeSessionIdRef.current;
      const activeTurnVisible = streaming || activeSessionRef.current?.status === "active";
      if (activeTurnVisible && conn && sessionId) {
        setStreaming(false);
        setInterrupted(true);
        void interruptChat(conn, sessionId)
          .then(() => addNotice("Interrupted chat.", "info"))
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      } else {
        addNotice("No active response to interrupt.", "info");
      }
      return true;
    }
    if (action === "app:help") {
      setRightPane({ kind: "help", title: "Help" });
      focusDetails();
      return true;
    }
    if (action === "app:redraw") {
      void refreshState().catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return true;
    }
    if (action === "app:clear" || action === "chat:clearScreen") {
      setClearedAt(new Date().toISOString());
      eventDedupKeysRef.current.clear();
      eventDedupKeyOrderRef.current = [];
      eventCountRef.current = 0;
      setEvents([]);
      setChatScrollOffset(0);
      addNotice("Cleared local transcript view.", "success");
      return true;
    }
    if (action === "app:toggleTodos" || action === "app:toggleTranscript") {
      toggleDetailsPane();
      return true;
    }
    if (action === "app:quit" || action === "app:exit") {
      requestAppExit();
      return true;
    }
    if (action === "chat:submit") {
      void submitPrompt(prompt);
      return true;
    }
    if (action === "chat:launchBackground") {
      void launchPromptInBackground(prompt);
      return true;
    }
    if (action === "chat:cancel" || action === "chat:clearInput") {
      handlePromptChange("");
      return true;
    }
    if (action === "chat:killAgents") {
      return reportUnavailable("chat:killAgents");
    }
    if (action === "chat:cycleMode" || action === "confirm:cycleMode") {
      cyclePermission(1);
      return true;
    }
    if (action === "chat:modelPicker") {
      openModelPicker();
      return true;
    }
    if (action === "chat:fastMode") {
      const activeModel = models.find((entry) => entry.id === modelState.modelId || entry.modelId === modelState.modelId);
      const descriptor = modelState.modelId ? getModelById(modelState.modelId) : undefined;
      const fastSupported =
        Boolean(activeModel?.serviceTiers?.some((tier) => tier.trim().toLowerCase() === "fast"))
        || modelSupportsFastMode(descriptor);
      if (fastSupported) {
        applyModelState((prev) => ({ ...prev, codexFastMode: !prev.codexFastMode }));
      } else if (modelState.provider === "claude") {
        void submitPrompt("/fast");
      } else {
        addNotice("Fast mode is not available for the active provider.", "info");
      }
      return true;
    }
    if (action === "chat:thinkingToggle" || action === "modelPicker:increaseEffort") {
      cycleReasoning(1);
      return true;
    }
    if (action === "modelPicker:decreaseEffort") {
      cycleReasoning(-1);
      return true;
    }
    if (action === "chat:new-line" || action === "chat:newline") {
      const nextPrompt = `${prompt}\n`;
      setFormDiscardArmed(false);
      if (activePaneRef.current === "chat") chatDraftRef.current = nextPrompt;
      setPrompt(nextPrompt);
      return true;
    }
    if (action === "chat:paste-image" || action === "chat:imagePaste") {
      return attachClipboardImage();
    }
    if (action === "chat:open-editor" || action === "chat:externalEditor") {
      const edited = editPromptInExternalEditor(prompt);
      if (edited == null) {
        addNotice("External editor exited without updating the prompt.", "error");
        return true;
      }
      handlePromptChange(edited);
      focusChat();
      addNotice("Loaded prompt from external editor.", "success");
      return true;
    }
    if (action === "chat:undo") {
      return reportUnavailable("chat:undo");
    }
    if (action === "chat:stash") {
      const current = prompt.trim();
      if (current) {
        promptHistoryRef.current = [...promptHistoryRef.current, current].slice(-100);
        handlePromptChange("");
        addNotice("Stashed prompt in local history.", "success");
      }
      return true;
    }
    if (action === "history:previous" || action === "history:next") {
      return recallPromptHistory(action === "history:previous" ? "previous" : "next");
    }
    if (action === "history:search" || action === "historySearch:next") {
      openHistorySearch();
      return true;
    }
    if (action === "historySearch:accept" || action === "historySearch:cancel" || action === "historySearch:execute") {
      focusChat();
      return true;
    }
    if (action === "historySearch:cycleScope") {
      addNotice("History search scope cycling is not available yet.", "info");
      return true;
    }
    if (action === "pane:toggle") {
      toggleDetailsPane();
      return true;
    }
    if (action === "pane:agents") {
      toggleSubagentsPane();
      return true;
    }
    if (action === "pane:close") {
      if (rightOpen) {
        userDismissedRightPaneRef.current = true;
        setRightOpen(false);
        // Explicit close clears the slash-command sticky marker so the next
        // open recomputes to the context default.
        lastUserOpenedPaneRef.current = null;
        setRightPane((prev) => prev.kind === "form" ? { kind: "empty" } : prev);
        focusAfterDetails();
      } else if (drawerOpen) {
        setDrawerOpen(false);
        focusChat();
      }
      return true;
    }
    if (
      action === "autocomplete:accept"
      || action === "confirm:yes"
      || action === "messageSelector:select"
      || action === "select:accept"
      || action === "footer:openSelected"
      || action === "diff:viewDetails"
    ) {
      return reportUnavailable();
    }
    if (
      action === "autocomplete:dismiss"
      || action === "confirm:no"
      || action === "select:cancel"
      || action === "help:dismiss"
      || action === "transcript:exit"
      || action === "diff:dismiss"
      || action === "attachments:exit"
      || action === "footer:clearSelection"
      || action === "settings:close"
    ) {
      if (rightOpen) {
        setRightOpen(false);
        lastUserOpenedPaneRef.current = null;
      }
      if (drawerOpen) setDrawerOpen(false);
      selectFooterControl(null);
      focusChat();
      return true;
    }
    if (action === "tabs:next" || action === "footer:next") {
      cyclePaneFocus();
      return true;
    }
    if (action === "tabs:previous" || action === "footer:previous") {
      cyclePaneFocus();
      return true;
    }
    if (action === "footer:up" || action === "footer:down") {
      if (action === "footer:up") {
        selectFooterControl(null);
        setInlineRowFocus({ cell: providerLockedRef.current ? "model" : "provider" });
      } else {
        selectFooterControl(footerControls[0] ?? "drawer");
      }
      return true;
    }
    if (
      action === "autocomplete:previous"
      || action === "confirm:previous"
      || action === "messageSelector:up"
      || action === "select:previous"
      || action === "attachments:previous"
      || action === "diff:previousFile"
    ) {
      setChatScrollOffset((offset) => offset + 1);
      return true;
    }
    if (
      action === "autocomplete:next"
      || action === "confirm:next"
      || action === "messageSelector:down"
      || action === "select:next"
      || action === "attachments:next"
      || action === "diff:nextFile"
    ) {
      setChatScrollOffset((offset) => offset - 1);
      return true;
    }
    if (action === "confirm:nextField" || action === "confirm:previousField" || action === "confirm:toggle" || action === "confirm:toggleExplanation" || action === "permission:toggleDebug") {
      return reportUnavailable();
    }
    if (action === "transcript:toggleShowAll") {
      toggleDetailsPane();
      return true;
    }
    if (action === "task:background" || action === "theme:toggleSyntaxHighlighting") {
      return reportUnavailable();
    }
    if (action === "attachments:remove") {
      return reportUnavailable();
    }
    if (action === "messageSelector:top") {
      setChatScrollOffset(Number.MAX_SAFE_INTEGER);
      return true;
    }
    if (action === "messageSelector:bottom") {
      setChatScrollOffset(0);
      return true;
    }
    if (action === "diff:previousSource" || action === "diff:nextSource" || action === "diff:back") {
      return reportUnavailable();
    }
    if (action === "plugin:toggle" || action === "plugin:install" || action === "plugin:favorite" || action === "settings:search" || action === "settings:retry" || action === "doctor:fix" || action === "voice:pushToTalk") {
      return reportUnavailable();
    }
    if (action === "scroll:up" || action === "scroll:lineUp") {
      setChatScrollOffset((offset) => offset + 1);
      return true;
    }
    if (action === "scroll:down" || action === "scroll:lineDown") {
      setChatScrollOffset((offset) => offset - 1);
      return true;
    }
    if (action === "scroll:pageUp" || action === "scroll:halfPageUp") {
      setChatScrollOffset((offset) => offset + Math.max(1, chatRowBudget - 2));
      return true;
    }
    if (action === "scroll:pageDown" || action === "scroll:halfPageDown") {
      setChatScrollOffset((offset) => offset - Math.max(1, chatRowBudget - 2));
      return true;
    }
    if (action === "scroll:fullPageUp") {
      setChatScrollOffset((offset) => offset + Math.max(1, chatRowBudget));
      return true;
    }
    if (action === "scroll:fullPageDown") {
      setChatScrollOffset((offset) => offset - Math.max(1, chatRowBudget));
      return true;
    }
    if (action === "scroll:top") {
      setChatScrollOffset(Number.MAX_SAFE_INTEGER);
      return true;
    }
    if (action === "scroll:bottom") {
      setChatScrollOffset(0);
      return true;
    }
    if (action === "selection:copy") {
      copyChatSelection();
      return true;
    }
    if (action.startsWith("selection:")) {
      return reportUnavailable();
    }
    return reportUnavailable();
  }, [addNotice, applyModelState, attachClipboardImage, chatRowBudget, copyChatSelection, cycleFooterControl, cyclePaneFocus, cyclePermission, cycleReasoning, drawerOpen, focusAfterDetails, focusChat, focusDetails, footerControls, launchPromptInBackground, modelState.provider, openHistorySearch, openModelRow, prompt, recallPromptHistory, refreshState, requestAppExit, rightOpen, selectFooterControl, setChatScrollOffset, submitPrompt, toggleDetailsPane, toggleSubagentsPane]);

  const chatPointFromMouse = useCallback((
    x: number | null,
    y: number | null,
    clampToChat: boolean,
  ): ChatSelectionPoint | null => {
    if (x == null || y == null) return null;
    const drawerWidth = drawerOpen ? DRAWER_PANE_WIDTH : 0;
    const textStartColumn = drawerWidth + 2;
    const textEndColumn = textStartColumn + Math.max(1, chatWrapWidth) - 1;
    const topRow = 2 + goalBannerRows;
    const bottomRow = topRow + Math.max(1, chatRowBudget) - 1;
    if (!clampToChat && (x < textStartColumn || x > textEndColumn || y < topRow || y > bottomRow)) {
      return null;
    }
    const visibleRow = Math.max(0, Math.min(y - topRow, Math.max(0, chatRowBudget - 1)));
    const column = Math.max(0, Math.min(x - textStartColumn, Math.max(0, chatWrapWidth - 1)));
    return chatSelectionPointFromVisibleRows(visibleChatSelectionRows, visibleRow, column, clampToChat);
  }, [chatRowBudget, chatWrapWidth, drawerOpen, goalBannerRows, visibleChatSelectionRows]);

  const chatSelectionEdgeFromMouseY = useCallback((y: number | null): ChatSelectionEdgeDirection | null => {
    const topRow = 2 + goalBannerRows;
    return chatSelectionEdgeDirectionForMouseY({
      y,
      topRow,
      rowBudget: chatRowBudget,
      scrollOffsetRows: chatScrollOffsetRowsRef.current,
      maxScrollOffsetRows: chatScrollMaxOffsetRef.current,
    });
  }, [chatRowBudget, goalBannerRows]);

  useInput((input, key) => {
    if (attachedTerminalIdRef.current) {
      if (input === "\x1d" || isTerminalControlToggle(input, key)) setAttachedTerminalId(null);
      return;
    }
    if (isTerminalControlToggle(input, key)) {
      const terminal = activeTerminalSession ?? activeTerminalSessionRef.current;
      if (
        terminal?.terminalId === activeSessionIdRef.current
        && terminal.status === "running"
        && terminalSessionProvider(terminal) === "claude"
      ) {
        focusChat();
        setAttachedTerminalId(terminal.terminalId);
      }
      return;
    }
    const mouse = parseTerminalMouseInput(input);
    if (mouse) {
      const activeSelection = chatMouseSelectionRef.current;
      if (mouse.kind === "click") {
        stopChatSelectionEdgeScroll();
        const point = chatPointFromMouse(mouse.x, mouse.y, false);
        if (point) {
          focusChat();
          const shiftAnchor = chatSelectionAnchorRef.current
            ?? (activeSelection ? { row: activeSelection.startRow, column: activeSelection.startColumn } : null);
          if (mouse.shift && shiftAnchor) {
            updateChatMouseSelection(chatSelectionFromAnchor(shiftAnchor, point, true));
          } else {
            chatSelectionAnchorRef.current = point;
            updateChatMouseSelection({
              startRow: point.row,
              startColumn: point.column,
              endRow: point.row,
              endColumn: point.column,
              active: true,
            });
          }
          return;
        }
        chatSelectionAnchorRef.current = null;
        if (activeSelection) updateChatMouseSelection(null);
      }
      if (mouse.kind === "drag" && activeSelection?.active) {
        const point = chatPointFromMouse(mouse.x, mouse.y, true);
        const edge = chatSelectionEdgeFromMouseY(mouse.y);
        if (edge) startChatSelectionEdgeScroll(edge, point?.column ?? activeSelection.endColumn);
        else stopChatSelectionEdgeScroll();
        if (point) {
          updateChatMouseSelection({
            ...activeSelection,
            endRow: point.row,
            endColumn: point.column,
            active: true,
          });
        }
        return;
      }
      if (mouse.kind === "release" && activeSelection?.active) {
        stopChatSelectionEdgeScroll();
        const point = chatPointFromMouse(mouse.x, mouse.y, true);
        const next = point
          ? {
              ...activeSelection,
              endRow: point.row,
              endColumn: point.column,
              active: false,
            }
          : { ...activeSelection, active: false };
        const collapsed = next.startRow === next.endRow && next.startColumn === next.endColumn;
        chatSelectionAnchorRef.current = { row: next.startRow, column: next.startColumn };
        updateChatMouseSelection(collapsed ? null : next);
        return;
      }

      const rightWidth = resolveRightPaneWidth(columns, rightOpen, drawerOpen);
      const drawerWidth = drawerOpen ? DRAWER_PANE_WIDTH : 0;
      const centerStart = drawerWidth + 1;
      const centerEnd = columns - rightWidth;
      const inCenterPane = mouse.x == null || (mouse.x >= centerStart && mouse.x <= centerEnd);
      const inTranscriptRows = mouse.y == null || mouse.y > 2;
      if (mouse.kind === "wheel" && inCenterPane && inTranscriptRows) {
        if (mouse.direction === "up") {
          setChatScrollOffset((offset) => offset + 3);
        } else if (mouse.direction === "down") {
          setChatScrollOffset((offset) => offset - 3);
        }
      } else if (
        mouse.kind === "click"
        && rightWidth > 0
        && rightPane.kind === "chat-info"
        && mouse.x != null
        && mouse.y != null
      ) {
        const rightStart = columns - rightWidth + 1;
        if (mouse.x >= rightStart) {
          const subagentPaneTop = 4 + goalBannerRows;
          const subagentContent = subagentPaneContentFromRightPane(rightPane);
          const nextIndex = subagentContent ? subagentIndexForPaneLine(subagentContent, mouse.y - subagentPaneTop, rightSelectionIndex) : null;
          if (nextIndex != null) {
            setRightSelectionIndex(nextIndex);
          }
          setRightOpen(true);
          setPaneFocus("details");
        }
      }
      return;
    }

    const pane = activePaneRef.current;
    const detailsFormActive = pane === "details" && rightOpen && rightPane.kind === "form";
    const footerActive = footerControlRef.current != null;
    const textInputActive = (pane === "chat" && !footerActive) || detailsFormActive;

    // Inline model row state machine. Lives above the chat-pane arrow handlers
    // so navigation events route here first when the row is focused.
    // Down arrow cycles values in the current cell; up arrow exits to prompt;
    // left/right moves between cells. Provider cell is skipped when chat is
    // already underway (providerLocked).
    if (inlineRowFocused) {
      const cell = inlineRowFocus.cell;
      if (key.upArrow) {
        setInlineRowFocus({ cell: null });
        return;
      }
      if (key.downArrow) {
        if (cell === "provider") cycleProvider(1);
        else if (cell === "model") cycleModel(1);
        else if (cell === "reasoning") cycleReasoning(1);
        else if (cell === "permission") cyclePermission(1);
        else if (cell === "subagents") openSubagentsPane();
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const fullOrder: Array<'provider' | 'model' | 'reasoning' | 'permission' | 'subagents'> = [
          "provider",
          "model",
          "reasoning",
          "permission",
          "subagents",
        ];
        const order = fullOrder.filter((entry) => {
          if (entry === "provider" && providerLockedRef.current) return false;
          if (entry === "subagents" && !subagentsButtonVisibleRef.current) return false;
          return true;
        });
        const idx = cell ? order.indexOf(cell) : 0;
        const delta = key.rightArrow ? 1 : -1;
        const safeIdx = idx < 0 ? 0 : idx;
        const nextCell = order[(safeIdx + delta + order.length) % order.length] ?? order[0] ?? "model";
        setInlineRowFocus({ cell: nextCell });
        return;
      }
      if (key.return) {
        if (cell === "subagents") {
          openSubagentsPane();
          return;
        }
        if (cell === "model" && activeTerminalSessionRef.current && modelStateRef.current.provider === "claude") {
          void sendClaudeModelCommandToTerminal()
            .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        }
        return;
      }
      if (key.escape) {
        setInlineRowFocus({ cell: null });
        return;
      }
      return;
    }

    if ((textInputActive || footerActive) && prompt.length > 0 && isPromptLineBackspace(input, key)) {
      if (footerActive) selectFooterControl(null);
      handlePromptChange(deletePreviousPromptLine(prompt));
      return;
    }
    if ((textInputActive || footerActive) && prompt.length > 0 && isPromptWordBackspace(input, key)) {
      if (footerActive) selectFooterControl(null);
      handlePromptChange(deletePreviousPromptWord(prompt));
      return;
    }
    if (textInputActive && key.return && key.shift) {
      handlePromptChange(`${prompt}\n`);
      return;
    }

    if (pane === "chat") {
      const pageUp = Boolean((key as { pageUp?: boolean }).pageUp);
      const pageDown = Boolean((key as { pageDown?: boolean }).pageDown);
      const home = Boolean((key as { home?: boolean }).home);
      const end = Boolean((key as { end?: boolean }).end);
      const paletteOpen = (activeMentionRange != null && mentionSuggestions.length > 0) || slashRows.length > 0;
      const pageRows = Math.max(1, chatRowBudget - 2);
      if (!paletteOpen && key.downArrow && effectiveChatScrollOffsetRows <= 0) {
        setInlineRowFocus({ cell: providerLockedRef.current ? "model" : "provider" });
        return;
      }
      if (pageUp || (key.ctrl && input === "u")) {
        setChatScrollOffset((offset) => offset + (key.ctrl ? Math.max(1, Math.floor(pageRows / 2)) : pageRows));
        return;
      }
      if (pageDown || (key.ctrl && input === "d")) {
        setChatScrollOffset((offset) => offset - (key.ctrl ? Math.max(1, Math.floor(pageRows / 2)) : pageRows));
        return;
      }
      if (home) {
        setChatScrollOffset(Number.MAX_SAFE_INTEGER);
        return;
      }
      if (end) {
        setChatScrollOffset(0);
        return;
      }
      if (activeMentionRange && mentionSuggestions.length) {
        if (key.upArrow) {
          setMentionIndex((index) => (index <= 0 ? mentionSuggestions.length - 1 : index - 1));
          return;
        }
        if (key.downArrow) {
          setMentionIndex((index) => (index + 1) % mentionSuggestions.length);
          return;
        }
        if (key.tab) {
          insertMention(mentionSuggestions[mentionIndex] ?? mentionSuggestions[0]!);
          return;
        }
      }
      if (slashRows.length) {
        if (key.upArrow) {
          setSlashIndex((index) => (index <= 0 ? slashRows.length - 1 : index - 1));
          return;
        }
        if (key.downArrow) {
          setSlashIndex((index) => (index + 1) % slashRows.length);
          return;
        }
        if (key.tab) {
          insertSlashCommand();
          return;
        }
      }
      if (!paletteOpen && (key.upArrow || key.downArrow)) {
        setChatScrollOffset((offset) => offset + (key.upArrow ? 1 : -1));
        return;
      }
    }
    const keybindingContext = pane === "details"
      ? rightPane.kind === "help" ? "Help" : "Select"
      : pane === "drawer" ? "Tabs" : "Chat";
    const keybindingAction = dispatchKeybinding(keybindings, keybindingContext, input, key, keybindingDispatchStateRef.current);
    if (keybindingAction === null) {
      return;
    }
    if (keybindingAction !== undefined && runKeybindingAction(keybindingAction)) {
      return;
    }
    if (pane === "chat" && textInputActive && key.return && key.meta && !key.ctrl && !key.shift) {
      void launchPromptInBackground(prompt);
      return;
    }
    const currentFormValues = (): Record<string, string> => {
      if (rightPane.kind !== "form") return formValues;
      const currentField = rightPane.fields[formFieldIndex] ?? rightPane.fields[0];
      return currentField ? { ...formValues, [currentField.name]: prompt } : formValues;
    };
    const formHasChanges = (values: Record<string, string>): boolean => {
      if (rightPane.kind !== "form") return false;
      return rightPane.fields.some((field) => (values[field.name] ?? "") !== (field.initialValue ?? ""));
    };

    if (key.tab && key.shift) {
      cyclePermission(1);
      return;
    }

    if (key.tab && !key.shift) {
      cyclePaneFocus();
      return;
    }

    if (key.ctrl && input === "o") {
      toggleDrawerPane();
      return;
    }

    if (key.ctrl && input === "l" && pane === "chat") {
      setClearedAt(new Date().toISOString());
      eventDedupKeysRef.current.clear();
      eventDedupKeyOrderRef.current = [];
      eventCountRef.current = 0;
      setEvents([]);
      setChatScrollOffset(0);
      addNotice("Viewport cleared. Durable chat history is unchanged.", "info");
      return;
    }

    if (key.ctrl && input === "p") {
      toggleDetailsPane();
      return;
    }

    if (key.ctrl && input === "a") {
      toggleSubagentsPane();
      return;
    }

    if (footerActive) {
      if (key.leftArrow || key.rightArrow) {
        cycleFooterControl(key.rightArrow ? 1 : -1);
        return;
      }
      if (key.upArrow) {
        selectFooterControl(null);
        setInlineRowFocus({ cell: providerLockedRef.current ? "model" : "provider" });
        return;
      }
      if (key.escape) {
        selectFooterControl(null);
        return;
      }
      if (key.return) {
        if (footerControlRef.current === "drawer") {
          toggleDrawerPane();
        } else if (footerControlRef.current === "agents") {
          toggleSubagentsPane();
        } else {
          toggleDetailsPane();
        }
        return;
      }
      if (key.backspace || key.delete) {
        selectFooterControl(null);
        handlePromptChange(prompt.slice(0, -1));
        return;
      }
      if (!key.ctrl && input) {
        const suffix = printableInput(input);
        if (suffix) {
          selectFooterControl(null);
          handlePromptChange(`${prompt}${suffix}`);
        }
        return;
      }
    }

    if (pane === "chat" && textInputActive && key.ctrl && input === "r") {
      openHistorySearch();
      return;
    }

    if (pane === "chat" && textInputActive && key.ctrl && input === "v") {
      attachClipboardImage();
      return;
    }

    if (pane === "chat" && textInputActive && key.ctrl && input === "g") {
      const edited = editPromptInExternalEditor(prompt);
      if (edited == null) {
        addNotice("External editor exited without updating the prompt.", "error");
      } else {
        handlePromptChange(edited);
        focusChat();
        addNotice("Loaded prompt from external editor.", "success");
      }
      return;
    }

    if (
      pane === "chat"
      && textInputActive
      && !key.ctrl
      && !key.meta
      && prompt.length === 0
      && !activeMentionRange
      && !slashRows.length
      && (key.upArrow || key.downArrow)
    ) {
      recallPromptHistory(key.upArrow ? "previous" : "next");
      return;
    }

    if (key.escape && chatMouseSelectionRef.current) {
      stopChatSelectionEdgeScroll();
      chatSelectionAnchorRef.current = null;
      updateChatMouseSelection(null);
      return;
    }

    if (pane === "chat" && textInputActive && vimModeEnabled && !key.ctrl && !key.meta) {
      if (key.escape) {
        setVimMode("normal");
        return;
      }
      if (vimMode === "normal") {
        if (input === "i" || input === "a") {
          setVimMode("insert");
          return;
        }
        if (input === ":" || input === "/") {
          handlePromptChange("/");
          setVimMode("insert");
          return;
        }
        if (input === "k" || key.upArrow) {
          recallPromptHistory("previous");
          return;
        }
        if (input === "j" || key.downArrow) {
          recallPromptHistory("next");
          return;
        }
        if (key.return) {
          void submitPrompt(prompt);
          return;
        }
        return;
      }
    }

    if (key.escape) {
      // First Esc unwinds a subagent transcript back to the main chat; the
      // right pane stays focused on the main agent's info, so a second Esc
      // would close the pane normally.
      if (
        pane === "details"
        && rightOpen
        && rightPane.kind === "chat-info"
        && inspectedSubagentId
      ) {
        setInspectedSubagentId(null);
        setChatScrollOffset(0);
        return;
      }
      if (pane === "details" && rightOpen) {
        if (rightPane.kind === "form") {
          const values = currentFormValues();
          if (formHasChanges(values) && !formDiscardArmed) {
            setFormValues(values);
            setFormDiscardArmed(true);
            addNotice("Press Esc again to discard this form.", "info");
            return;
          }
          setFormDiscardArmed(false);
          setFormValues({});
          setFormFieldIndex(0);
          setPrompt("");
          setRightPane({ kind: "empty" });
        }
        setRightOpen(false);
        lastUserOpenedPaneRef.current = null;
        userDismissedRightPaneRef.current = true;
        focusAfterDetails();
        return;
      }
      if (pane === "drawer") {
        if (drawerSection === "chats") {
          setDrawerSection("lanes");
          setSelectedDrawerChatAction(null);
          setSelectedDrawerChatId(null);
          return;
        }
        setDrawerOpen(false);
        focusChat();
        return;
      }
      const conn = connectionRef.current;
      const sessionId = activeSessionIdRef.current;
      const activeTurnVisible = streaming || activeSession?.status === "active";
      if (pane === "chat" && activeTurnVisible && conn && sessionId) {
        setStreaming(false);
        setInterrupted(true);
        void interruptChat(conn, sessionId)
          .then(() => addNotice("Interrupted chat.", "info"))
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        return;
      }
      setPrompt("");
      return;
    }

    if (key.meta && input.toLowerCase() === "c") {
      copyChatSelection();
      return;
    }

    if ((key.ctrl && input === "c") || input === "\x03") {
      if (isCtrlCCopyPlatform() && isChatTextSelectionRange(chatMouseSelectionRef.current)) {
        copyChatSelection();
        return;
      }
      const conn = connectionRef.current;
      const sessionId = activeSessionIdRef.current;
      const activeTurnVisible = streaming || activeSession?.status === "active";
      if (activeTurnVisible && conn && sessionId) {
        setStreaming(false);
        setInterrupted(true);
        void interruptChat(conn, sessionId)
          .then(() => addNotice("Interrupted chat.", "info"))
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        return;
      }
      requestCtrlCExit();
      return;
    }

    if (pendingApproval?.mode === "approval" && !pendingApproval.highStakes && (input === "a" || input === "d")) {
      void resolvePendingApproval(pendingApproval, input === "a" ? "accept" : "decline")
        .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
      return;
    }

    if (pane === "details" && rightOpen && rightPane.kind === "form" && (key.upArrow || key.downArrow || key.return)) {
      const fields = rightPane.fields;
      const nextValues = currentFormValues();
      if (key.return) {
        if (prompt.trim().startsWith("/")) {
          void submitPrompt(prompt);
        } else {
          setFormDiscardArmed(false);
          void submitRightForm(rightPane, nextValues)
            .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        }
        return;
      }
      const delta = key.upArrow ? -1 : 1;
      const nextIndex = fields.length ? (formFieldIndex + delta + fields.length) % fields.length : 0;
      setFormValues(nextValues);
      setFormFieldIndex(nextIndex);
      setPrompt(fields[nextIndex] ? nextValues[fields[nextIndex]!.name] ?? "" : "");
      return;
    }

    if (
      pane === "details"
      && rightOpen
      && rightPane.kind === "chat-info"
      && (key.upArrow || key.downArrow || key.return)
    ) {
      const subagentContent = subagentPaneContentFromRightPane(rightPane);
      if (!subagentContent) return;
      const snapshotRows = buildSubagentPaneRows(subagentContent)
        .filter((row): row is Extract<SubagentPaneRow, { kind: "snapshot" }> => row.kind === "snapshot");
      // Selection: 0 = main row; 1..N = subagent rows.
      const selectableCount = snapshotRows.length + 1;
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        setRightSelectionIndex((index) => (index + delta + selectableCount) % selectableCount);
        return;
      }
      if (key.return) {
        const row = rightSelectionIndex > 0 ? snapshotRows[rightSelectionIndex - 1] : null;
        const snapshot: SubagentSnapshot | null = row ? row.snapshot : null;
        setInspectedSubagentId(snapshot?.id ?? null);
        setChatScrollOffset(0);
        return;
      }
      return;
    }

    if (
      pane === "details"
      && rightOpen
      && (rightPane.kind === "new-chat-setup" || rightPane.kind === "model-setup")
      && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.return)
    ) {
      const rows = rightPane.rows;
      const totalRows = rows.length;
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        setRightSelectionIndex((index) => totalRows ? (index + delta + totalRows) % totalRows : 0);
        return;
      }
      if (key.return) {
        // Enter on the model row opens the rich picker (favorites/recents/providers).
        // Other rows still fall through to "apply" for parity with the prior flow.
        const focusedRow = rows[rightSelectionIndex];
        if (focusedRow?.kind === "model" && !focusedRow.disabled) {
          openModelPicker({ surface: "new-chat" });
          return;
        }
        const applyRow = rows.find((entry) => entry.kind === "apply");
        if (applyRow) handleSetupRow(applyRow, 1);
        return;
      }
      if (rightSelectionIndex >= rows.length) {
        return;
      }
      const row = rows[rightSelectionIndex] ?? rows[0];
      if (!row) return;
      handleSetupRow(row, key.leftArrow ? -1 : 1);
      return;
    }

    if (pane === "details" && rightOpen && rightPane.kind === "model-picker") {
      const picker = rightPane;
      // Re-derive layout each keystroke so we never select stale indexes.
	      const layout = buildModelPickerLayout({
	        models,
	        catalog: modelCatalogRef.current ?? modelCatalog,
	        favorites: modelPickerFavorites,
	        recents: modelPickerRecents,
	        activeModelId: modelState.modelId,
	        query: picker.query,
	        selection: picker.selection,
	        providerTabKey: picker.providerTabKey ?? null,
	        focusedIndex: picker.focusedIndex,
	        searchMode: picker.searchMode,
	      });

      if (key.escape) {
        if (picker.query.length) {
          setRightPane({ ...picker, query: "", searchMode: false, focusedIndex: 0 });
          return;
        }
        if (picker.surface === "new-chat") {
          const laneId = activeLaneIdRef.current;
          const lane = laneId ? lanes.find((entry) => entry.id === laneId) : null;
          if (lane) {
            setRightPane({
              kind: "new-chat-setup",
              laneId: lane.id,
              laneLabel: lane.name,
              rows: newChatSetupRows,
            });
            setRightOpen(true);
            setPaneFocus("details");
            return;
          }
        }
        setRightPane({ kind: "empty" });
        setRightOpen(false);
        setPaneFocus("chat");
        return;
      }
      if (key.upArrow) {
        const next = Math.max(0, layout.focusedIndex - 1);
        setRightPane({ ...picker, focusedIndex: next });
        return;
      }
      if (key.downArrow) {
        const next = Math.min(Math.max(0, layout.entries.length - 1), layout.focusedIndex + 1);
        setRightPane({ ...picker, focusedIndex: next });
        return;
      }
      if (key.tab || (key.shift && key.tab)) {
        const total = layout.railEntries.length;
        if (total === 0) return;
        const delta = key.shift ? -1 : 1;
        const nextIndex = (layout.railIndex + delta + total) % total;
        const nextEntry = layout.railEntries[nextIndex];
        if (!nextEntry) return;
	        const nextSelection =
	          nextEntry.kind === "favorites"
	            ? ({ kind: "favorites" } as const)
	            : nextEntry.kind === "recents"
	              ? ({ kind: "recents" } as const)
	              : ({ kind: "provider", provider: nextEntry.provider } as const);
	        if (nextSelection.kind === "provider") {
	          const refreshProvider =
	            nextSelection.provider === "opencode" || nextSelection.provider === "cursor" || nextSelection.provider === "droid"
	            || nextSelection.provider === "lmstudio" || nextSelection.provider === "ollama"
	              ? nextSelection.provider
	              : null;
	          if (refreshProvider) void refreshModelCatalog({ refreshProvider });
	        }
	        setRightPane({
	          ...picker,
	          selection: nextSelection,
	          providerTabKey: null,
	          focusedIndex: 0,
	          query: "",
          searchMode: false,
        });
        return;
      }
	      if (key.return) {
	        const target = layout.entries[layout.focusedIndex];
	        if (target?.isAvailable) commitModelPickerSelection(target.modelId);
	        return;
	      }
	      if ((input === "[" || input === "]") && layout.providerTabs.length > 1) {
	        const delta = input === "[" ? -1 : 1;
	        const nextIndex = (layout.providerTabIndex + delta + layout.providerTabs.length) % layout.providerTabs.length;
	        const nextTab = layout.providerTabs[nextIndex];
	        if (nextTab) {
	          setRightPane({ ...picker, providerTabKey: nextTab.key, focusedIndex: 0 });
	        }
	        return;
	      }
      // 'f' toggles favorite on focused row when not actively editing a search.
      if (input === "f" && !picker.searchMode && !key.ctrl && !key.meta) {
        const target = layout.entries[layout.focusedIndex];
        if (target) toggleModelPickerFavoriteId(target.modelId);
        return;
      }
      // '/' enters search mode — clears any previous query.
      if (input === "/" && !picker.searchMode) {
        setRightPane({ ...picker, searchMode: true, query: "", focusedIndex: 0 });
        return;
      }
      // Backspace shortens the active query; if empty, exit search mode.
      if (key.backspace || key.delete) {
        if (!picker.searchMode && !picker.query.length) return;
        const nextQuery = picker.query.slice(0, -1);
        setRightPane({
          ...picker,
          query: nextQuery,
          searchMode: nextQuery.length > 0,
          focusedIndex: 0,
        });
        return;
      }
      // Plain printable input either starts or extends the query.
      if (
        typeof input === "string"
        && input.length === 1
        && !key.ctrl
        && !key.meta
        && input >= " "
      ) {
        setRightPane({
          ...picker,
          query: picker.query + input,
          searchMode: true,
          focusedIndex: 0,
        });
        return;
      }
      return;
    }

    if (pane === "details" && rightOpen && rightPane.kind === "lane-details") {
      const laneDetails = rightPane;
      const worktreeMissing = laneDetails.worktreeAvailable === false;
      const maxIndex = worktreeMissing ? 0 : LANE_DETAIL_ACTIONS.length - 1 + (laneDetails.pr ? 1 : 0);
      if (key.upArrow) {
        setRightPane((prev) => prev.kind === "lane-details"
          ? { ...prev, selectedActionIndex: Math.max(0, prev.selectedActionIndex - 1) }
          : prev);
        return;
      }
      if (key.downArrow) {
        setRightPane((prev) => prev.kind === "lane-details"
          ? { ...prev, selectedActionIndex: Math.min(maxIndex, prev.selectedActionIndex + 1) }
          : prev);
        return;
      }
      if (input === "t" && !key.ctrl && !key.meta) {
        setRightPane((prev) => prev.kind === "lane-details" ? { ...prev, showFiles: !prev.showFiles } : prev);
        return;
      }
      if (key.return) {
        if (worktreeMissing) {
          addNotice(laneWorktreeUnavailableMessage(laneDetails.lane) ?? "Lane worktree is unavailable.", "error");
          return;
        }
        const index = laneDetails.selectedActionIndex;
        if (index < LANE_DETAIL_ACTIONS.length) {
          const action = LANE_DETAIL_ACTIONS[index];
          if (action) {
            const text = action.slashCommand === "/commit" ? `${action.slashCommand} ` : action.slashCommand;
            setPrompt(text);
            promptRef.current = text;
            chatDraftRef.current = text;
            focusChat();
          }
          return;
        }
        if (laneDetails.pr) {
          const url = laneDetails.pr.url;
          const bridge = (globalThis as { window?: { ade?: { app?: { openExternal?: (url: string) => unknown } } } }).window;
          const opener = bridge?.ade?.app?.openExternal;
          if (typeof opener === "function") {
            try {
              opener(url);
              addNotice("Opening PR in browser…", "info");
              return;
            } catch {
              // fall through to platform open
            }
          }
          if (process.platform === "darwin" && url) {
            spawn("open", [url], { stdio: "ignore", detached: true }).unref();
            addNotice("Opening PR in browser…", "info");
            return;
          }
          if (process.platform === "linux" && url) {
            spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
            addNotice("Opening PR in browser…", "info");
            return;
          }
          setPrompt("/pr open");
          promptRef.current = "/pr open";
          void submitPrompt("/pr open");
          return;
        }
        return;
      }
    }

    if (pane === "details" && rightOpen && rightPane.kind === "list" && rightPane.action && key.upArrow) {
      const max = rightPane.rows.length;
      setRightSelectionIndex((index) => (index <= 0 ? Math.max(0, max - 1) : index - 1));
      return;
    }
    if (pane === "details" && rightOpen && rightPane.kind === "list" && rightPane.action && key.downArrow) {
      const max = rightPane.rows.length;
      setRightSelectionIndex((index) => (max > 0 ? (index + 1) % max : 0));
      return;
    }
    if (pane === "details" && rightOpen && rightPane.kind === "list" && rightPane.action && key.return) {
      const selectedId = rightPane.action.ids[rightSelectionIndex] ?? rightPane.action.ids[0] ?? null;
      if (!selectedId) return;
      if (rightPane.action.kind === "switch-lane") {
        const lane = lanes.find((entry) => entry.id === selectedId);
        if (!lane) return;
        selectActiveLaneId(lane.id);
        setDrawerLaneId(lane.id);
        setSelectedDrawerLaneId(lane.id);
        const session = newestSession(displaySessions.filter((entry) => entry.laneId === lane.id));
        selectActiveSessionId(session?.sessionId ?? null);
        setSelectedDrawerChatId(session?.sessionId ?? null);
        addNotice(`Switched to lane ${lane.name}.`, "success");
        return;
      }
      const session = displaySessions.find((entry) => entry.sessionId === selectedId);
      if (!session) return;
      selectActiveLaneId(session.laneId);
      setDrawerLaneId(session.laneId);
      setSelectedDrawerLaneId(session.laneId);
      selectActiveSessionId(session.sessionId);
      setSelectedDrawerChatId(session.sessionId);
      addNotice(`Switched to chat ${session.title ?? session.sessionId}.`, "success");
      return;
    }

    const pageUp = Boolean((key as { pageUp?: boolean }).pageUp);
    const pageDown = Boolean((key as { pageDown?: boolean }).pageDown);
    const home = Boolean((key as { home?: boolean }).home);
    const end = Boolean((key as { end?: boolean }).end);
    if (pane === "chat" && !activeMentionRange && !slashRows.length) {
      const pageRows = Math.max(1, chatRowBudget - 2);
      if (pageUp || (key.ctrl && input === "u")) {
        setChatScrollOffset((offset) => offset + (key.ctrl ? Math.max(1, Math.floor(pageRows / 2)) : pageRows));
        return;
      }
      if (pageDown || (key.ctrl && input === "d")) {
        setChatScrollOffset((offset) => offset - (key.ctrl ? Math.max(1, Math.floor(pageRows / 2)) : pageRows));
        return;
      }
      if (home) {
        setChatScrollOffset((offset) => Math.max(offset, 100_000));
        return;
      }
      if (end) {
        setChatScrollOffset(0);
        return;
      }
      if (!prompt.trim() && key.upArrow) {
        recallPromptHistory("previous");
        return;
      }
      if (!prompt.trim() && key.downArrow) {
        recallPromptHistory("next");
        return;
      }
    }

    if (pane === "chat" && key.upArrow && activeMentionRange && mentionSuggestions.length) {
      setMentionIndex((index) => (index <= 0 ? mentionSuggestions.length - 1 : index - 1));
      return;
    }
    if (pane === "chat" && key.downArrow && activeMentionRange && mentionSuggestions.length) {
      setMentionIndex((index) => (index + 1) % mentionSuggestions.length);
      return;
    }
    if (pane === "chat" && key.tab && activeMentionRange && mentionSuggestions.length) {
      insertMention(mentionSuggestions[mentionIndex] ?? mentionSuggestions[0]!);
      return;
    }
    if (pane === "chat" && key.upArrow && slashRows.length) {
      setSlashIndex((index) => (index <= 0 ? slashRows.length - 1 : index - 1));
      return;
    }
    if (pane === "chat" && key.downArrow && slashRows.length) {
      setSlashIndex((index) => (index + 1) % slashRows.length);
      return;
    }
    if (pane === "chat" && key.tab && slashRows.length) {
      insertSlashCommand();
      return;
    }
    if (pane === "chat" && key.downArrow && !activeMentionRange && !slashRows.length) {
      setInlineRowFocus({ cell: providerLockedRef.current ? "model" : "provider" });
      setPaneFocus("chat");
      return;
    }

    if (pane === "drawer" && drawerOpen && key.tab) {
      setDrawerSection((section) => section === "lanes" ? "chats" : "lanes");
      return;
    }
    if (pane === "drawer" && drawerOpen && key.upArrow) {
      if (drawerSection === "lanes") {
        const nextIndex = Math.max(0, selectedLaneIndex - 1);
        const lane = drawerLaneRows[nextIndex] ?? null;
        if (lane) {
          setSelectedDrawerLaneAction(null);
          setSelectedDrawerLaneId(lane.id);
          setDrawerLaneId(lane.id);
          selectActiveLaneId(lane.id);
          applyDrawerChatSelection({ session: null, action: null });
        }
      } else {
        if (selectedChatIndex === 0 && selectedDrawerChatAction !== "new-chat") {
          setDrawerSection("lanes");
          setSelectedDrawerChatAction(null);
          setSelectedDrawerChatId(null);
          applyDrawerChatSelection({ session: null, action: null });
          return;
        }
        const nextIndex = Math.max(0, selectedChatIndex - 1);
        const session = drawerVisibleLaneSessions[nextIndex] ?? null;
        const action: DrawerChatAction | null = session ? null : "new-chat";
        setSelectedDrawerChatAction(action);
        setSelectedDrawerChatId(session?.sessionId ?? null);
        applyDrawerChatSelection({ session, action });
      }
      return;
    }
    if (pane === "drawer" && drawerOpen && key.downArrow) {
      if (drawerSection === "lanes") {
        if (selectedDrawerLaneAction === "new-lane" || selectedLaneIndex >= drawerLaneRows.length) {
          // fall through to new-lane row handling below
        } else {
          const lane = drawerLaneRows[selectedLaneIndex] ?? null;
          if (lane && !unavailableLaneIds.has(lane.id)) {
            enterDrawerChatListForLane(lane);
            return;
          }
        }
        const nextIndex = Math.min(drawerLaneRows.length, selectedLaneIndex + 1);
        const lane = drawerLaneRows[nextIndex] ?? null;
        if (lane) {
          setSelectedDrawerLaneAction(null);
          setSelectedDrawerLaneId(lane.id);
          setDrawerLaneId(lane.id);
          selectActiveLaneId(lane.id);
          applyDrawerChatSelection({ session: null, action: null });
        } else if (drawerLaneRows.length > 0) {
          setSelectedDrawerLaneAction("new-lane");
          setSelectedDrawerLaneId(null);
        }
      } else {
        const atChatBottom = selectedDrawerChatAction === "new-chat"
          || selectedChatIndex >= drawerVisibleLaneSessions.length;
        if (atChatBottom) {
          setDrawerSection("lanes");
          setSelectedDrawerChatAction(null);
          setSelectedDrawerChatId(null);
          applyDrawerChatSelection({ session: null, action: null });
          const nextLaneIndex = Math.min(drawerLaneRows.length, selectedLaneIndex + 1);
          const lane = drawerLaneRows[nextLaneIndex] ?? null;
          if (lane) {
            setSelectedDrawerLaneAction(null);
            setSelectedDrawerLaneId(lane.id);
            setDrawerLaneId(lane.id);
            selectActiveLaneId(lane.id);
          } else if (drawerLaneRows.length > 0) {
            setSelectedDrawerLaneAction("new-lane");
            setSelectedDrawerLaneId(null);
          }
          return;
        }
        const nextIndex = Math.min(drawerVisibleLaneSessions.length, selectedChatIndex + 1);
        const session = drawerVisibleLaneSessions[nextIndex] ?? null;
        const action: DrawerChatAction | null = session ? null : "new-chat";
        setSelectedDrawerChatAction(action);
        setSelectedDrawerChatId(session?.sessionId ?? null);
        applyDrawerChatSelection({ session, action });
      }
      return;
    }
    if (pane === "drawer" && drawerOpen && key.return) {
      if (drawerSection === "lanes") {
        if (selectedDrawerLaneAction === "new-lane" || selectedLaneIndex >= drawerLaneRows.length) {
          openNewLaneForm();
          return;
        }
        const lane = drawerLaneRows[selectedLaneIndex];
        if (lane) {
          selectActiveLaneId(lane.id);
          setDrawerLaneId(lane.id);
          setSelectedDrawerLaneId(lane.id);
          setSelectedDrawerLaneAction(null);
          const unavailableMessage = laneWorktreeUnavailableMessage(lane);
          if (unavailableMessage) {
            setDraftChatMode(false);
            selectActiveSessionId(null);
            setSelectedDrawerChatId(null);
            setSelectedDrawerChatAction(null);
            setRightPane(seedLaneDetails(lane, false));
            setRightOpen(true);
            addNotice(unavailableMessage, "error");
            return;
          }
          const laneSessions = displaySessions.filter((entry) => entry.laneId === lane.id);
          const lastSessionId = lastChatByLaneRef.current.get(lane.id);
          const session =
            laneSessions.find((s) => s.sessionId === lastSessionId)
            ?? newestSession(laneSessions);
          setSelectedDrawerChatId(session?.sessionId ?? null);
          setSelectedDrawerChatAction(session ? null : "new-chat");
          setDrawerSection("chats");
          applyDrawerChatSelection({
            session: session ?? null,
            action: session ? null : "new-chat",
          });
        }
      } else {
        if (selectedDrawerChatAction === "new-chat" || selectedChatIndex >= drawerVisibleLaneSessions.length) {
          openNewChatSetup();
          setRightOpen(true);
          return;
        }
        focusChat();
      }
      return;
    }

    if (pane === "drawer" && drawerOpen && !key.ctrl && !key.meta && input) {
      const suffix = printableInput(input);
      if (suffix) {
        const draft = `${chatDraftRef.current}${suffix}`;
        focusChat();
        chatDraftRef.current = draft;
        promptRef.current = draft;
        setPrompt(draft);
      }
      return;
    }

    if (pane === "chat" && key.return && !prompt.trim() && latestFailedLineId && !pendingApproval && rightPane.kind !== "form" && !slashRows.length) {
      setExpandedLineIds((prev) => {
        const next = new Set(prev);
        if (next.has(latestFailedLineId)) next.delete(latestFailedLineId);
        else next.add(latestFailedLineId);
        return next;
      });
      return;
    }
    if (
      pane === "chat"
      && !prompt.trim()
      && !pendingApproval
      && rightPane.kind !== "form"
      && !slashRows.length
      && key.ctrl
      && !key.meta
      && input === "h"
    ) {
      openLatestImage();
      return;
    }
    const linePrefix = inputBeforeLineBreak(input);
    if (textInputActive && linePrefix != null && !key.return) {
      const suffix = printablePromptInput(input);
      if (suffix) handlePromptChange(`${prompt}${suffix}`);
      return;
    }
    if (textInputActive && key.return) {
      void submitPrompt(prompt);
      return;
    }
    if (textInputActive && (key.backspace || key.delete)) {
      handlePromptChange(prompt.slice(0, -1));
      return;
    }
    if (textInputActive && !key.ctrl && input) {
      const suffix = printableInput(input);
      if (suffix) handlePromptChange(`${prompt}${suffix}`);
    }
  });

  const handlePromptChange = useCallback((value: string) => {
    setFormDiscardArmed(false);
    if (activePaneRef.current === "chat" && value === "?") {
      setRightPane({ kind: "help", title: "Help" });
      focusDetails();
      setPrompt("");
      return;
    }
    if (activePaneRef.current === "chat") {
      chatDraftRef.current = value;
    }
    if (activePaneRef.current === "details" && rightPane.kind === "form" && activeFormField) {
      setFormValues((prev) => ({ ...prev, [activeFormField.name]: value }));
    }
    setPrompt(value);
  }, [activeFormField, focusDetails, rightPane]);

  const attachedImageChips = useMemo(() => {
    return selectedMentions
      .filter((mention) => (
        mention.kind === "file"
        && mention.filePath
        && isImageFilePath(mention.filePath)
        && (mention.attachment || prompt.includes(mention.insertText))
      ))
      .map((mention) => {
        const dimensions = mention.filePath ? readImageDimensions(mention.filePath) : null;
        return {
          key: mention.filePath ?? mention.insertText,
          label: mention.label,
          dimensions: dimensions ? `${dimensions.width}x${dimensions.height}` : null,
        };
      });
  }, [prompt, selectedMentions]);

  const rightPaneVisible = rightPaneWidth > 0;
  const laneName = activeLane?.name ?? "main";
  // When the cursor is in the inline model row, the prompt box loses its
  // focused outline so the user can see the row took over.
  const promptFocused = !inlineRowFocused
    && ((activePane === "chat" && footerControl == null) || (activePane === "details" && rightPane.kind === "form"));
  const drawerFooterSelected = footerControl === "drawer";
  const detailsFooterSelected = footerControl === "details";
  const agentsFooterSelected = footerControl === "agents";
  const rightPaneShowsAgents = rightPaneVisible && rightPane.kind === "chat-info";
  const showMentionPalette = activeMentionRange != null && mentionSuggestions.length > 0;
  const showSlashPalette = prompt.startsWith("/") && slashRows.length > 0;
  const modelStatusOverlayRows = statusRows
    + (draftChatActive || (vimModeEnabled && !hideVimModeIndicator) || modelState.codexFastMode ? 1 : 0);
  const paletteBottomRows = 5
    + (promptRows.length - 1)
    + modelStatusOverlayRows
    + (attachedImageChips.length ? 1 : 0)
    + (error ? 1 : 0);
  const paletteOverlayRows = showMentionPalette ? MENTION_PALETTE_ROWS : SLASH_PALETTE_ROWS;
  const paletteOverlayTop = Math.max(1, rows - paletteBottomRows - paletteOverlayRows);
  const paletteOverlayLeft = drawerOpen ? DRAWER_PANE_WIDTH : 0;
  const paletteOverlayWidth = Math.max(MIN_CENTER_PANE_WIDTH, centerWidth);

  if (error && !connection) {
    return (
      <Box flexDirection="column">
        <Text color="red">ade-code failed to start</Text>
        <Text>{error}</Text>
      </Box>
    );
  }

  return (
    <SpinTickProvider active={spinTickActive}>
      <Box flexDirection="column" height={rows}>
        <Header
          projectName={projectName}
          lane={activeLane}
          chatTitle={draftChatActive ? "New chat" : activeTerminalSession?.title ?? activeSession?.title ?? activeSession?.goal ?? activeSession?.summary ?? null}
        />
        {goalBannerText ? (
          <Box paddingX={1} flexShrink={0}>
            <Text color={theme.color.warning} wrap="truncate-end">{goalBannerText}</Text>
            {streaming ? <Text color={theme.color.mutedFg} dimColor>{" · streaming"}</Text> : null}
          </Box>
        ) : null}
        <Box flexGrow={1} minHeight={8}>
          {drawerOpen ? (
            <Drawer
              lanes={lanes}
              sessions={displaySessions}
              activeLaneId={activeLaneId}
              activeSessionId={activeSessionId}
              browsingLaneId={drawerLaneId ?? activeLaneId}
              selectedLaneIndex={selectedLaneIndex}
              selectedChatIndex={drawerSection === "chats" ? selectedChatIndex : -1}
              panelHeight={rows}
              focused={activePane === "drawer"}
              mode={drawerSection}
              loading={mode === "connecting" || lanes.length === 0}
              prByLaneId={prByLaneId}
              diffByLaneId={diffByLaneId}
              unavailableLaneIds={unavailableLaneIds}
            />
          ) : null}
          <Box width={centerWidth} flexDirection="column">
            {pendingApproval?.highStakes ? (
              <ApprovalPrompt approval={pendingApproval} modal />
            ) : activeTerminalSession ? (
              <TerminalPane
                title={activeTerminalSession.title}
                preview={terminalPreview}
                liveChunks={terminalLiveChunks[activeTerminalSession.terminalId] ?? []}
                attached={attachedTerminalId === activeTerminalSession.terminalId}
                width={terminalPaneWidth}
                height={chatRowBudget}
                hiddenBottomRows={CLAUDE_TERMINAL_HIDDEN_INPUT_ROWS}
              />
            ) : (
              <>
                <ChatView
                  events={displayEvents}
                  notices={displayNotices}
                  activeSession={activeSession}
                  projectName={projectName}
                  laneName={laneName}
                  lane={activeLane}
                  provider={modelState.provider}
                  modelDisplay={modelState.displayName}
                  streaming={displayStreaming}
                  interrupted={displayInterrupted}
                  worktreeAvailable={!activeLane || !unavailableLaneIds.has(activeLane.id)}
                  expandedLineIds={expandedLineIds}
                  maxRows={chatRowBudget}
                  scrollOffsetRows={effectiveChatScrollOffsetRows}
                  unseenMessageCount={unseenMessageCount}
                  selection={chatMouseSelection}
                  width={chatWrapWidth}
                />
                <ApprovalPrompt approval={pendingApproval} />
              </>
            )}
          </Box>
          {rightPaneVisible ? (
            <RightPane
              content={rightPane}
              formValues={formValues}
              activeFormField={formFieldIndex}
              selectedIndex={rightSelectionIndex}
              focused={activePane === "details"}
              activeProvider={activeCommandProvider as AdeCodeProvider}
              width={rightPaneWidth}
	              modelPickerInputs={{
	                models,
	                catalog: modelCatalog,
	                favorites: modelPickerFavorites,
                recents: modelPickerRecents,
                activeModelId: modelState.modelId,
              }}
            />
          ) : null}
        </Box>
        {showMentionPalette ? (
          <Box position="absolute" marginTop={paletteOverlayTop} marginLeft={paletteOverlayLeft}>
            <MentionPalette
              suggestions={mentionSuggestions}
              selectedIndex={mentionIndex}
              query={activeMentionRange?.query ?? ""}
              width={paletteOverlayWidth}
            />
          </Box>
        ) : null}
        {!showMentionPalette && showSlashPalette ? (
          <Box position="absolute" marginTop={paletteOverlayTop} marginLeft={paletteOverlayLeft}>
            <SlashPalette
              query={prompt}
              userCommands={slashCommands}
              selectedIndex={slashIndex}
              provider={activeCommandProvider}
              width={paletteOverlayWidth}
            />
          </Box>
        ) : null}
        {error ? <Text color="red">{error}</Text> : null}
        {attachedImageChips.length ? (
          <Box paddingX={1} flexShrink={0} flexDirection="row" flexWrap="wrap">
            {attachedImageChips.map((chip) => (
              <Box key={chip.key} marginRight={1}>
                <Text color={theme.color.accent}>▣ </Text>
                <Text>{chip.label}</Text>
                {chip.dimensions ? <Text color={theme.color.mutedFg} dimColor>{` ${chip.dimensions}`}</Text> : null}
              </Box>
            ))}
          </Box>
        ) : null}
        {modeChangeNotice ? (
          <Box paddingX={1} borderStyle="single" borderColor={modeAccentColor(modeChangeNotice.summary)} flexShrink={0}>
            <Text color={modeAccentColor(modeChangeNotice.summary)} bold>{modeChangeNotice.summary} mode</Text>
            <Text color={theme.color.t3}>{` · ${modeDescription(modeChangeNotice.summary)}`}</Text>
          </Box>
        ) : null}
        <Box
          borderStyle="round"
          borderColor={isPlanMode(modelState) ? theme.color.planMode : (promptFocused ? PURPLE : theme.color.border)}
          paddingX={1}
          flexShrink={0}
          flexDirection="column"
          width={promptPaneWidth}
        >
          {promptRows.map((line, index) => {
            const last = index === promptRows.length - 1;
            return (
              <Box key={`${index}:${line}`} flexDirection="row">
                <Text color={PURPLE}>{index === 0 ? "› " : "  "}</Text>
                <Text>{line}</Text>
                {last ? <Text inverse> </Text> : null}
                {index === 0 && !prompt ? <Text color={theme.color.mutedFg} dimColor>{"  ^V paste image"}</Text> : null}
                {last && streaming && !goalBannerText ? <Text color={theme.color.mutedFg} dimColor>{"  · streaming"}</Text> : null}
              </Box>
            );
          })}
        </Box>
        <ModelStatus
          draftChatActive={draftChatActive}
          statusLineText={statusLineText}
          vimMode={vimModeEnabled && !hideVimModeIndicator ? vimMode : null}
        />
        <FooterControls
          provider={modelState.provider}
          modelDisplay={modelState.displayName}
          reasoningEffort={modelState.reasoningEffort}
          permissionLabel={permissionSummary(modelState)}
          contextPercent={contextPercent}
          tokenSummary={tokenSummary}
          approvalActive={pendingApproval?.mode === "approval" && !pendingApproval.highStakes}
          liveAgentCount={liveAgentCount}
          fastMode={modelState.codexFastMode}
          inlineRowFocused={inlineRowFocused}
          inlineRowCell={inlineRowFocus.cell}
          providerLocked={providerLocked}
          subagentsButtonVisible={subagentPaneCommandAvailable}
          planMode={isPlanMode(modelState)}
          terminalControlAvailable={claudeTerminalControlAvailable}
          terminalControlActive={claudeTerminalControlActive}
        />
      </Box>
    </SpinTickProvider>
  );
}
