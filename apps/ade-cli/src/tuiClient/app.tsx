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
  resolveProviderGroupForModel,
} from "../../../desktop/src/shared/modelRegistry";
import { CURSOR_AVAILABLE_MODE_IDS, CURSOR_MODE_LABELS } from "../../../desktop/src/shared/cursorModes";
import type {
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatClaudeMcpServerStatus,
  AgentChatClaudePlugin,
  AgentChatReloadClaudePluginsResult,
  AgentChatContextUsage,
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatModelInfo,
  AgentChatPermissionMode,
  AgentChatSessionSummary,
  AgentChatSlashCommand,
  CodexThreadGoal,
} from "../../../desktop/src/shared/types/chat";
import type { AiSettingsStatus, OpenCodeRuntimeSnapshot } from "../../../desktop/src/shared/types/config";
import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import {
  DEFAULT_CODEX_REASONING_EFFORT,
  approveToolUse,
  createChatSession,
  discoverProjectSlashCommands,
  getAvailableModels,
  getAiSettingsStatus,
  getChatHistory,
  getClaudeMcpStatus,
  getContextUsage,
  getOpenCodeRuntimeDiagnostics,
  getSlashCommands,
  getStoredApiKeyProviders,
  interruptChat,
  latestGoal,
  latestTokenStats,
  listClaudePlugins,
  listClaudeOutputStyles,
  listChatSessions,
  listLanes,
  navigateDesktop,
  newestSession,
  renameChat,
  reloadClaudePlugins,
  respondToInput,
  sendChatMessage,
  setClaudeOutputStyle,
  tagChat,
  updateChatModel,
  type TokenStats,
} from "./adeApi";
import { paletteCommands, parseCommand } from "./commands";
import { connectToAde } from "./connection";
import { Drawer, visibleDrawerChatCount, visibleDrawerLaneCount } from "./components/Drawer";
import { ChatView } from "./components/ChatView";
import { Header } from "./components/Header";
import { LANE_DETAIL_ACTIONS, RightPane } from "./components/RightPane";
import { SlashPalette } from "./components/SlashPalette";
import { MentionPalette } from "./components/MentionPalette";
import { ApprovalPrompt } from "./components/ApprovalPrompt";
import { ModelStatus } from "./components/ModelStatus";
import { FooterControls } from "./components/FooterControls";
import { theme } from "./theme";
import { chooseInitialLane } from "./project";
import { resolveDrawerChatSelection } from "./drawerSelection";
import { latestExpandableFailureId, renderObject, summarizeDiffChanges } from "./format";
import { startTuiHeartbeat, type TuiHeartbeat } from "./heartbeat";
import { isImageFilePath, normalizeOpenableImageTarget } from "./imageTargets";
import { loadAdeCodeState, saveAdeCodeState } from "./state";
import { buildLinearToolRequest } from "./linearCommands";
import { buildPendingInputAnswers, latestPendingApproval } from "./pendingInput";
import { claudeHomePath, defaultKeybindingsPath, dispatchKeybinding, openKeybindingsFile, readClaudeKeybindingsFile, type KeybindingDispatchState, type TuiKeybindingAction } from "./keybindings";
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
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "opencode", label: "OpenCode" },
  { value: "cursor", label: "Cursor" },
  { value: "droid", label: "Droid" },
];
const PROVIDERS = new Set<AdeCodeProvider>(PROVIDER_OPTIONS.map((provider) => provider.value));
const CODEX_PRESETS = ["default", "plan", "full-auto", "config-toml"] as const;
const CLAUDE_PERMISSION_OPTIONS = ["default", "auto", "plan", "acceptEdits", "bypassPermissions"] as const;
const OPENCODE_PERMISSION_OPTIONS = ["plan", "edit", "full-auto"] as const;
const DROID_PERMISSION_OPTIONS = ["read-only", "auto-low", "auto-medium", "auto-high"] as const;
const SETTINGS_AI_ROUTE = "/settings?tab=ai#ai-providers";
type PaneFocus = "drawer" | "chat" | "details";
type FooterControl = "drawer" | "details";
type DrawerLaneAction = "new-lane";
type DrawerChatAction = "new-chat";
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
  const descriptor = getDefaultModelDescriptor(provider)
    ?? listModelDescriptorsForProvider(provider)[0]
    ?? getDefaultModelDescriptor("codex");
  return {
    provider,
    model: descriptor?.providerModelId ?? descriptor?.shortId ?? descriptor?.id ?? "gpt-5.5",
    modelId: descriptor?.id ?? null,
    displayName: descriptor?.displayName ?? providerLabel(provider),
    reasoningEffort: descriptor?.reasoningTiers?.[0] ?? (provider === "codex" ? DEFAULT_CODEX_REASONING_EFFORT : null),
  };
}

function modelReasoningEfforts(modelState: AdeCodeModelState, models: AgentChatModelInfo[]): string[] {
  if (modelState.provider === "cursor" || modelState.provider === "droid") return [];
  const model = models.find((entry) => entry.id === modelState.modelId || entry.modelId === modelState.modelId);
  const fromModel = model?.reasoningEfforts?.map((entry) => entry.effort).filter(Boolean) ?? [];
  if (fromModel.length) return fromModel;
  const descriptor = modelState.modelId ? getModelById(modelState.modelId) : undefined;
  return descriptor?.reasoningTiers?.length ? descriptor.reasoningTiers : EFFORTS;
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
  const budget = goal.tokenBudget ?? null;
  if (used != null && budget != null) {
    right.push(`${compactNumber(used)}/${compactNumber(budget)}`);
  } else if (used != null) {
    right.push(`${compactNumber(used)} tokens`);
  }
  if (typeof goal.timeUsedSeconds === "number" && goal.timeUsedSeconds > 0) {
    const seconds = Math.round(goal.timeUsedSeconds);
    const mins = Math.floor(seconds / 60);
    right.push(mins > 0 ? `${mins}m ${seconds % 60}s` : `${seconds}s`);
  }
  if (goal.status) right.push(goal.status.replace(/_/g, " "));
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
  if (usage.mcpTools?.length) extras.push(`${usage.mcpTools.length} MCP tool${usage.mcpTools.length === 1 ? "" : "s"}`);
  return [header, usage.model ? `Model: ${usage.model}` : null, "", ...rows, extras.length ? `\n${extras.join(" · ")}` : null]
    .filter((line): line is string => line != null)
    .join("\n");
}

function subagentSnapshotsFromEvents(events: AgentChatEventEnvelope[]): SubagentSnapshot[] {
  const snapshots = new Map<string, SubagentSnapshot>();
  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    const id = typeof event.taskId === "string"
      ? event.taskId
      : typeof event.agentId === "string"
        ? event.agentId
        : null;
    if (!id || !type.startsWith("subagent")) continue;
    const existing = snapshots.get(id);
    const agentType = typeof event.agentType === "string" ? event.agentType : "subagent";
    const usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : {};
    const background = event.background === true || existing?.kind === "background";
    const summary = typeof event.summary === "string"
      ? event.summary
      : typeof event.finalSummary === "string"
        ? event.finalSummary
        : typeof event.text === "string"
          ? event.text
          : typeof event.description === "string"
            ? event.description
            : existing?.summary ?? "";
    const base: SubagentSnapshot = {
      id,
      name: typeof event.description === "string" ? event.description : existing?.name ?? agentType,
      kind: background ? "background" : "subagent",
      status: existing?.status ?? "running",
      summary,
      tokens: typeof usage.totalTokens === "number" ? usage.totalTokens : typeof event.tokens === "number" ? event.tokens : existing?.tokens,
      durationMs: typeof usage.durationMs === "number" ? usage.durationMs : existing?.durationMs,
      lastToolName: typeof event.lastToolName === "string" ? event.lastToolName : existing?.lastToolName,
    };
    if (type === "subagent_result" || type === "subagent.completed") {
      const status = event.status === "failed" || event.status === "stopped" || event.status === "completed" ? event.status : "completed";
      snapshots.set(id, { ...base, status });
    } else {
      snapshots.set(id, { ...base, status: "running" });
    }
  }
  return [...snapshots.values()];
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

function formatMcpStatus(statuses: AgentChatClaudeMcpServerStatus[]): string {
  if (!statuses.length) return "No MCP servers are configured for this Claude chat yet.";
  return [
    "Claude MCP servers:",
    "",
    ...statuses.map((server) => {
      const scope = server.scope ? ` · ${server.scope}` : "";
      const toolCount = server.tools?.length ? ` · ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}` : "";
      const target = server.config?.url ?? server.config?.command ?? "";
      const detail = server.error ?? target;
      return [
        `${server.name}: ${server.status}${scope}${toolCount}`,
        detail ? `  ${detail}` : null,
      ].filter((line): line is string => Boolean(line)).join("\n");
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
    result.mcpServers.length ? `${result.mcpServers.length} MCP server${result.mcpServers.length === 1 ? "" : "s"}` : null,
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

function clipboardImageTarget(workspaceRoot: string, extension = "png"): string {
  const dir = path.join(workspaceRoot, ".ade", "cache", "ade-code-clipboard");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `clipboard-${Date.now()}.${extension}`);
}

function powershellQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function nonEmptyFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
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

function readClipboardImageAttachment(workspaceRoot: string): AgentChatFileRef | null {
  if (process.platform === "darwin" && commandAvailable("pngpaste")) {
    const target = clipboardImageTarget(workspaceRoot);
    const result = spawnSync("pngpaste", [target], { stdio: "ignore" });
    if (result.status === 0 && nonEmptyFile(target)) return { path: target, type: "image" };
  }
  if (process.platform === "darwin" && commandAvailable("pbpaste")) {
    const target = clipboardImageTarget(workspaceRoot);
    const result = spawnSync("pbpaste", ["-Prefer", "image"], { encoding: "buffer", maxBuffer: 30 * 1024 * 1024 });
    if (result.status === 0 && result.stdout.length) {
      fs.writeFileSync(target, result.stdout);
      if (nonEmptyFile(target)) return { path: target, type: "image" };
    }
  }
  if (process.platform === "win32" && commandAvailable("powershell")) {
    const target = clipboardImageTarget(workspaceRoot);
    const command = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "Add-Type -AssemblyName System.Drawing;",
      "$image = [System.Windows.Forms.Clipboard]::GetImage();",
      `if ($image -ne $null) { $image.Save(${powershellQuoted(target)}, [System.Drawing.Imaging.ImageFormat]::Png) }`,
    ].join(" ");
    const result = spawnSync("powershell", ["-NoProfile", "-Command", command], { stdio: "ignore" });
    if (result.status === 0 && nonEmptyFile(target)) return { path: target, type: "image" };
  }
  if (process.platform === "linux") {
    const target = clipboardImageTarget(workspaceRoot);
    const commands = commandAvailable("wl-paste")
      ? [["wl-paste", "-t", "image/png"]]
      : commandAvailable("xclip")
        ? [["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]]
        : [];
    for (const [command, ...args] of commands) {
      const result = spawnSync(command, args, { encoding: "buffer", maxBuffer: 30 * 1024 * 1024 });
      if (result.status === 0 && result.stdout.length) {
        fs.writeFileSync(target, result.stdout);
        if (nonEmptyFile(target)) return { path: target, type: "image" };
      }
    }
  }
  const clipboardText = readClipboardText();
  const clipboardPath = clipboardText?.split(/\r?\n/).map((line) => line.trim()).find((line) => line && fs.existsSync(line));
  if (clipboardPath && isImageFilePath(clipboardPath)) return { path: clipboardPath, type: "image" };
  return null;
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
  mcpCount: number | null;
}): string {
  const keybindings = readClaudeKeybindingsFile({ create: false });
  const statusLine = formatClaudeStatusLineConfig(args.workspaceRoot);
  return [
    "ADE Code doctor:",
    "",
    `provider: ${args.activeProvider ?? "none"}`,
    `keybindings: ${keybindings.warnings.length ? `${keybindings.warnings.length} warning${keybindings.warnings.length === 1 ? "" : "s"}` : "ok"}`,
    args.pluginCount == null ? "plugins: not checked" : `plugins: ${args.pluginCount}`,
    args.mcpCount == null ? "MCP servers: not checked" : `MCP servers: ${args.mcpCount}`,
    "",
    statusLine,
  ].join("\n");
}

function buildSetupRows(args: {
  modelState: AdeCodeModelState;
  models: AgentChatModelInfo[];
  includeRefresh: boolean;
  includeApply: boolean;
}): SetupPaneRow[] {
  const efforts = modelReasoningEfforts(args.modelState, args.models);
  const descriptor = args.modelState.modelId ? getModelById(args.modelState.modelId) : undefined;
  const fastSupported = args.modelState.provider === "codex" && modelSupportsFastMode(descriptor);
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
      detail: args.modelState.provider === "codex"
        ? `${args.modelState.codexApprovalPolicy} / ${args.modelState.codexSandbox}`
        : args.modelState.provider === "cursor"
          ? "Cursor mode"
          : "provider native",
      cyclable: true,
    },
  ];
  if (args.modelState.provider === "codex") {
    rows.push({
      kind: "codex-fast",
      label: "Fast mode",
      value: fastSupported ? (args.modelState.codexFastMode ? "on" : "off") : "unsupported",
      detail: "Codex service tier",
      disabled: !fastSupported,
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
      label: "Use this setup",
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

function providerConnectionDetail(status: AiSettingsStatus | null, provider: Exclude<AdeCodeProvider, "opencode">): ProviderReadinessRow {
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

function inputBeforeLineBreak(input: string): string | null {
  const index = input.search(/[\r\n]/);
  return index === -1 ? null : input.slice(0, index);
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
    return "ADE Droid chat runs Factory Droid over ACP. Set FACTORY_API_KEY before launching ADE, or run `droid` and use its interactive `/login`.";
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

export function AdeCodeApp({ project, forceEmbedded, requireSocket, socketPath }: AdeCodeAppProps) {
  const { exit } = useApp();
  const [columns, rows] = useTerminalDimensions();
  const [connection, setConnection] = useState<AdeCodeConnection | null>(null);
  const [mode, setMode] = useState<RuntimeMode | "connecting">("connecting");
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [activeLaneId, setActiveLaneId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentChatEventEnvelope[]>([]);
  const [notices, setNotices] = useState<LocalNotice[]>([]);
  const [slashCommands, setSlashCommands] = useState<AgentChatSlashCommand[]>([]);
  const [keybindings, setKeybindings] = useState(() => readClaudeKeybindingsFile({ create: false }).bindings);
  const [models, setModels] = useState<AgentChatModelInfo[]>([]);
  const [modelState, setModelState] = useState<AdeCodeModelState>(initialModelState);
  const [draftChatActive, setDraftChatActive] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiSettingsStatus | null>(null);
  const [aiStatusCheckedAt, setAiStatusCheckedAt] = useState<string | null>(null);
  const [storedApiKeyProviders, setStoredApiKeyProviders] = useState<string[]>([]);
  const [openCodeDiagnostics, setOpenCodeDiagnostics] = useState<OpenCodeRuntimeSnapshot | null>(null);
  const [rightPane, setRightPane] = useState<RightPaneContent>({ kind: "empty" });
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [formFieldIndex, setFormFieldIndex] = useState(0);
  const [rightSelectionIndex, setRightSelectionIndex] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(() => columns >= 110);
  const [activePane, setActivePane] = useState<PaneFocus>("chat");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [contextPercent, setContextPercent] = useState<number | null>(null);
  const [tokenSummary, setTokenSummary] = useState<string | null>(null);
  const [statusLineStats, setStatusLineStats] = useState<TokenStats | null>(null);
  const [statusLineText, setStatusLineText] = useState<string | null>(null);
  const [vimModeEnabled, setVimModeEnabled] = useState(() => readClaudeVimMode(project.workspaceRoot));
  const [vimMode, setVimMode] = useState<"insert" | "normal">("insert");
  const [hideVimModeIndicator, setHideVimModeIndicator] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [expandedLineIds, setExpandedLineIds] = useState<Set<string>>(() => new Set());
  const [chatScrollOffsetRows, setChatScrollOffsetRows] = useState(0);
  const [mentionSuggestions, setMentionSuggestions] = useState<MentionSuggestion[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [selectedMentions, setSelectedMentions] = useState<MentionSuggestion[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [drawerSection, setDrawerSection] = useState<"lanes" | "chats">("lanes");
  const [drawerLaneId, setDrawerLaneId] = useState<string | null>(null);
  const [selectedDrawerLaneId, setSelectedDrawerLaneId] = useState<string | null>(null);
  const [selectedDrawerChatId, setSelectedDrawerChatId] = useState<string | null>(null);
  const [selectedDrawerLaneAction, setSelectedDrawerLaneAction] = useState<DrawerLaneAction | null>(null);
  const [selectedDrawerChatAction, setSelectedDrawerChatAction] = useState<DrawerChatAction | null>(null);
  const [formDiscardArmed, setFormDiscardArmed] = useState(false);
  const [footerControl, setFooterControl] = useState<FooterControl | null>(null);

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
  const lastLocalSendAtRef = useRef<number>(0);
  const eventCountRef = useRef<number>(0);
  const chatScrollOffsetRowsRef = useRef(0);
  const heartbeatRef = useRef<TuiHeartbeat | null>(null);
  const draftSeededFromHistoryRef = useRef(false);
  const attachProbeInFlightRef = useRef(false);
  const lastChatByLaneRef = useRef<Map<string, string>>(new Map(Object.entries(loadAdeCodeState().lastChatByLane)));
  const lastChatByLaneWriteTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingNewChatTitleRef = useRef<string | null>(null);

  const persistLastChatByLane = useCallback(() => {
    if (lastChatByLaneWriteTimerRef.current) {
      clearTimeout(lastChatByLaneWriteTimerRef.current);
    }
    lastChatByLaneWriteTimerRef.current = setTimeout(() => {
      lastChatByLaneWriteTimerRef.current = null;
      const lastChatByLane: Record<string, string> = {};
      for (const [laneId, sessionId] of lastChatByLaneRef.current) {
        lastChatByLane[laneId] = sessionId;
      }
      saveAdeCodeState({ lastChatByLane });
    }, 500);
  }, []);

  const setChatScrollOffset = useCallback((value: number | ((previous: number) => number)) => {
    setChatScrollOffsetRows((previous) => {
      const next = Math.max(0, typeof value === "function" ? value(previous) : value);
      chatScrollOffsetRowsRef.current = next;
      return next;
    });
  }, []);

  const selectActiveLaneId = useCallback((laneId: string | null) => {
    if (activeLaneIdRef.current !== laneId) setChatScrollOffset(0);
    activeLaneIdRef.current = laneId;
    setActiveLaneId(laneId);
  }, [setChatScrollOffset]);

  const selectActiveSessionId = useCallback((sessionId: string | null) => {
    if (activeSessionIdRef.current !== sessionId) setChatScrollOffset(0);
    if (sessionId) {
      draftChatActiveRef.current = false;
      setDraftChatActive(false);
      setSelectedDrawerChatAction(null);
      const laneId = activeLaneIdRef.current;
      if (laneId && lastChatByLaneRef.current.get(laneId) !== sessionId) {
        lastChatByLaneRef.current.set(laneId, sessionId);
        persistLastChatByLane();
      }
    }
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
  }, [persistLastChatByLane, setChatScrollOffset]);

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
    promptRef.current = prompt;
  }, [prompt]);

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

  const focusDetails = useCallback(() => {
    const previousPane = activePaneRef.current;
    stashActiveInput();
    selectFooterControl(null);
    if (previousPane !== "details") {
      paneBeforeDetailsRef.current = previousPane;
    }
    setFormDiscardArmed(false);
    setRightOpen(true);
    if (rightPane.kind === "form") {
      const field = rightPane.fields[formFieldIndex] ?? rightPane.fields[0];
      setPrompt(field ? formValues[field.name] ?? field.initialValue ?? "" : "");
    } else {
      setPrompt("");
    }
    setPaneFocus("details");
  }, [formFieldIndex, formValues, rightPane, selectFooterControl, setPaneFocus, stashActiveInput]);

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
    if (rightOpen && rightPane.kind !== "form") {
      setRightOpen(false);
      focusChat();
      return;
    }
    if (activePaneRef.current === "details") {
      focusChat();
      return;
    }
    focusDetails();
  }, [focusChat, focusDetails, rightOpen, rightPane.kind, selectFooterControl]);

  const cyclePaneFocus = useCallback(() => {
    const order: PaneFocus[] = ["drawer", "chat", "details"];
    const currentIndex = order.indexOf(activePaneRef.current);
    const nextPane = order[(currentIndex + 1) % order.length] ?? "chat";
    if (nextPane === "drawer") {
      focusDrawer();
    } else if (nextPane === "details") {
      focusDetails();
    } else {
      focusChat();
    }
  }, [focusChat, focusDetails, focusDrawer]);

  const focusAfterDetails = useCallback(() => {
    if (paneBeforeDetailsRef.current === "drawer" && drawerOpen) {
      focusDrawer();
      return;
    }
    focusChat();
  }, [drawerOpen, focusChat, focusDrawer]);

  const projectName = path.basename(project.projectRoot);
  const activeLane = useMemo(
    () => lanes.find((lane) => lane.id === activeLaneId) ?? null,
    [activeLaneId, lanes],
  );
  const activeSession = useMemo(
    () => sessions.find((session) => session.sessionId === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );
  const activeCommandProvider = activeSession?.provider ?? modelState.provider;
  const latestFailedLineId = useMemo(() => latestExpandableFailureId(events), [events]);
  const subagentSnapshots = useMemo(() => subagentSnapshotsFromEvents(events), [events]);
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
  const drawerLaneRows = useMemo(
    () => lanes.slice(0, visibleDrawerLaneCount(rows, lanes.length)),
    [lanes, rows],
  );
  const drawerLaneSessions = useMemo(
    () => sessions.filter((session) => session.laneId === drawerLaneId),
    [drawerLaneId, sessions],
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
  const activeMentionRange = useMemo(() => (
    activePane === "chat" ? activeMention(prompt) : null
  ), [activePane, prompt]);
  const slashRows = useMemo(() => (
    activePane === "chat" && prompt.startsWith("/")
      ? paletteCommands(prompt, slashCommands, { provider: activeCommandProvider })
      : []
  ), [activeCommandProvider, activePane, prompt, slashCommands]);
  const pendingApproval = useMemo(() => latestPendingApproval(events), [events]);
  const currentGoal = useMemo(() => latestGoal(events), [events]);
  const goalBannerText = useMemo(() => formatGoalBannerLine(currentGoal), [currentGoal]);
  const activeFormField = rightPane.kind === "form"
    ? rightPane.fields[formFieldIndex] ?? rightPane.fields[0] ?? null
    : null;
  const statusLineRows = statusLineText ? Math.min(3, statusLineText.split(/\r?\n/).filter(Boolean).length || 1) : 0;
  const statusRows = statusLineRows;
  const goalBannerRows = goalBannerText ? 1 : 0;
  const chatRowBudget = Math.max(4, rows - 12 - statusRows - goalBannerRows);
  const providerReadinessRows = useMemo(
    () => buildProviderReadinessRows(aiStatus, storedApiKeyProviders, openCodeDiagnostics),
    [aiStatus, openCodeDiagnostics, storedApiKeyProviders],
  );
  const newChatSetupRows = useMemo(
    () => setupRowsForRuntime(buildSetupRows({ modelState, models, includeRefresh: false, includeApply: true }), mode),
    [mode, modelState, models],
  );
  const modelSetupRows = useMemo(
    () => setupRowsForRuntime(buildSetupRows({ modelState, models, includeRefresh: true, includeApply: false }), mode),
    [mode, modelState, models],
  );

  useEffect(() => {
    activeLaneIdRef.current = activeLaneId;
  }, [activeLaneId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (rightPane.kind === "new-chat-setup") {
      setRightPane((prev) => prev.kind === "new-chat-setup"
        ? {
            ...prev,
            laneId: activeLaneId ?? prev.laneId,
            laneLabel: activeLane?.name ?? prev.laneLabel,
            rows: newChatSetupRows,
          }
        : prev);
    } else if (rightPane.kind === "model-setup") {
      setRightPane((prev) => prev.kind === "model-setup"
        ? {
            ...prev,
            rows: modelSetupRows,
            providerRows: providerReadinessRows,
            activeProvider: modelState.provider,
            checkedAt: aiStatusCheckedAt,
            desktopAttached: mode === "attached",
          }
        : prev);
    } else if (rightPane.kind === "subagents") {
      setRightPane((prev) => prev.kind === "subagents" ? { ...prev, snapshots: subagentSnapshots } : prev);
    }
  }, [activeLane?.name, activeLaneId, aiStatusCheckedAt, mode, modelSetupRows, modelState.provider, newChatSetupRows, providerReadinessRows, rightPane.kind, subagentSnapshots]);

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

  useEffect(() => {
    if (activePane !== "details" || !rightOpen) return;
    if (!activeLane || !activeLaneId) return;
    if (rightPane.kind !== "empty" && rightPane.kind !== "lane-details") return;

    let cancelled = false;
    const lane = activeLane;
    const laneId = activeLaneId;

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

        const activePr = prsRes[0] ?? null;
        let pr: { number: number; state: "open" | "closed" | "merged"; url: string; checksPassed: number; checksTotal: number } | null = null;
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
          if (prId) {
            const checks = await conn.actionList<Array<{ status?: string; conclusion?: string | null }>>("pr", "getChecks", [prId]).catch(() => null);
            if (!cancelled && Array.isArray(checks)) {
              checksTotal = checks.length;
              checksPassed = checks.filter((check) => check.status === "completed" && check.conclusion === "success").length;
            }
          }
          if (number != null && url) {
            pr = { number, state, url, checksPassed, checksTotal };
          }
        }

        if (cancelled) return;
        setRightPane((prev) => {
          if (cancelled) return prev;
          if (prev.kind !== "lane-details" && prev.kind !== "empty") return prev;
          const previousIndex = prev.kind === "lane-details" ? prev.selectedActionIndex : 0;
          const previousShowFiles = prev.kind === "lane-details" ? prev.showFiles : false;
          const maxIndex = LANE_DETAIL_ACTIONS.length - 1 + (pr ? 1 : 0);
          return {
            kind: "lane-details",
            lane,
            git: {
              staged: staged.length,
              unstaged: unstaged.length,
              total: files.length,
              ahead,
              behind,
              remote,
            },
            files,
            pr,
            showFiles: previousShowFiles,
            selectedActionIndex: Math.max(0, Math.min(previousIndex, maxIndex)),
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
  }, [activeLane, activeLaneId, activePane, rightOpen, rightPane.kind]);

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

  const loadProviderModels = useCallback(async (provider: AdeCodeProvider, options: { applyDefault?: boolean } = {}) => {
    const conn = connectionRef.current;
    const nextModels = conn
      ? await getAvailableModels(conn, provider).catch(() => [])
      : [];
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

  const openNewChatSetup = useCallback((title?: string | null) => {
    if (!activeLaneIdRef.current) {
      setRightPane({ kind: "details", title: "New chat", body: "No active lane is available." });
      focusDetails();
      return;
    }
    const trimmedTitle = title?.trim() || null;
    pendingNewChatTitleRef.current = trimmedTitle;
    draftSeededFromHistoryRef.current = true;
    const previousPane = activePaneRef.current;
    stashActiveInput();
    if (previousPane !== "details") {
      paneBeforeDetailsRef.current = previousPane;
    }
    setDraftChatMode(true);
    selectActiveSessionId(null);
    setEvents([]);
    setClearedAt(null);
    chatDraftRef.current = "";
    setPrompt("");
    setRightSelectionIndex(0);
    setFormDiscardArmed(false);
    setRightPane({
      kind: "new-chat-setup",
      laneId: activeLaneIdRef.current,
      laneLabel: activeLane?.name ?? activeLaneIdRef.current,
      rows: newChatSetupRows,
    });
    setRightOpen(true);
    setPaneFocus("details");
    void refreshAiSetupStatus().catch(() => undefined);
    void loadProviderModels(modelState.provider, { applyDefault: false }).catch(() => undefined);
  }, [activeLane?.name, focusDetails, loadProviderModels, modelState.provider, newChatSetupRows, refreshAiSetupStatus, selectActiveSessionId, setDraftChatMode, setPaneFocus, stashActiveInput]);

  const openModelSetup = useCallback((options: { forceRefresh?: boolean } = {}) => {
    const previousPane = activePaneRef.current;
    stashActiveInput();
    if (previousPane !== "details") {
      paneBeforeDetailsRef.current = previousPane;
    }
    setRightSelectionIndex(0);
    setRightPane({
      kind: "model-setup",
      rows: modelSetupRows,
      providerRows: providerReadinessRows,
      activeProvider: modelState.provider,
      checkedAt: aiStatusCheckedAt,
      desktopAttached: mode === "attached",
    });
    setRightOpen(true);
    setPrompt("");
    setPaneFocus("details");
    void refreshAiSetupStatus({ force: options.forceRefresh === true }).catch((err) => {
      addNotice(err instanceof Error ? err.message : String(err), "error");
    });
    void loadProviderModels(modelState.provider, { applyDefault: false }).catch(() => undefined);
  }, [addNotice, aiStatusCheckedAt, loadProviderModels, mode, modelSetupRows, modelState.provider, providerReadinessRows, refreshAiSetupStatus, setPaneFocus, stashActiveInput]);

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
      ...sessions.slice(0, 30).map((session) => ({
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
      const next = [...localSuggestions, ...remote].slice(0, 10);
      setMentionSuggestions(next);
      setMentionIndex((index) => Math.min(index, Math.max(0, next.length - 1)));
    };
    void loadRemoteSuggestions();
    return () => {
      cancelled = true;
    };
  }, [activeMentionRange, lanes, sessions]);

  const refreshState = useCallback(async () => {
    const conn = connectionRef.current;
    if (!conn) return;
    const nextLanes = await listLanes(conn);
    const nextLane = nextLanes.find((lane) => lane.id === activeLaneIdRef.current)
      ?? chooseInitialLane(nextLanes, project);
    const nextLaneId = nextLane?.id ?? null;
    const nextSessions = await listChatSessions(conn);
    const laneSessions = nextSessions.filter((session) => session.laneId === nextLaneId);
    const draftMode = draftChatActiveRef.current;
    const seedSession = draftMode ? newestSession(laneSessions) : null;
    const nextSession = draftMode
      ? null
      : nextSessions.find((session) => session.sessionId === activeSessionIdRef.current)
        ?? newestSession(laneSessions);
    const nextSessionId = nextSession?.sessionId ?? null;
    let nextEvents: AgentChatEventEnvelope[] = [];
    if (nextSessionId) {
      const history = await getChatHistory(conn, nextSessionId);
      nextEvents = clearedAt
        ? history.events.filter((event) => event.timestamp > clearedAt)
        : history.events;
      const activeModelId = nextSession?.modelId ?? null;
      const fallbackContext = activeModelId ? getModelById(activeModelId)?.contextWindow ?? null : null;
      const stats = latestTokenStats(history.events, fallbackContext);
      setContextPercent(stats.percent);
      setTokenSummary(formatTokenSummary(stats));
      setStatusLineStats(stats);
      setStreaming(nextSession?.status === "active");
      eventCountRef.current = history.events.length;
    } else {
      setContextPercent(null);
      setTokenSummary(null);
      setStatusLineStats(null);
      setStreaming(false);
      eventCountRef.current = 0;
    }
    const configSession = nextSession ?? (!draftSeededFromHistoryRef.current ? seedSession : null);
    const nextProvider = configSession?.provider ?? modelState.provider ?? "codex";
    const commandSessionId = nextSessionId ?? configSession?.sessionId ?? null;
    const remoteCommands = commandSessionId ? await getSlashCommands(conn, commandSessionId).catch(() => []) : [];
    const projectCommands = discoverProjectSlashCommands(nextLane?.worktreePath || project.workspaceRoot);
    const nextCommands = remoteCommands.length ? remoteCommands : projectCommands;
    const nextModels = await getAvailableModels(conn, nextProvider).catch(() => []);
    const activeModel = nextModels.find((model) => model.modelId === configSession?.modelId || model.id === configSession?.modelId)
      ?? nextModels.find((model) => model.isDefault)
      ?? null;
    setLanes(nextLanes);
    setSessions(nextSessions);
    selectActiveLaneId(nextLaneId);
    selectActiveSessionId(nextSessionId);
    setEvents(nextEvents);
    setSlashCommands(nextCommands);
    setModels(nextModels);
    if (configSession && (!draftMode || !draftSeededFromHistoryRef.current)) {
      const provider = normalizeProvider(nextProvider);
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
  }, [clearedAt, modelState.provider, project, selectActiveLaneId, selectActiveSessionId]);

  const commitModelStateToSession = useCallback(async (nextState: AdeCodeModelState) => {
    const conn = connectionRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!conn || !sessionId || draftChatActiveRef.current) return;
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const conn = await connectToAde({ project, forceEmbedded, requireSocket, socketPath });
        if (cancelled) {
          await conn.close();
          return;
        }
        heartbeatRef.current = startTuiHeartbeat(project.projectRoot);
        connectionRef.current = conn;
        setConnection(conn);
        setMode(conn.mode);
        draftSeededFromHistoryRef.current = false;
        setDraftChatMode(true);
        selectActiveSessionId(null);
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
        saveAdeCodeState({ lastChatByLane });
      }
      const conn = connectionRef.current;
      connectionRef.current = null;
      void conn?.close().catch(() => {});
    };
  }, [forceEmbedded, project, requireSocket, socketPath]);

  useEffect(() => {
    if (!connection) return;
    return connection.onChatEvent((envelope) => {
      if (envelope.sessionId !== activeSessionIdRef.current) {
        void refreshState().catch(() => undefined);
        return;
      }
      if (clearedAt && envelope.timestamp <= clearedAt) return;
      setEvents((prev) => {
        const key = `${envelope.sequence ?? ""}:${envelope.timestamp}:${envelope.event.type}`;
        if (prev.some((entry) => `${entry.sequence ?? ""}:${entry.timestamp}:${entry.event.type}` === key)) return prev;
        return [...prev, envelope].slice(-500);
      });
      const event = envelope.event as Record<string, unknown>;
      if (event.type === "status" && event.turnStatus === "started") setStreaming(true);
      if (event.type === "done" || (event.type === "status" && event.turnStatus === "completed")) setStreaming(false);
      if (event.type === "subagent_started" || event.type === "subagent.started") {
        setRightOpen(true);
        setRightPane((prev) => prev.kind === "subagents" ? prev : { kind: "subagents", tab: "subagents", snapshots: [] });
        setPaneFocus("details");
      }
    });
  }, [clearedAt, connection, refreshState, setPaneFocus]);

  useEffect(() => {
    if (!connection) return;
    const timer = setInterval(() => {
      void refreshState().catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [connection, refreshState]);

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
    if (activeSessionIdRef.current) return activeSessionIdRef.current;
    const normalized = { ...modelState, ...applyProviderPermissionMode(modelState) };
    const created = await createChatSession({
      connection: conn,
      laneId,
      title: pendingNewChatTitleRef.current,
      provider: normalized.provider,
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
  }, [modelState, refreshState, selectActiveSessionId, setDraftChatMode]);

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

  const runRightCommand = useCallback(async (name: string, args: string) => {
    const conn = connectionRef.current;
    if (!conn) return;
    const laneId = activeLaneIdRef.current;
    const sessionId = activeSessionIdRef.current;
    focusDetails();

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
      let mcpCount: number | null = null;
      if (sessionId && activeSession?.provider === "claude") {
        try {
          pluginCount = (await listClaudePlugins(conn, sessionId)).length;
        } catch {
          pluginCount = null;
        }
        try {
          mcpCount = (await getClaudeMcpStatus(conn, sessionId)).length;
        } catch {
          mcpCount = null;
        }
      }
      setRightPane({
        kind: "details",
        title: "Doctor",
        body: formatDoctorReport({
          workspaceRoot: project.workspaceRoot,
          activeProvider: activeSession?.provider ?? modelState.provider,
          pluginCount,
          mcpCount,
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
    if (name === "/mcp") {
      if (!sessionId) {
        setRightPane({ kind: "details", title: "MCP", body: "No active chat is selected." });
        return;
      }
      if (activeSession?.provider !== "claude") {
        setRightPane({ kind: "details", title: "MCP", body: "/mcp is only available for Claude chats." });
        return;
      }
      const statuses = await getClaudeMcpStatus(conn, sessionId);
      setRightPane({ kind: "details", title: "MCP", body: formatMcpStatus(statuses) });
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
        setStreaming(true);
        await sendChatMessage(conn, sessionId, command);
        await refreshState();
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
        : await Promise.all([
            conn.actionList("pr", "getReviews", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
            conn.actionList("pr", "getReviewThreads", [prId]).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
          ]).then(([reviews, threads]) => ({ reviews, threads }));
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
        await sendChatMessage(conn, targetSessionId, issueContext);
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
      const laneSessions = sessions.filter((session) => session.laneId === laneId);
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
        const session = newestSession(sessions.filter((entry) => entry.laneId === lane.id));
        selectActiveSessionId(session?.sessionId ?? null);
        setSelectedDrawerChatId(session?.sessionId ?? null);
        addNotice(`Switched to lane ${lane.name}.`, "success");
      } else {
        setRightPane({ kind: "details", title: "Switch", body: `No lane matched "${args}".` });
      }
      return;
    }
    if (name === "/model") {
      if (args) {
        if (!sessionId) {
          const model = models.find((entry) => entry.id === args || entry.modelId === args);
          setModelState((prev) => ({
            ...prev,
            model: model?.id ?? args,
            modelId: model?.modelId ?? model?.id ?? args,
            displayName: model?.displayName ?? args,
          }));
          addNotice(`Default model set to ${model?.displayName ?? args}.`, "success");
          return;
        }
        await updateChatModel({ connection: conn, sessionId, modelId: args });
        addNotice(`Model set to ${args}.`, "success");
        await refreshState();
        return;
      }
      openModelSetup();
      return;
    }
    if (name === "/effort") {
      if (args) {
        if (!EFFORTS.includes(args)) {
          setRightPane({ kind: "details", title: "Effort", body: `Usage: /effort <${EFFORTS.join("|")}>` });
          return;
        }
        if (!sessionId) {
          setModelState((prev) => ({ ...prev, reasoningEffort: args }));
          addNotice(`Default effort set to ${args}.`, "success");
          return;
        }
        await updateChatModel({ connection: conn, sessionId, reasoningEffort: args });
        addNotice(`Effort set to ${args}.`, "success");
        await refreshState();
        return;
      }
      setRightSelectionIndex(Math.max(0, EFFORTS.findIndex((effort) => effort === modelState.reasoningEffort)));
      setRightPane({ kind: "effort", efforts: EFFORTS, activeEffort: modelState.reasoningEffort });
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
  }, [activeLane?.name, activeSession?.provider, activeSession?.sessionId, activeSession?.title, addNotice, ensureActiveSession, focusDetails, lanes, mode, modelState.modelId, models, openForm, openModelSetup, openNewChatSetup, openNewLaneForm, project, refreshState, selectActiveLaneId, selectActiveSessionId, sessions, setChatScrollOffset]);

  const runInlineCommand = useCallback(async (name: string, args: string) => {
    const conn = connectionRef.current;
    if (!conn) return;
    const laneId = activeLaneIdRef.current;
    const sessionId = activeSessionIdRef.current;
    if (name === "/quit") {
      exit();
      return;
    }
    if (name === "/clear") {
      setClearedAt(new Date().toISOString());
      setEvents([]);
      setChatScrollOffset(0);
      addNotice("Local transcript view cleared. The durable chat remains in ADE.", "info");
      return;
    }
    if (name === "/end") {
      if (!sessionId) {
        addNotice("No active chat is selected.", "error");
        return;
      }
      await conn.action("chat", "dispose", { sessionId });
      addNotice("Ended active chat runtime.", "success");
      await refreshState();
      return;
    }
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
  }, [activeSession?.provider, addNotice, exit, loadProviderModels, modelState.provider, project, refreshAiSetupStatus, refreshState, setChatScrollOffset, socketPath]);

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
  }, [addNotice, focusAfterDetails, refreshState, selectActiveLaneId, selectActiveSessionId]);

  const openLatestImage = useCallback(() => {
    let target: string | null = null;
    const acceptTarget = (candidate: string) => {
      const normalized = normalizeOpenableImageTarget(candidate);
      if (!normalized) return false;
      target = normalized;
      return true;
    };
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]?.event as Record<string, unknown> | undefined;
      if (!event) continue;
      if (event.type === "codex_image_generation") {
        const candidate = (event as { result?: unknown }).result;
        if (typeof candidate === "string" && acceptTarget(candidate)) break;
      }
      if (event.type === "codex_image_view") {
        const local = (event as { path?: unknown }).path;
        const remote = (event as { url?: unknown }).url;
        if (typeof local === "string" && acceptTarget(local)) break;
        if (typeof remote === "string" && acceptTarget(remote)) break;
      }
    }
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

  const submitPrompt = useCallback(async (value: string) => {
    const text = value.trim();
    if (!text && rightPane.kind !== "form") return;
    const conn = connectionRef.current;
    if (!conn) return;
    try {
      if (streaming && !text.startsWith("/") && rightPane.kind !== "form") {
        addNotice("This chat is still responding. Press ctrl-c to interrupt before sending another message.", "info");
        return;
      }
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
          const sessionId = await ensureActiveSession();
          if (sessionId) {
            setStreaming(true);
            await sendChatMessage(conn, sessionId, selected.name);
            await refreshState();
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
      const sessionId = await ensureActiveSession();
      if (!sessionId) {
        addNotice("No active lane is available for chat.", "error");
        return;
      }
      lastLocalSendAtRef.current = Date.now();
      const attachments: AgentChatFileRef[] = selectedMentions
        .filter((mention) => mention.kind === "file" && mention.filePath && text.includes(mention.insertText))
        .map((mention) => ({ type: isImageFilePath(mention.filePath!) ? "image" : "file", path: mention.filePath! }));
      setStreaming(true);
      await sendChatMessage(conn, sessionId, text, attachments);
      await refreshState();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStreaming(false);
      setError(message);
      addNotice(message, "error");
    }
  }, [activeCommandProvider, activeFormField, addNotice, answerPendingInput, ensureActiveSession, formValues, pendingApproval, refreshState, resolvePendingApproval, rightPane, runInlineCommand, runRightCommand, selectedMentions, setChatScrollOffset, slashCommands, slashIndex, slashRows, streaming, submitRightForm]);

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
      void commitModelStateToSession(next).catch((err) => {
        addNotice(err instanceof Error ? err.message : String(err), "error");
      });
      return next;
    });
  }, [addNotice, commitModelStateToSession]);

  const selectProvider = useCallback(async (provider: AdeCodeProvider) => {
    const conn = connectionRef.current;
    const nextModels = conn ? await getAvailableModels(conn, provider).catch(() => []) : [];
    setModels(nextModels);
    const model = nextModels.find((entry) => entry.isDefault) ?? nextModels[0] ?? null;
    applyModelState((prev) => ({
      ...prev,
      ...(model ? modelStatePatchForModel(provider, model) : fallbackModelStatePatch(provider)),
    }));
  }, [applyModelState]);

  const cycleProvider = useCallback((delta: number) => {
    const index = Math.max(0, PROVIDER_OPTIONS.findIndex((entry) => entry.value === modelState.provider));
    const next = PROVIDER_OPTIONS[(index + delta + PROVIDER_OPTIONS.length) % PROVIDER_OPTIONS.length]?.value ?? "codex";
    void selectProvider(next).catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
  }, [addNotice, modelState.provider, selectProvider]);

  const cycleModel = useCallback((delta: number) => {
    const candidates = models.length
      ? models
      : listModelDescriptorsForProvider(modelState.provider).map((descriptor) => ({
          id: descriptor.id,
          modelId: descriptor.id,
          displayName: descriptor.displayName,
          isDefault: descriptor.id === getDefaultModelDescriptor(modelState.provider)?.id,
          reasoningEfforts: descriptor.reasoningTiers?.map((effort) => ({ effort, description: effort })),
        }));
    if (!candidates.length) return;
    const index = Math.max(0, candidates.findIndex((entry) => entry.id === modelState.modelId || entry.modelId === modelState.modelId));
    const nextModel = candidates[(index + delta + candidates.length) % candidates.length] ?? candidates[0]!;
    applyModelState((prev) => ({
      ...prev,
      ...modelStatePatchForModel(modelState.provider, nextModel),
      codexFastMode: modelSupportsFastMode(getModelById(nextModel.modelId ?? nextModel.id)) ? prev.codexFastMode : false,
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
      setRightOpen(false);
      setRightPane({ kind: "empty" });
      focusChat();
      addNotice(`New chat ready in ${activeLane?.name ?? activeLaneIdRef.current ?? "current lane"}.`, "success");
    }
  }, [activeLane?.name, addNotice, applyModelState, cycleModel, cyclePermission, cycleProvider, cycleReasoning, focusChat, refreshAiSetupStatus]);

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
    const current = promptRef.current || chatDraftRef.current;
    const nextPrompt = current.trim() ? `${current} ${insertText}` : insertText;
    setSelectedMentions((prev) => {
      if (prev.some((entry) => entry.filePath === attachment.path)) return prev;
      return [...prev, {
        kind: "file" as const,
        label: path.basename(attachment.path),
        insertText,
        detail: attachment.path,
        filePath: attachment.path,
      }].slice(-12);
    });
    chatDraftRef.current = nextPrompt;
    promptRef.current = nextPrompt;
    setPrompt(nextPrompt);
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
      if (streaming && conn && sessionId) {
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
      exit();
      return true;
    }
    if (action === "chat:submit") {
      void submitPrompt(prompt);
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
      openModelSetup();
      return true;
    }
    if (action === "chat:fastMode") {
      if (modelState.provider === "codex") {
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
    if (action === "pane:close") {
      if (rightOpen) {
        setRightOpen(false);
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
      if (rightOpen) setRightOpen(false);
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
      selectFooterControl(action === "footer:up" ? null : (footerControlRef.current ?? "drawer"));
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
    if (action.startsWith("selection:")) {
      return reportUnavailable();
    }
    return reportUnavailable();
  }, [addNotice, applyModelState, attachClipboardImage, chatRowBudget, cyclePaneFocus, cyclePermission, cycleReasoning, drawerOpen, exit, focusAfterDetails, focusChat, focusDetails, modelState.provider, openHistorySearch, openModelSetup, prompt, recallPromptHistory, refreshState, rightOpen, selectFooterControl, setChatScrollOffset, submitPrompt, toggleDetailsPane]);

  useInput((input, key) => {
    const pane = activePaneRef.current;
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
    const detailsFormActive = pane === "details" && rightOpen && rightPane.kind === "form";
    const footerActive = footerControlRef.current != null;
    const textInputActive = (pane === "chat" && !footerActive) || detailsFormActive;
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
      cyclePaneFocus();
      return;
    }

    if (key.ctrl && input === "o") {
      if (drawerOpen && pane === "drawer") {
        setDrawerOpen(false);
        focusChat();
      } else {
        focusDrawer();
      }
      return;
    }

    if (key.ctrl && input === "l" && pane === "chat") {
      setClearedAt(new Date().toISOString());
      setEvents([]);
      setChatScrollOffset(0);
      addNotice("Viewport cleared. Durable chat history is unchanged.", "info");
      return;
    }

    if (key.ctrl && input === "p") {
      focusDetails();
      return;
    }

    if (footerActive) {
      if (key.leftArrow || key.rightArrow) {
        selectFooterControl(footerControlRef.current === "drawer" ? "details" : "drawer");
        return;
      }
      if (key.upArrow || key.escape) {
        selectFooterControl(null);
        return;
      }
      if (key.return) {
        if (footerControlRef.current === "drawer") {
          toggleDrawerPane();
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
        focusAfterDetails();
        return;
      }
      if (pane === "drawer") {
        setDrawerOpen(false);
        focusChat();
        return;
      }
      setPrompt("");
      return;
    }

    if (key.ctrl && input === "c") {
      const conn = connectionRef.current;
      const sessionId = activeSessionIdRef.current;
      if (streaming && conn && sessionId) {
        void interruptChat(conn, sessionId)
          .then(() => addNotice("Interrupted chat.", "info"))
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        return;
      }
      exit();
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

    if (pane === "details" && rightOpen && rightPane.kind === "subagents" && key.tab) {
      const tabs = ["subagents", "teammates", "background"] as const;
      const index = tabs.indexOf(rightPane.tab);
      setRightPane({ ...rightPane, tab: tabs[(index + 1) % tabs.length] ?? "subagents" });
      return;
    }

    if (
      pane === "details"
      && rightOpen
      && (rightPane.kind === "new-chat-setup" || rightPane.kind === "model-setup")
      && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.return)
    ) {
      const rows = rightPane.rows;
      const providerRowCount = rightPane.kind === "model-setup" ? rightPane.providerRows.length : 0;
      const totalRows = rows.length + providerRowCount;
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        setRightSelectionIndex((index) => totalRows ? (index + delta + totalRows) % totalRows : 0);
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

    if (pane === "details" && rightOpen && rightPane.kind === "lane-details") {
      const laneDetails = rightPane;
      const maxIndex = LANE_DETAIL_ACTIONS.length - 1 + (laneDetails.pr ? 1 : 0);
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

    if (pane === "details" && rightOpen && (rightPane.kind === "models" || rightPane.kind === "effort" || (rightPane.kind === "list" && rightPane.action)) && key.upArrow) {
      const max = rightPane.kind === "models"
        ? rightPane.models.length
        : rightPane.kind === "effort"
          ? rightPane.efforts.length
          : rightPane.rows.length;
      setRightSelectionIndex((index) => (index <= 0 ? Math.max(0, max - 1) : index - 1));
      return;
    }
    if (pane === "details" && rightOpen && (rightPane.kind === "models" || rightPane.kind === "effort" || (rightPane.kind === "list" && rightPane.action)) && key.downArrow) {
      const max = rightPane.kind === "models"
        ? rightPane.models.length
        : rightPane.kind === "effort"
          ? rightPane.efforts.length
          : rightPane.rows.length;
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
        const session = newestSession(sessions.filter((entry) => entry.laneId === lane.id));
        selectActiveSessionId(session?.sessionId ?? null);
        setSelectedDrawerChatId(session?.sessionId ?? null);
        addNotice(`Switched to lane ${lane.name}.`, "success");
        return;
      }
      const session = sessions.find((entry) => entry.sessionId === selectedId);
      if (!session) return;
      selectActiveLaneId(session.laneId);
      setDrawerLaneId(session.laneId);
      setSelectedDrawerLaneId(session.laneId);
      selectActiveSessionId(session.sessionId);
      setSelectedDrawerChatId(session.sessionId);
      addNotice(`Switched to chat ${session.title ?? session.sessionId}.`, "success");
      return;
    }
    if (pane === "details" && rightOpen && (rightPane.kind === "models" || rightPane.kind === "effort") && key.return) {
      const conn = connectionRef.current;
      const sessionId = activeSessionIdRef.current;
      if (!conn) {
        return;
      }
      if (rightPane.kind === "models") {
        const model = rightPane.models[rightSelectionIndex] ?? rightPane.models[0];
        if (!model) return;
        const modelId = model.modelId ?? model.id;
        if (!sessionId) {
          setModelState((prev) => ({
            ...prev,
            model: model.id,
            modelId,
            displayName: model.displayName,
          }));
          addNotice(`Default model set to ${model.displayName}.`, "success");
          return;
        }
        void updateChatModel({ connection: conn, sessionId, modelId })
          .then(() => {
            addNotice(`Model set to ${model.displayName}.`, "success");
            return refreshState();
          })
          .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
        return;
      }
      const effort = rightPane.efforts[rightSelectionIndex] ?? rightPane.efforts[0];
      if (!effort) return;
      if (!sessionId) {
        setModelState((prev) => ({ ...prev, reasoningEffort: effort }));
        addNotice(`Default effort set to ${effort}.`, "success");
        return;
      }
      void updateChatModel({ connection: conn, sessionId, reasoningEffort: effort })
        .then(() => {
          addNotice(`Effort set to ${effort}.`, "success");
          return refreshState();
        })
        .catch((err) => addNotice(err instanceof Error ? err.message : String(err), "error"));
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
      selectFooterControl(footerControlRef.current ?? "drawer");
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
        setSelectedDrawerLaneAction(lane ? null : "new-lane");
        setSelectedDrawerLaneId(lane?.id ?? null);
      } else if (selectedChatIndex <= 0) {
        setDrawerSection("lanes");
        const lastLane = drawerLaneRows[drawerLaneRows.length - 1] ?? null;
        setSelectedDrawerLaneAction("new-lane");
        setSelectedDrawerLaneId(lastLane?.id ?? null);
      } else {
        const nextIndex = Math.max(0, selectedChatIndex - 1);
        const session = drawerVisibleLaneSessions[nextIndex] ?? null;
        setSelectedDrawerChatAction(session ? null : "new-chat");
        setSelectedDrawerChatId(session?.sessionId ?? null);
      }
      return;
    }
    if (pane === "drawer" && drawerOpen && key.downArrow) {
      if (drawerSection === "lanes") {
        if (selectedLaneIndex >= drawerLaneRows.length) {
          setDrawerSection("chats");
          const firstSession = drawerVisibleLaneSessions[0] ?? null;
          setSelectedDrawerChatAction(firstSession ? null : "new-chat");
          setSelectedDrawerChatId(firstSession?.sessionId ?? null);
        } else {
          const nextIndex = Math.min(drawerLaneRows.length, selectedLaneIndex + 1);
          const lane = drawerLaneRows[nextIndex] ?? null;
          setSelectedDrawerLaneAction(lane ? null : "new-lane");
          setSelectedDrawerLaneId(lane?.id ?? null);
        }
      } else {
        const nextIndex = Math.min(drawerVisibleLaneSessions.length, selectedChatIndex + 1);
        const session = drawerVisibleLaneSessions[nextIndex] ?? null;
        setSelectedDrawerChatAction(session ? null : "new-chat");
        setSelectedDrawerChatId(session?.sessionId ?? null);
      }
      return;
    }
    if (pane === "drawer" && drawerOpen && key.return) {
      if (drawerSection === "lanes") {
        if (selectedDrawerLaneAction === "new-lane" || selectedLaneIndex >= drawerLaneRows.length) {
          openNewLaneForm();
          setRightOpen(true);
          return;
        }
        const lane = drawerLaneRows[selectedLaneIndex];
        if (lane) {
          selectActiveLaneId(lane.id);
          setDrawerLaneId(lane.id);
          setSelectedDrawerLaneId(lane.id);
          setSelectedDrawerLaneAction(null);
          const laneSessions = sessions.filter((entry) => entry.laneId === lane.id);
          const lastSessionId = lastChatByLaneRef.current.get(lane.id);
          const session =
            laneSessions.find((s) => s.sessionId === lastSessionId)
            ?? newestSession(laneSessions);
          selectActiveSessionId(session?.sessionId ?? null);
          setSelectedDrawerChatId(session?.sessionId ?? null);
          setSelectedDrawerChatAction(session ? null : "new-chat");
          setDrawerSection("chats");
          addNotice(`Switched to lane ${lane.name}.`, "success");
        }
      } else {
        if (selectedDrawerChatAction === "new-chat" || selectedChatIndex >= drawerVisibleLaneSessions.length) {
          openNewChatSetup();
          setRightOpen(true);
          return;
        }
        const session = drawerVisibleLaneSessions[selectedChatIndex];
        if (session) {
          selectActiveLaneId(session.laneId);
          setDrawerLaneId(session.laneId);
          setSelectedDrawerLaneId(session.laneId);
          setSelectedDrawerLaneAction(null);
          selectActiveSessionId(session.sessionId);
          setSelectedDrawerChatId(session.sessionId);
          setSelectedDrawerChatAction(null);
        }
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
    if (textInputActive && (key.return || linePrefix != null)) {
      const suffix = linePrefix == null ? "" : printableInput(linePrefix);
      void submitPrompt(`${prompt}${suffix}`);
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

  const centerWidth = Math.max(40, columns - (drawerOpen ? 30 : 0) - (rightOpen ? 40 : 0));
  const laneName = activeLane?.name ?? "main";
  const promptFocused = (activePane === "chat" && footerControl == null) || (activePane === "details" && rightPane.kind === "form");
  const drawerFooterSelected = footerControl === "drawer";
  const detailsFooterSelected = footerControl === "details";

  if (error && !connection) {
    return (
      <Box flexDirection="column">
        <Text color="red">ade-code failed to start</Text>
        <Text>{error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={rows}>
      <Header
        projectName={projectName}
        lane={activeLane}
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
            sessions={sessions}
            activeLaneId={activeLaneId}
            activeSessionId={activeSessionId}
            browsingLaneId={drawerLaneId ?? activeLaneId}
            selectedLaneIndex={drawerSection === "lanes" ? selectedLaneIndex : -1}
            selectedChatIndex={drawerSection === "chats" ? selectedChatIndex : -1}
            panelHeight={rows}
            focused={activePane === "drawer"}
          />
        ) : null}
        <Box width={centerWidth} flexDirection="column">
          {pendingApproval?.highStakes ? (
            <ApprovalPrompt approval={pendingApproval} modal />
          ) : (
            <>
              <ChatView
                events={events}
                notices={notices}
                activeSession={activeSession}
                projectName={projectName}
                laneName={laneName}
                lane={activeLane}
                expandedLineIds={expandedLineIds}
                maxRows={chatRowBudget}
                scrollOffsetRows={chatScrollOffsetRows}
                width={centerWidth}
              />
              <ApprovalPrompt approval={pendingApproval} />
            </>
          )}
        </Box>
        {rightOpen ? (
          <RightPane
            content={rightPane}
            formValues={formValues}
            activeFormField={formFieldIndex}
            selectedIndex={rightSelectionIndex}
            focused={activePane === "details"}
          />
        ) : null}
      </Box>
      <MentionPalette suggestions={mentionSuggestions} selectedIndex={mentionIndex} />
      <SlashPalette query={prompt} userCommands={slashCommands} selectedIndex={slashIndex} provider={activeCommandProvider} />
      {error ? <Text color="red">{error}</Text> : null}
      <Box borderStyle="round" borderColor={promptFocused ? PURPLE : theme.color.border} paddingX={1} flexShrink={0}>
        <Text color={PURPLE}>› </Text>
        <Text>{prompt}</Text>
        <Text inverse> </Text>
        {streaming && !goalBannerText ? <Text color={theme.color.mutedFg} dimColor>{"  · streaming"}</Text> : null}
      </Box>
      <ModelStatus
        provider={modelState.provider}
        displayName={modelState.displayName}
        reasoningEffort={modelState.reasoningEffort}
        permissionLabel={permissionSummary(modelState)}
        fastMode={modelState.provider === "codex" && modelState.codexFastMode}
        draftChatActive={draftChatActive}
        contextPercent={contextPercent}
        tokenSummary={tokenSummary}
        statusLineText={statusLineText}
        vimMode={vimModeEnabled && !hideVimModeIndicator ? vimMode : null}
      />
      <FooterControls
        drawerOpen={drawerOpen}
        rightOpen={rightOpen}
        drawerFocused={drawerFooterSelected}
        detailsFocused={detailsFooterSelected}
        footerControlActive={footerControl != null}
      />
    </Box>
  );
}
