import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { generateText, streamText, stepCountIs, type LanguageModel } from "ai";
import { createClaudeCode } from "ai-sdk-provider-claude-code";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createSessionService } from "../sessions/sessionService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createPackService } from "../packs/packService";
import { runGit } from "../git/git";
import type {
  AgentChatApprovalDecision,
  AgentChatCreateArgs,
  AgentChatDisposeArgs,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatIdentityKey,
  AgentChatInterruptArgs,
  AgentChatModelInfo,
  AgentChatProvider,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSteerArgs,
  AgentChatSendArgs,
  AgentChatUpdateSessionArgs,
  TerminalSessionStatus,
  TerminalToolType,
  CtoCapabilityMode
} from "../../../shared/types";
import {
  getModelById,
  getAvailableModels as getRegistryModels,
  MODEL_REGISTRY,
  resolveModelAlias,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { detectAllAuth } from "../ai/authDetector";
import { resolveModel, buildProviderOptions, isModelCliWrapped, normalizeCliMcpServers } from "../ai/providerResolver";
import { createUniversalToolSet, type PermissionMode } from "../ai/tools/universalTools";
import { resolveClaudeCliModel } from "../ai/claudeModelUtils";
import type { createMemoryService } from "../memory/memoryService";
import type { createCtoStateService } from "../cto/ctoStateService";
import { resolveAdeMcpServerLaunch } from "../orchestrator/unifiedOrchestratorAdapter";

type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type ClaudeToolPermissionResult = {
  behavior: "allow" | "deny";
  message?: string;
  interrupt?: boolean;
};

type PersistedClaudeMessage = {
  role: "user" | "assistant";
  content: string;
};

type PersistedChatState = {
  version: 1;
  sessionId: string;
  laneId: string;
  provider: AgentChatProvider;
  model: string;
  modelId?: string;
  reasoningEffort?: string | null;
  permissionMode?: AgentChatSession["permissionMode"];
  identityKey?: AgentChatIdentityKey;
  capabilityMode?: CtoCapabilityMode;
  threadId?: string;
  messages?: PersistedClaudeMessage[];
  updatedAt: string;
};

type PendingRpc = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

type PendingCodexApproval = {
  requestId: string | number;
  kind: "command" | "file_change";
};

type PendingClaudeApproval = {
  resolve: (decision: AgentChatApprovalDecision) => void;
};

type CodexRuntime = {
  kind: "codex";
  process: ChildProcessWithoutNullStreams;
  reader: readline.Interface;
  nextRequestId: number;
  pending: Map<string, PendingRpc>;
  approvals: Map<string, PendingCodexApproval>;
  activeTurnId: string | null;
  threadResumed: boolean;
  commandOutputByItemId: Map<string, string>;
  fileDeltaByItemId: Map<string, string>;
  fileChangesByItemId: Map<string, Array<{ path: string; kind: "create" | "modify" | "delete" }>>;
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  notify: (method: string, params?: unknown) => void;
  sendResponse: (id: string | number, result: unknown) => void;
  sendError: (id: string | number, message: string) => void;
};

type ClaudeRuntime = {
  kind: "claude";
  messages: PersistedClaudeMessage[];
  busy: boolean;
  abortController: AbortController | null;
  activeTurnId: string | null;
  pendingSteers: string[];
  approvals: Map<string, PendingClaudeApproval>;
  interrupted: boolean;
};

type PendingUnifiedApproval = {
  resolve: (decision: AgentChatApprovalDecision) => void;
};

type UnifiedRuntime = {
  kind: "unified";
  messages: Array<{ role: string; content: string }>;
  busy: boolean;
  abortController: AbortController | null;
  activeTurnId: string | null;
  permissionMode: PermissionMode;
  pendingApprovals: Map<string, PendingUnifiedApproval>;
  pendingSteers: string[];
  interrupted: boolean;
  resolvedModel: LanguageModel;
  modelDescriptor: ModelDescriptor;
};

type ChatRuntime = CodexRuntime | ClaudeRuntime | UnifiedRuntime;

type ManagedChatSession = {
  session: AgentChatSession;
  transcriptPath: string;
  transcriptBytesWritten: number;
  transcriptLimitReached: boolean;
  metadataPath: string;
  laneWorktreePath: string;
  runtime: ChatRuntime | null;
  preview: string | null;
  closed: boolean;
  endedNotified: boolean;
  ctoSessionStartedAt: string | null;
  pendingReconstructionContext: string | null;
  autoTitleSeed: string | null;
  autoTitleStage: "none" | "initial" | "final";
  autoTitleInFlight: boolean;
};

type ResolvedChatConfig = {
  codexApprovalPolicy: "untrusted" | "on-request" | "on-failure" | "never";
  codexSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  claudePermissionMode: "plan" | "acceptEdits" | "bypassPermissions";
  unifiedPermissionMode: PermissionMode;
  sessionBudgetUsd: number | null;
  autoTitleEnabled: boolean;
  autoTitleModelId: string | null;
  autoTitleRefreshOnComplete: boolean;
};

const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";
const DEFAULT_CLAUDE_MODEL = "sonnet";
const DEFAULT_UNIFIED_MODEL_ID = "anthropic/claude-sonnet-4-6-api";
const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_AUTO_TITLE_MODEL_ID = "anthropic/claude-haiku-4-5-api";
const MAX_CHAT_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const CHAT_TRANSCRIPT_LIMIT_NOTICE = "\n[ADE] chat transcript limit reached (8MB). Further events omitted.\n";
const AUTO_TITLE_MAX_CHARS = 48;
const AUTO_TITLE_SYSTEM_PROMPT = `You title software development chat sessions.
Return only the title text.
- Use 2 to 6 words.
- Focus on the task, feature, bug, or deliverable.
- Never start with Completed, Complete, Done, Finished, Resolved, or Success.
- No quotes.
- No emoji.
- No trailing punctuation.`;
const CODEX_REASONING_EFFORTS: Array<{ effort: string; description: string }> = [
  { effort: "minimal", description: "Minimum reasoning, fastest responses." },
  { effort: "low", description: "Fastest turn-around with shallow reasoning." },
  { effort: "medium", description: "Balanced reasoning depth and speed." },
  { effort: "high", description: "Deeper reasoning for multi-step implementation." },
  { effort: "xhigh", description: "Maximum reasoning depth for complex tasks." }
];

const CLAUDE_REASONING_EFFORTS: Array<{ effort: string; description: string }> = [
  { effort: "low", description: "Quick responses with minimal reasoning." },
  { effort: "medium", description: "Balanced reasoning depth and speed." },
  { effort: "high", description: "Deep reasoning for complex tasks." },
  { effort: "max", description: "Maximum reasoning depth." }
];

const CLAUDE_EFFORT_TO_TOKENS: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
  max: 32768
};

const KNOWN_CLAUDE_EFFORTS = new Set(CLAUDE_REASONING_EFFORTS.map((e) => e.effort));

const CODEX_FALLBACK_MODELS: AgentChatModelInfo[] = [
  {
    id: "gpt-5.3-codex",
    displayName: "gpt-5.3-codex",
    description: "Latest Codex model for implementation-heavy tasks.",
    isDefault: true,
    reasoningEfforts: CODEX_REASONING_EFFORTS
  },
  {
    id: "gpt-5.3-codex-spark",
    displayName: "gpt-5.3-codex-spark",
    description: "Near-instant real-time coding, optimized for speed.",
    isDefault: false,
    reasoningEfforts: CODEX_REASONING_EFFORTS.filter((e) => ["minimal", "low", "medium"].includes(e.effort))
  },
  {
    id: "gpt-5.2-codex",
    displayName: "gpt-5.2-codex",
    description: "Strong coding model with balanced latency/cost.",
    isDefault: false,
    reasoningEfforts: CODEX_REASONING_EFFORTS
  },
  {
    id: "gpt-5.1-codex-max",
    displayName: "gpt-5.1-codex-max",
    description: "Extended-context Codex model for large refactors.",
    isDefault: false,
    reasoningEfforts: CODEX_REASONING_EFFORTS
  },
  {
    id: "codex-mini-latest",
    displayName: "codex-mini-latest",
    description: "Fast lightweight Codex model for small edits.",
    isDefault: false,
    reasoningEfforts: CODEX_REASONING_EFFORTS
  },
  {
    id: "o4-mini",
    displayName: "o4-mini",
    description: "Compact reasoning model for planning and review.",
    isDefault: false,
    reasoningEfforts: CODEX_REASONING_EFFORTS
  },
  {
    id: "o3",
    displayName: "o3",
    description: "Advanced reasoning model for complex debugging.",
    isDefault: false,
    reasoningEfforts: CODEX_REASONING_EFFORTS
  }
];

const CLAUDE_FALLBACK_MODELS: AgentChatModelInfo[] = [
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6", description: "Highest capability for complex strategy and review.", isDefault: false, reasoningEfforts: CLAUDE_REASONING_EFFORTS, maxThinkingTokens: 32768 },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", description: "Latest balanced model — quality and speed for everyday work.", isDefault: true, reasoningEfforts: CLAUDE_REASONING_EFFORTS, maxThinkingTokens: 32768 },
  { id: "claude-sonnet-4-5-20241022", displayName: "Claude Sonnet 4.5", description: "Previous-gen Sonnet — stable and cost-effective.", isDefault: false, reasoningEfforts: CLAUDE_REASONING_EFFORTS, maxThinkingTokens: 32768 },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", description: "Fastest Claude variant for lightweight tasks.", isDefault: false, reasoningEfforts: CLAUDE_REASONING_EFFORTS, maxThinkingTokens: 32768 },
];

function normalizeReasoningEffort(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized.length) return null;
  return normalized;
}

const KNOWN_CODEX_EFFORTS = new Set(CODEX_REASONING_EFFORTS.map((e) => e.effort));

function validateReasoningEffort(provider: "codex" | "claude", effort: string | null | undefined): string | null {
  if (!effort) return null;
  if (provider === "codex" && !KNOWN_CODEX_EFFORTS.has(effort)) {
    return DEFAULT_REASONING_EFFORT;
  }
  if (provider === "claude" && !KNOWN_CLAUDE_EFFORTS.has(effort)) {
    return "medium";
  }
  return effort;
}

function describeClaudeModel(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return null;
  if (normalized.includes("opus")) return "Highest capability for complex strategy and review.";
  if (normalized.includes("sonnet")) return "Balanced quality and speed for everyday work.";
  if (normalized.includes("haiku")) return "Fastest Claude variant for lightweight tasks.";
  return null;
}

function isChatToolType(toolType: TerminalToolType | null | undefined): toolType is "codex-chat" | "claude-chat" | "ai-chat" {
  return toolType === "codex-chat" || toolType === "claude-chat" || toolType === "ai-chat";
}

function providerFromToolType(toolType: TerminalToolType | null | undefined): AgentChatProvider {
  if (toolType === "ai-chat") return "unified";
  return toolType === "claude-chat" ? "claude" : "codex";
}

function toolTypeFromProvider(provider: AgentChatProvider): "codex-chat" | "claude-chat" | "ai-chat" {
  if (provider === "unified") return "ai-chat";
  return provider === "claude" ? "claude-chat" : "codex-chat";
}

function mapTerminalStatusToChatStatus(status: TerminalSessionStatus): AgentChatSession["status"] {
  if (status === "running") return "idle";
  return "ended";
}

function mapCommandStatus(raw: string | null | undefined): "running" | "completed" | "failed" {
  if (raw === "completed") return "completed";
  if (raw === "failed" || raw === "declined") return "failed";
  return "running";
}

function mapFileChangeKind(raw: unknown): "create" | "modify" | "delete" {
  const type = typeof raw === "string"
    ? raw
    : raw && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string"
      ? String((raw as { type?: unknown }).type)
      : "update";
  if (type === "add") return "create";
  if (type === "delete") return "delete";
  return "modify";
}

function mapCodexTurnStatus(raw: unknown): "completed" | "interrupted" | "failed" {
  const value = typeof raw === "string" ? raw : "";
  if (value === "interrupted") return "interrupted";
  if (value === "failed") return "failed";
  return "completed";
}

function formatCodexErrorInfo(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mapApprovalDecisionForCodex(decision: AgentChatApprovalDecision): "accept" | "acceptForSession" | "decline" | "cancel" {
  if (decision === "accept_for_session") return "acceptForSession";
  if (decision === "accept") return "accept";
  if (decision === "cancel") return "cancel";
  return "decline";
}

function normalizePreview(text: string, maxChars = 220): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const preview = lines[lines.length - 1] ?? "";
  return preview.length > maxChars ? preview.slice(0, maxChars) : preview;
}

function sanitizeAutoTitle(raw: string, maxChars = AUTO_TITLE_MAX_CHARS): string | null {
  const normalized = raw
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N})\]]+$/gu, "")
    .trim();
  if (!normalized.length) return null;
  const lowercase = normalized.toLowerCase();
  const collapsed = lowercase.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (
    collapsed === "completed"
    || collapsed === "complete"
    || collapsed === "done"
    || collapsed === "finished"
    || collapsed === "resolved"
    || collapsed === "success"
    || collapsed === "session closed"
    || collapsed === "chat completed"
  ) {
    return null;
  }

  if (/^(completed?|done|finished|resolved|success)\b/u.test(collapsed)) {
    const remainder = collapsed.replace(/^(completed?|done|finished|resolved|success)\b/u, "").trim();
    const remainderTokens = remainder.length ? remainder.split(/\s+/).filter(Boolean) : [];
    const genericRemainder = remainderTokens.every((token) =>
      /^(ok|okay|yes|no|true|false|ready|response|reply|result|output|pass|passed)$/u.test(token)
    );
    if (!remainderTokens.length || remainderTokens.length <= 2 || genericRemainder) {
      return null;
    }
  }

  if (/^(session closed|chat completed)\b/u.test(collapsed)) {
    return null;
  }
  return normalized.length > maxChars ? normalized.slice(0, maxChars).trimEnd() : normalized;
}

function defaultChatSessionTitle(provider: AgentChatProvider): string {
  if (provider === "codex") return "Codex Chat";
  if (provider === "claude") return "Claude Chat";
  return "AI Chat";
}

function hasCustomChatSessionTitle(title: string | null | undefined, provider: AgentChatProvider): boolean {
  const normalized = String(title ?? "").trim();
  return normalized.length > 0 && normalized !== defaultChatSessionTitle(provider);
}

function resumeCommandForProvider(provider: AgentChatProvider, sessionId: string): string {
  if (provider === "codex") return "chat:codex";
  if (provider === "unified") return `chat:unified:${sessionId}`;
  return `chat:claude:${sessionId}`;
}

function parseJsonLine(raw: string): JsonRpcEnvelope | null {
  const line = raw.trim();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as JsonRpcEnvelope;
  } catch {
    return null;
  }
}

function resolveModelIdFromStoredValue(
  model: string,
  providerHint?: AgentChatProvider,
): string | undefined {
  const normalized = model.trim().toLowerCase();
  if (!normalized.length) return undefined;

  const aliasMatch = resolveModelAlias(normalized);
  if (aliasMatch) {
    if (providerHint === "codex" && !(aliasMatch.family === "openai" && aliasMatch.isCliWrapped)) return undefined;
    if (providerHint === "claude" && !(aliasMatch.family === "anthropic" && aliasMatch.isCliWrapped)) return undefined;
    if (providerHint === "unified" && aliasMatch.isCliWrapped) return undefined;
    return aliasMatch.id;
  }

  const matches = MODEL_REGISTRY.filter(
    (entry) =>
      entry.id.toLowerCase() === normalized
      || entry.shortId.toLowerCase() === normalized
      || entry.sdkModelId.toLowerCase() === normalized
  );
  if (!matches.length) return undefined;

  const prefer = (() => {
    if (providerHint === "codex") {
      return matches.find((entry) => entry.isCliWrapped && entry.family === "openai");
    }
    if (providerHint === "claude") {
      return matches.find((entry) => entry.isCliWrapped && entry.family === "anthropic");
    }
    if (providerHint === "unified") {
      return matches.find((entry) => !entry.isCliWrapped);
    }
    return undefined;
  })();
  if (prefer) return prefer.id;

  return matches[0]?.id;
}

function fallbackModelForProvider(provider: AgentChatProvider): string {
  if (provider === "codex") return DEFAULT_CODEX_MODEL;
  if (provider === "claude") return DEFAULT_CLAUDE_MODEL;
  return DEFAULT_UNIFIED_MODEL_ID;
}

// Permission mapping functions are shared with the orchestrator/mission system.
// Delegate to the single source of truth in permissionMapping.ts.
import {
  mapPermissionToClaude,
  mapPermissionToCodex
} from "../orchestrator/permissionMapping";

/** Spread-ready codex policy args (approvalPolicy + sandbox) or empty object if null. */
function codexPolicyArgs(policy: ReturnType<typeof mapPermissionToCodex>): Record<string, string> {
  return policy ? { approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox } : {};
}

function normalizePersistedPermissionMode(value: unknown): AgentChatSession["permissionMode"] | undefined {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw.length) return undefined;
  if (raw === "default" || raw === "plan" || raw === "edit" || raw === "full-auto" || raw === "config-toml") {
    return raw;
  }
  return undefined;
}

function normalizeIdentityKey(value: unknown): AgentChatIdentityKey | undefined {
  return value === "cto" ? "cto" : undefined;
}

function normalizeCapabilityMode(value: unknown): CtoCapabilityMode | undefined {
  if (value === "full_mcp" || value === "fallback") {
    return value;
  }
  return undefined;
}

function inferCapabilityMode(provider: AgentChatProvider): CtoCapabilityMode {
  return provider === "codex" || provider === "claude" ? "full_mcp" : "fallback";
}

function resolveMcpRuntimeRoot(): string {
  const startPoints = [process.cwd(), __dirname];
  for (const start of startPoints) {
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i += 1) {
      if (fs.existsSync(path.join(dir, "apps", "mcp-server", "package.json"))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

function toIso(): string {
  return new Date().toISOString();
}

function fileSizeOrZero(filePath: string): number {
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

export function createAgentChatService(args: {
  projectRoot: string;
  adeDir: string;
  transcriptsDir: string;
  projectId?: string;
  memoryService?: ReturnType<typeof createMemoryService> | null;
  packService?: ReturnType<typeof createPackService> | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  logger: Logger;
  appVersion: string;
  onEvent?: (event: AgentChatEventEnvelope) => void;
  onSessionEnded?: (args: { laneId: string; sessionId: string; exitCode: number | null }) => void;
}) {
  const {
    projectRoot,
    adeDir,
    transcriptsDir,
    projectId,
    memoryService,
    packService,
    ctoStateService,
    laneService,
    sessionService,
    projectConfigService,
    logger,
    appVersion,
    onEvent,
    onSessionEnded
  } = args;

  const chatSessionsDir = path.join(adeDir, "chat-sessions");
  const chatTranscriptsDir = path.join(adeDir, "chat-transcripts");
  fs.mkdirSync(chatSessionsDir, { recursive: true });
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(chatTranscriptsDir, { recursive: true });

  const claudeProvider = createClaudeCode();
  const managedSessions = new Map<string, ManagedChatSession>();

  const buildAdeMcpServers = (
    provider: "claude" | "codex",
    defaultRole: "agent" | "cto",
  ): Record<string, Record<string, unknown>> => {
    const launch = resolveAdeMcpServerLaunch({
      workspaceRoot: projectRoot,
      runtimeRoot: resolveMcpRuntimeRoot(),
      defaultRole
    });
    return normalizeCliMcpServers(provider, {
      ade: {
        command: launch.command,
        args: launch.cmdArgs,
        env: launch.env
      }
    }) ?? {};
  };

  const refreshReconstructionContext = (managed: ManagedChatSession): void => {
    if (managed.session.identityKey !== "cto" || !ctoStateService) {
      managed.pendingReconstructionContext = null;
      return;
    }
    managed.pendingReconstructionContext = ctoStateService.buildReconstructionContext(8);
  };

  const applyReconstructionContextToStreamingRuntime = (
    managed: ManagedChatSession,
    runtime: ClaudeRuntime | UnifiedRuntime
  ): void => {
    const context = managed.pendingReconstructionContext?.trim() ?? "";
    if (!context.length) return;
    runtime.messages.push({
      role: "user",
      content: [
        "System context (CTO reconstruction, do not echo verbatim):",
        context
      ].join("\n")
    });
    managed.pendingReconstructionContext = null;
    persistChatState(managed);
  };

  const detectAuth = async () => {
    const snapshot = projectConfigService.get();
    const configured = snapshot.effective.ai?.apiKeys;
    const configApiKeys: Record<string, string> = {};
    if (configured && typeof configured === "object") {
      for (const [provider, value] of Object.entries(configured as Record<string, unknown>)) {
        const key = typeof value === "string" ? value.trim() : "";
        if (!key.length) continue;
        configApiKeys[String(provider).trim().toLowerCase()] = key;
      }
    }
    return detectAllAuth(configApiKeys);
  };

  const setManagedSessionTitle = (managed: ManagedChatSession, rawTitle: string): string | null => {
    const title = sanitizeAutoTitle(rawTitle);
    if (!title) return null;

    const currentTitle = sessionService.get(managed.session.id)?.title ?? null;
    if (currentTitle?.trim() === title) return title;

    sessionService.updateMeta({ sessionId: managed.session.id, title });
    return title;
  };

  const maybeAutoTitleSession = async (
    managed: ManagedChatSession,
    args: { stage: "initial" | "final"; latestUserText?: string | null; summary?: string | null }
  ): Promise<void> => {
    const config = resolveChatConfig();
    if (!config.autoTitleEnabled) return;
    if (managed.autoTitleInFlight) return;
    if (args.stage === "initial" && managed.autoTitleStage !== "none") return;
    if (args.stage === "final") {
      if (!config.autoTitleRefreshOnComplete) return;
      if (managed.autoTitleStage === "final") return;
    }

    const seed = sanitizeAutoTitle(args.latestUserText ?? managed.autoTitleSeed ?? "", 180);
    if (!seed) return;

    const auth = await detectAuth();
    const availableModels = getRegistryModels(auth).filter((descriptor) => !descriptor.deprecated);
    if (!availableModels.length) return;

    const preferredModelId =
      [
        config.autoTitleModelId,
        DEFAULT_AUTO_TITLE_MODEL_ID,
        "anthropic/claude-haiku-4-5",
        "openai/codex-mini-latest",
        "openai/gpt-4.1-mini",
        "openai/gpt-5.4",
        availableModels[0]?.id,
      ].find((candidate) => {
        const modelId = typeof candidate === "string" ? candidate.trim() : "";
        return modelId.length > 0 && availableModels.some((descriptor) => descriptor.id === modelId);
      }) ?? null;

    if (!preferredModelId) return;

    const descriptor = getModelById(preferredModelId);
    if (!descriptor) return;

    const laneName = sessionService.get(managed.session.id)?.laneName ?? "Current lane";
    const currentTitle = sessionService.get(managed.session.id)?.title ?? null;
    const titleContext = [
      `Lane: ${laneName}`,
      `Model: ${getModelById(managed.session.modelId ?? "")?.displayName ?? managed.session.model}`,
      `Primary request: ${seed}`,
      args.summary?.trim().length
        ? `Latest outcome: ${args.summary.trim()}`
        : managed.preview?.trim().length
          ? `Latest output: ${managed.preview.trim()}`
          : null,
      hasCustomChatSessionTitle(currentTitle, managed.session.provider)
        ? `Current title: ${String(currentTitle).trim()}`
        : null,
    ].filter((line): line is string => Boolean(line && line.trim().length));

    managed.autoTitleInFlight = true;
    try {
      const resolvedModel = await resolveModel(descriptor.id, auth, {
        cwd: managed.laneWorktreePath,
        middleware: false,
      });
      const result = await generateText({
        model: resolvedModel,
        system: AUTO_TITLE_SYSTEM_PROMPT,
        prompt: [
          args.stage === "final"
            ? "Write a final concise title for this completed coding chat."
            : "Write a concise title for this new coding chat.",
          titleContext.join("\n"),
        ].join("\n\n"),
      });
      const nextTitle = setManagedSessionTitle(managed, result.text);
      if (!nextTitle) return;
      managed.autoTitleStage = args.stage;
    } catch (error) {
      logger.warn("agent_chat.auto_title_failed", {
        sessionId: managed.session.id,
        stage: args.stage,
        modelId: descriptor.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      managed.autoTitleInFlight = false;
    }
  };

  // Unified session support — for API-key / local models using streamText + universal tools.
  // CLI-wrapped models fall through to the existing Claude/Codex runtimes.
  const startUnifiedSession = async (managed: ManagedChatSession): Promise<"handled" | "fallthrough"> => {
    const modelId = managed.session.modelId;
    if (!modelId) return "fallthrough";

    const descriptor = getModelById(modelId);
    if (!descriptor) return "fallthrough";

    // CLI-wrapped models -> defer to CLI session runtimes.
    if (descriptor.isCliWrapped) return "fallthrough";

    logger.info("agent_chat.unified_session_starting", {
      sessionId: managed.session.id,
      modelId,
      family: descriptor.family,
    });

    const auth = await detectAuth();
    const resolvedModel = await resolveModel(modelId, auth, {
      cwd: managed.laneWorktreePath,
    });

    const chatConfig = resolveChatConfig();
    // Map AgentChatPermissionMode to PermissionMode ("default" → "edit" for unified models)
    const sessionPermMode = managed.session.permissionMode;
    const mappedSessionPermMode: PermissionMode | undefined =
      sessionPermMode === "default" ? "edit"
      : sessionPermMode === "plan" || sessionPermMode === "edit" || sessionPermMode === "full-auto" ? sessionPermMode
      : undefined;
    const permMode: PermissionMode = mappedSessionPermMode ?? chatConfig.unifiedPermissionMode;

    const runtime: UnifiedRuntime = {
      kind: "unified",
      messages: [],
      busy: false,
      abortController: null,
      activeTurnId: null,
      permissionMode: permMode,
      pendingApprovals: new Map(),
      pendingSteers: [],
      interrupted: false,
      resolvedModel,
      modelDescriptor: descriptor,
    };

    managed.runtime = runtime;
    managed.session.provider = "unified";
    managed.session.capabilityMode = "fallback";
    return "handled";
  };

  const resolveChatConfig = (): ResolvedChatConfig => {
    const snapshot = projectConfigService.get();
    const ai = snapshot.effective.ai ?? {};
    const permissions = ai.permissions ?? {};
    const chat = ai.chat ?? {};
    const cliMode = permissions.cli?.mode ?? "edit";
    const inProcessMode = permissions.inProcess?.mode ?? "edit";

    const approvalPolicy = (() => {
      if (chat.defaultApprovalPolicy === "auto") return "never" as const;
      if (chat.defaultApprovalPolicy === "approve_all") return "untrusted" as const;
      if (chat.defaultApprovalPolicy === "approve_mutations") return "on-request" as const;
      if (cliMode === "full-auto") return "never" as const;
      if (cliMode === "read-only") return "untrusted" as const;
      return "on-request" as const;
    })();

    const sandboxMode = (() => {
      if (chat.codexSandbox) return chat.codexSandbox;
      if (permissions.cli?.sandboxPermissions) return permissions.cli.sandboxPermissions;
      return "workspace-write" as const;
    })();

    const claudePermissionMode = (() => {
      if (chat.claudePermissionMode) return chat.claudePermissionMode;
      if (cliMode === "read-only") return "plan" as const;
      if (cliMode === "full-auto") return "bypassPermissions" as const;
      return "acceptEdits" as const;
    })();

    const unifiedPermissionMode = (() => {
      if (chat.unifiedPermissionMode === "plan" || chat.unifiedPermissionMode === "edit" || chat.unifiedPermissionMode === "full-auto") {
        return chat.unifiedPermissionMode;
      }
      if (inProcessMode === "plan" || inProcessMode === "edit" || inProcessMode === "full-auto") {
        return inProcessMode;
      }
      if (claudePermissionMode === "bypassPermissions") return "full-auto" as const;
      if (claudePermissionMode === "plan") return "plan" as const;
      return "edit" as const;
    })();

    const budget = Number(chat.sessionBudgetUsd ?? permissions.cli?.maxBudgetUsd ?? NaN);
    const sessionBudgetUsd = Number.isFinite(budget) && budget > 0 ? budget : null;
    const autoTitleModelId = typeof chat.autoTitleModelId === "string" && chat.autoTitleModelId.trim().length
      ? chat.autoTitleModelId.trim()
      : null;

    return {
      codexApprovalPolicy: approvalPolicy,
      codexSandboxMode: sandboxMode,
      claudePermissionMode,
      unifiedPermissionMode,
      sessionBudgetUsd,
      autoTitleEnabled: chat.autoTitleEnabled === true,
      autoTitleModelId,
      autoTitleRefreshOnComplete: chat.autoTitleRefreshOnComplete !== false,
    };
  };

  const computeHeadShaBestEffort = async (laneId: string): Promise<string | null> => {
    const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
    const cwd = fs.existsSync(worktreePath) ? worktreePath : projectRoot;
    const res = await runGit(["rev-parse", "HEAD"], { cwd, timeoutMs: 8_000 });
    if (res.exitCode !== 0) return null;
    const sha = res.stdout.trim();
    return sha.length ? sha : null;
  };

  const metadataPathFor = (sessionId: string): string => path.join(chatSessionsDir, `${sessionId}.json`);

  const persistChatState = (managed: ManagedChatSession): void => {
    const payload: PersistedChatState = {
      version: 1,
      sessionId: managed.session.id,
      laneId: managed.session.laneId,
      provider: managed.session.provider,
      model: managed.session.model,
      ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
      ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
      ...(managed.session.permissionMode ? { permissionMode: managed.session.permissionMode } : {}),
      ...(managed.session.identityKey ? { identityKey: managed.session.identityKey } : {}),
      ...(managed.session.capabilityMode ? { capabilityMode: managed.session.capabilityMode } : {}),
      ...(managed.session.threadId ? { threadId: managed.session.threadId } : {}),
      ...(managed.runtime?.kind === "claude" ? { messages: managed.runtime.messages } : {}),
      ...(managed.runtime?.kind === "unified"
        ? { messages: managed.runtime.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })) }
        : {}),
      updatedAt: toIso()
    };

    try {
      fs.mkdirSync(path.dirname(managed.metadataPath), { recursive: true });
      fs.writeFileSync(managed.metadataPath, JSON.stringify(payload, null, 2), "utf8");
    } catch (error) {
      logger.warn("agent_chat.persist_failed", {
        sessionId: managed.session.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const readPersistedState = (sessionId: string): PersistedChatState | null => {
    const filePath = metadataPathFor(sessionId);
    if (!fs.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") return null;
      const record = parsed as Partial<PersistedChatState>;
      if (record.version !== 1) return null;
      const provider = record.provider;
      if (provider !== "codex" && provider !== "claude" && provider !== "unified") return null;
      const laneId = String(record.laneId ?? "").trim();
      const model = String(record.model ?? "").trim();
      const modelId = typeof record.modelId === "string" && record.modelId.trim().length
        ? (getModelById(record.modelId.trim()) ? record.modelId.trim() : undefined)
        : resolveModelIdFromStoredValue(model, provider);
      const reasoningEffort = normalizeReasoningEffort(record.reasoningEffort);
      const permissionMode = normalizePersistedPermissionMode(record.permissionMode);
      const identityKey = normalizeIdentityKey(record.identityKey);
      const capabilityMode = normalizeCapabilityMode(record.capabilityMode);
      if (!laneId || !model) return null;
      const messages = Array.isArray(record.messages)
        ? record.messages
            .filter((entry): entry is PersistedClaudeMessage => {
              if (!entry || typeof entry !== "object") return false;
              const role = (entry as { role?: unknown }).role;
              const content = (entry as { content?: unknown }).content;
              return (role === "user" || role === "assistant") && typeof content === "string";
            })
        : undefined;
      return {
        version: 1,
        sessionId,
        laneId,
        provider,
        model,
        ...(modelId ? { modelId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(identityKey ? { identityKey } : {}),
        ...(capabilityMode ? { capabilityMode } : {}),
        ...(typeof record.threadId === "string" && record.threadId.trim().length
          ? { threadId: record.threadId.trim() }
          : {}),
        ...(messages?.length ? { messages } : {}),
        updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim().length ? record.updatedAt : toIso()
      };
    } catch {
      return null;
    }
  };

  const writeTranscript = (managed: ManagedChatSession, envelope: AgentChatEventEnvelope): void => {
    if (managed.transcriptLimitReached) return;
    try {
      fs.mkdirSync(path.dirname(managed.transcriptPath), { recursive: true });
      const rawLine = `${JSON.stringify(envelope)}\n`;
      const chunk = Buffer.from(rawLine, "utf8");
      const remaining = MAX_CHAT_TRANSCRIPT_BYTES - managed.transcriptBytesWritten;
      if (remaining <= 0) {
        managed.transcriptLimitReached = true;
        void fs.promises.appendFile(managed.transcriptPath, CHAT_TRANSCRIPT_LIMIT_NOTICE, "utf8").catch(() => {});
        return;
      }
      let toWrite = chunk;
      if (chunk.length > remaining) {
        toWrite = chunk.subarray(0, remaining);
        managed.transcriptLimitReached = true;
      }
      managed.transcriptBytesWritten += toWrite.length;
      void fs.promises.appendFile(managed.transcriptPath, toWrite).then(async () => {
        if (!managed.transcriptLimitReached) return;
        await fs.promises.appendFile(managed.transcriptPath, CHAT_TRANSCRIPT_LIMIT_NOTICE, "utf8");
      }).catch(() => {
        // ignore transcript write failures
      });
    } catch {
      // ignore transcript write failures
    }

    // Also write to the dedicated chat-transcripts directory for persistence
    writeChatTranscriptLine(managed.session.id, envelope);
  };

  const writeChatTranscriptLine = (sessionId: string, envelope: AgentChatEventEnvelope): void => {
    try {
      const transcriptFile = path.join(chatTranscriptsDir, `${sessionId}.jsonl`);
      const line = `${JSON.stringify(envelope)}\n`;
      void fs.promises.appendFile(transcriptFile, line, "utf8").catch(() => {});
    } catch {
      // ignore chat transcript write failures
    }
  };

  const setSessionPreview = (managed: ManagedChatSession, candidate: string): void => {
    const next = normalizePreview(candidate);
    if (!next) return;
    if (next === managed.preview) return;
    managed.preview = next;
    sessionService.setLastOutputPreview(managed.session.id, next);
  };

  const emitChatEvent = (managed: ManagedChatSession, event: AgentChatEvent): void => {
    managed.session.lastActivityAt = toIso();

    if (event.type === "text") {
      setSessionPreview(managed, event.text);
    } else if (event.type === "command") {
      setSessionPreview(managed, event.output);
    } else if (event.type === "error") {
      setSessionPreview(managed, event.message);
    }

    if (event.type === "done") {
      const summary = managed.preview
        ? `${event.status}: ${managed.preview}`
        : `Turn ${event.status}`;
      sessionService.setSummary(managed.session.id, summary);
    }

    const envelope: AgentChatEventEnvelope = {
      sessionId: managed.session.id,
      timestamp: toIso(),
      event
    };

    writeTranscript(managed, envelope);
    onEvent?.(envelope);
  };

  /** Tear down the active runtime, releasing all resources and cancelling pending approvals. */
  const teardownRuntime = (managed: ManagedChatSession): void => {
    if (managed.runtime?.kind === "codex") {
      try { managed.runtime.reader.close(); } catch { /* ignore */ }
      try { managed.runtime.process.kill(); } catch { /* ignore */ }
      managed.runtime.pending.clear();
      managed.runtime.approvals.clear();
      managed.runtime = null;
    }
    if (managed.runtime?.kind === "claude") {
      managed.runtime.abortController?.abort();
      for (const pending of managed.runtime.approvals.values()) {
        pending.resolve("cancel");
      }
      managed.runtime.approvals.clear();
      managed.runtime = null;
    }
    if (managed.runtime?.kind === "unified") {
      managed.runtime.abortController?.abort();
      for (const pending of managed.runtime.pendingApprovals.values()) {
        pending.resolve("cancel");
      }
      managed.runtime.pendingApprovals.clear();
      managed.runtime = null;
    }
  };

  const finishSession = async (
    managed: ManagedChatSession,
    status: TerminalSessionStatus,
    options?: { exitCode?: number | null; summary?: string | null }
  ): Promise<void> => {
    if (managed.endedNotified) return;
    managed.endedNotified = true;

    if (options?.summary !== undefined) {
      sessionService.setSummary(managed.session.id, options.summary);
    }

    void maybeAutoTitleSession(managed, {
      stage: "final",
      summary: options?.summary ?? managed.preview,
    });

    const endedAt = toIso();
    sessionService.end({
      sessionId: managed.session.id,
      endedAt,
      exitCode: options?.exitCode ?? null,
      status
    });

    if (managed.session.identityKey === "cto" && ctoStateService) {
      try {
        const explicitSummary = typeof options?.summary === "string" ? options.summary.trim() : "";
        const fallbackSummary = managed.preview?.trim() ?? "";
        const summary = explicitSummary || fallbackSummary || "CTO session ended.";
        ctoStateService.appendSessionLog({
          sessionId: managed.session.id,
          summary,
          startedAt: managed.ctoSessionStartedAt ?? managed.session.createdAt,
          endedAt,
          provider: managed.session.provider,
          modelId: managed.session.modelId ?? managed.session.model,
          capabilityMode: managed.session.capabilityMode ?? inferCapabilityMode(managed.session.provider)
        });
      } catch (error) {
        logger.warn("agent_chat.cto_log_append_failed", {
          sessionId: managed.session.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const endSha = await computeHeadShaBestEffort(managed.session.laneId).catch(() => null);
    if (endSha) {
      sessionService.setHeadShaEnd(managed.session.id, endSha);
    }

    managed.session.status = "ended";
    managed.closed = true;
    managed.ctoSessionStartedAt = null;
    persistChatState(managed);

    teardownRuntime(managed);

    try {
      onSessionEnded?.({ laneId: managed.session.laneId, sessionId: managed.session.id, exitCode: options?.exitCode ?? null });
    } catch {
      // ignore callback failures
    }
  };

  const ensureManagedSession = (sessionId: string): ManagedChatSession => {
    const existing = managedSessions.get(sessionId);
    if (existing) return existing;

    const row = sessionService.get(sessionId);
    if (!row) {
      throw new Error(`Chat session '${sessionId}' was not found.`);
    }
    if (!isChatToolType(row.toolType)) {
      throw new Error(`Session '${sessionId}' is not an agent chat session.`);
    }

    const persisted = readPersistedState(sessionId);
    const provider = persisted?.provider ?? providerFromToolType(row.toolType);
    const fallbackModel = persisted?.model ?? fallbackModelForProvider(provider);
    const hydratedModelId = persisted?.modelId
      ?? resolveModelIdFromStoredValue(fallbackModel, provider)
      ?? (provider === "unified" ? DEFAULT_UNIFIED_MODEL_ID : undefined);
    const model = provider === "unified" ? (hydratedModelId ?? fallbackModel) : fallbackModel;
    const lane = laneService.getLaneBaseAndBranch(row.laneId);

    const managed: ManagedChatSession = {
      session: {
        id: sessionId,
        laneId: row.laneId,
        provider,
        model,
        ...(hydratedModelId ? { modelId: hydratedModelId } : {}),
        reasoningEffort: persisted?.reasoningEffort ?? null,
        ...(persisted?.permissionMode ? { permissionMode: persisted.permissionMode } : {}),
        ...(persisted?.identityKey ? { identityKey: persisted.identityKey } : {}),
        capabilityMode: persisted?.capabilityMode ?? inferCapabilityMode(provider),
        status: mapTerminalStatusToChatStatus(row.status),
        ...(persisted?.threadId ? { threadId: persisted.threadId } : {}),
        createdAt: row.startedAt,
        lastActivityAt: persisted?.updatedAt ?? row.endedAt ?? row.startedAt
      },
      transcriptPath: row.transcriptPath || path.join(transcriptsDir, `${sessionId}.chat.jsonl`),
      transcriptBytesWritten: fileSizeOrZero(row.transcriptPath || path.join(transcriptsDir, `${sessionId}.chat.jsonl`)),
      transcriptLimitReached: false,
      metadataPath: metadataPathFor(sessionId),
      laneWorktreePath: lane.worktreePath,
      runtime: null,
      preview: row.lastOutputPreview ?? null,
      closed: row.status !== "running",
      endedNotified: row.status !== "running",
      ctoSessionStartedAt: row.status === "running" ? row.startedAt : null,
      pendingReconstructionContext: null,
      autoTitleSeed: null,
      autoTitleStage: hasCustomChatSessionTitle(row.title, provider) ? "initial" : "none",
      autoTitleInFlight: false,
    };
    managed.transcriptLimitReached = managed.transcriptBytesWritten >= MAX_CHAT_TRANSCRIPT_BYTES;
    refreshReconstructionContext(managed);

    managedSessions.set(sessionId, managed);
    return managed;
  };

  const sendCodexMessage = async (managed: ManagedChatSession, text: string, attachments: AgentChatFileRef[] = []): Promise<void> => {
    if (!managed.session.threadId) {
      throw new Error(`Codex session '${managed.session.id}' is missing thread id.`);
    }
    if (!managed.runtime || managed.runtime.kind !== "codex") {
      throw new Error(`Codex runtime is not available for session '${managed.session.id}'.`);
    }
    if (managed.runtime.activeTurnId) {
      throw new Error("A turn is already active. Use steer or interrupt.");
    }

    const input: Array<Record<string, unknown>> = [
      {
        type: "text",
        text,
        text_elements: []
      }
    ];

    const reconstructionContext = managed.pendingReconstructionContext?.trim() ?? "";
    if (reconstructionContext.length) {
      input.unshift({
        type: "text",
        text: [
          "System context (CTO reconstruction, do not echo verbatim):",
          reconstructionContext
        ].join("\n"),
        text_elements: []
      });
      managed.pendingReconstructionContext = null;
    }

    for (const attachment of attachments) {
      if (attachment.type === "image") {
        input.push({ type: "localImage", path: attachment.path });
        continue;
      }
      const name = path.basename(attachment.path) || attachment.path;
      input.push({ type: "mention", name, path: attachment.path });
    }

    managed.session.status = "active";
    emitChatEvent(managed, { type: "user_message", text, attachments });

    const result = await managed.runtime.request<{ turn?: { id?: string } }>("turn/start", {
      threadId: managed.session.threadId,
      input,
      ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {})
    });

    const turnId = typeof result?.turn?.id === "string" ? result.turn.id : null;
    if (turnId) {
      managed.runtime.activeTurnId = turnId;
    }
    persistChatState(managed);
  };

  // ── Helpers for unified turn logic ──

  const mapReasoningEffortToThinking = (effort: string | null | undefined): import("../../../shared/types").ThinkingLevel | null => {
    if (!effort) return null;
    const map: Record<string, import("../../../shared/types").ThinkingLevel> = {
      none: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      max: "max",
      xhigh: "xhigh",
      extra_high: "max",
    };
    return map[effort] ?? null;
  };

  const classifyUnifiedError = (
    error: unknown,
    providerFamily: string,
    modelDisplayName: string,
  ): {
    message: string;
    errorInfo: { category: "auth" | "rate_limit" | "budget" | "network" | "unknown"; provider?: string; model?: string };
  } => {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const lower = rawMessage.toLowerCase();

    const statusCode = (error as { status?: number; statusCode?: number })?.status
      ?? (error as { status?: number; statusCode?: number })?.statusCode
      ?? null;

    if (statusCode === 429 || lower.includes("rate limit") || lower.includes("429") || lower.includes("too many requests")) {
      return {
        message: `Rate limited by ${providerFamily}. The middleware will retry automatically. If this persists, try a different model.`,
        errorInfo: { category: "rate_limit", provider: providerFamily, model: modelDisplayName },
      };
    }

    if (
      statusCode === 401 || statusCode === 403
      || lower.includes("unauthorized") || lower.includes("forbidden")
      || lower.includes("authentication failed") || lower.includes("invalid api key")
      || lower.includes("api key") || lower.includes("invalid_api_key")
    ) {
      return {
        message: `Authentication failed for ${modelDisplayName}. Check your API key in Settings.`,
        errorInfo: { category: "auth", provider: providerFamily, model: modelDisplayName },
      };
    }

    if (lower.includes("budget") || lower.includes("cost limit") || lower.includes("spending limit")) {
      return {
        message: "Session budget limit reached. Increase budget in Settings or start a new session.",
        errorInfo: { category: "budget", provider: providerFamily, model: modelDisplayName },
      };
    }

    if (
      lower.includes("timeout") || lower.includes("timed out") || lower.includes("econnrefused")
      || lower.includes("enotfound") || lower.includes("network") || lower.includes("fetch failed")
      || lower.includes("econnreset") || lower.includes("socket hang up")
    ) {
      return {
        message: `Connection to ${providerFamily} timed out. Check your network or try again.`,
        errorInfo: { category: "network", provider: providerFamily, model: modelDisplayName },
      };
    }

    return {
      message: rawMessage,
      errorInfo: { category: "unknown", provider: providerFamily, model: modelDisplayName },
    };
  };

  // ── Shared streaming turn for both Claude and Unified runtimes ──

  const runTurn = async (managed: ManagedChatSession, text: string, attachments: AgentChatFileRef[] = []): Promise<void> => {
    const runtimeKind = managed.runtime?.kind;
    if (runtimeKind !== "claude" && runtimeKind !== "unified") {
      throw new Error(`Streaming runtime is not available for session '${managed.session.id}'.`);
    }

    const runtime = managed.runtime as ClaudeRuntime | UnifiedRuntime;
    if (runtime.busy) {
      throw new Error("A turn is already active. Use steer or interrupt.");
    }

    const isUnified = runtimeKind === "unified";
    const turnId = randomUUID();
    runtime.busy = true;
    runtime.activeTurnId = turnId;
    runtime.interrupted = false;
    managed.session.status = "active";

    const attachmentHint = attachments.length
      ? `\n\nAttached context:\n${attachments.map((file) => `- ${file.type}: ${file.path}`).join("\n")}`
      : "";
    const userContent = `${text}${attachmentHint}`;

    applyReconstructionContextToStreamingRuntime(managed, runtime);

    runtime.messages.push({ role: "user", content: userContent });
    emitChatEvent(managed, { type: "user_message", text, attachments, turnId });
    emitChatEvent(managed, { type: "status", turnStatus: "started", turnId });

    const abortController = new AbortController();
    runtime.abortController = abortController;

    let assistantText = "";
    let usage: { inputTokens?: number | null; outputTokens?: number | null } | undefined;

    try {
      // Provider-specific stream creation
      let stream: ReturnType<typeof streamText>;

      if (isUnified) {
        const unifiedRt = runtime as UnifiedRuntime;

        const tools = createUniversalToolSet(managed.laneWorktreePath, {
          permissionMode: unifiedRt.permissionMode,
          ...(memoryService && projectId ? { memoryService, projectId } : {}),
          agentScopeOwnerId: managed.session.identityKey ?? managed.session.id,
          ...(managed.session.identityKey === "cto" && ctoStateService
            ? {
                onMemoryUpdateCore: (patch) => {
                  const snapshot = ctoStateService.updateCoreMemory(patch);
                  return {
                    version: snapshot.coreMemory.version,
                    updatedAt: snapshot.coreMemory.updatedAt
                  };
                }
              }
            : {}),
          onAskUser: async (question) => {
            const askItemId = randomUUID();
            emitChatEvent(managed, {
              type: "approval_request",
              itemId: askItemId,
              kind: "tool_call",
              description: question,
              detail: { tool: "askUser", question },
              turnId,
            });

            const decision = await new Promise<AgentChatApprovalDecision>((resolve) => {
              unifiedRt.pendingApprovals.set(askItemId, { resolve });
            });
            unifiedRt.pendingApprovals.delete(askItemId);
            return decision === "accept" ? "yes" : decision === "decline" ? "no" : String(decision);
          },
        });

        const thinkingLevel = mapReasoningEffortToThinking(managed.session.reasoningEffort);
        const providerOptions = buildProviderOptions(unifiedRt.modelDescriptor, thinkingLevel);

        stream = streamText({
          model: unifiedRt.resolvedModel,
          messages: runtime.messages.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
          tools,
          providerOptions: providerOptions as any,
          stopWhen: stepCountIs(20),
          abortSignal: abortController.signal,
          onError({ error }) {
            logger.warn("agent_chat.unified_stream_error", {
              sessionId: managed.session.id,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        });
      } else {
        const claudeRt = runtime as ClaudeRuntime;
        const chatConfig = resolveChatConfig();
        const claudePermissionMode = managed.session.permissionMode
          ? mapPermissionToClaude(managed.session.permissionMode)
          : chatConfig.claudePermissionMode;

        const canUseTool = async (toolName: string, toolInput: unknown): Promise<ClaudeToolPermissionResult> => {
          const itemId = randomUUID();
          emitChatEvent(managed, {
            type: "approval_request",
            itemId,
            kind: "tool_call",
            description: `Tool '${toolName}' requests approval`,
            detail: toolInput,
            turnId
          });

          const decision = await new Promise<AgentChatApprovalDecision>((resolve) => {
            claudeRt.approvals.set(itemId, { resolve });
          });
          claudeRt.approvals.delete(itemId);

          if (decision === "accept" || decision === "accept_for_session") {
            return { behavior: "allow" };
          }

          return {
            behavior: "deny",
            message: `Tool '${toolName}' blocked by user decision.`,
            interrupt: false
          };
        };

        const claudeOpts: Record<string, unknown> = {
          cwd: managed.laneWorktreePath,
          permissionMode: claudePermissionMode,
          settingSources: [],
          mcpServers: buildAdeMcpServers("claude", managed.session.identityKey === "cto" ? "cto" : "agent"),
          maxBudgetUsd: chatConfig.sessionBudgetUsd ?? undefined,
          canUseTool
        };
        if (managed.session.reasoningEffort) {
          const tokens = CLAUDE_EFFORT_TO_TOKENS[managed.session.reasoningEffort];
          if (tokens) {
            claudeOpts.maxThinkingTokens = tokens;
          }
        }

        stream = streamText({
          model: claudeProvider(resolveClaudeCliModel(managed.session.model), claudeOpts as any),
          messages: runtime.messages.map((message) => ({ role: message.role, content: message.content })) as any,
          abortSignal: abortController.signal,
          onError({ error }) {
            logger.warn("agent_chat.claude_stream_error", {
              sessionId: managed.session.id,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        });
      }

      // ── Shared stream processing loop ──
      for await (const part of stream.fullStream as AsyncIterable<any>) {
        if (!part || typeof part !== "object") continue;

        if (part.type === "text-delta") {
          const delta = String(part.text ?? part.textDelta ?? "");
          if (!delta.length) continue;
          assistantText += delta;
          emitChatEvent(managed, {
            type: "text",
            text: delta,
            turnId,
            itemId: typeof part.id === "string" ? part.id : undefined
          });
          continue;
        }

        if (part.type === "reasoning" || part.type === "reasoning-delta") {
          const delta = String(part.text ?? part.textDelta ?? part.delta ?? "");
          if (!delta.length) continue;
          emitChatEvent(managed, {
            type: "reasoning",
            text: delta,
            turnId,
            itemId: typeof part.id === "string" ? part.id : undefined
          });
          continue;
        }

        if (part.type === "tool-call") {
          emitChatEvent(managed, {
            type: "tool_call",
            tool: String(part.toolName ?? "tool"),
            args: part.input ?? part.args ?? part.arguments,
            itemId: String(part.toolCallId ?? randomUUID()),
            turnId
          });
          continue;
        }

        if (part.type === "tool-result") {
          emitChatEvent(managed, {
            type: "tool_result",
            tool: String(part.toolName ?? "tool"),
            result: part.output ?? part.result,
            itemId: String(part.toolCallId ?? randomUUID()),
            turnId,
            status: part.preliminary ? "running" : "completed"
          });
          continue;
        }

        if (part.type === "tool-error") {
          emitChatEvent(managed, {
            type: "error",
            message: `Tool '${String(part.toolName ?? "tool")}' failed: ${String(part.error ?? "unknown error")}`,
            turnId,
            itemId: String(part.toolCallId ?? randomUUID())
          });
          continue;
        }

        if (part.type === "tool-approval-request") {
          const itemId = String(part.approvalId ?? randomUUID());
          emitChatEvent(managed, {
            type: "approval_request",
            itemId,
            kind: "tool_call",
            description: `Approve tool '${String(part.toolCall?.toolName ?? "tool")}'`,
            detail: part.toolCall,
            turnId
          });
          continue;
        }

        if (part.type === "finish") {
          const usagePayload = (part.totalUsage ?? part.usage) as
            | {
                inputTokens?: number;
                outputTokens?: number;
                promptTokens?: number;
                completionTokens?: number;
              }
            | undefined;
          usage = {
            inputTokens: usagePayload?.inputTokens ?? usagePayload?.promptTokens ?? null,
            outputTokens: usagePayload?.outputTokens ?? usagePayload?.completionTokens ?? null,
          };
          continue;
        }

        if (part.type === "error") {
          emitChatEvent(managed, {
            type: "error",
            message: String(part.error ?? "Stream error."),
            turnId
          });
        }
      }

      // ── Shared turn completion ──
      if (assistantText.trim().length) {
        runtime.messages.push({ role: "assistant", content: assistantText });
      }

      runtime.busy = false;
      runtime.activeTurnId = null;
      runtime.abortController = null;
      managed.session.status = "idle";

      emitChatEvent(managed, { type: "status", turnStatus: "completed", turnId });
      emitChatEvent(managed, {
        type: "done",
        turnId,
        status: "completed",
        model: managed.session.model,
        ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        ...(usage ? { usage } : {})
      });

      const endSha = await computeHeadShaBestEffort(managed.session.laneId).catch(() => null);
      if (endSha) {
        sessionService.setHeadShaEnd(managed.session.id, endSha);
      }

      persistChatState(managed);

      // Process queued steers
      if (runtime.pendingSteers.length) {
        const steerText = runtime.pendingSteers.shift() ?? "";
        if (steerText.trim().length) {
          await runTurn(managed, steerText, []);
        }
      }
    } catch (error) {
      runtime.busy = false;
      runtime.activeTurnId = null;
      runtime.abortController = null;

      if (runtime.interrupted) {
        managed.session.status = "idle";
        emitChatEvent(managed, { type: "status", turnStatus: "interrupted", turnId });
        emitChatEvent(managed, {
          type: "done",
          turnId,
          status: "interrupted",
          model: managed.session.model,
          ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        });
      } else {
        managed.session.status = "idle";

        // Unified runtime provides classified error messages; Claude uses raw error text
        if (isUnified) {
          const unifiedRt = runtime as UnifiedRuntime;
          const { message: errorMessage, errorInfo } = classifyUnifiedError(
            error,
            unifiedRt.modelDescriptor.family,
            unifiedRt.modelDescriptor.displayName,
          );

          emitChatEvent(managed, {
            type: "error",
            message: errorMessage,
            turnId,
            errorInfo,
          });
        } else {
          emitChatEvent(managed, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
            turnId
          });
        }

        emitChatEvent(managed, { type: "status", turnStatus: "failed", turnId });
        emitChatEvent(managed, {
          type: "done",
          turnId,
          status: "failed",
          model: managed.session.model,
          ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        });
      }

      persistChatState(managed);
    }
  };

  const handleCodexServerRequest = (managed: ManagedChatSession, runtime: CodexRuntime, payload: JsonRpcEnvelope): void => {
    const method = typeof payload.method === "string" ? payload.method : "";
    const id = payload.id;
    if (id == null) return;

    if (method === "item/commandExecution/requestApproval") {
      const params = (payload.params as { itemId?: string; command?: string; cwd?: string; reason?: string } | null) ?? {};
      const itemId = String(params.itemId ?? randomUUID());
      runtime.approvals.set(itemId, { requestId: id, kind: "command" });
      emitChatEvent(managed, {
        type: "approval_request",
        itemId,
        kind: "command",
        description: params.reason?.trim() || `Run command: ${params.command ?? "command"}`,
        detail: {
          command: params.command ?? null,
          cwd: params.cwd ?? null,
          reason: params.reason ?? null
        },
        turnId: runtime.activeTurnId ?? undefined
      });
      return;
    }

    if (method === "item/fileChange/requestApproval") {
      const params = (payload.params as { itemId?: string; reason?: string; grantRoot?: string } | null) ?? {};
      const itemId = String(params.itemId ?? randomUUID());
      runtime.approvals.set(itemId, { requestId: id, kind: "file_change" });
      emitChatEvent(managed, {
        type: "approval_request",
        itemId,
        kind: "file_change",
        description: params.reason?.trim() || "Approve file changes",
        detail: {
          grantRoot: params.grantRoot ?? null,
          reason: params.reason ?? null
        },
        turnId: runtime.activeTurnId ?? undefined
      });
      return;
    }

    runtime.sendError(id, `Unsupported server request: ${method || "unknown"}`);
  };

  const handleCodexItemEvent = (
    managed: ManagedChatSession,
    runtime: CodexRuntime,
    item: Record<string, unknown>,
    eventKind: "started" | "completed"
  ): void => {
    const itemId = String(item.id ?? randomUUID());
    const itemType = String(item.type ?? "");
    const turnId = runtime.activeTurnId ?? undefined;

    if (itemType === "commandExecution") {
      const status = mapCommandStatus(
        String(item.status ?? (eventKind === "completed" ? "completed" : "inProgress"))
      );
      const output = String(item.aggregatedOutput ?? runtime.commandOutputByItemId.get(itemId) ?? "");
      runtime.commandOutputByItemId.set(itemId, output);
      emitChatEvent(managed, {
        type: "command",
        command: String(item.command ?? "command"),
        cwd: String(item.cwd ?? managed.laneWorktreePath),
        output,
        itemId,
        turnId,
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
        durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
        status
      });
      return;
    }

    if (itemType === "fileChange") {
      const changes = Array.isArray(item.changes)
        ? item.changes
            .map((change) => {
              if (!change || typeof change !== "object") return null;
              const record = change as { path?: unknown; kind?: unknown; diff?: unknown };
              const filePath = typeof record.path === "string" ? record.path : "";
              if (!filePath) return null;
              return {
                path: filePath,
                kind: mapFileChangeKind(record.kind),
                diff: typeof record.diff === "string" ? record.diff : ""
              };
            })
            .filter((entry): entry is { path: string; kind: "create" | "modify" | "delete"; diff: string } => entry != null)
        : [];

      runtime.fileChangesByItemId.set(itemId, changes.map((change) => ({ path: change.path, kind: change.kind })));

      const status = mapCommandStatus(
        String(item.status ?? (eventKind === "completed" ? "completed" : "inProgress"))
      );
      for (const change of changes) {
        emitChatEvent(managed, {
          type: "file_change",
          path: change.path,
          diff: change.diff || runtime.fileDeltaByItemId.get(itemId) || "",
          kind: change.kind,
          itemId,
          turnId,
          status
        });
      }
      return;
    }

    if (itemType === "mcpToolCall") {
      if (eventKind === "started") {
        emitChatEvent(managed, {
          type: "tool_call",
          tool: String(item.tool ?? "tool"),
          args: item.arguments,
          itemId,
          turnId
        });
      }
      if (eventKind === "completed") {
        const status = String(item.status ?? "completed");
        emitChatEvent(managed, {
          type: "tool_result",
          tool: String(item.tool ?? "tool"),
          result: status === "failed" ? item.error : item.result,
          itemId,
          turnId,
          status: status === "failed" ? "failed" : "completed"
        });
      }
    }
  };

  const handleCodexNotification = async (managed: ManagedChatSession, runtime: CodexRuntime, payload: JsonRpcEnvelope): Promise<void> => {
    const method = typeof payload.method === "string" ? payload.method : "";
    const params = (payload.params as Record<string, unknown> | null) ?? {};

    if (method === "turn/started") {
      const turn = (params.turn as { id?: unknown } | null) ?? null;
      const turnId = typeof turn?.id === "string" ? turn.id : null;
      runtime.activeTurnId = turnId;
      managed.session.status = "active";
      emitChatEvent(managed, {
        type: "status",
        turnStatus: "started",
        ...(turnId ? { turnId } : {})
      });
      persistChatState(managed);
      return;
    }

    if (method === "turn/completed") {
      const turn = (params.turn as { id?: unknown; status?: unknown; error?: { message?: unknown; codexErrorInfo?: unknown } | null } | null) ?? null;
      const turnId = typeof turn?.id === "string" ? turn.id : runtime.activeTurnId ?? randomUUID();
      runtime.activeTurnId = null;
      const status = mapCodexTurnStatus(turn?.status);
      managed.session.status = "idle";

      if (status === "failed" && turn?.error?.message) {
        emitChatEvent(managed, {
          type: "error",
          message: String(turn.error.message),
          turnId,
          errorInfo: formatCodexErrorInfo(turn.error.codexErrorInfo)
        });
      }

      emitChatEvent(managed, {
        type: "status",
        turnStatus: status,
        turnId,
        ...(status === "failed" && turn?.error?.message
          ? { message: String(turn.error.message) }
          : {})
      });

      emitChatEvent(managed, {
        type: "done",
        turnId,
        status,
        model: managed.session.model,
        ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
      });

      const endSha = await computeHeadShaBestEffort(managed.session.laneId).catch(() => null);
      if (endSha) {
        sessionService.setHeadShaEnd(managed.session.id, endSha);
      }

      persistChatState(managed);
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = String((params.delta as string | undefined) ?? "");
      if (!delta.length) return;
      emitChatEvent(managed, {
        type: "text",
        text: delta,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        itemId: typeof params.itemId === "string" ? params.itemId : undefined
      });
      return;
    }

    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const delta = String((params.delta as string | undefined) ?? "");
      if (!delta.length) return;
      emitChatEvent(managed, {
        type: "reasoning",
        text: delta,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        itemId: typeof params.itemId === "string" ? params.itemId : undefined,
        summaryIndex: typeof params.summaryIndex === "number" ? params.summaryIndex : undefined
      });
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      const itemId = String((params.itemId as string | undefined) ?? randomUUID());
      const delta = String((params.delta as string | undefined) ?? "");
      const next = `${runtime.commandOutputByItemId.get(itemId) ?? ""}${delta}`;
      runtime.commandOutputByItemId.set(itemId, next);
      emitChatEvent(managed, {
        type: "command",
        command: "command",
        cwd: managed.laneWorktreePath,
        output: delta,
        itemId,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        status: "running"
      });
      return;
    }

    if (method === "item/fileChange/outputDelta") {
      const itemId = String((params.itemId as string | undefined) ?? randomUUID());
      const delta = String((params.delta as string | undefined) ?? "");
      const next = `${runtime.fileDeltaByItemId.get(itemId) ?? ""}${delta}`;
      runtime.fileDeltaByItemId.set(itemId, next);

      const knownChanges = runtime.fileChangesByItemId.get(itemId) ?? [];
      if (knownChanges.length) {
        for (const change of knownChanges) {
          emitChatEvent(managed, {
            type: "file_change",
            path: change.path,
            kind: change.kind,
            diff: delta,
            itemId,
            turnId: typeof params.turnId === "string" ? params.turnId : undefined,
            status: "running"
          });
        }
      } else {
        emitChatEvent(managed, {
          type: "file_change",
          path: "(pending file)",
          kind: "modify",
          diff: delta,
          itemId,
          turnId: typeof params.turnId === "string" ? params.turnId : undefined,
          status: "running"
        });
      }
      return;
    }

    if (method === "turn/plan/updated") {
      const plan = Array.isArray(params.plan) ? params.plan : [];
      const steps = plan
        .map((step) => {
          if (!step || typeof step !== "object") return null;
          const record = step as { step?: unknown; status?: unknown };
          const text = typeof record.step === "string" ? record.step : "";
          if (!text) return null;
          const rawStatus = typeof record.status === "string" ? record.status : "pending";
          const mappedStatus = rawStatus === "completed"
            ? "completed"
            : rawStatus === "inProgress"
              ? "in_progress"
              : rawStatus === "failed"
                ? "failed"
              : "pending";
          return {
            text,
            status: mappedStatus
          };
        })
        .filter((entry): entry is { text: string; status: "pending" | "in_progress" | "completed" | "failed" } => entry != null);

      emitChatEvent(managed, {
        type: "plan",
        steps,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        explanation: typeof params.explanation === "string" ? params.explanation : null
      });
      return;
    }

    if (method === "item/started") {
      const item = (params.item as Record<string, unknown> | null) ?? null;
      if (!item) return;
      handleCodexItemEvent(managed, runtime, item, "started");
      return;
    }

    if (method === "item/completed") {
      const item = (params.item as Record<string, unknown> | null) ?? null;
      if (!item) return;
      handleCodexItemEvent(managed, runtime, item, "completed");
      return;
    }

    if (method === "error") {
      const error = (params.error as { message?: unknown; codexErrorInfo?: unknown } | null) ?? null;
      emitChatEvent(managed, {
        type: "error",
        message: String(error?.message ?? "Codex app-server error."),
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        errorInfo: formatCodexErrorInfo(error?.codexErrorInfo)
      });
    }
  };

  const startCodexRuntime = async (managed: ManagedChatSession): Promise<CodexRuntime> => {
    const proc = spawn("codex", ["app-server"], {
      cwd: managed.laneWorktreePath,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const reader = readline.createInterface({ input: proc.stdout });
    const pending = new Map<string, PendingRpc>();

    const runtime: CodexRuntime = {
      kind: "codex",
      process: proc,
      reader,
      nextRequestId: 1,
      pending,
      approvals: new Map<string, PendingCodexApproval>(),
      activeTurnId: null,
      threadResumed: false,
      commandOutputByItemId: new Map<string, string>(),
      fileDeltaByItemId: new Map<string, string>(),
      fileChangesByItemId: new Map<string, Array<{ path: string; kind: "create" | "modify" | "delete" }>>(),
      request: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
        const id = runtime.nextRequestId;
        runtime.nextRequestId += 1;

        const payload: JsonRpcEnvelope = {
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {})
        };

        if (!proc.stdin.writable) {
          throw new Error("Codex app-server stdin is not writable.");
        }

        return new Promise<T>((resolve, reject) => {
          pending.set(String(id), { resolve, reject });
          proc.stdin.write(`${JSON.stringify(payload)}\n`);
        });
      },
      notify: (method: string, params?: unknown) => {
        if (!proc.stdin.writable) return;
        const payload: JsonRpcEnvelope = {
          jsonrpc: "2.0",
          method,
          ...(params !== undefined ? { params } : {})
        };
        proc.stdin.write(`${JSON.stringify(payload)}\n`);
      },
      sendResponse: (id: string | number, result: unknown) => {
        if (!proc.stdin.writable) return;
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
      },
      sendError: (id: string | number, message: string) => {
        if (!proc.stdin.writable) return;
        proc.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message } })}\n`
        );
      }
    };

    reader.on("line", (line) => {
      const payload = parseJsonLine(line);
      if (!payload) return;

      if (payload.method && payload.id != null) {
        handleCodexServerRequest(managed, runtime, payload);
        return;
      }

      if (payload.method) {
        void handleCodexNotification(managed, runtime, payload).catch((error) => {
          logger.warn("agent_chat.codex_notification_failed", {
            sessionId: managed.session.id,
            method: payload.method,
            error: error instanceof Error ? error.message : String(error)
          });
        });
        return;
      }

      if (payload.id != null) {
        const key = String(payload.id);
        const request = pending.get(key);
        if (!request) return;
        pending.delete(key);

        if (payload.error) {
          request.reject(new Error(payload.error.message || "Codex request failed."));
          return;
        }

        request.resolve(payload.result);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (!text.length) return;
      logger.warn("agent_chat.codex_stderr", {
        sessionId: managed.session.id,
        line: text
      });
    });

    proc.on("exit", (code, signal) => {
      const message = `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;

      for (const request of pending.values()) {
        request.reject(new Error(message));
      }
      pending.clear();

      runtime.approvals.clear();

      if (managed.closed || managed.session.status === "ended") return;

      emitChatEvent(managed, {
        type: "error",
        message
      });

      void finishSession(managed, "failed", {
        summary: message,
        exitCode: code ?? null
      }).catch(() => {});
    });

    await runtime.request("initialize", {
      clientInfo: {
        name: "ade",
        title: "ADE",
        version: appVersion
      },
      capabilities: {
        experimentalApi: true
      }
    });

    runtime.notify("initialized");
    return runtime;
  };

  const ensureCodexSessionRuntime = async (managed: ManagedChatSession): Promise<CodexRuntime> => {
    if (managed.runtime?.kind === "codex") return managed.runtime;
    const runtime = await startCodexRuntime(managed);
    managed.runtime = runtime;
    return runtime;
  };

  type CodexPolicy = {
    approvalPolicy: "untrusted" | "on-request" | "on-failure" | "never";
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
  } | null;

  const resolveCodexThreadParams = (managed: ManagedChatSession): {
    codexPolicy: CodexPolicy;
    mcpServers: Record<string, Record<string, unknown>>;
  } => {
    const config = resolveChatConfig();
    const codexPolicy = managed.session.permissionMode
      ? mapPermissionToCodex(managed.session.permissionMode)
      : { approvalPolicy: config.codexApprovalPolicy, sandbox: config.codexSandboxMode };
    const mcpServers = buildAdeMcpServers("codex", managed.session.identityKey === "cto" ? "cto" : "agent");
    return { codexPolicy, mcpServers };
  };

  const startFreshCodexThread = async (
    managed: ManagedChatSession,
    runtime: CodexRuntime,
    codexPolicy: CodexPolicy,
    mcpServers: Record<string, Record<string, unknown>>,
  ): Promise<void> => {
    const startResponse = await runtime.request<{ thread?: { id?: string } }>("thread/start", {
      model: managed.session.model,
      ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
      cwd: managed.laneWorktreePath,
      mcpServers,
      mcp_servers: mcpServers,
      ...codexPolicyArgs(codexPolicy),
      experimentalRawEvents: false,
      persistExtendedHistory: true
    });
    const newThreadId = typeof startResponse.thread?.id === "string" ? startResponse.thread.id : undefined;
    if (newThreadId) {
      managed.session.threadId = newThreadId;
      sessionService.setResumeCommand(managed.session.id, `chat:codex:${newThreadId}`);
    }
    runtime.threadResumed = true;
    persistChatState(managed);
  };

  const ensureClaudeSessionRuntime = (managed: ManagedChatSession): ClaudeRuntime => {
    if (managed.runtime?.kind === "claude") return managed.runtime;

    const persisted = readPersistedState(managed.session.id);
    const runtime: ClaudeRuntime = {
      kind: "claude",
      messages: persisted?.messages ?? [],
      busy: false,
      abortController: null,
      activeTurnId: null,
      pendingSteers: [],
      approvals: new Map<string, PendingClaudeApproval>(),
      interrupted: false
    };

    managed.runtime = runtime;
    return runtime;
  };

  const listCodexModelsFromAppServer = async (): Promise<AgentChatModelInfo[]> => {
    const tempSession: ManagedChatSession = {
      session: {
        id: randomUUID(),
        laneId: "temporary",
        provider: "codex",
        model: DEFAULT_CODEX_MODEL,
        capabilityMode: "full_mcp",
        status: "idle",
        createdAt: toIso(),
        lastActivityAt: toIso()
      },
      transcriptPath: path.join(transcriptsDir, `${randomUUID()}.chat.jsonl`),
      transcriptBytesWritten: 0,
      transcriptLimitReached: false,
      metadataPath: metadataPathFor(randomUUID()),
      laneWorktreePath: projectRoot,
      runtime: null,
      preview: null,
      closed: false,
      endedNotified: false,
      ctoSessionStartedAt: null,
      pendingReconstructionContext: null,
      autoTitleSeed: null,
      autoTitleStage: "none",
      autoTitleInFlight: false,
    };

    let runtime: CodexRuntime | null = null;

    try {
      runtime = await startCodexRuntime(tempSession);
      const response = await runtime.request<{ data?: Array<Record<string, unknown>> }>("model/list", {});
      const rows = Array.isArray(response?.data) ? response.data : [];
      const models = rows
        .map((row): AgentChatModelInfo | null => {
          const id = typeof row.id === "string" ? row.id.trim() : "";
          if (!id) return null;

          const displayName = typeof row.displayName === "string" && row.displayName.trim().length
            ? row.displayName.trim()
            : id;
          const description = typeof row.description === "string" && row.description.trim().length
            ? row.description.trim()
            : null;
          const isDefault = Boolean(row.isDefault);

          const reasoningEfforts = Array.isArray(row.supportedReasoningEfforts)
            ? row.supportedReasoningEfforts
                .map((entry) => {
                  if (typeof entry === "string") {
                    const effort = normalizeReasoningEffort(entry);
                    return effort
                      ? {
                          effort,
                          description:
                            CODEX_REASONING_EFFORTS.find((option) => option.effort === effort)?.description ?? ""
                        }
                      : null;
                  }
                  if (!entry || typeof entry !== "object") return null;
                  const effort = normalizeReasoningEffort((entry as { reasoningEffort?: unknown }).reasoningEffort);
                  const detail = typeof (entry as { description?: unknown }).description === "string"
                    ? String((entry as { description?: unknown }).description)
                    : "";
                  if (!effort) return null;
                  return { effort, description: detail };
                })
                .filter((entry): entry is { effort: string; description: string } => entry != null)
            : undefined;

          const normalizedEfforts = reasoningEfforts?.length ? reasoningEfforts : CODEX_REASONING_EFFORTS;

          return {
            id,
            displayName,
            ...(description ? { description } : {}),
            isDefault,
            reasoningEfforts: normalizedEfforts
          } satisfies AgentChatModelInfo;
        })
        .filter((entry): entry is AgentChatModelInfo => entry != null);

      if (models.length) return models;
      return CODEX_FALLBACK_MODELS;
    } catch {
      return CODEX_FALLBACK_MODELS;
    } finally {
      // This throwaway runtime is not a tracked session; suppress exit-side lifecycle hooks.
      tempSession.closed = true;
      tempSession.endedNotified = true;
      tempSession.session.status = "ended";
      try {
        runtime?.reader.close();
      } catch {
        // ignore
      }
      try {
        runtime?.process.kill();
      } catch {
        // ignore
      }
    }
  };

  const listClaudeModelsFromSdk = async (): Promise<AgentChatModelInfo[]> => {
    const mapped = MODEL_REGISTRY
      .filter((descriptor) => descriptor.family === "anthropic" && !descriptor.deprecated)
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((descriptor): AgentChatModelInfo => {
        const id = descriptor.id;
        const displayName = descriptor.displayName;
        const description = describeClaudeModel(`${descriptor.shortId} ${displayName}`);
        return {
          id,
          displayName,
          ...(description ? { description } : {}),
          isDefault: descriptor.shortId === "sonnet" || /sonnet/i.test(displayName),
          reasoningEfforts: CLAUDE_REASONING_EFFORTS,
          maxThinkingTokens: 32768
        };
      });

    if (!mapped.length) return CLAUDE_FALLBACK_MODELS;
    if (!mapped.some((entry) => entry.isDefault)) {
      const preferredIdx = mapped.findIndex((entry) => /sonnet/i.test(entry.id) || /sonnet/i.test(entry.displayName));
      if (preferredIdx >= 0) {
        mapped[preferredIdx] = { ...mapped[preferredIdx]!, isDefault: true };
      } else {
        mapped[0] = { ...mapped[0]!, isDefault: true };
      }
    }
    return mapped;
  };

  const createSession = async ({
    laneId,
    provider,
    model,
    modelId,
    reasoningEffort,
    permissionMode: requestedPermMode,
    identityKey
  }: AgentChatCreateArgs): Promise<AgentChatSession> => {
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const sessionId = randomUUID();
    const startedAt = toIso();
    const transcriptPath = path.join(transcriptsDir, `${sessionId}.chat.jsonl`);
    const metadataPath = metadataPathFor(sessionId);

    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });

    const normalizedInputModel = model.trim()
      || (provider === "codex"
        ? DEFAULT_CODEX_MODEL
        : provider === "claude"
          ? DEFAULT_CLAUDE_MODEL
          : "");
    // Resolve modelId from registry if provided
    const resolvedModelId = modelId && getModelById(modelId)
      ? modelId
      : resolveModelIdFromStoredValue(normalizedInputModel, provider);

    if (provider === "unified" && !resolvedModelId) {
      throw new Error("Unified chat requires a known model ID. Select a model from the registry.");
    }

    const resolvedDescriptor = resolvedModelId ? getModelById(resolvedModelId) : undefined;
    if (resolvedModelId && !resolvedDescriptor) {
      throw new Error(`Unknown model '${resolvedModelId}'.`);
    }

    let effectiveProvider: AgentChatProvider = provider;
    let normalizedModel = normalizedInputModel;

    if (resolvedDescriptor) {
      if (resolvedDescriptor.isCliWrapped) {
        if (resolvedDescriptor.family === "openai") {
          effectiveProvider = "codex";
          normalizedModel = resolvedDescriptor.shortId;
        } else if (resolvedDescriptor.family === "anthropic") {
          effectiveProvider = "claude";
          normalizedModel = resolvedDescriptor.shortId;
        } else if (provider === "unified") {
          throw new Error(
            `Model '${resolvedDescriptor.id}' is CLI-only but does not map to a supported chat runtime.`,
          );
        }
      } else {
        effectiveProvider = "unified";
        normalizedModel = resolvedDescriptor.id;
      }
    }

    const rawEffort = effectiveProvider === "codex"
      ? normalizeReasoningEffort(reasoningEffort) ?? DEFAULT_REASONING_EFFORT
      : normalizeReasoningEffort(reasoningEffort);
    const normalizedReasoningEffort = effectiveProvider === "unified"
      ? rawEffort
      : validateReasoningEffort(effectiveProvider === "claude" ? "claude" : "codex", rawEffort);
    const capabilityMode = inferCapabilityMode(effectiveProvider);

    sessionService.create({
      sessionId,
      laneId,
      ptyId: null,
      tracked: true,
      title: defaultChatSessionTitle(effectiveProvider),
      startedAt,
      transcriptPath,
      toolType: toolTypeFromProvider(effectiveProvider),
      resumeCommand: resumeCommandForProvider(effectiveProvider, sessionId)
    });

    const managed: ManagedChatSession = {
      session: {
        id: sessionId,
        laneId,
        provider: effectiveProvider,
        model: normalizedModel,
        ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
        ...(normalizedReasoningEffort ? { reasoningEffort: normalizedReasoningEffort } : {}),
        ...(requestedPermMode ? { permissionMode: requestedPermMode } : {}),
        ...(identityKey ? { identityKey } : {}),
        capabilityMode,
        status: "idle",
        createdAt: startedAt,
        lastActivityAt: startedAt
      },
      transcriptPath,
      transcriptBytesWritten: fileSizeOrZero(transcriptPath),
      transcriptLimitReached: false,
      metadataPath,
      laneWorktreePath: lane.worktreePath,
      runtime: null,
      preview: null,
      closed: false,
      endedNotified: false,
      ctoSessionStartedAt: identityKey === "cto" ? startedAt : null,
      pendingReconstructionContext: null,
      autoTitleSeed: null,
      autoTitleStage: "none",
      autoTitleInFlight: false,
    };
    managed.transcriptLimitReached = managed.transcriptBytesWritten >= MAX_CHAT_TRANSCRIPT_BYTES;
    refreshReconstructionContext(managed);

    // Init dedicated chat transcript file for persistence
    try {
      const chatTranscriptFile = path.join(chatTranscriptsDir, `${sessionId}.jsonl`);
      const header = JSON.stringify({
        type: "session_init",
        sessionId,
        laneId,
        provider: effectiveProvider,
        model: managed.session.model,
        createdAt: startedAt,
      });
      fs.writeFileSync(chatTranscriptFile, `${header}\n`, "utf8");
    } catch {
      // Non-fatal — chat transcript init failure should not block session creation
    }

    managedSessions.set(sessionId, managed);

    const headStart = await computeHeadShaBestEffort(laneId).catch(() => null);
    if (headStart) {
      sessionService.setHeadShaStart(sessionId, headStart);
    }

    // Lazy runtime boot: keep new-chat creation fast and start runtime/thread
    // on first send/resume instead of blocking UI during session creation.
    persistChatState(managed);
    return managed.session;
  };

  const sendMessage = async ({ sessionId, text, attachments = [], reasoningEffort }: AgentChatSendArgs): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed.length) return;

    const managed = ensureManagedSession(sessionId);

    if (managed.session.status === "ended") {
      sessionService.reopen(sessionId);
      managed.session.status = "idle";
      managed.closed = false;
      managed.endedNotified = false;
      managed.ctoSessionStartedAt = managed.session.identityKey === "cto" ? toIso() : null;
      refreshReconstructionContext(managed);
    }

    if (!managed.autoTitleSeed) {
      managed.autoTitleSeed = trimmed;
      void maybeAutoTitleSession(managed, {
        stage: "initial",
        latestUserText: trimmed,
      });
    }

    // Unified runtime dispatch
    if (managed.session.provider === "unified") {
      if (!managed.runtime || managed.runtime.kind !== "unified") {
        const restarted = await startUnifiedSession(managed);
        if (restarted !== "handled" || !managed.runtime) {
          throw new Error(`Unified runtime is not available for session '${managed.session.id}'.`);
        }
      }
      if (reasoningEffort) {
        managed.session.reasoningEffort = normalizeReasoningEffort(reasoningEffort);
      }
      await runTurn(managed, trimmed, attachments);
      return;
    }

    if (managed.session.provider === "codex") {
      const runtime = await ensureCodexSessionRuntime(managed);
      const nextReasoningEffort = validateReasoningEffort("codex", normalizeReasoningEffort(reasoningEffort));
      if (nextReasoningEffort) {
        managed.session.reasoningEffort = nextReasoningEffort;
      } else if (!managed.session.reasoningEffort) {
        managed.session.reasoningEffort = DEFAULT_REASONING_EFFORT;
      }

      if (!runtime.threadResumed) {
        const threadIdToResume = managed.session.threadId || readPersistedState(sessionId)?.threadId;
        const { codexPolicy, mcpServers } = resolveCodexThreadParams(managed);

        if (threadIdToResume) {
          try {
            await runtime.request("thread/resume", {
              threadId: threadIdToResume,
              model: managed.session.model,
              ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
              cwd: managed.laneWorktreePath,
              mcpServers,
              mcp_servers: mcpServers,
              ...codexPolicyArgs(codexPolicy),
              persistExtendedHistory: true
            });
            managed.session.threadId = threadIdToResume;
            runtime.threadResumed = true;
          } catch (resumeError) {
            logger.warn("agent_chat.thread_resume_failed", {
              sessionId,
              threadId: threadIdToResume,
              error: resumeError instanceof Error ? resumeError.message : String(resumeError)
            });
            await startFreshCodexThread(managed, runtime, codexPolicy, mcpServers);
          }
        } else {
          await startFreshCodexThread(managed, runtime, codexPolicy, mcpServers);
        }
      }

      await sendCodexMessage(managed, trimmed, attachments);
      return;
    }

    const nextClaudeEffort = validateReasoningEffort("claude", normalizeReasoningEffort(reasoningEffort));
    if (nextClaudeEffort) {
      managed.session.reasoningEffort = nextClaudeEffort;
    }

    ensureClaudeSessionRuntime(managed);
    await runTurn(managed, trimmed, attachments);
  };

  const steer = async ({ sessionId, text }: AgentChatSteerArgs): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed.length) return;

    const managed = ensureManagedSession(sessionId);

    // Unified runtime steer
    if (managed.runtime?.kind === "unified") {
      const runtime = managed.runtime;
      if (runtime.busy) {
        runtime.pendingSteers.push(trimmed);
        emitChatEvent(managed, {
          type: "user_message",
          text: trimmed,
          turnId: runtime.activeTurnId ?? undefined,
        });
        persistChatState(managed);
        return;
      }
      await runTurn(managed, trimmed, []);
      return;
    }

    if (managed.session.provider === "codex") {
      const runtime = await ensureCodexSessionRuntime(managed);
      if (!managed.session.threadId || !runtime.activeTurnId) {
        throw new Error("No active turn to steer.");
      }

      emitChatEvent(managed, {
        type: "user_message",
        text: trimmed,
        turnId: runtime.activeTurnId
      });

      await runtime.request("turn/steer", {
        threadId: managed.session.threadId,
        expectedTurnId: runtime.activeTurnId,
        input: [
          {
            type: "text",
            text: trimmed,
            text_elements: []
          }
        ]
      });
      return;
    }

    const runtime = ensureClaudeSessionRuntime(managed);
    if (runtime.busy) {
      runtime.pendingSteers.push(trimmed);
      emitChatEvent(managed, {
        type: "user_message",
        text: trimmed,
        turnId: runtime.activeTurnId ?? undefined
      });
      persistChatState(managed);
      return;
    }

    await runTurn(managed, trimmed, []);
  };

  const interrupt = async ({ sessionId }: AgentChatInterruptArgs): Promise<void> => {
    const managed = ensureManagedSession(sessionId);

    // Unified runtime interrupt
    if (managed.runtime?.kind === "unified") {
      managed.runtime.interrupted = true;
      managed.runtime.abortController?.abort();
      return;
    }

    if (managed.session.provider === "codex") {
      const runtime = await ensureCodexSessionRuntime(managed);
      if (!managed.session.threadId || !runtime.activeTurnId) return;
      await runtime.request("turn/interrupt", {
        threadId: managed.session.threadId,
        turnId: runtime.activeTurnId
      });
      return;
    }

    const runtime = ensureClaudeSessionRuntime(managed);
    runtime.interrupted = true;
    runtime.abortController?.abort();
  };

  const resumeSession = async ({ sessionId }: { sessionId: string }): Promise<AgentChatSession> => {
    const managed = ensureManagedSession(sessionId);
    const persisted = readPersistedState(sessionId);
    managed.session.capabilityMode = managed.session.capabilityMode ?? inferCapabilityMode(managed.session.provider);
    refreshReconstructionContext(managed);

    if (managed.session.provider === "codex") {
      const runtime = await ensureCodexSessionRuntime(managed);
      if (!managed.session.reasoningEffort) {
        managed.session.reasoningEffort = persisted?.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
      }
      const threadId = persisted?.threadId ?? managed.session.threadId;
      if (threadId) {
        const { codexPolicy, mcpServers } = resolveCodexThreadParams(managed);
        try {
          await runtime.request("thread/resume", {
            threadId,
            model: managed.session.model,
            ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
            cwd: managed.laneWorktreePath,
            mcpServers,
            mcp_servers: mcpServers,
            ...codexPolicyArgs(codexPolicy),
            persistExtendedHistory: true
          });
          managed.session.threadId = threadId;
          runtime.threadResumed = true;
          sessionService.setResumeCommand(sessionId, `chat:codex:${threadId}`);
        } catch (resumeError) {
          logger.warn("agent_chat.resume_session_thread_failed", {
            sessionId,
            threadId,
            error: resumeError instanceof Error ? resumeError.message : String(resumeError)
          });
          await startFreshCodexThread(managed, runtime, codexPolicy, mcpServers);
        }
      }
    } else if (managed.runtime?.kind === "unified" || (managed.session.modelId && !isModelCliWrapped(managed.session.modelId))) {
      // Unified runtime resume — re-resolve the model
      const result = await startUnifiedSession(managed);
      if (result === "handled" && managed.runtime?.kind === "unified") {
        // Restore message history from persisted state
        const persistedMessages = persisted?.messages;
        if (persistedMessages?.length) {
          managed.runtime.messages = persistedMessages.map((m) => ({ role: m.role, content: m.content }));
        }
        // Restore permission mode
        if (persisted?.permissionMode) {
          managed.runtime.permissionMode = persisted.permissionMode as any;
          managed.session.permissionMode = persisted.permissionMode as any;
        }
        sessionService.setResumeCommand(sessionId, `chat:unified:${sessionId}`);
      } else {
        if (managed.session.provider === "unified") {
          throw new Error(`Unable to resume unified runtime for model '${managed.session.model}'.`);
        }
        // Fallthrough to Claude
        const runtime = ensureClaudeSessionRuntime(managed);
        runtime.messages = persisted?.messages ?? runtime.messages;
        sessionService.setResumeCommand(sessionId, `chat:claude:${sessionId}`);
      }
    } else {
      const runtime = ensureClaudeSessionRuntime(managed);
      runtime.messages = persisted?.messages ?? runtime.messages;
      sessionService.setResumeCommand(sessionId, `chat:claude:${sessionId}`);
    }

    sessionService.reopen(sessionId);
    managed.session.status = "idle";
    managed.closed = false;
    managed.endedNotified = false;
    managed.ctoSessionStartedAt = managed.session.identityKey === "cto" ? toIso() : null;

    persistChatState(managed);
    return managed.session;
  };

  const listSessions = async (laneId?: string): Promise<AgentChatSessionSummary[]> => {
    const rows = sessionService.list({ ...(laneId ? { laneId } : {}), limit: 500 });
    const chatRows = rows.filter((row) => isChatToolType(row.toolType));

    return chatRows.map((row) => {
      const persisted = readPersistedState(row.id);
      const provider = persisted?.provider ?? providerFromToolType(row.toolType);
      const fallbackModel = persisted?.model ?? fallbackModelForProvider(provider);
      const hydratedModelId = persisted?.modelId
        ?? resolveModelIdFromStoredValue(fallbackModel, provider)
        ?? (provider === "unified" ? DEFAULT_UNIFIED_MODEL_ID : undefined);
      const model = provider === "unified" ? (hydratedModelId ?? fallbackModel) : fallbackModel;
      return {
        sessionId: row.id,
        laneId: row.laneId,
        provider,
        model,
        ...(hydratedModelId ? { modelId: hydratedModelId } : {}),
        title: row.title ?? null,
        goal: row.goal ?? null,
        reasoningEffort: persisted?.reasoningEffort ?? null,
        ...(persisted?.permissionMode ? { permissionMode: persisted.permissionMode } : {}),
        ...(persisted?.identityKey ? { identityKey: persisted.identityKey } : {}),
        capabilityMode: persisted?.capabilityMode ?? inferCapabilityMode(provider),
        status: row.status === "running" ? "idle" : "ended",
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        lastActivityAt: persisted?.updatedAt ?? row.endedAt ?? row.startedAt,
        lastOutputPreview: row.lastOutputPreview,
        summary: row.summary,
        ...(persisted?.threadId ? { threadId: persisted.threadId } : {})
      } satisfies AgentChatSessionSummary;
    });
  };

  const ensureIdentitySession = async (args: {
    identityKey: AgentChatIdentityKey;
    laneId: string;
    modelId?: string | null;
    reasoningEffort?: string | null;
    permissionMode?: AgentChatSession["permissionMode"];
  }): Promise<AgentChatSession> => {
    const laneId = args.laneId.trim();
    if (!laneId.length) {
      throw new Error("laneId is required to ensure an identity-bound chat session.");
    }

    const existing = (await listSessions())
      .filter((entry) => entry.identityKey === args.identityKey)
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

    const preferred = existing.find((entry) => entry.laneId === laneId) ?? existing[0] ?? null;
    if (preferred) {
      const managed = ensureManagedSession(preferred.sessionId);
      managed.session.identityKey = args.identityKey;
      managed.session.capabilityMode = inferCapabilityMode(managed.session.provider);
      if (args.reasoningEffort) {
        managed.session.reasoningEffort = normalizeReasoningEffort(args.reasoningEffort);
      }
      if (args.permissionMode) {
        managed.session.permissionMode = args.permissionMode;
      }
      refreshReconstructionContext(managed);
      persistChatState(managed);

      if (managed.session.status === "ended") {
        await resumeSession({ sessionId: managed.session.id });
      }
      return ensureManagedSession(managed.session.id).session;
    }

    const identity = ctoStateService?.getIdentity();
    const pref = identity?.modelPreferences;
    const preferredProviderRaw = (pref?.provider ?? "").trim().toLowerCase();
    const providerFromPreference: AgentChatProvider = (() => {
      if (preferredProviderRaw.includes("codex") || preferredProviderRaw.includes("openai")) return "codex";
      if (preferredProviderRaw.includes("claude") || preferredProviderRaw.includes("anthropic")) return "claude";
      return "unified";
    })();

    const explicitModelId = typeof args.modelId === "string" && args.modelId.trim().length
      ? args.modelId.trim()
      : null;
    const preferredModelId = typeof pref?.modelId === "string" && pref.modelId.trim().length
      ? pref.modelId.trim()
      : null;
    const resolvedModelId = explicitModelId ?? preferredModelId;
    const resolvedDescriptor = resolvedModelId ? getModelById(resolvedModelId) : undefined;

    const provider: AgentChatProvider = (() => {
      if (!resolvedDescriptor) return providerFromPreference;
      if (!resolvedDescriptor.isCliWrapped) return "unified";
      if (resolvedDescriptor.family === "openai") return "codex";
      if (resolvedDescriptor.family === "anthropic") return "claude";
      return providerFromPreference;
    })();

    const preferredModel = typeof pref?.model === "string" && pref.model.trim().length
      ? pref.model.trim()
      : fallbackModelForProvider(provider);

    const created = await createSession({
      laneId,
      provider,
      model: preferredModel,
      ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
      reasoningEffort: args.reasoningEffort ?? pref?.reasoningEffort ?? null,
      permissionMode: args.permissionMode,
      identityKey: args.identityKey
    });

    const managed = ensureManagedSession(created.id);
    refreshReconstructionContext(managed);
    persistChatState(managed);
    return managed.session;
  };

  const approveToolUse = async ({ sessionId, itemId, decision }: { sessionId: string; itemId: string; decision: AgentChatApprovalDecision }): Promise<void> => {
    const managed = ensureManagedSession(sessionId);

    if (managed.runtime?.kind === "codex") {
      const pending = managed.runtime.approvals.get(itemId);
      if (!pending) {
        throw new Error(`No pending approval found for item '${itemId}'.`);
      }

      const mapped = mapApprovalDecisionForCodex(decision);
      managed.runtime.sendResponse(pending.requestId, { decision: mapped });
      managed.runtime.approvals.delete(itemId);
      return;
    }

    if (managed.runtime?.kind === "claude") {
      const pending = managed.runtime.approvals.get(itemId);
      if (!pending) {
        throw new Error(`No pending approval found for item '${itemId}'.`);
      }
      managed.runtime.approvals.delete(itemId);
      pending.resolve(decision);
      return;
    }

    if (managed.runtime?.kind === "unified") {
      const pending = managed.runtime.pendingApprovals.get(itemId);
      if (!pending) {
        throw new Error(`No pending approval found for item '${itemId}'.`);
      }
      managed.runtime.pendingApprovals.delete(itemId);
      pending.resolve(decision);
      return;
    }

    throw new Error(`Session '${sessionId}' does not have a live runtime for approvals.`);
  };

  const getAvailableModels = async ({ provider }: { provider: AgentChatProvider }): Promise<AgentChatModelInfo[]> => {
    if (provider === "codex") {
      return listCodexModelsFromAppServer();
    }
    if (provider === "claude") {
      return listClaudeModelsFromSdk();
    }

    // For unified/non-CLI providers: return all models with valid auth.
    try {
      const auth = await detectAuth();
      const available = getRegistryModels(auth);
      const targetModels = provider === "unified"
        ? available
        : available.filter(m => m.family === provider);
      if (targetModels.length > 0) {
        return targetModels.map((m, i) => ({
          id: m.id,
          displayName: m.displayName,
          description: `${m.displayName} (${m.family})`,
          isDefault: i === 0,
          reasoningEfforts: m.reasoningTiers?.map(tier => ({
            effort: tier,
            description: `${tier} reasoning`
          })) ?? [],
        }));
      }
    } catch {
      // fallback to empty
    }
    return [];
  };

  const dispose = async ({ sessionId }: AgentChatDisposeArgs): Promise<void> => {
    const managed = ensureManagedSession(sessionId);

    // Interrupt active codex turn before teardown
    if (managed.runtime?.kind === "codex") {
      try {
        if (managed.session.threadId && managed.runtime.activeTurnId) {
          await managed.runtime.request("turn/interrupt", {
            threadId: managed.session.threadId,
            turnId: managed.runtime.activeTurnId
          });
        }
      } catch {
        // ignore interrupt failures while disposing
      }
    }

    // Mark streaming runtimes as interrupted so the catch block handles gracefully
    if (managed.runtime?.kind === "claude") {
      managed.runtime.interrupted = true;
    }
    if (managed.runtime?.kind === "unified") {
      managed.runtime.interrupted = true;
    }

    await finishSession(managed, "disposed", {
      summary: managed.preview ? `Session closed: ${managed.preview}` : "Session closed."
    });
  };

  const disposeAll = async (): Promise<void> => {
    for (const sessionId of [...managedSessions.keys()]) {
      try {
        await dispose({ sessionId });
      } catch {
        // ignore shutdown errors
      }
    }
  };

  const updateSession = async ({
    sessionId,
    modelId,
    reasoningEffort,
    permissionMode,
  }: AgentChatUpdateSessionArgs): Promise<AgentChatSession> => {
    const managed = ensureManagedSession(sessionId);

    if (modelId !== undefined) {
      const nextModelId = String(modelId ?? "").trim();
      if (!nextModelId.length) {
        throw new Error("A modelId is required when updating a chat session model.");
      }

      const descriptor = getModelById(nextModelId) ?? resolveModelAlias(nextModelId);
      if (!descriptor) {
        throw new Error(`Unknown model '${nextModelId}'.`);
      }

      const nextProvider: AgentChatProvider = (() => {
        if (!descriptor.isCliWrapped) return "unified";
        if (descriptor.family === "openai") return "codex";
        if (descriptor.family === "anthropic") return "claude";
        return managed.session.provider;
      })();
      const nextModel = descriptor.isCliWrapped ? descriptor.shortId : descriptor.id;
      const compatible =
        managed.runtime == null
          ? true
          : managed.session.provider === "codex"
            ? descriptor.family === "openai" && descriptor.isCliWrapped
            : managed.session.provider === "claude"
              ? descriptor.family === "anthropic" && descriptor.isCliWrapped
              : !descriptor.isCliWrapped;

      if (!compatible) {
        throw new Error("This session can only switch to models compatible with its current runtime.");
      }

      const currentTitle = sessionService.get(sessionId)?.title ?? null;
      const previousProvider = managed.session.provider;
      managed.session.provider = nextProvider;
      managed.session.modelId = descriptor.id;
      managed.session.model = nextModel;
      managed.session.capabilityMode = inferCapabilityMode(nextProvider);
      sessionService.updateMeta({
        sessionId,
        ...(hasCustomChatSessionTitle(currentTitle, previousProvider)
          ? {}
          : { title: defaultChatSessionTitle(nextProvider) }),
        toolType: toolTypeFromProvider(nextProvider),
        resumeCommand: resumeCommandForProvider(nextProvider, sessionId)
      });
    }

    if (reasoningEffort !== undefined) {
      managed.session.reasoningEffort = normalizeReasoningEffort(reasoningEffort);
    }

    if (permissionMode !== undefined) {
      managed.session.permissionMode = permissionMode;
      if (managed.runtime?.kind === "unified") {
        managed.runtime.permissionMode = permissionMode === "default" || permissionMode === "config-toml"
          ? "edit"
          : permissionMode === "plan" || permissionMode === "edit" || permissionMode === "full-auto"
            ? permissionMode
            : "edit";
      }
    }

    persistChatState(managed);
    return managed.session;
  };

  const listContextPacks = async (args: { laneId?: string } = {}): Promise<import("../../../shared/types").ContextPackOption[]> => {
    const packs: import("../../../shared/types").ContextPackOption[] = [
      { scope: "project", label: "Project", description: "Live project context export", available: Boolean(packService) },
    ];

    if (args.laneId) {
      packs.push(
        { scope: "lane", label: "Lane", description: "Live lane context export", available: Boolean(packService), laneId: args.laneId },
        { scope: "conflict", label: "Conflicts", description: "Live conflict context export", available: Boolean(packService), laneId: args.laneId },
        { scope: "plan", label: "Plan", description: "Live plan context export", available: Boolean(packService), laneId: args.laneId }
      );
    }

    packs.push(
      {
        scope: "mission",
        label: "Mission",
        description: "Mission-scoped export requires an explicit mission selection and is not wired into this picker yet",
        available: false
      }
    );

    return packs;
  };

  const fetchContextPack = async (args: import("../../../shared/types").ContextPackFetchArgs): Promise<import("../../../shared/types").ContextPackFetchResult> => {
    const MAX_CHARS = 50_000;
    let content = "";
    let truncated = false;
    const level = args.level === "brief" ? "lite" : args.level === "detailed" ? "deep" : "standard";

    try {
      if (!packService) {
        throw new Error("Live context export service is unavailable.");
      }

      const exportResult = await (async () => {
        if (args.scope === "project") return await packService.getProjectExport({ level });
        if (args.scope === "lane") {
          if (!args.laneId?.trim()) throw new Error("Lane context requires laneId.");
          return await packService.getLaneExport({ laneId: args.laneId.trim(), level });
        }
        if (args.scope === "conflict") {
          if (!args.laneId?.trim()) throw new Error("Conflict context requires laneId.");
          return await packService.getConflictExport({ laneId: args.laneId.trim(), level });
        }
        if (args.scope === "plan") {
          if (!args.laneId?.trim()) throw new Error("Plan context requires laneId.");
          return await packService.getPlanExport({ laneId: args.laneId.trim(), level });
        }
        if (args.scope === "feature") {
          if (!args.featureKey?.trim()) throw new Error("Feature context requires featureKey.");
          return await packService.getFeatureExport({ featureKey: args.featureKey.trim(), level });
        }
        if (!args.missionId?.trim()) throw new Error("Mission context requires missionId.");
        return await packService.getMissionExport({ missionId: args.missionId.trim(), level });
      })();

      content = exportResult.content;
      truncated = exportResult.truncated;

      if (content.length > MAX_CHARS) {
        content = content.slice(0, MAX_CHARS);
        truncated = true;
      }
    } catch (error) {
      content = `Failed to fetch ${args.scope} context: ${error instanceof Error ? error.message : String(error)}`;
    }

    return { scope: args.scope, content, truncated };
  };

  const changePermissionMode = ({ sessionId, permissionMode }: import("../../../shared/types").AgentChatChangePermissionModeArgs): void => {
    const managed = ensureManagedSession(sessionId);

    if (managed.runtime?.kind === "unified") {
      // Map to unified PermissionMode (which doesn't include "default" or "config-toml")
      const unifiedMode: PermissionMode = permissionMode === "default" || permissionMode === "config-toml" ? "edit"
        : permissionMode === "plan" || permissionMode === "edit" || permissionMode === "full-auto" ? permissionMode
        : "edit";
      managed.runtime.permissionMode = unifiedMode;
    }

    managed.session.permissionMode = permissionMode;
    persistChatState(managed);

    logger.info("agent_chat.permission_mode_changed", {
      sessionId,
      permissionMode,
    });
  };

  return {
    createSession,
    sendMessage,
    steer,
    interrupt,
    resumeSession,
    listSessions,
    ensureIdentitySession,
    approveToolUse,
    getAvailableModels,
    dispose,
    disposeAll,
    updateSession,
    listContextPacks,
    fetchContextPack,
    changePermissionMode,
  };
}
