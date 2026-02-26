import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { streamText } from "ai";
import { createClaudeCode } from "ai-sdk-provider-claude-code";
import {
  unstable_v2_createSession,
  type ModelInfo,
  type PermissionResult
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createSessionService } from "../sessions/sessionService";
import type { createProjectConfigService } from "../config/projectConfigService";
import { runGit } from "../git/git";
import type {
  AgentChatApprovalDecision,
  AgentChatCreateArgs,
  AgentChatDisposeArgs,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatInterruptArgs,
  AgentChatModelInfo,
  AgentChatProvider,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSteerArgs,
  AgentChatSendArgs,
  TerminalSessionStatus,
  TerminalToolType
} from "../../../shared/types";
import {
  getModelById,
  getAvailableModels as getRegistryModels,
  MODEL_REGISTRY,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { detectAllAuth } from "../ai/authDetector";

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
  reasoningEffort?: string | null;
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

type ChatRuntime = CodexRuntime | ClaudeRuntime;

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
};

type ResolvedChatConfig = {
  codexApprovalPolicy: "untrusted" | "on-request" | "on-failure" | "never";
  codexSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  claudePermissionMode: "plan" | "acceptEdits" | "bypassPermissions";
  sessionBudgetUsd: number | null;
};

const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";
const DEFAULT_CLAUDE_MODEL = "sonnet";
const DEFAULT_REASONING_EFFORT = "medium";
const MAX_CHAT_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const CHAT_TRANSCRIPT_LIMIT_NOTICE = "\n[ADE] chat transcript limit reached (8MB). Further events omitted.\n";
const CODEX_REASONING_EFFORTS: Array<{ effort: string; description: string }> = [
  { effort: "low", description: "Fastest turn-around with shallow reasoning." },
  { effort: "medium", description: "Balanced reasoning depth and speed." },
  { effort: "high", description: "Deeper reasoning for multi-step implementation." },
  { effort: "extra_high", description: "Maximum reasoning depth for complex tasks." }
];

const CLAUDE_REASONING_EFFORTS: Array<{ effort: string; description: string }> = [
  { effort: "low", description: "Quick responses with ~1K thinking tokens." },
  { effort: "medium", description: "Balanced reasoning with ~4K thinking tokens." },
  { effort: "high", description: "Deep reasoning with ~16K thinking tokens." },
  { effort: "max", description: "Maximum reasoning with ~32K thinking tokens." }
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

const CLAUDE_ALIAS_TO_MODEL: Record<string, string> = {
  opus: "claude-opus-4-6",
  "opus-4-6": "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  "sonnet-4-6": "claude-sonnet-4-6",
  "sonnet-4-5": "claude-sonnet-4-5-20241022",
  haiku: "claude-haiku-4-5-20251001",
  "haiku-4-5": "claude-haiku-4-5-20251001"
};

const CLAUDE_FALLBACK_MODELS: AgentChatModelInfo[] = [
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6", description: "Highest capability for complex strategy and review.", isDefault: false, reasoningEfforts: CLAUDE_REASONING_EFFORTS, maxThinkingTokens: 32768 },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", description: "Latest balanced model — quality and speed for everyday work.", isDefault: true, reasoningEfforts: CLAUDE_REASONING_EFFORTS, maxThinkingTokens: 32768 },
  { id: "claude-sonnet-4-5-20241022", displayName: "Claude Sonnet 4.5", description: "Previous-gen Sonnet — stable and cost-effective.", isDefault: false, reasoningEfforts: CLAUDE_REASONING_EFFORTS, maxThinkingTokens: 32768 },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", description: "Fastest Claude variant for lightweight tasks.", isDefault: false, reasoningEfforts: CLAUDE_REASONING_EFFORTS, maxThinkingTokens: 32768 },
  { id: "opus", displayName: "Opus (alias)", description: "Alias for Claude Opus 4.6.", isDefault: false, reasoningEfforts: CLAUDE_REASONING_EFFORTS, maxThinkingTokens: 32768 },
  { id: "sonnet", displayName: "Sonnet (alias)", description: "Alias for Claude Sonnet 4.6.", isDefault: false, reasoningEfforts: CLAUDE_REASONING_EFFORTS, maxThinkingTokens: 32768 },
  { id: "haiku", displayName: "Haiku (alias)", description: "Alias for Claude Haiku 4.5.", isDefault: false, reasoningEfforts: CLAUDE_REASONING_EFFORTS, maxThinkingTokens: 32768 }
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

function isChatToolType(toolType: TerminalToolType | null | undefined): toolType is "codex-chat" | "claude-chat" {
  return toolType === "codex-chat" || toolType === "claude-chat";
}

function providerFromToolType(toolType: TerminalToolType | null | undefined): AgentChatProvider {
  return toolType === "claude-chat" ? "claude" : "codex";
}

function toolTypeFromProvider(provider: AgentChatProvider): "codex-chat" | "claude-chat" {
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

function resolveClaudeModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return CLAUDE_ALIAS_TO_MODEL.sonnet;
  return CLAUDE_ALIAS_TO_MODEL[normalized] ?? model;
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

  // Unified session support — gradual migration path for model registry IDs.
  // For CLI-wrapped models, we fall through to the existing Claude/Codex runtimes.
  // For API-key models, this will be fully implemented once WS3 is complete.
  const startUnifiedSession = async (managed: ManagedChatSession, _message: string): Promise<"handled" | "fallthrough"> => {
    const modelId = managed.session.modelId;
    if (!modelId) return "fallthrough";

    const descriptor = getModelById(modelId);
    if (!descriptor) return "fallthrough";

    // CLI-wrapped Anthropic models -> fall through to Claude runtime
    if (descriptor.isCliWrapped && descriptor.family === "anthropic") {
      return "fallthrough";
    }
    // CLI-wrapped OpenAI models -> fall through to Codex runtime
    if (descriptor.isCliWrapped && descriptor.family === "openai") {
      return "fallthrough";
    }

    // For API-key models, log that the unified path was requested but
    // fall through for now. Full implementation arrives with WS3.
    logger.info("agent_chat.unified_session_requested", {
      sessionId: managed.session.id,
      modelId,
      family: descriptor.family,
    });
    return "fallthrough";
  };

  const resolveChatConfig = (): ResolvedChatConfig => {
    const snapshot = projectConfigService.get();
    const ai = snapshot.effective.ai ?? {};
    const permissions = ai.permissions ?? {};
    const chat = ai.chat ?? {};

    const approvalPolicy = (() => {
      if (chat.defaultApprovalPolicy === "auto") return "never" as const;
      if (chat.defaultApprovalPolicy === "approve_all") return "untrusted" as const;
      if (chat.defaultApprovalPolicy === "approve_mutations") return "on-request" as const;
      const codexApproval = permissions.codex?.approvalMode ?? permissions.codex?.approval_mode;
      if (codexApproval === "untrusted" || codexApproval === "on-request" || codexApproval === "on-failure" || codexApproval === "never") {
        return codexApproval;
      }
      if (codexApproval === "suggest") return "untrusted" as const;
      if (codexApproval === "auto-edit") return "on-request" as const;
      if (codexApproval === "full-auto") return "never" as const;
      return "on-request" as const;
    })();

    const sandboxMode = (() => {
      if (chat.codexSandbox) return chat.codexSandbox;
      if (permissions.codex?.sandboxPermissions) return permissions.codex.sandboxPermissions;
      return "workspace-write" as const;
    })();

    const claudePermissionMode = (() => {
      if (chat.claudePermissionMode) return chat.claudePermissionMode;
      if (permissions.claude?.permissionMode === "plan") return "plan" as const;
      if (permissions.claude?.permissionMode === "bypassPermissions") return "bypassPermissions" as const;
      if (permissions.claude?.permissionMode === "acceptEdits") return "acceptEdits" as const;
      return "acceptEdits" as const;
    })();

    const budget = Number(chat.sessionBudgetUsd ?? permissions.claude?.maxBudgetUsd ?? NaN);
    const sessionBudgetUsd = Number.isFinite(budget) && budget > 0 ? budget : null;

    return {
      codexApprovalPolicy: approvalPolicy,
      codexSandboxMode: sandboxMode,
      claudePermissionMode,
      sessionBudgetUsd
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
      ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
      ...(managed.session.threadId ? { threadId: managed.session.threadId } : {}),
      ...(managed.runtime?.kind === "claude" ? { messages: managed.runtime.messages } : {}),
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
      if (provider !== "codex" && provider !== "claude") return null;
      const laneId = String(record.laneId ?? "").trim();
      const model = String(record.model ?? "").trim();
      const reasoningEffort = normalizeReasoningEffort(record.reasoningEffort);
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
        ...(reasoningEffort ? { reasoningEffort } : {}),
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

    const endedAt = toIso();
    sessionService.end({
      sessionId: managed.session.id,
      endedAt,
      exitCode: options?.exitCode ?? null,
      status
    });

    const endSha = await computeHeadShaBestEffort(managed.session.laneId).catch(() => null);
    if (endSha) {
      sessionService.setHeadShaEnd(managed.session.id, endSha);
    }

    managed.session.status = "ended";
    managed.closed = true;
    persistChatState(managed);

    // Clean up runtime resources
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

    const provider = providerFromToolType(row.toolType);
    const persisted = readPersistedState(sessionId);
    const model = persisted?.model ?? (provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL);
    const lane = laneService.getLaneBaseAndBranch(row.laneId);

    const managed: ManagedChatSession = {
      session: {
        id: sessionId,
        laneId: row.laneId,
        provider,
        model,
        reasoningEffort: persisted?.reasoningEffort ?? null,
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
      endedNotified: row.status !== "running"
    };
    managed.transcriptLimitReached = managed.transcriptBytesWritten >= MAX_CHAT_TRANSCRIPT_BYTES;

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

  const runClaudeTurn = async (managed: ManagedChatSession, text: string, attachments: AgentChatFileRef[] = []): Promise<void> => {
    if (!managed.runtime || managed.runtime.kind !== "claude") {
      throw new Error(`Claude runtime is not available for session '${managed.session.id}'.`);
    }

    const runtime = managed.runtime;
    if (runtime.busy) {
      throw new Error("A turn is already active. Use steer or interrupt.");
    }

    const turnId = randomUUID();
    runtime.busy = true;
    runtime.activeTurnId = turnId;
    runtime.interrupted = false;
    managed.session.status = "active";

    const attachmentHint = attachments.length
      ? `\n\nAttached context:\n${attachments.map((file) => `- ${file.type}: ${file.path}`).join("\n")}`
      : "";
    const userContent = `${text}${attachmentHint}`;

    runtime.messages.push({ role: "user", content: userContent });
    emitChatEvent(managed, { type: "user_message", text, attachments, turnId });
    emitChatEvent(managed, { type: "status", turnStatus: "started", turnId });

    const chatConfig = resolveChatConfig();
    const abortController = new AbortController();
    runtime.abortController = abortController;

    let assistantText = "";
    let usage: { inputTokens?: number | null; outputTokens?: number | null } | undefined;

    const canUseTool = async (toolName: string, toolInput: unknown): Promise<PermissionResult> => {
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
        runtime.approvals.set(itemId, { resolve });
      });
      runtime.approvals.delete(itemId);

      if (decision === "accept" || decision === "accept_for_session") {
        return { behavior: "allow" };
      }

      return {
        behavior: "deny",
        message: `Tool '${toolName}' blocked by user decision.`,
        interrupt: false
      };
    };

    try {
      const claudeOpts: Record<string, unknown> = {
          cwd: managed.laneWorktreePath,
          permissionMode: chatConfig.claudePermissionMode,
          settingSources: [],
          maxBudgetUsd: chatConfig.sessionBudgetUsd ?? undefined,
          canUseTool
      };
      if (managed.session.reasoningEffort) {
        const tokens = CLAUDE_EFFORT_TO_TOKENS[managed.session.reasoningEffort];
        if (tokens) {
          claudeOpts.maxThinkingTokens = tokens;
        }
      }

      const stream = streamText({
        model: claudeProvider(resolveClaudeModel(managed.session.model), claudeOpts as any),
        messages: runtime.messages.map((message) => ({ role: message.role, content: message.content })) as any,
        abortSignal: abortController.signal
      });

      for await (const part of stream.fullStream as AsyncIterable<any>) {
        if (!part || typeof part !== "object") continue;

        if (part.type === "text-delta") {
          const delta = String(part.text ?? "");
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

        if (part.type === "reasoning-delta") {
          const delta = String(part.text ?? "");
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
            args: part.input,
            itemId: String(part.toolCallId ?? randomUUID()),
            turnId
          });
          continue;
        }

        if (part.type === "tool-result") {
          emitChatEvent(managed, {
            type: "tool_result",
            tool: String(part.toolName ?? "tool"),
            result: part.output,
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
          const totalUsage = part.totalUsage as
            | {
                inputTokens?: number;
                outputTokens?: number;
              }
            | undefined;
          usage = {
            inputTokens: totalUsage?.inputTokens ?? null,
            outputTokens: totalUsage?.outputTokens ?? null
          };
          continue;
        }

        if (part.type === "error") {
          emitChatEvent(managed, {
            type: "error",
            message: String(part.error ?? "Claude stream error."),
            turnId
          });
        }
      }

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
        ...(usage ? { usage } : {})
      });

      const endSha = await computeHeadShaBestEffort(managed.session.laneId).catch(() => null);
      if (endSha) {
        sessionService.setHeadShaEnd(managed.session.id, endSha);
      }

      persistChatState(managed);

      if (runtime.pendingSteers.length) {
        const steerText = runtime.pendingSteers.shift() ?? "";
        if (steerText.trim().length) {
          await runClaudeTurn(managed, steerText, []);
        }
      }
    } catch (error) {
      runtime.busy = false;
      runtime.activeTurnId = null;
      runtime.abortController = null;

      if (runtime.interrupted) {
        managed.session.status = "idle";
        emitChatEvent(managed, { type: "status", turnStatus: "interrupted", turnId });
        emitChatEvent(managed, { type: "done", turnId, status: "interrupted" });
      } else {
        managed.session.status = "idle";
        emitChatEvent(managed, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          turnId
        });
        emitChatEvent(managed, { type: "status", turnStatus: "failed", turnId });
        emitChatEvent(managed, { type: "done", turnId, status: "failed" });
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

      emitChatEvent(managed, { type: "done", turnId, status });

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
      endedNotified: false
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
    try {
      const session = unstable_v2_createSession({
        model: CLAUDE_ALIAS_TO_MODEL.sonnet,
        permissionMode: "plan"
      }) as unknown as {
        supportedModels?: () => Promise<ModelInfo[]>;
        close: () => void;
      };

      try {
        if (typeof session.supportedModels !== "function") {
          return CLAUDE_FALLBACK_MODELS;
        }

        const discovered = await session.supportedModels();
        const mapped = discovered
          .map((entry): AgentChatModelInfo | null => {
            const id = String(entry.value ?? "").trim();
            if (!id.length) return null;
            const displayName = String(entry.displayName ?? entry.value ?? id).trim() || id;
            const description = describeClaudeModel(`${id} ${displayName}`);
            return {
              id,
              displayName,
              ...(description ? { description } : {}),
              isDefault: id === CLAUDE_ALIAS_TO_MODEL.sonnet,
              reasoningEfforts: CLAUDE_REASONING_EFFORTS,
              maxThinkingTokens: 32768
            };
          })
          .filter((entry): entry is AgentChatModelInfo => entry != null);

        if (mapped.length) {
          if (!mapped.some((entry) => entry.isDefault)) {
            const preferredIdx = mapped.findIndex((entry) => /sonnet/i.test(entry.id) || /sonnet/i.test(entry.displayName));
            if (preferredIdx >= 0) {
              mapped[preferredIdx] = { ...mapped[preferredIdx]!, isDefault: true };
            } else {
              mapped[0] = { ...mapped[0]!, isDefault: true };
            }
          }
          return mapped;
        }
      } finally {
        session.close();
      }
    } catch {
      // fall back below
    }

    return CLAUDE_FALLBACK_MODELS;
  };

  const createSession = async ({ laneId, provider, model, modelId, reasoningEffort }: AgentChatCreateArgs): Promise<AgentChatSession> => {
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const sessionId = randomUUID();
    const startedAt = toIso();
    const transcriptPath = path.join(transcriptsDir, `${sessionId}.chat.jsonl`);
    const metadataPath = metadataPathFor(sessionId);

    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });

    const normalizedModel = model.trim() || (provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL);
    const legacyProvider: "codex" | "claude" = provider === "codex" ? "codex" : "claude";
    const rawEffort = legacyProvider === "codex"
      ? normalizeReasoningEffort(reasoningEffort) ?? DEFAULT_REASONING_EFFORT
      : normalizeReasoningEffort(reasoningEffort);
    const normalizedReasoningEffort = validateReasoningEffort(legacyProvider, rawEffort);

    // Resolve modelId from registry if provided
    const resolvedModelId = modelId && getModelById(modelId) ? modelId : undefined;

    sessionService.create({
      sessionId,
      laneId,
      ptyId: null,
      tracked: true,
      title: provider === "codex" ? "Codex Chat" : "Claude Chat",
      startedAt,
      transcriptPath,
      toolType: toolTypeFromProvider(provider),
      resumeCommand: provider === "codex" ? "chat:codex" : `chat:claude:${sessionId}`
    });

    const managed: ManagedChatSession = {
      session: {
        id: sessionId,
        laneId,
        provider,
        model: normalizedModel,
        ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
        ...(normalizedReasoningEffort ? { reasoningEffort: normalizedReasoningEffort } : {}),
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
      endedNotified: false
    };
    managed.transcriptLimitReached = managed.transcriptBytesWritten >= MAX_CHAT_TRANSCRIPT_BYTES;

    // Init dedicated chat transcript file for persistence
    try {
      const chatTranscriptFile = path.join(chatTranscriptsDir, `${sessionId}.jsonl`);
      const header = JSON.stringify({
        type: "session_init",
        sessionId,
        laneId,
        provider,
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

    try {
      if (provider === "codex") {
        const runtime = await ensureCodexSessionRuntime(managed);
        const config = resolveChatConfig();
        const response = await runtime.request<{
          thread?: { id?: string };
          model?: string;
        }>("thread/start", {
          model: normalizedModel,
          ...(normalizedReasoningEffort ? { reasoningEffort: normalizedReasoningEffort } : {}),
          cwd: lane.worktreePath,
          approvalPolicy: config.codexApprovalPolicy,
          sandbox: config.codexSandboxMode,
          experimentalRawEvents: false,
          persistExtendedHistory: true
        });

        const threadId = typeof response.thread?.id === "string" ? response.thread.id : undefined;
        if (threadId) {
          managed.session.threadId = threadId;
          runtime.threadResumed = true;
          sessionService.setResumeCommand(sessionId, `chat:codex:${threadId}`);
        }
      } else {
        ensureClaudeSessionRuntime(managed);
      }

      persistChatState(managed);
      return managed.session;
    } catch (error) {
      await finishSession(managed, "failed", {
        summary: error instanceof Error ? error.message : String(error)
      }).catch(() => {});
      throw error;
    }
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
    }

    if (managed.session.provider === "codex") {
      const runtime = await ensureCodexSessionRuntime(managed);
      const nextReasoningEffort = validateReasoningEffort("codex", normalizeReasoningEffort(reasoningEffort));
      if (nextReasoningEffort) {
        managed.session.reasoningEffort = nextReasoningEffort;
      } else if (!managed.session.reasoningEffort) {
        managed.session.reasoningEffort = DEFAULT_REASONING_EFFORT;
      }

      const threadIdToResume = managed.session.threadId || readPersistedState(sessionId)?.threadId;

      if (!runtime.threadResumed && threadIdToResume) {
        const config = resolveChatConfig();
        const resumeParams = {
          threadId: threadIdToResume,
          model: managed.session.model,
          ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
          cwd: managed.laneWorktreePath,
          approvalPolicy: config.codexApprovalPolicy,
          sandbox: config.codexSandboxMode,
          persistExtendedHistory: true
        };

        try {
          await runtime.request("thread/resume", resumeParams);
          managed.session.threadId = threadIdToResume;
          runtime.threadResumed = true;
        } catch (resumeError) {
          // Rollout expired or thread not found — start a fresh thread instead
          logger.warn("agent_chat.thread_resume_failed", {
            sessionId,
            threadId: threadIdToResume,
            error: resumeError instanceof Error ? resumeError.message : String(resumeError)
          });
          const startResponse = await runtime.request<{ thread?: { id?: string } }>("thread/start", {
            model: managed.session.model,
            ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
            cwd: managed.laneWorktreePath,
            approvalPolicy: config.codexApprovalPolicy,
            sandbox: config.codexSandboxMode,
            experimentalRawEvents: false,
            persistExtendedHistory: true
          });
          const newThreadId = typeof startResponse.thread?.id === "string" ? startResponse.thread.id : undefined;
          if (newThreadId) {
            managed.session.threadId = newThreadId;
            sessionService.setResumeCommand(sessionId, `chat:codex:${newThreadId}`);
          }
          runtime.threadResumed = true;
          persistChatState(managed);
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
    await runClaudeTurn(managed, trimmed, attachments);
  };

  const steer = async ({ sessionId, text }: AgentChatSteerArgs): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed.length) return;

    const managed = ensureManagedSession(sessionId);

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

    await runClaudeTurn(managed, trimmed, []);
  };

  const interrupt = async ({ sessionId }: AgentChatInterruptArgs): Promise<void> => {
    const managed = ensureManagedSession(sessionId);

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

    if (managed.session.provider === "codex") {
      const runtime = await ensureCodexSessionRuntime(managed);
      const config = resolveChatConfig();
      if (!managed.session.reasoningEffort) {
        managed.session.reasoningEffort = persisted?.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
      }
      const threadId = persisted?.threadId ?? managed.session.threadId;
      if (threadId) {
        try {
          await runtime.request("thread/resume", {
            threadId,
            model: managed.session.model,
            ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
            cwd: managed.laneWorktreePath,
            approvalPolicy: config.codexApprovalPolicy,
            sandbox: config.codexSandboxMode,
            persistExtendedHistory: true
          });
          managed.session.threadId = threadId;
          runtime.threadResumed = true;
          sessionService.setResumeCommand(sessionId, `chat:codex:${threadId}`);
        } catch (resumeError) {
          // Rollout expired or thread not found — start a fresh thread
          logger.warn("agent_chat.resume_session_thread_failed", {
            sessionId,
            threadId,
            error: resumeError instanceof Error ? resumeError.message : String(resumeError)
          });
          const startResponse = await runtime.request<{ thread?: { id?: string } }>("thread/start", {
            model: managed.session.model,
            ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
            cwd: managed.laneWorktreePath,
            approvalPolicy: config.codexApprovalPolicy,
            sandbox: config.codexSandboxMode,
            experimentalRawEvents: false,
            persistExtendedHistory: true
          });
          const newThreadId = typeof startResponse.thread?.id === "string" ? startResponse.thread.id : undefined;
          if (newThreadId) {
            managed.session.threadId = newThreadId;
            sessionService.setResumeCommand(sessionId, `chat:codex:${newThreadId}`);
          }
          runtime.threadResumed = true;
        }
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

    persistChatState(managed);
    return managed.session;
  };

  const listSessions = async (laneId?: string): Promise<AgentChatSessionSummary[]> => {
    const rows = sessionService.list({ ...(laneId ? { laneId } : {}), limit: 500 });
    const chatRows = rows.filter((row) => isChatToolType(row.toolType));

    return chatRows.map((row) => {
      const persisted = readPersistedState(row.id);
      const provider = providerFromToolType(row.toolType);
      return {
        sessionId: row.id,
        laneId: row.laneId,
        provider,
        model: persisted?.model ?? (provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL),
        reasoningEffort: persisted?.reasoningEffort ?? null,
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

  const approveToolUse = async ({ sessionId, itemId, decision }: { sessionId: string; itemId: string; decision: AgentChatApprovalDecision }): Promise<void> => {
    const managed = ensureManagedSession(sessionId);

    if (managed.runtime?.kind === "codex") {
      const pending = managed.runtime.approvals.get(itemId);
      if (!pending) {
        throw new Error(`No pending approval found for item '${itemId}'.`);
      }

      const mapped = mapApprovalDecisionForCodex(decision);
      if (pending.kind === "command") {
        managed.runtime.sendResponse(pending.requestId, { decision: mapped });
      } else {
        managed.runtime.sendResponse(pending.requestId, { decision: mapped });
      }
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

    throw new Error(`Session '${sessionId}' does not have a live runtime for approvals.`);
  };

  const getAvailableModels = async ({ provider }: { provider: AgentChatProvider }): Promise<AgentChatModelInfo[]> => {
    if (provider === "codex") {
      return listCodexModelsFromAppServer();
    }
    if (provider === "claude") {
      return listClaudeModelsFromSdk();
    }

    // For non-legacy providers, try to resolve from the model registry
    try {
      const auth = await detectAllAuth();
      const available = getRegistryModels(auth);
      const familyModels = available.filter(m => m.family === provider);
      if (familyModels.length > 0) {
        return familyModels.map((m, i) => ({
          id: m.sdkModelId,
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
    let clearClaudeRuntimeAfterFinish = false;

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

      try {
        managed.runtime.reader.close();
      } catch {
        // ignore
      }
      try {
        managed.runtime.process.kill();
      } catch {
        // ignore
      }
      managed.runtime.pending.clear();
      managed.runtime.approvals.clear();
      managed.runtime = null;
    }

    if (managed.runtime?.kind === "claude") {
      managed.runtime.interrupted = true;
      managed.runtime.abortController?.abort();
      for (const pending of managed.runtime.approvals.values()) {
        pending.resolve("cancel");
      }
      managed.runtime.approvals.clear();
      clearClaudeRuntimeAfterFinish = true;
    }

    await finishSession(managed, "disposed", {
      summary: managed.preview ? `Session closed: ${managed.preview}` : "Session closed."
    });

    if (clearClaudeRuntimeAfterFinish) {
      managed.runtime = null;
    }
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

  const listContextPacks = async (args: { laneId?: string } = {}): Promise<import("../../../shared/types").ContextPackOption[]> => {
    const packs: import("../../../shared/types").ContextPackOption[] = [
      { scope: "project", label: "Project", description: "Full project context pack", available: true },
    ];

    if (args.laneId) {
      packs.push(
        { scope: "lane", label: "Lane", description: "Current lane context", available: true, laneId: args.laneId },
        { scope: "conflict", label: "Conflicts", description: "Conflict analysis for this lane", available: true, laneId: args.laneId },
        { scope: "plan", label: "Plan", description: "Lane development plan", available: true, laneId: args.laneId }
      );
    }

    packs.push(
      { scope: "mission", label: "Mission", description: "Active mission context", available: true }
    );

    return packs;
  };

  const fetchContextPack = async (args: import("../../../shared/types").ContextPackFetchArgs): Promise<import("../../../shared/types").ContextPackFetchResult> => {
    const MAX_CHARS = 50_000;
    let content = "";
    let truncated = false;

    try {
      content = `[Context Pack: ${args.scope}]`;

      if (content.length > MAX_CHARS) {
        content = content.slice(0, MAX_CHARS);
        truncated = true;
      }
    } catch (error) {
      content = `Failed to fetch ${args.scope} context: ${error instanceof Error ? error.message : String(error)}`;
    }

    return { scope: args.scope, content, truncated };
  };

  return {
    createSession,
    sendMessage,
    steer,
    interrupt,
    resumeSession,
    listSessions,
    approveToolUse,
    getAvailableModels,
    dispose,
    disposeAll,
    listContextPacks,
    fetchContextPack
  };
}
