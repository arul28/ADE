import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { IPty, IWindowsPtyForkOptions } from "node-pty";
import type * as ptyNs from "node-pty";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import { resolveLaneLaunchContext } from "../lanes/laneLaunchContext";
import type { createSessionService } from "../sessions/sessionService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createProjectConfigService } from "../config/projectConfigService";
import { runGit } from "../git/git";
import { resolveCliSpawnInvocation } from "../shared/processExecution";
import type {
  PtyDataEvent,
  PtyExitEvent,
  PtyCreateArgs,
  PtyCreateResult,
  ChatTerminalActiveForChatArgs,
  ChatTerminalListArgs,
  ChatTerminalReadArgs,
  ChatTerminalReadResult,
  ChatTerminalSession,
  ChatTerminalSignalArgs,
  ChatTerminalWriteArgs,
  TerminalResumeMetadata,
  TerminalRuntimeState,
  TerminalSessionStatus,
  TerminalSessionSummary,
  TerminalToolType
} from "../../../shared/types";
import { isProviderSlashCommandInput } from "../../../shared/chatSlashCommands";
import { stripAnsi } from "../../utils/ansiStrip";
import { summarizeTerminalSession } from "../../utils/sessionSummary";
import { derivePreviewFromChunk } from "../../utils/terminalPreview";
import {
  defaultResumeCommandForTool,
  extractResumeCommandFromOutput,
  parseTrackedCliLaunchConfig,
  runtimeStateFromOsc133Chunk
} from "../../utils/terminalSessionSignals";

/** Delay before auto-generating a title from CLI output; keep in sync with tests. */
export const PTY_AI_TITLE_DEBOUNCE_MS = 6000;
export const PTY_AI_TITLE_TIMEOUT_MS = 60_000;

/** Interactive agent TUIs often hide useful text in an alt-screen, so titles come from the first submitted user prompt instead of startup output. */
const CLI_USER_TITLE_TOOL_TYPES = new Set<TerminalToolType>(["claude", "codex", "cursor-cli", "droid", "opencode"]);

function shouldScheduleOutputSnippetTitle(tool: TerminalToolType | null): boolean {
  if (!tool || tool === "shell" || tool === "run-shell") return false;
  return !CLI_USER_TITLE_TOOL_TYPES.has(tool);
}

const CLI_USER_TITLE_SEED_MIN_LEN = 3;
const CLI_USER_TITLE_SEED_MAX_LEN = 180;
const CLI_USER_TITLE_FALLBACK_MAX_LEN = 72;
const PTY_DATA_BATCH_INTERVAL_MS = 16;
const PTY_DATA_BATCH_MAX_CHARS = 64 * 1024;
const PTY_DATA_SUMMARY_INTERVAL_MS = 10_000;
const DEFAULT_TERMINAL_READ_MAX_BYTES = 220_000;

function hasEnvValue(env: NodeJS.ProcessEnv, key: string): boolean {
  return typeof env[key] === "string" && env[key]!.trim().length > 0;
}

function withInteractiveTerminalColorEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const term = next.TERM?.trim().toLowerCase() ?? "";
  if (!term || term === "dumb") {
    next.TERM = "xterm-256color";
  }
  if (!hasEnvValue(next, "COLORTERM")) {
    next.COLORTERM = "truecolor";
  }
  if (!hasEnvValue(next, "NO_COLOR") && !hasEnvValue(next, "FORCE_COLOR")) {
    next.FORCE_COLOR = "1";
  }
  return next;
}

function withAdeTerminalContextEnv(env: NodeJS.ProcessEnv, args: {
  projectRoot: string;
  laneId: string;
  chatSessionId: string | null;
}): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    ADE_PROJECT_ROOT: args.projectRoot,
    ADE_LANE_ID: args.laneId,
  };
  if (args.chatSessionId) {
    next.ADE_CHAT_SESSION_ID = args.chatSessionId;
  } else {
    delete next.ADE_CHAT_SESSION_ID;
  }
  return next;
}

function sanitizeCliUserTitleSeed(raw: string): string {
  const stripped = stripAnsi(raw)
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped.length) return "";
  return stripped.slice(0, CLI_USER_TITLE_SEED_MAX_LEN);
}

function trimPromptLeadIn(raw: string): string {
  let text = raw.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = text
      .replace(/^(?:ok(?:ay)?|so|hey|hi|hello|please|pls|vv)\b[\s,.:;-]*/iu, "")
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

function sentenceCase(raw: string): string {
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw;
}

function deterministicCliTitleFromSeed(seed: string): string {
  const cleaned = trimPromptLeadIn(seed)
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";

  const clauseMatch = cleaned.match(/^(.{18,}?[,.!?;:])\s/u);
  const clause = clauseMatch?.[1]?.replace(/[,.!?;:]+$/u, "").trim();
  const base = clause && clause.length >= 12 ? clause : cleaned;
  const clipped = base.length > CLI_USER_TITLE_FALLBACK_MAX_LEN
    ? base.slice(0, CLI_USER_TITLE_FALLBACK_MAX_LEN).replace(/\s+\S*$/u, "").trim()
    : base;
  return sentenceCase(clipped || base.slice(0, CLI_USER_TITLE_FALLBACK_MAX_LEN).trim()).replace(/[.?!,:;]+$/u, "");
}

function isCliPlaceholderTitle(title: string | null | undefined, toolType: TerminalToolType | null | undefined): boolean {
  const normalized = String(title ?? "").trim().toLowerCase();
  if (!normalized.length) return true;
  if (isProviderSlashCommandInput(normalized)) return true;
  if (toolType === "codex") return normalized === "codex" || normalized === "codex cli" || normalized === "codex session";
  if (toolType === "claude") return normalized === "claude" || normalized === "claude cli" || normalized === "claude session" || normalized === "claude code";
  return false;
}

function sanitizeGeneratedCliTitle(raw: string): string {
  const title = stripAnsi(raw)
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N})\]]+$/gu, "")
    .trim()
    .slice(0, 80)
    .trim();
  if (!title.length) return "";
  if (isProviderSlashCommandInput(title)) return "";
  const collapsed = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const rejected = new Set([
    "model", "models", "status", "help", "clear", "compact", "resume",
    "chat", "session", "claude", "claude code", "codex", "codex cli",
    "untitled", "untitled chat", "new chat", "new session",
    "completed", "done", "finished", "success",
  ]);
  if (/^(new session|new chat|untitled chat|untitled)\b/u.test(collapsed)) return "";
  return rejected.has(collapsed) ? "" : title;
}

function isSessionManuallyNamed(
  sessionService: ReturnType<typeof createSessionService>,
  sessionId: string,
): boolean {
  return sessionService.get(sessionId)?.manuallyNamed === true;
}

type PtyEntry = {
  pty: IPty;
  laneId: string;
  laneWorktreePath: string;
  boundCwd: string;
  sessionId: string;
  chatSessionId: string | null;
  tracked: boolean;
  transcriptPath: string;
  transcriptStream: fs.WriteStream | null;
  transcriptBytesWritten: number;
  transcriptLimitReached: boolean;
  lastPreviewWriteAt: number;
  previewCurrentLine: string;
  latestPreviewLine: string | null;
  lastPreviewWritten: string | null;
  toolTypeHint: TerminalToolType | null;
  resumeCommand: string | null;
  resumeCommandIsFallback: boolean;
  resumeScanBuffer: string;
  lastRuntimeSignalAt: number;
  lastRuntimeSignalState: TerminalRuntimeState;
  lastRuntimeSignalPreview: string | null;
  disposed: boolean;
  createdAt: number;
  cleanupPaths: string[];
  lastResizeCols: number | null;
  lastResizeRows: number | null;
  pendingDataChunks: string[];
  pendingDataChars: number;
  pendingDataTimer: ReturnType<typeof setTimeout> | null;
  /** Output-snippet title timer (skipped for interactive Claude/Codex; see CLI user-title path). */
  aiTitleTimer: ReturnType<typeof setTimeout> | null;
  cliUserTitleLineBuffer: string;
  cliUserTitleCommitted: boolean;
};

type RuntimeStateEntry = {
  state: TerminalRuntimeState;
  updatedAt: number;
  lastActivityAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

type PtyDataListener = (event: PtyDataEvent & { laneId: string }) => void;

type PtyExitListener = (event: PtyExitEvent & { laneId: string }) => void;

type ShellSpec = { file: string; args: string[] };

function resolveShellCandidates(): ShellSpec[] {
  if (process.platform === "win32") {
    return [
      { file: "powershell.exe", args: [] },
      { file: "cmd.exe", args: [] }
    ];
  }
  const candidates: string[] = [];
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv) candidates.push(fromEnv);
  candidates.push("/bin/zsh", "/bin/bash", "/bin/sh");
  const uniq = Array.from(new Set(candidates.filter(Boolean)));
  return uniq.map((file) => ({ file, args: [] }));
}

function quotePosixShellArg(value: string): string {
  if (!value.length) return "''";
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildDirectCommandShellFallback(command: string, args: string[]): string | null {
  if (process.platform === "win32") return null;
  return ["exec", command, ...args].map(quotePosixShellArg).join(" ");
}

function clampDims(cols: number, rows: number): { cols: number; rows: number } {
  const safeCols = Number.isFinite(cols) ? Math.max(20, Math.min(400, Math.floor(cols))) : 80;
  const safeRows = Number.isFinite(rows) ? Math.max(6, Math.min(200, Math.floor(rows))) : 24;
  return { cols: safeCols, rows: safeRows };
}

function statusFromExit(exitCode: number | null): TerminalSessionStatus {
  if (exitCode == null) return "completed";
  if (exitCode === 0) return "completed";
  return "failed";
}

function runtimeFromStatus(status: TerminalSessionStatus): TerminalRuntimeState {
  if (status === "running") return "running";
  if (status === "disposed") return "killed";
  return "exited";
}

function normalizeToolType(raw: unknown): TerminalToolType | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value) return null;
  const allowed: TerminalToolType[] = [
    "shell",
    "run-shell",
    "claude",
    "codex",
    "cursor-cli",
    "droid",
    "opencode",
    "claude-orchestrated",
    "codex-orchestrated",
    "opencode-orchestrated",
    "codex-chat",
    "claude-chat",
    "opencode-chat",
    "cursor",
    "droid-chat",
    "aider",
    "continue",
    "other"
  ];
  return (allowed as string[]).includes(value) ? (value as TerminalToolType) : "other";
}

/** Extract --session-id <uuid> from a Claude startup command if present. */
function extractClaudeSessionIdFromCommand(command: string): string | null {
  const match = command.match(/--session-id\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match?.[1] ?? null;
}

function buildInitialResumeMetadata(args: {
  toolType: TerminalToolType | null;
  startupCommand: string;
}): TerminalResumeMetadata | null {
  const parsedLaunch = parseTrackedCliLaunchConfig(args.startupCommand, args.toolType);
  const isClaude = args.toolType === "claude" || args.toolType === "claude-orchestrated";
  const isCodex = args.toolType === "codex" || args.toolType === "codex-orchestrated";
  const isCursor = args.toolType === "cursor-cli";
  const isDroid = args.toolType === "droid";
  const isOpenCode = args.toolType === "opencode";

  // Extract pre-assigned --session-id from Claude startup command
  const preAssignedId = isClaude ? extractClaudeSessionIdFromCommand(args.startupCommand) : null;

  if (parsedLaunch) {
    let provider: TerminalResumeMetadata["provider"] = "claude";
    if (isCodex) provider = "codex";
    else if (isCursor) provider = "cursor";
    else if (isDroid) provider = "droid";
    else if (isOpenCode) provider = "opencode";
    return {
      provider,
      targetKind: isCodex ? "thread" : "session",
      targetId: preAssignedId,
      launch: parsedLaunch,
    };
  }

  if (isClaude) {
    return { provider: "claude", targetKind: "session", targetId: preAssignedId, launch: {} };
  }
  if (isCodex) {
    return { provider: "codex", targetKind: "thread", targetId: null, launch: {} };
  }
  if (isCursor) {
    return { provider: "cursor", targetKind: "session", targetId: null, launch: {} };
  }
  if (isDroid) {
    return { provider: "droid", targetKind: "session", targetId: null, launch: {} };
  }
  if (isOpenCode) {
    return { provider: "opencode", targetKind: "session", targetId: null, launch: {} };
  }
  return null;
}

function isTrackedCliToolType(toolType: TerminalToolType | null): toolType is "claude" | "codex" | "cursor-cli" | "droid" | "opencode" | "claude-orchestrated" | "codex-orchestrated" {
  return toolType === "claude"
    || toolType === "codex"
    || toolType === "cursor-cli"
    || toolType === "droid"
    || toolType === "opencode"
    || toolType === "claude-orchestrated"
    || toolType === "codex-orchestrated";
}

function inferSessionCwdFromTranscriptPath(transcriptPath: string | null | undefined): string | null {
  if (!transcriptPath) return null;
  const normalized = transcriptPath.replace(/\\/g, "/");
  const markerIndex = normalized.indexOf("/.ade/transcripts/");
  if (markerIndex < 0) return null;
  return transcriptPath.slice(0, markerIndex) || null;
}

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const TRANSCRIPT_LIMIT_NOTICE = "\n[ADE] transcript limit reached (64MB). Further output omitted.\n";
const RESUME_TARGET_MISSING_COOLDOWN_MS = 10 * 60_000;
const RESUME_SCAN_WINDOW_MS = 60_000;

export function createPtyService({
  projectRoot,
  transcriptsDir,
  laneService,
  sessionService,
  aiIntegrationService,
  projectConfigService,
  getLaneRuntimeEnv,
  getAdeCliAgentEnv,
  logger,
  broadcastData,
  broadcastExit,
  onSessionEnded,
  onSessionRuntimeSignal,
  loadPty
}: {
  projectRoot: string;
  transcriptsDir: string;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService>;
  projectConfigService?: ReturnType<typeof createProjectConfigService>;
  getLaneRuntimeEnv?: (laneId: string) => Promise<Record<string, string>> | Record<string, string>;
  getAdeCliAgentEnv?: (baseEnv?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  logger: Logger;
  broadcastData: (ev: PtyDataEvent) => void;
  broadcastExit: (ev: PtyExitEvent) => void;
  onSessionEnded?: (args: { laneId: string; sessionId: string; exitCode: number | null }) => void;
  onSessionRuntimeSignal?: (args: {
    laneId: string;
    sessionId: string;
    runtimeState: TerminalRuntimeState;
    lastOutputPreview: string | null;
    at: string;
  }) => void;
  loadPty: () => typeof ptyNs;
}) {
  const ptys = new Map<string, PtyEntry>();
  const runtimeStates = new Map<string, RuntimeStateEntry>();
  const dataListeners = new Set<PtyDataListener>();
  const exitListeners = new Set<PtyExitListener>();
  const terminalChatSessions = new Map<string, string>();
  const activeTerminalByChatSession = new Map<string, string>();
  const missingResumeTargetBackfillFailures = new Map<string, { toolType: TerminalToolType | null; checkedAtMs: number }>();
  /** Timers for auto-closing tool-typed PTYs when the CLI tool exits back to shell prompt */
  const toolAutoCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let ptyDataSummaryTimer: ReturnType<typeof setTimeout> | null = null;
  let ptyDataSummaryStartedAt = Date.now();
  let ptyDataChunkCount = 0;
  let ptyDataBatchCount = 0;
  let ptyDataCharCount = 0;
  let ptyDataMaxBatchChars = 0;

  const getSessionIntelligence = () => {
    const ai = projectConfigService?.get().effective.ai;
    return ai?.sessionIntelligence;
  };

  const isTitleGenerationEnabled = (): boolean => {
    const si = getSessionIntelligence();
    return si?.titles?.enabled ?? true;
  };

  const resolveTitleModelId = (): string | undefined => {
    const si = getSessionIntelligence();
    const raw = si?.titles?.modelId;
    return typeof raw === "string" && raw.trim().length ? raw.trim() : undefined;
  };

  const tryCliUserTitleFromWrite = (entry: PtyEntry, data: string): void => {
    if (!CLI_USER_TITLE_TOOL_TYPES.has(entry.toolTypeHint ?? "shell")) return;
    if (entry.cliUserTitleCommitted || entry.disposed) return;

    entry.cliUserTitleLineBuffer += data;
    while (true) {
      const idx = entry.cliUserTitleLineBuffer.indexOf("\r");
      if (idx === -1) break;
      const segment = entry.cliUserTitleLineBuffer.slice(0, idx);
      entry.cliUserTitleLineBuffer = entry.cliUserTitleLineBuffer.slice(idx + 1);
      const seed = sanitizeCliUserTitleSeed(segment);
      if (seed.length < CLI_USER_TITLE_SEED_MIN_LEN) continue;
      if (isProviderSlashCommandInput(seed)) continue;

      entry.cliUserTitleCommitted = true;
      if (entry.aiTitleTimer) {
        clearTimeout(entry.aiTitleTimer);
        entry.aiTitleTimer = null;
      }

      const session = sessionService.get(entry.sessionId);
      if (!session) return;
      if (!session.goal?.trim().length) {
        sessionService.updateMeta({ sessionId: entry.sessionId, goal: seed });
      }
      if (isSessionManuallyNamed(sessionService, entry.sessionId)) {
        logger.info("pty.cli_user_title_skipped_user_renamed", { sessionId: entry.sessionId });
        return;
      }
      if (isCliPlaceholderTitle(session.title, session.toolType)) {
        const fallbackTitle = deterministicCliTitleFromSeed(seed);
        if (fallbackTitle) {
          sessionService.updateMeta({ sessionId: entry.sessionId, title: fallbackTitle, manuallyNamed: false });
        }
      }
      if (!aiIntegrationService || aiIntegrationService.getMode() === "guest") return;
      if (!isTitleGenerationEnabled()) return;

      const laneName = session.laneName?.trim() || "Current lane";
      const titleModelId = resolveTitleModelId();
      const prompt = [
        "Write a concise title for this CLI coding session.",
        "Return only plain text, max 80 characters, no punctuation at the end.",
        "",
        `Lane: ${laneName}`,
        `Session type: ${session.toolType ?? "terminal"}`,
        "Primary request (first submitted user input):",
        seed,
      ].join("\n");

      const capturedAi = aiIntegrationService;
      capturedAi
        .summarizeTerminal({
          cwd: entry.boundCwd || entry.laneWorktreePath,
          prompt,
          taskType: "session_title",
          timeoutMs: PTY_AI_TITLE_TIMEOUT_MS,
          ...(titleModelId ? { model: titleModelId } : {}),
        })
        .then((result) => {
          if (entry.disposed) return;
          const title = sanitizeGeneratedCliTitle(result.text);
          if (!title) return;
          if (isSessionManuallyNamed(sessionService, entry.sessionId)) {
            logger.info("pty.cli_user_title_skipped_user_renamed", { sessionId: entry.sessionId });
            return;
          }
          sessionService.updateMeta({ sessionId: entry.sessionId, title, manuallyNamed: false });
        })
        .catch((err) => {
          logger.warn("pty.cli_user_title_generation_failed", {
            sessionId: entry.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return;
    }

    if (entry.cliUserTitleLineBuffer.length > 8000) {
      entry.cliUserTitleLineBuffer = entry.cliUserTitleLineBuffer.slice(-4000);
    }
  };

  /** Only orchestrated worker sessions auto-close after the wrapped CLI exits back to shell. */
  const TOOL_TYPES_WITH_AUTO_CLOSE = new Set<TerminalToolType>([
    "claude-orchestrated",
    "codex-orchestrated",
    "opencode-orchestrated"
  ]);

  const clearToolAutoCloseTimer = (ptyId: string) => {
    const timer = toolAutoCloseTimers.get(ptyId);
    if (timer) {
      clearTimeout(timer);
      toolAutoCloseTimers.delete(ptyId);
    }
  };

  const clearIdleTimer = (sessionId: string) => {
    const state = runtimeStates.get(sessionId);
    if (!state?.idleTimer) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  };

  const flushPtyDataSummary = () => {
    if (ptyDataSummaryTimer) {
      clearTimeout(ptyDataSummaryTimer);
      ptyDataSummaryTimer = null;
    }
    if (ptyDataChunkCount > 0 || ptyDataBatchCount > 0) {
      const intervalMs = Math.max(1, Date.now() - ptyDataSummaryStartedAt);
      logger.info("pty.data.summary", {
        intervalMs,
        chunks: ptyDataChunkCount,
        batches: ptyDataBatchCount,
        chars: ptyDataCharCount,
        avgChunksPerBatch: ptyDataBatchCount > 0 ? Math.round((ptyDataChunkCount / ptyDataBatchCount) * 10) / 10 : 0,
        maxBatchChars: ptyDataMaxBatchChars,
        activePtys: ptys.size,
        listeners: dataListeners.size,
      });
    }
    ptyDataSummaryStartedAt = Date.now();
    ptyDataChunkCount = 0;
    ptyDataBatchCount = 0;
    ptyDataCharCount = 0;
    ptyDataMaxBatchChars = 0;
  };

  const schedulePtyDataSummary = () => {
    if (ptyDataSummaryTimer) return;
    ptyDataSummaryTimer = setTimeout(flushPtyDataSummary, PTY_DATA_SUMMARY_INTERVAL_MS);
  };

  const setRuntimeState = (sessionId: string, nextState: TerminalRuntimeState, opts?: { touch?: boolean }) => {
    const now = Date.now();
    const prev = runtimeStates.get(sessionId);
    if (prev) {
      prev.state = nextState;
      prev.updatedAt = now;
      if (opts?.touch ?? true) {
        prev.lastActivityAt = now;
      }
      runtimeStates.set(sessionId, prev);
      return;
    }
    runtimeStates.set(sessionId, {
      state: nextState,
      updatedAt: now,
      lastActivityAt: now,
      idleTimer: null
    });
  };

  const scheduleIdleTransition = (sessionId: string) => {
    const state = runtimeStates.get(sessionId);
    if (!state) return;
    clearIdleTimer(sessionId);
    state.idleTimer = setTimeout(() => {
      const current = runtimeStates.get(sessionId);
      if (!current) return;
      if (current.state !== "running") return;
      if (Date.now() - current.lastActivityAt < 12_000) return;
      current.state = "idle";
      current.updatedAt = Date.now();
      current.idleTimer = null;
    }, 12_500);
  };

  const safeTranscriptPathFor = (sessionId: string) => path.join(transcriptsDir, `${sessionId}.log`);

  const computeHeadShaBestEffort = async (worktreePath: string): Promise<string | null> => {
    const res = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 6_000 });
    if (res.exitCode !== 0) return null;
    const sha = res.stdout.trim();
    return sha.length ? sha : null;
  };

  const summarizeSessionBestEffort = (
    sessionId: string,
    context?: { laneWorktreePath?: string | null; boundCwd?: string | null },
  ): void => {
    const entryContext = Array.from(ptys.values()).find((entry) => entry.sessionId === sessionId) ?? null;
    const summaryCwd = (
      context?.boundCwd
      ?? context?.laneWorktreePath
      ?? entryContext?.boundCwd
      ?? entryContext?.laneWorktreePath
      ?? ""
    ).trim();
    Promise.resolve()
      .then(async () => {
        const session = sessionService.get(sessionId);
        if (!session) return;

        const transcript = session.tracked
          ? await sessionService.readTranscriptTail(session.transcriptPath, 220_000)
          : "";

        const summary = summarizeTerminalSession({
          title: session.title,
          goal: session.goal,
          toolType: session.toolType,
          exitCode: session.exitCode,
          transcript
        });

        sessionService.setSummary(sessionId, summary);

        const si = getSessionIntelligence();
        const hasAi = Boolean(aiIntegrationService && aiIntegrationService.getMode() !== "guest");

        // AI-enhanced summary (only when summaries are enabled and AI is available)
        if (si?.summaries?.enabled !== false && hasAi) {
          try {
            const prompt = [
              "You are ADE's terminal summary assistant.",
              "Rewrite this terminal session into a concise 1-3 sentence summary with outcome and next action.",
              "Do not invent commands or outcomes.",
              "",
              "Deterministic summary:",
              summary,
              "",
              "Terminal transcript tail:",
              transcript.slice(-18_000)
            ].join("\n");

            const summaryModelId = typeof si?.summaries?.modelId === "string" && si.summaries.modelId.trim().length
              ? si.summaries.modelId.trim()
              : undefined;

            const aiSummary = await aiIntegrationService!.summarizeTerminal({
              cwd: summaryCwd || laneService.getLaneBaseAndBranch(session.laneId).worktreePath,
              prompt,
              ...(summaryModelId ? { model: summaryModelId } : {}),
            });
            const text = aiSummary.text.trim();
            if (text.length) {
              sessionService.setSummary(sessionId, text);
            }
          } catch (err) {
            logger.warn("pty.ai_summary_failed", {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Refresh title on complete — runs independently of AI summaries toggle
        if (hasAi) {
          const refreshOnComplete = getSessionIntelligence()?.titles?.refreshOnComplete ?? true;
          if (refreshOnComplete && isTitleGenerationEnabled()) {
            try {
              if (isSessionManuallyNamed(sessionService, sessionId)) {
                logger.info("pty.session_title_refresh_skipped_user_renamed", { sessionId });
              } else {
              const titlePrompt = [
                "Generate a concise final title for this completed terminal session.",
                "Return only plain text, max 80 characters, no punctuation at the end.",
                "",
                `Session type: ${session.toolType ?? "terminal"}`,
                `Initial title: ${session.title}`,
                session.goal ? `Current goal: ${session.goal}` : null,
                `Exit code: ${session.exitCode ?? "unknown"}`,
                "",
                "Terminal transcript tail:",
                transcript.slice(-2000),
              ].filter(Boolean).join("\n");

              const titleModelId = resolveTitleModelId();
              const titleResult = await aiIntegrationService!.summarizeTerminal({
                cwd: summaryCwd || laneService.getLaneBaseAndBranch(session.laneId).worktreePath,
                prompt: titlePrompt,
                taskType: "session_title",
                timeoutMs: PTY_AI_TITLE_TIMEOUT_MS,
                ...(titleModelId ? { model: titleModelId } : {}),
              });
              const finalTitle = sanitizeGeneratedCliTitle(titleResult.text);
              if (finalTitle) {
                // Re-check in case user renamed during AI call
                if (isSessionManuallyNamed(sessionService, sessionId)) {
                  logger.info("pty.session_title_refresh_skipped_user_renamed", { sessionId });
                } else {
                  sessionService.updateMeta({ sessionId, title: finalTitle, manuallyNamed: false });
                }
              }
              }
            } catch (err) {
              logger.warn("pty.session_title_refresh_failed", {
                sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      })
      .catch(() => {
        // ignore summary generation failures
      });
  };

  const endTranscriptStream = (stream: fs.WriteStream | null): Promise<void> => {
    if (!stream) return Promise.resolve();
    if (stream.writableFinished || stream.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        stream.removeListener("finish", complete);
        stream.removeListener("error", complete);
        resolve();
      };
      stream.once("finish", complete);
      stream.once("error", complete);
      try {
        stream.end(() => complete());
      } catch {
        complete();
      }
    });
  };

  const scheduleTranscriptDependentWork = (
    entry: Pick<PtyEntry, "sessionId" | "toolTypeHint" | "transcriptStream" | "laneWorktreePath" | "boundCwd">,
    reason: "close" | "dispose" | "orphan-dispose",
  ): void => {
    void endTranscriptStream(entry.transcriptStream)
      .finally(() => {
        backfillResumeTargetFromTranscriptBestEffort(entry.sessionId, entry.toolTypeHint, reason, entry.boundCwd);
        summarizeSessionBestEffort(entry.sessionId, {
          laneWorktreePath: entry.laneWorktreePath,
          boundCwd: entry.boundCwd,
        });
      });
  };

  /**
   * Try to find the Claude session ID from Claude's local JSONL storage.
   * Claude Code stores conversations at ~/.claude/projects/<escaped-cwd>/<uuid>.jsonl.
   * We find the most recently modified JSONL in the project dir and return its UUID.
   */
  const resolveClaudeSessionIdFromStorage = (cwd: string): string | null => {
    try {
      const homedir = require("node:os").homedir();
      // Claude encodes the cwd by replacing / with - (and leading -)
      // Claude encodes cwd by replacing all / with - (e.g. /Users/admin/Projects/ADE → -Users-admin-Projects-ADE)
      const escapedCwd = cwd.replace(/\//g, "-");
      const claudeProjectDir = path.join(homedir, ".claude", "projects", escapedCwd);
      if (!fs.existsSync(claudeProjectDir)) return null;

      // Find the most recently modified .jsonl that is a direct session (not in subagents/)
      const entries = fs.readdirSync(claudeProjectDir, { withFileTypes: true });
      let newest: { name: string; mtimeMs: number } | null = null;
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const stat = fs.statSync(path.join(claudeProjectDir, entry.name));
        if (!newest || stat.mtimeMs > newest.mtimeMs) {
          newest = { name: entry.name, mtimeMs: stat.mtimeMs };
        }
      }
      if (!newest) return null;
      // UUID is the filename without .jsonl extension
      const uuid = newest.name.replace(/\.jsonl$/, "");
      // Basic UUID format check
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) return null;
      // Only consider if modified within the last 5 minutes (to avoid picking up stale sessions)
      if (Date.now() - newest.mtimeMs > 5 * 60 * 1000) return null;
      return uuid;
    } catch {
      return null;
    }
  };

  function readJsonlFirstLine(filePath: string, maxBytes = 256 * 1024): string | null {
    let fd: number | null = null;
    try {
      fd = fs.openSync(filePath, "r");
      const chunks: Buffer[] = [];
      let total = 0;
      let position = 0;
      while (total < maxBytes) {
        const nextRead = Math.min(4096, maxBytes - total);
        const buf = Buffer.alloc(nextRead);
        const bytesRead = fs.readSync(fd, buf, 0, nextRead, position);
        if (bytesRead <= 0) break;
        const slice = buf.subarray(0, bytesRead);
        const newlineIdx = slice.indexOf(0x0a);
        if (newlineIdx >= 0) {
          chunks.push(slice.subarray(0, newlineIdx));
          break;
        }
        chunks.push(slice);
        total += bytesRead;
        position += bytesRead;
      }
      const firstLine = Buffer.concat(chunks).toString("utf8").trim();
      return firstLine.length ? firstLine : null;
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close errors while scanning best-effort session metadata.
        }
      }
    }
  }

  function readFilePrefix(filePath: string, maxBytes = 512 * 1024): string | null {
    let fd: number | null = null;
    try {
      fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
      if (bytesRead <= 0) return null;
      return buf.subarray(0, bytesRead).toString("utf8");
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close errors while scanning best-effort session metadata.
        }
      }
    }
  }

  /**
   * Try to find the Codex session ID from Codex's local storage.
   * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
   * Each JSONL starts with a session_meta event containing `payload.id` and `payload.cwd`.
   * We score recent candidates by cwd match and closeness to ADE's session startedAt.
   */
  const resolveCodexSessionIdFromStorage = (args: {
    cwd: string;
    startedAt?: string | null;
    maxStartDeltaMs?: number;
    notBeforeMs?: number;
    requiredText?: string;
  }): string | null => {
    try {
      const sessionsBase = path.join(os.homedir(), ".codex", "sessions");
      if (!fs.existsSync(sessionsBase)) return null;

      const now = new Date();
      const requestedStartedAtMs = Date.parse(args.startedAt ?? "");
      const hasStartedAt = Number.isFinite(requestedStartedAtMs);
      const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
      for (let dayOffset = 0; dayOffset <= 6; dayOffset++) {
        const d = new Date(now.getTime() - dayOffset * 86400_000);
        const dirPath = path.join(
          sessionsBase,
          String(d.getFullYear()),
          String(d.getMonth() + 1).padStart(2, "0"),
          String(d.getDate()).padStart(2, "0"),
        );
        if (!fs.existsSync(dirPath)) continue;
        for (const entry of fs.readdirSync(dirPath)) {
          if (!entry.endsWith(".jsonl")) continue;
          const fp = path.join(dirPath, entry);
          const stat = fs.statSync(fp);
          candidates.push({ filePath: fp, mtimeMs: stat.mtimeMs });
        }
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

      let bestMatch: { id: string; score: number; mtimeMs: number } | null = null;
      for (const candidate of candidates.slice(0, 80)) {
        const firstLine = readJsonlFirstLine(candidate.filePath);
        if (!firstLine) continue;
        let meta: unknown;
        try {
          meta = JSON.parse(firstLine);
        } catch {
          continue;
        }
        const payload = typeof meta === "object" && meta != null ? (meta as { payload?: Record<string, unknown>; type?: unknown }).payload : null;
        const type = typeof meta === "object" && meta != null ? (meta as { type?: unknown }).type : null;
        const id = typeof payload?.id === "string" ? payload.id.trim() : "";
        const cwd = typeof payload?.cwd === "string" ? payload.cwd.trim() : "";
        if (type !== "session_meta" || !id || cwd !== args.cwd) continue;
        if (args.requiredText) {
          // The Codex session_meta record sits at the very top of the JSONL,
          // so 16 KB is more than enough to scan for the marker without
          // pulling half a megabyte off disk per candidate inside the poll.
          const prefix = readFilePrefix(candidate.filePath, 16 * 1024);
          if (!prefix?.includes(args.requiredText)) continue;
        }

        if (!hasStartedAt) return id;

        const payloadTimestamp = typeof payload?.timestamp === "string" ? payload.timestamp : "";
        const payloadTimestampMs = Date.parse(payloadTimestamp);
        const referenceMs = Number.isFinite(payloadTimestampMs) ? payloadTimestampMs : candidate.mtimeMs;
        if (typeof args.notBeforeMs === "number" && referenceMs < args.notBeforeMs) continue;
        const score = Math.abs(referenceMs - requestedStartedAtMs);
        if (typeof args.maxStartDeltaMs === "number" && score > args.maxStartDeltaMs) continue;
        if (!bestMatch || score < bestMatch.score || (score === bestMatch.score && candidate.mtimeMs > bestMatch.mtimeMs)) {
          bestMatch = { id, score, mtimeMs: candidate.mtimeMs };
        }
      }
      return bestMatch?.id ?? null;
    } catch {
      return null;
    }
  };

  const resolveDroidSessionIdFromStorage = (args: {
    cwd: string;
    startedAt?: string | null;
    maxStartDeltaMs?: number;
  }): string | null => {
    try {
      const escapedCwd = args.cwd.replace(/\//g, "-");
      const droidSessionsDir = path.join(os.homedir(), ".factory", "sessions");
      const expectedProjectDir = path.join(droidSessionsDir, escapedCwd);
      if (!fs.existsSync(droidSessionsDir)) return null;
      const projectDirs = fs.existsSync(expectedProjectDir)
        ? [expectedProjectDir]
        : fs.readdirSync(droidSessionsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(droidSessionsDir, entry.name));
      const requestedStartedAtMs = Date.parse(args.startedAt ?? "");
      const hasStartedAt = Number.isFinite(requestedStartedAtMs);
      let bestMatch: { id: string; score: number; mtimeMs: number } | null = null;
      for (const projectDir of projectDirs) {
        for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
          const filePath = path.join(projectDir, entry.name);
          const stat = fs.statSync(filePath);
          const firstLine = readJsonlFirstLine(filePath);
          if (!firstLine) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(firstLine);
          } catch {
            continue;
          }
          const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
          const id = typeof record?.id === "string" ? record.id.trim() : entry.name.replace(/\.jsonl$/, "");
          const cwd = typeof record?.cwd === "string" ? record.cwd.trim() : "";
          if (record?.type !== "session_start" || !id || cwd !== args.cwd) continue;
          if (!hasStartedAt) return id;
          const score = Math.abs(stat.mtimeMs - requestedStartedAtMs);
          if (typeof args.maxStartDeltaMs === "number" && score > args.maxStartDeltaMs) continue;
          if (!bestMatch || score < bestMatch.score || (score === bestMatch.score && stat.mtimeMs > bestMatch.mtimeMs)) {
            bestMatch = { id, score, mtimeMs: stat.mtimeMs };
          }
        }
      }
      return bestMatch?.id ?? null;
    } catch {
      return null;
    }
  };

  const resolveOpenCodeSessionIdFromCli = (args: {
    cwd: string;
    startedAt?: string | null;
    maxStartDeltaMs?: number;
  }): string | null => {
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
      delete env.FORCE_COLOR;
      const result = spawnSync("opencode", ["session", "list", "--format", "json", "--max-count", "80"], {
        cwd: args.cwd,
        encoding: "utf8",
        timeout: 4000,
        maxBuffer: 1024 * 1024,
        env,
      });
      if (result.error || result.status !== 0) return null;
      const stdout = String(result.stdout ?? "");
      const jsonStart = stdout.indexOf("[");
      if (jsonStart < 0) return null;
      const rows = JSON.parse(stdout.slice(jsonStart)) as unknown;
      if (!Array.isArray(rows)) return null;
      const requestedStartedAtMs = Date.parse(args.startedAt ?? "");
      const hasStartedAt = Number.isFinite(requestedStartedAtMs);
      let bestMatch: { id: string; score: number; updatedMs: number } | null = null;
      for (const row of rows) {
        const record = row && typeof row === "object" ? row as Record<string, unknown> : null;
        const id = typeof record?.id === "string" ? record.id.trim() : "";
        const directory = typeof record?.directory === "string" ? record.directory.trim() : "";
        if (!id || directory !== args.cwd) continue;
        const createdMs = Number(record?.created);
        const updatedMs = Number(record?.updated);
        let referenceMs: number;
        if (Number.isFinite(createdMs)) {
          referenceMs = createdMs;
        } else if (Number.isFinite(updatedMs)) {
          referenceMs = updatedMs;
        } else {
          referenceMs = Date.now();
        }
        if (!hasStartedAt) return id;
        const score = Math.abs(referenceMs - requestedStartedAtMs);
        if (typeof args.maxStartDeltaMs === "number" && score > args.maxStartDeltaMs) continue;
        if (!bestMatch || score < bestMatch.score || (score === bestMatch.score && referenceMs > bestMatch.updatedMs)) {
          bestMatch = { id, score, updatedMs: referenceMs };
        }
      }
      return bestMatch?.id ?? null;
    } catch {
      return null;
    }
  };

  const tryBackfillResumeTarget = async (
    sessionId: string,
    preferredToolType: TerminalToolType | null,
    reason: "close" | "dispose" | "orphan-dispose" | "session-list" | "resume-launch",
    sessionCwd?: string | null,
  ): Promise<boolean> => {
    const session = sessionService.get(sessionId);
    if (!session?.tracked) return false;
    const effectiveToolType = preferredToolType ?? session.toolType ?? null;
    if (!isTrackedCliToolType(effectiveToolType)) return false;
    if (session.resumeMetadata?.targetId?.trim()) return true;
    const recentMissing = missingResumeTargetBackfillFailures.get(sessionId);
    if (
      reason === "session-list"
      && recentMissing?.toolType === effectiveToolType
      && Date.now() - recentMissing.checkedAtMs < RESUME_TARGET_MISSING_COOLDOWN_MS
    ) {
      return false;
    }

    // Strategy 1: Try parsing the transcript for an explicit resume command
    const transcript = await sessionService.readTranscriptTail(session.transcriptPath, 220_000);
    const detected = extractResumeCommandFromOutput(transcript, effectiveToolType);
    if (detected) {
      missingResumeTargetBackfillFailures.delete(sessionId);
      sessionService.setResumeCommand(sessionId, detected);
      logger.info("pty.resume_target_backfilled", { sessionId, toolType: effectiveToolType, reason, source: "transcript" });
      return true;
    }

    // Strategy 2: Read the session/thread ID from the CLI's local storage
    const cwd = sessionCwd ?? inferSessionCwdFromTranscriptPath(session.transcriptPath);

    if ((effectiveToolType === "claude" || effectiveToolType === "claude-orchestrated") && cwd) {
      const claudeSessionId = resolveClaudeSessionIdFromStorage(cwd);
      if (claudeSessionId) {
        const resumeCmd = `claude --resume ${claudeSessionId}`;
        missingResumeTargetBackfillFailures.delete(sessionId);
        sessionService.setResumeCommand(sessionId, resumeCmd);
        logger.info("pty.resume_target_backfilled", { sessionId, toolType: effectiveToolType, reason, source: "claude-storage", claudeSessionId });
        return true;
      }
    }

    // The session-list path NEEDS this Codex storage fallback: it's how we
    // backfill resume targets for older sessions whose transcripts no longer
    // contain an explicit resume command. Only resume-launch is excluded —
    // that flow already has the live capture poll for fresh sessions, and
    // running the storage scan inline would slow launch.
    if ((effectiveToolType === "codex" || effectiveToolType === "codex-orchestrated") && cwd && reason !== "resume-launch") {
      const codexSessionId = resolveCodexSessionIdFromStorage({
        cwd,
        startedAt: session.startedAt,
        maxStartDeltaMs: 10 * 60_000,
      });
      if (codexSessionId) {
        const resumeCmd = `codex resume ${codexSessionId}`;
        missingResumeTargetBackfillFailures.delete(sessionId);
        sessionService.setResumeCommand(sessionId, resumeCmd);
        logger.info("pty.resume_target_backfilled", { sessionId, toolType: effectiveToolType, reason, source: "codex-storage", codexSessionId });
        return true;
      }
    }

    if (effectiveToolType === "droid" && cwd && reason !== "resume-launch") {
      const droidSessionId = resolveDroidSessionIdFromStorage({
        cwd,
        startedAt: session.startedAt,
        maxStartDeltaMs: 10 * 60_000,
      });
      if (droidSessionId) {
        const resumeCmd = `droid --resume ${droidSessionId}`;
        missingResumeTargetBackfillFailures.delete(sessionId);
        sessionService.setResumeCommand(sessionId, resumeCmd);
        logger.info("pty.resume_target_backfilled", { sessionId, toolType: effectiveToolType, reason, source: "droid-storage", droidSessionId });
        return true;
      }
    }

    if (effectiveToolType === "opencode" && cwd && reason !== "resume-launch") {
      const opencodeSessionId = resolveOpenCodeSessionIdFromCli({
        cwd,
        startedAt: session.startedAt,
        maxStartDeltaMs: 10 * 60_000,
      });
      if (opencodeSessionId) {
        const resumeCmd = `opencode --session ${opencodeSessionId}`;
        missingResumeTargetBackfillFailures.delete(sessionId);
        sessionService.setResumeCommand(sessionId, resumeCmd);
        logger.info("pty.resume_target_backfilled", { sessionId, toolType: effectiveToolType, reason, source: "opencode-session-list", opencodeSessionId });
        return true;
      }
    }

    if (reason === "session-list") {
      missingResumeTargetBackfillFailures.set(sessionId, {
        toolType: effectiveToolType,
        checkedAtMs: Date.now(),
      });
    }
    logger.warn("pty.resume_target_missing", { sessionId, toolType: effectiveToolType, reason });
    return false;
  };

  const backfillResumeTargetFromTranscriptBestEffort = (
    sessionId: string,
    preferredToolType: TerminalToolType | null,
    reason: "close" | "dispose" | "orphan-dispose",
    sessionCwd?: string | null,
  ): void => {
    void tryBackfillResumeTarget(sessionId, preferredToolType, reason, sessionCwd).catch((err) => {
      logger.warn("pty.resume_target_backfill_failed", {
        sessionId,
        toolType: preferredToolType,
        reason,
        err: String(err),
      });
    });
  };

  // Polling is the fallback when fs.watch is unavailable or misses the create/write events.
  // Cadence is intentionally aggressive at the start (codex usually writes session_meta within
  // ~1 s) and falls off so a slow startup doesn't keep timers alive forever.
  const CODEX_FALLBACK_POLL_DELAYS_MS = [500, 2_000, 5_000, 12_000, 30_000];
  const CODEX_LIVE_CAPTURE_HARD_TIMEOUT_MS = 60_000;
  const CODEX_WATCH_DEBOUNCE_MS = 200;

  /**
   * Stable thread name we register against the freshly-discovered codex UUID. From this point
   * forward, `codex resume ade-<id>` resolves through `~/.codex/session_index.jsonl` regardless
   * of where the rollout file ends up on disk. We control this name space (`ade-*`) so it never
   * collides with user-chosen names.
   */
  const buildCodexAdeName = (sessionId: string): string => {
    const stripped = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
    return `ade-${stripped || "session"}`;
  };

  /**
   * Append `{id, thread_name, updated_at}` to ~/.codex/session_index.jsonl so codex's resume
   * picker can find the session by our chosen name. Codex normally writes this file from its
   * `SetThreadName` op, but the format is a public on-disk contract — appending one line with
   * an atomic write is well under PIPE_BUF and safe vs. concurrent codex writers. Returns true
   * on successful write.
   */
  const registerCodexThreadNameInIndex = (uuid: string, threadName: string): boolean => {
    if (typeof (fs as { appendFileSync?: unknown }).appendFileSync !== "function") return false;
    try {
      const indexPath = path.join(os.homedir(), ".codex", "session_index.jsonl");
      const line = JSON.stringify({
        id: uuid,
        thread_name: threadName,
        updated_at: new Date().toISOString(),
      }) + "\n";
      fs.appendFileSync(indexPath, line, { encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  };

  // Codex CLI has no pre-assigned session ID flag (unlike Claude's --session-id), so the
  // rollout JSONL is the only handle on the session's UUID. We watch the day directory for the
  // file's appearance, then claim a stable `ade-<id>` thread name so future resumes don't
  // depend on filesystem heuristics. A staggered poll covers environments where fs.watch is
  // missing/unreliable (network mounts, Linux on some FSes, the test harness).
  const scheduleCodexSessionIdCaptureBestEffort = (
    sessionId: string,
    cwd: string,
    startedAt: string,
  ): void => {
    const startedAtMs = Date.parse(startedAt);
    const startedAtFinite = Number.isFinite(startedAtMs) ? startedAtMs : null;
    const sessionsBase = path.join(os.homedir(), ".codex", "sessions");
    let captured = false;
    const watchers: Array<{ close: () => void }> = [];
    const timers = new Set<NodeJS.Timeout>();
    let watchDebounceTimer: NodeJS.Timeout | null = null;

    const trackTimer = (t: NodeJS.Timeout): NodeJS.Timeout => {
      timers.add(t);
      t.unref?.();
      return t;
    };

    const cleanup = (): void => {
      captured = true;
      for (const w of watchers) {
        try { w.close(); } catch { /* ignore */ }
      }
      watchers.length = 0;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (watchDebounceTimer) {
        clearTimeout(watchDebounceTimer);
        watchDebounceTimer = null;
      }
    };

    const tryResolve = (source: "initial" | "watch" | "poll", attempt: number): boolean => {
      if (captured) return true;
      const session = sessionService.get(sessionId);
      if (!session) {
        cleanup();
        return true;
      }
      if (session.resumeMetadata?.targetId?.trim()) {
        cleanup();
        return true;
      }
      const codexUuid = resolveCodexSessionIdFromStorage({
        cwd,
        startedAt,
        maxStartDeltaMs: 5 * 60_000,
        ...(startedAtFinite !== null ? { notBeforeMs: startedAtFinite - 1_000 } : {}),
        requiredText: "ADE session guidance",
      });
      if (!codexUuid) return false;

      captured = true;
      const adeName = buildCodexAdeName(sessionId);
      const indexed = registerCodexThreadNameInIndex(codexUuid, adeName);
      const resumeCmd = indexed ? `codex resume ${adeName}` : `codex resume ${codexUuid}`;
      sessionService.setResumeCommand(sessionId, resumeCmd);
      logger.info("pty.codex_session_id_captured_live", {
        sessionId,
        codexSessionId: codexUuid,
        adeName: indexed ? adeName : null,
        source,
        attempt,
      });
      cleanup();
      return true;
    };

    if (tryResolve("initial", 0)) return;

    if (typeof (fs as { watch?: unknown }).watch === "function") {
      const now = new Date();
      for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
        const d = new Date(now.getTime() + dayOffset * 86_400_000);
        const dirPath = path.join(
          sessionsBase,
          String(d.getFullYear()),
          String(d.getMonth() + 1).padStart(2, "0"),
          String(d.getDate()).padStart(2, "0"),
        );
        try {
          try { fs.mkdirSync(dirPath, { recursive: true }); } catch { /* ignore */ }
          const watcher = fs.watch(dirPath, { persistent: false }, (_event, filename) => {
            if (captured) return;
            if (typeof filename === "string" && filename && !filename.endsWith(".jsonl")) return;
            if (watchDebounceTimer) return;
            watchDebounceTimer = setTimeout(() => {
              watchDebounceTimer = null;
              if (!captured) tryResolve("watch", 0);
            }, CODEX_WATCH_DEBOUNCE_MS);
            watchDebounceTimer.unref?.();
          });
          watcher.unref?.();
          watchers.push(watcher);
        } catch (err) {
          logger.warn("pty.codex_session_id_watch_failed", { sessionId, dirPath, err: String(err) });
        }
      }
    }

    for (let i = 0; i < CODEX_FALLBACK_POLL_DELAYS_MS.length; i++) {
      const attempt = i;
      trackTimer(setTimeout(() => {
        try {
          if (captured) return;
          tryResolve("poll", attempt);
        } catch (err) {
          logger.warn("pty.codex_session_id_capture_failed", { sessionId, attempt, err: String(err) });
        }
      }, CODEX_FALLBACK_POLL_DELAYS_MS[i]));
    }

    trackTimer(setTimeout(() => {
      cleanup();
    }, CODEX_LIVE_CAPTURE_HARD_TIMEOUT_MS));
  };

  const closeEntry = (ptyId: string, exitCode: number | null) => {
    const entry = ptys.get(ptyId);
    if (!entry) return;
    if (entry.disposed) return;
    entry.disposed = true;
    if (entry.aiTitleTimer) {
      clearTimeout(entry.aiTitleTimer);
      entry.aiTitleTimer = null;
    }
    clearToolAutoCloseTimer(ptyId);
    cleanupEntryPaths(entry);
    flushPreview(entry);

    const endedAt = new Date().toISOString();
    const status = statusFromExit(exitCode);
    sessionService.end({ sessionId: entry.sessionId, endedAt, exitCode, status });
    scheduleTranscriptDependentWork(entry, "close");
    clearIdleTimer(entry.sessionId);
    const finalRuntimeState = runtimeFromStatus(status);
    setRuntimeState(entry.sessionId, finalRuntimeState, { touch: false });
    runtimeStates.delete(entry.sessionId);
    if (entry.chatSessionId && activeTerminalByChatSession.get(entry.chatSessionId) === entry.sessionId) {
      const replacement = Array.from(ptys.values())
        .filter((candidate) => (
          candidate.sessionId !== entry.sessionId
          && !candidate.disposed
          && candidate.chatSessionId === entry.chatSessionId
        ))
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      if (replacement) {
        activeTerminalByChatSession.set(entry.chatSessionId, replacement.sessionId);
      } else {
        activeTerminalByChatSession.delete(entry.chatSessionId);
      }
    }
    try {
      onSessionRuntimeSignal?.({
        laneId: entry.laneId,
        sessionId: entry.sessionId,
        runtimeState: finalRuntimeState,
        lastOutputPreview: entry.latestPreviewLine ?? entry.lastPreviewWritten ?? null,
        at: endedAt
      });
    } catch {
      // ignore callback failures
    }

    // Best-effort head SHA at end; never block exit.
    Promise.resolve()
      .then(async () => {
        const sha = await computeHeadShaBestEffort(entry.boundCwd || entry.laneWorktreePath);
        if (sha) sessionService.setHeadShaEnd(entry.sessionId, sha);
      })
      .catch(() => {})
      .finally(() => {
        if (!entry.tracked) return;
        try {
          onSessionEnded?.({ laneId: entry.laneId, sessionId: entry.sessionId, exitCode });
        } catch {
          // ignore
        }
      });

    flushQueuedPtyData(entry, { ptyId, sessionId: entry.sessionId });
    emitPtyExit(entry, { ptyId, sessionId: entry.sessionId, exitCode });
    ptys.delete(ptyId);
  };

  const writeTranscript = (entry: PtyEntry, data: string) => {
    if (!entry.tracked || !entry.transcriptStream) return;
    if (entry.transcriptLimitReached) return;
    try {
      const chunk = Buffer.from(data, "utf8");
      const remaining = MAX_TRANSCRIPT_BYTES - entry.transcriptBytesWritten;
      if (remaining <= 0) {
        entry.transcriptLimitReached = true;
        entry.transcriptStream.write(TRANSCRIPT_LIMIT_NOTICE);
        return;
      }
      if (chunk.length > remaining) {
        entry.transcriptStream.write(chunk.subarray(0, remaining));
        entry.transcriptBytesWritten += remaining;
        entry.transcriptLimitReached = true;
        entry.transcriptStream.write(TRANSCRIPT_LIMIT_NOTICE);
        return;
      }
      entry.transcriptStream.write(chunk);
      entry.transcriptBytesWritten += chunk.length;
    } catch {
      // ignore
    }
  };

  const flushPreview = (entry: PtyEntry) => {
    const candidate = (entry.latestPreviewLine ?? "").trim();
    if (!candidate) return;
    if (candidate === entry.lastPreviewWritten) return;
    entry.lastPreviewWritten = candidate;
    sessionService.setLastOutputPreview(entry.sessionId, candidate);
  };

  const updatePreviewThrottled = (entry: PtyEntry, chunk: string) => {
    const next = derivePreviewFromChunk({
      previousLine: entry.previewCurrentLine,
      previousPreview: entry.latestPreviewLine,
      chunk,
      maxChars: 220
    });
    entry.previewCurrentLine = next.nextLine;
    entry.latestPreviewLine = next.preview;

    const now = Date.now();
    if (now - entry.lastPreviewWriteAt < 900) return;
    entry.lastPreviewWriteAt = now;
    flushPreview(entry);
  };

  const emitRuntimeSignalThrottled = (entry: PtyEntry, runtimeState: TerminalRuntimeState) => {
    if (!entry.tracked || !onSessionRuntimeSignal) return;
    const now = Date.now();
    const preview = entry.latestPreviewLine ?? entry.lastPreviewWritten ?? null;
    const stateChanged = runtimeState !== entry.lastRuntimeSignalState;
    const previewChanged = preview !== entry.lastRuntimeSignalPreview;
    const periodicHeartbeatDue = now - entry.lastRuntimeSignalAt >= 10_000;
    const previewEmitDue = previewChanged && now - entry.lastRuntimeSignalAt >= 1_200;
    if (!stateChanged && !previewEmitDue && !periodicHeartbeatDue) return;
    entry.lastRuntimeSignalAt = now;
    entry.lastRuntimeSignalState = runtimeState;
    entry.lastRuntimeSignalPreview = preview;
    try {
      onSessionRuntimeSignal({
        laneId: entry.laneId,
        sessionId: entry.sessionId,
        runtimeState,
        lastOutputPreview: preview,
        at: new Date(now).toISOString()
      });
    } catch {
      // ignore callback failures
    }
  };

  const cleanupEntryPaths = (entry: PtyEntry) => {
    for (const cleanupPath of entry.cleanupPaths) {
      try {
        fs.unlinkSync(cleanupPath);
      } catch {
        // best effort
      }
    }
  };

  const emitPtyDataNow = (entry: PtyEntry, event: PtyDataEvent) => {
    const scopedEvent = { ...event, projectRoot };
    broadcastData(scopedEvent);
    const enriched = { ...scopedEvent, laneId: entry.laneId };
    for (const listener of dataListeners) {
      try {
        listener(enriched);
      } catch {
        // ignore listener failures
      }
    }
  };

  const clearPendingDataTimer = (entry: PtyEntry) => {
    if (!entry.pendingDataTimer) return;
    clearTimeout(entry.pendingDataTimer);
    entry.pendingDataTimer = null;
  };

  const flushQueuedPtyData = (entry: PtyEntry, ids: { ptyId: string; sessionId: string }) => {
    clearPendingDataTimer(entry);
    if (entry.pendingDataChunks.length === 0) return;
    const data = entry.pendingDataChunks.join("");
    entry.pendingDataChunks.length = 0;
    entry.pendingDataChars = 0;
    if (!data) return;
    ptyDataBatchCount += 1;
    ptyDataMaxBatchChars = Math.max(ptyDataMaxBatchChars, data.length);
    emitPtyDataNow(entry, { ...ids, data });
  };

  const enqueuePtyData = (entry: PtyEntry, event: PtyDataEvent) => {
    if (!event.data) return;
    ptyDataChunkCount += 1;
    ptyDataCharCount += event.data.length;
    schedulePtyDataSummary();
    entry.pendingDataChunks.push(event.data);
    entry.pendingDataChars += event.data.length;
    const ids = { ptyId: event.ptyId, sessionId: event.sessionId };
    if (entry.pendingDataChars >= PTY_DATA_BATCH_MAX_CHARS) {
      flushQueuedPtyData(entry, ids);
      return;
    }
    if (entry.pendingDataTimer) return;
    entry.pendingDataTimer = setTimeout(() => {
      flushQueuedPtyData(entry, ids);
    }, PTY_DATA_BATCH_INTERVAL_MS);
  };

  const emitPtyExit = (entry: Pick<PtyEntry, "laneId" | "sessionId">, event: PtyExitEvent) => {
    const scopedEvent = { ...event, projectRoot };
    broadcastExit(scopedEvent);
    const enriched = { ...scopedEvent, laneId: entry.laneId };
    for (const listener of exitListeners) {
      try {
        listener(enriched);
      } catch {
        // ignore listener failures
      }
    }
  };

  const cleanOptionalId = (value: unknown): string | null => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed.length ? trimmed : null;
  };

  const liveEntryBySessionId = (sessionId: string): [string, PtyEntry] | null => (
    Array.from(ptys.entries()).find(([, entry]) => entry.sessionId === sessionId && !entry.disposed) ?? null
  );

  const computeRuntimeState = (sessionId: string, fallbackStatus: TerminalSessionStatus): TerminalRuntimeState => {
    const runtime = runtimeStates.get(sessionId);
    return runtime ? runtime.state : runtimeFromStatus(fallbackStatus);
  };

  const terminalSessionFromSummary = (summary: TerminalSessionSummary): ChatTerminalSession => {
    const live = liveEntryBySessionId(summary.id);
    const chatSessionId = terminalChatSessions.get(summary.id)
      ?? live?.[1].chatSessionId
      ?? summary.chatSessionId
      ?? null;
    const activeTerminalId = chatSessionId ? activeTerminalByChatSession.get(chatSessionId) ?? null : null;
    const fallbackStatus = live ? "running" : summary.status;
    return {
      terminalId: summary.id,
      ptyId: live?.[0] ?? summary.ptyId ?? null,
      chatSessionId,
      laneId: summary.laneId,
      laneName: summary.laneName,
      title: summary.title,
      status: fallbackStatus,
      runtimeState: computeRuntimeState(summary.id, fallbackStatus),
      active: Boolean(activeTerminalId && activeTerminalId === summary.id),
      startedAt: summary.startedAt,
      endedAt: live ? null : summary.endedAt,
      exitCode: live ? null : summary.exitCode,
      pid: live?.[1].pty.pid ?? null,
    };
  };

  const resolveTerminalId = (args: {
    terminalId?: string | null;
    chatSessionId?: string | null;
  }): string | null => {
    const terminalId = cleanOptionalId(args.terminalId);
    if (terminalId) return terminalId;
    const chatSessionId = cleanOptionalId(args.chatSessionId);
    if (!chatSessionId) return null;
    const activeTerminalId = activeTerminalByChatSession.get(chatSessionId) ?? null;
    if (activeTerminalId && liveEntryBySessionId(activeTerminalId)) return activeTerminalId;
    const replacement = Array.from(ptys.values())
      .filter((entry) => entry.chatSessionId === chatSessionId && !entry.disposed)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    if (replacement) {
      activeTerminalByChatSession.set(chatSessionId, replacement.sessionId);
      return replacement.sessionId;
    }
    activeTerminalByChatSession.delete(chatSessionId);
    return null;
  };

  return {
    async ensureResumeTargets(sessionIds: string[]): Promise<void> {
      const uniqueSessionIds = Array.from(new Set(
        sessionIds
          .map((sessionId) => (typeof sessionId === "string" ? sessionId.trim() : ""))
          .filter((sessionId) => sessionId.length > 0),
      ));
      for (const sessionId of uniqueSessionIds) {
        try {
          await tryBackfillResumeTarget(sessionId, null, "session-list");
        } catch (err) {
          logger.warn("pty.resume_target_backfill_failed", {
            sessionId,
            toolType: null,
            reason: "session-list",
            err: String(err),
          });
        }
      }
    },

    async create(args: PtyCreateArgs): Promise<PtyCreateResult> {
      const { laneId, title } = args;
      const chatSessionId = cleanOptionalId(args.chatSessionId);
      const launchContext = resolveLaneLaunchContext({
        laneService,
        laneId,
        requestedCwd: args.cwd,
        allowExternalCwd: args.allowExternalCwd === true,
        purpose: "start a terminal session",
      });
      const { laneWorktreePath: worktreePath, cwd } = launchContext;
      const { cols, rows } = clampDims(args.cols, args.rows);

      const requestedSessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      const allowNewSessionId = args.allowNewSessionId === true;
      const isResumeAttempt =
        typeof args.startupCommand === "string" && args.startupCommand.trim().length > 0;
      const existingSession = requestedSessionId.length
        ? sessionService.get(requestedSessionId)
        : null;
      if (requestedSessionId.length && !existingSession && isResumeAttempt && !allowNewSessionId) {
        throw new Error(`Terminal session '${requestedSessionId}' was not found.`);
      }
      if (existingSession && existingSession.laneId !== laneId) {
        throw new Error(`Terminal session '${requestedSessionId}' belongs to lane '${existingSession.laneId}', not '${laneId}'.`);
      }
      if (existingSession && !existingSession.tracked) {
        throw new Error(`Terminal session '${requestedSessionId}' is not tracked and cannot be resumed.`);
      }
      const liveAttachedEntry = existingSession
        ? Array.from(ptys.entries()).find(([, entry]) => entry.sessionId === existingSession.id && !entry.disposed)
        : null;
      if (existingSession && liveAttachedEntry) {
        const [attachedPtyId, attachedEntry] = liveAttachedEntry;
        if (chatSessionId) {
          attachedEntry.chatSessionId = chatSessionId;
          terminalChatSessions.set(existingSession.id, chatSessionId);
          activeTerminalByChatSession.set(chatSessionId, existingSession.id);
          if (existingSession.chatSessionId !== chatSessionId) {
            try { sessionService.setChatSessionId(existingSession.id, chatSessionId); } catch {}
          }
        }
        const needsSessionResync = existingSession.status !== "running" || existingSession.ptyId !== attachedPtyId;
        if (needsSessionResync) {
          sessionService.reattach({
            sessionId: existingSession.id,
            ptyId: attachedPtyId,
            startedAt: new Date(attachedEntry.createdAt).toISOString(),
          });
          setRuntimeState(existingSession.id, "running");
        }
        logger.info("pty.resume_reused_live_attachment", {
          sessionId: existingSession.id,
          ptyId: attachedPtyId,
          needsSessionResync,
        });
        return {
          ptyId: attachedPtyId,
          sessionId: existingSession.id,
          pid: attachedEntry.pty.pid ?? null,
        };
      }

      const ptyId = randomUUID();
      const sessionId = existingSession?.id ?? (requestedSessionId.length ? requestedSessionId : randomUUID());
      const startedAt = new Date().toISOString();
      const tracked = existingSession?.tracked ?? (args.tracked !== false);
      const toolTypeHint = normalizeToolType(args.toolType ?? existingSession?.toolType ?? null);
      const requestedStartupCommand = typeof args.startupCommand === "string" ? args.startupCommand.trim() : "";
      let initialResumeCommand = existingSession?.resumeCommand ?? defaultResumeCommandForTool(toolTypeHint);
      let initialResumeMetadata = existingSession?.resumeMetadata ?? buildInitialResumeMetadata({
        toolType: toolTypeHint,
        startupCommand: requestedStartupCommand,
      });
      const transcriptPath = tracked
        ? (existingSession?.transcriptPath?.trim() || safeTranscriptPathFor(sessionId))
        : "";
      let startupCommand = requestedStartupCommand.trim();
      const cleanupPaths: string[] = [];

      let transcriptStream: fs.WriteStream | null = null;
      let transcriptBytesWritten = 0;
      if (tracked) {
        fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
        try {
          transcriptBytesWritten = fs.existsSync(transcriptPath) ? fs.statSync(transcriptPath).size : 0;
        } catch {
          transcriptBytesWritten = 0;
        }
        transcriptStream = fs.createWriteStream(transcriptPath, { flags: "a" });
      }

      if (!existingSession) {
        sessionService.create({
          sessionId,
          laneId,
          ptyId,
          tracked,
          title,
          startedAt,
          transcriptPath: tracked ? transcriptPath : "",
          toolType: toolTypeHint,
          resumeCommand: initialResumeCommand,
          resumeMetadata: initialResumeMetadata,
          chatSessionId,
        });
        setRuntimeState(sessionId, "running");

        // Best-effort head SHA at start; do not block terminal creation.
        Promise.resolve()
          .then(async () => {
            const sha = await computeHeadShaBestEffort(cwd || worktreePath);
            if (sha) sessionService.setHeadShaStart(sessionId, sha);
          })
          .catch(() => {});
      }

      const baseLaunchEnv = {
        ...process.env,
        ...((await getLaneRuntimeEnv?.(laneId)) ?? {}),
        ...(args.env ?? {})
      };
      const contextLaunchEnv = withAdeTerminalContextEnv(baseLaunchEnv, {
        projectRoot,
        laneId,
        chatSessionId,
      });
      const launchEnv = withInteractiveTerminalColorEnv(getAdeCliAgentEnv?.(contextLaunchEnv) ?? contextLaunchEnv);
      const shouldBackfillResumeTarget =
        existingSession
        && isTrackedCliToolType(toolTypeHint)
        && !existingSession.resumeMetadata?.targetId?.trim();
      if (shouldBackfillResumeTarget) {
        const backfilled = await tryBackfillResumeTarget(sessionId, toolTypeHint, "resume-launch", cwd);
        const updatedSession = backfilled ? sessionService.get(sessionId) : null;
        if (updatedSession?.resumeCommand?.trim()) {
          initialResumeCommand = updatedSession.resumeCommand.trim();
          initialResumeMetadata = updatedSession.resumeMetadata ?? initialResumeMetadata;
          startupCommand = initialResumeCommand;
        }
      }

      const shellCandidates = resolveShellCandidates();
      let pty: IPty;
      let selectedShell: ShellSpec | null = null;
      const directCommand = typeof args.command === "string" ? args.command.trim() : "";
      const directArgs = Array.isArray(args.args) ? args.args.filter((value): value is string => typeof value === "string") : [];
      let launchedDirectCommand = false;
      try {
        const ptyLib = loadPty();
        const opts: IWindowsPtyForkOptions = {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: launchEnv
        };
        let lastErr: unknown = null;
        let created: IPty | null = null;
        if (directCommand) {
          try {
            const invocation = resolveCliSpawnInvocation(directCommand, directArgs, launchEnv);
            const ptyArgs = invocation.windowsVerbatimArguments
              ? invocation.args.join(" ")
              : invocation.args;
            created = ptyLib.spawn(invocation.command, ptyArgs, opts);
            launchedDirectCommand = true;
          } catch (err) {
            lastErr = err;
            const shellFallbackCmd = buildDirectCommandShellFallback(directCommand, directArgs);
            if (shellFallbackCmd) startupCommand ||= shellFallbackCmd;
          }
        }
        if (!created && (!directCommand || startupCommand)) {
          for (const shell of shellCandidates) {
            try {
              created = ptyLib.spawn(shell.file, shell.args, opts);
              selectedShell = shell;
              launchedDirectCommand = false;
              break;
            } catch (err) {
              lastErr = err;
              logger.warn("pty.spawn_retry", {
                ptyId,
                sessionId,
                shell: shell.file,
                cwd,
                toolType: toolTypeHint,
                startupCommandPresent: Boolean(startupCommand),
                envShell: process.env.SHELL ?? "",
                envPath: process.env.PATH ?? "",
                resourcesPath: process.resourcesPath ?? "",
                err: String(err),
              });
            }
          }
        }
        if (!created) {
          throw lastErr ?? new Error("Unable to spawn terminal shell.");
        }
        pty = created;
      } catch (err) {
        logger.error("pty.spawn_failed", {
          ptyId,
          sessionId,
          cwd,
          toolType: toolTypeHint,
          startupCommandPresent: Boolean(startupCommand),
          command: directCommand || null,
          args: directArgs,
          selectedShell: selectedShell?.file ?? null,
          shellCandidates: shellCandidates.map((shell) => shell.file),
          envShell: process.env.SHELL ?? "",
          envPath: process.env.PATH ?? "",
          resourcesPath: process.resourcesPath ?? "",
          err: String(err),
        });
        for (const cleanupPath of cleanupPaths) {
          try {
            fs.unlinkSync(cleanupPath);
          } catch {
            // best effort
          }
        }
        try {
          await endTranscriptStream(transcriptStream);
        } catch {
          // ignore
        }
        if (existingSession) throw err;
        sessionService.end({ sessionId, endedAt: new Date().toISOString(), exitCode: null, status: "failed" });
        clearIdleTimer(sessionId);
        setRuntimeState(sessionId, "exited", { touch: false });
        runtimeStates.delete(sessionId);
        summarizeSessionBestEffort(sessionId, {
          laneWorktreePath: worktreePath,
          boundCwd: cwd,
        });
        broadcastExit({ ptyId, sessionId, projectRoot, exitCode: null });
        throw err;
      }

      if (existingSession) {
        sessionService.reattach({ sessionId, ptyId, startedAt });
        setRuntimeState(sessionId, "running");
        Promise.resolve()
          .then(async () => {
            const sha = await computeHeadShaBestEffort(cwd || worktreePath);
            if (sha) sessionService.setHeadShaStart(sessionId, sha);
          })
          .catch(() => {});
      }

      const entry: PtyEntry = {
        pty,
        laneId,
        laneWorktreePath: worktreePath,
        boundCwd: cwd,
        sessionId,
        chatSessionId,
        tracked,
        transcriptPath,
        transcriptStream,
        transcriptBytesWritten,
        transcriptLimitReached: transcriptBytesWritten >= MAX_TRANSCRIPT_BYTES,
        lastPreviewWriteAt: 0,
        previewCurrentLine: "",
        latestPreviewLine: null,
        lastPreviewWritten: null,
        toolTypeHint,
        resumeCommand: initialResumeCommand,
        resumeCommandIsFallback: Boolean(initialResumeCommand),
        resumeScanBuffer: "",
        lastRuntimeSignalAt: 0,
        lastRuntimeSignalState: "running",
        lastRuntimeSignalPreview: null,
        disposed: false,
        createdAt: Date.now(),
        cleanupPaths,
        lastResizeCols: null,
        lastResizeRows: null,
        pendingDataChunks: [],
        pendingDataChars: 0,
        pendingDataTimer: null,
        aiTitleTimer: null,
        cliUserTitleLineBuffer: "",
        cliUserTitleCommitted: false,
      };
      ptys.set(ptyId, entry);
      if (chatSessionId) {
        terminalChatSessions.set(sessionId, chatSessionId);
        activeTerminalByChatSession.set(chatSessionId, sessionId);
        if (existingSession && existingSession.chatSessionId !== chatSessionId) {
          try { sessionService.setChatSessionId(sessionId, chatSessionId); } catch {}
        }
      }

      // Buffer initial output for AI title generation
      let titleOutputBuffer = "";
      let titleBufferFull = false;

      pty.onData((data) => {
        // Late chunks can arrive after closeEntry()/dispose() has flushed the
        // final buffer and emitted ptyExit. Bail out so post-teardown data
        // can't re-arm pendingDataTimer, mutate previews/runtime state, or
        // emit ptyData after ptyExit while transcript summarization is in
        // flight.
        if (entry.disposed) return;
        writeTranscript(entry, data);
        updatePreviewThrottled(entry, data);
        enqueuePtyData(entry, { ptyId, sessionId, data });

        const prevState = runtimeStates.get(sessionId)?.state ?? "running";
        const runtimeState = runtimeStateFromOsc133Chunk(data, prevState);
        setRuntimeState(sessionId, runtimeState);
        if (runtimeState === "running") {
          scheduleIdleTransition(sessionId);
          clearToolAutoCloseTimer(ptyId);
        } else {
          clearIdleTimer(sessionId);
        }
        emitRuntimeSignalThrottled(entry, runtimeState);

        // Auto-close tool-typed PTYs when the CLI tool exits back to shell prompt.
        // When a tool like claude/codex exits (via /exit, completion, etc.), the outer
        // shell stays alive and returns to its prompt, detected as "waiting-input".
        // We auto-dispose after a brief delay to let final output flush.
        if (
          runtimeState === "waiting-input" &&
          (prevState === "running" || prevState === "idle") &&
          entry.toolTypeHint &&
          TOOL_TYPES_WITH_AUTO_CLOSE.has(entry.toolTypeHint) &&
          !toolAutoCloseTimers.has(ptyId) &&
          Date.now() - entry.createdAt > 5_000  // ignore initial shell prompt
        ) {
          toolAutoCloseTimers.set(
            ptyId,
            setTimeout(() => {
              toolAutoCloseTimers.delete(ptyId);
              if (entry.disposed) return;
              logger.info("pty.tool_exit_auto_close", { ptyId, sessionId, toolType: entry.toolTypeHint });
              try {
                entry.pty.kill();
              } catch {
                // If kill fails, force close via closeEntry
                closeEntry(ptyId, 0);
              }
            }, 1500)
          );
        }

        // Resume-command scanning runs an ANSI strip + 2 regex passes over a
        // 12KB rolling buffer on every output chunk. Claude/codex print the
        // resume command near startup, so cap the window — long-running
        // sessions otherwise pay this cost forever. Storage-based backfill
        // (tryBackfillResumeTarget) covers sessions that never print one.
        if (
          (!entry.resumeCommand || entry.resumeCommandIsFallback)
          && Date.now() - entry.createdAt < RESUME_SCAN_WINDOW_MS
        ) {
          entry.resumeScanBuffer = `${entry.resumeScanBuffer}${data}`.slice(-12_000);
          const detected = extractResumeCommandFromOutput(entry.resumeScanBuffer, entry.toolTypeHint);
          if (detected && detected !== entry.resumeCommand) {
            entry.resumeCommand = detected;
            entry.resumeCommandIsFallback = false;
            sessionService.setResumeCommand(sessionId, detected);
          }
        } else if (entry.resumeScanBuffer.length > 0) {
          entry.resumeScanBuffer = "";
        }

        // Accumulate initial output for session title generation
        if (!titleBufferFull) {
          titleOutputBuffer += data;
          if (titleOutputBuffer.length >= 800) {
            titleBufferFull = true;
          }
        }
      });

      pty.onExit(({ exitCode }) => {
        logger.info("pty.exit", { ptyId, sessionId, exitCode });
        closeEntry(ptyId, exitCode ?? null);
      });

      // Only type the startup command into the terminal when we launched an
      // interactive shell. Direct command launches already received argv; if a
      // direct launch fell back to shell, startupCommand keeps compatibility
      // with CLIs that are only available through shell startup files.
      if (startupCommand && !launchedDirectCommand && selectedShell) {
        try {
          pty.write(`${startupCommand}\r`);
          setRuntimeState(sessionId, "running");
          scheduleIdleTransition(sessionId);
        } catch (err) {
          logger.warn("pty.startup_command_failed", {
            ptyId,
            sessionId,
            cwd,
            toolType: toolTypeHint,
            envShell: process.env.SHELL ?? "",
            envPath: process.env.PATH ?? "",
            err: String(err),
          });
        }
      }

      if (
        !existingSession
        && (toolTypeHint === "codex" || toolTypeHint === "codex-orchestrated")
        && cwd
      ) {
        scheduleCodexSessionIdCaptureBestEffort(sessionId, cwd, startedAt);
      }

      // Fire-and-forget: after 6s, attempt AI title from initial PTY output (not used for interactive Claude/Codex — those title from the first submitted user input via pty.write).
      if (
        aiIntegrationService
        && aiIntegrationService.getMode() !== "guest"
        && shouldScheduleOutputSnippetTitle(toolTypeHint)
      ) {
        const capturedAi = aiIntegrationService;
        entry.aiTitleTimer = setTimeout(() => {
          entry.aiTitleTimer = null;
          if (entry.disposed) return;

          if (!isTitleGenerationEnabled()) return;

          if (isSessionManuallyNamed(sessionService, sessionId)) {
            logger.info("pty.session_title_skipped_user_renamed", { sessionId });
            return;
          }

          const strippedOutput = stripAnsi(titleOutputBuffer).trim();
          if (strippedOutput.length < 10) return;

          // Check if session has a non-shell toolType (set by the renderer after creation)
          const session = sessionService.get(sessionId);
          if (!session) return;
          const toolType = session.toolType;
          if (!toolType || toolType === "shell") return;

          const prompt = [
            "Generate a concise terminal session title.",
            "Return only plain text, max 80 characters, no punctuation at the end.",
            "",
            "Initial output:",
            strippedOutput.slice(0, 800)
          ].join("\n");

          const titleModelId = resolveTitleModelId();
          capturedAi
            .summarizeTerminal({
              cwd: entry.boundCwd || entry.laneWorktreePath,
              prompt,
              taskType: "session_title",
              timeoutMs: PTY_AI_TITLE_TIMEOUT_MS,
              ...(titleModelId ? { model: titleModelId } : {}),
            })
            .then((result) => {
              const title = sanitizeGeneratedCliTitle(result.text);
              if (title) {
                // Re-check in case user renamed during AI call
                if (isSessionManuallyNamed(sessionService, sessionId)) {
                  logger.info("pty.session_title_skipped_user_renamed", { sessionId });
                } else {
                  sessionService.updateMeta({ sessionId, title, manuallyNamed: false });
                }
              }
            })
            .catch((err) => {
              logger.warn("pty.session_title_generation_failed", {
                sessionId,
                error: err instanceof Error ? err.message : String(err)
              });
            });
        }, PTY_AI_TITLE_DEBOUNCE_MS);
      }

      logger.info("pty.create", { ptyId, sessionId, laneId, cwd, shell: selectedShell?.file ?? "unknown" });

      return { ptyId, sessionId, pid: pty.pid ?? null };
    },

    write({ ptyId, data }: { ptyId: string; data: string }): void {
      const entry = ptys.get(ptyId);
      if (!entry) return;
      try {
        entry.pty.write(data);
        tryCliUserTitleFromWrite(entry, data);
        setRuntimeState(entry.sessionId, "running");
        scheduleIdleTransition(entry.sessionId);
      } catch (err) {
        logger.warn("pty.write_failed", { ptyId, err: String(err) });
      }
    },

    listTerminals(args: ChatTerminalListArgs = {}): ChatTerminalSession[] {
      const chatSessionId = cleanOptionalId(args.chatSessionId);
      const laneId = cleanOptionalId(args.laneId);
      const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(500, Math.floor(args.limit)))
        : 200;
      const summaries = sessionService.list({
        ...(laneId ? { laneId } : {}),
        limit,
      });
      return summaries
        .filter((summary) => {
          if (!chatSessionId) return true;
          const linkedChatSessionId = terminalChatSessions.get(summary.id)
            ?? liveEntryBySessionId(summary.id)?.[1].chatSessionId
            ?? summary.chatSessionId
            ?? null;
          return linkedChatSessionId === chatSessionId;
        })
        .map(terminalSessionFromSummary)
        .sort((a, b) => {
          if (a.active !== b.active) return a.active ? -1 : 1;
          const aRunning = a.status === "running";
          const bRunning = b.status === "running";
          if (aRunning !== bRunning) return aRunning ? -1 : 1;
          return Date.parse(b.startedAt) - Date.parse(a.startedAt);
        });
    },

    activeForChat(args: ChatTerminalActiveForChatArgs): ChatTerminalSession | null {
      const chatSessionId = cleanOptionalId(args.chatSessionId);
      if (!chatSessionId) return null;
      const terminalId = activeTerminalByChatSession.get(chatSessionId) ?? null;
      if (terminalId && liveEntryBySessionId(terminalId)) {
        const session = sessionService.get(terminalId);
        return session ? terminalSessionFromSummary(session) : null;
      }
      const replacement = Array.from(ptys.values())
        .filter((entry) => entry.chatSessionId === chatSessionId && !entry.disposed)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      if (!replacement) {
        activeTerminalByChatSession.delete(chatSessionId);
        return null;
      }
      activeTerminalByChatSession.set(chatSessionId, replacement.sessionId);
      const session = sessionService.get(replacement.sessionId);
      return session ? terminalSessionFromSummary(session) : null;
    },

    async readTerminal(args: ChatTerminalReadArgs = {}): Promise<ChatTerminalReadResult> {
      const terminalId = resolveTerminalId(args);
      if (!terminalId) throw new Error("terminal.read requires terminalId or an active chat terminal.");
      const session = sessionService.get(terminalId);
      if (!session) throw new Error(`Terminal session '${terminalId}' was not found.`);
      const maxBytes = typeof args.maxBytes === "number" && Number.isFinite(args.maxBytes)
        ? Math.max(1, Math.min(MAX_TRANSCRIPT_BYTES, Math.floor(args.maxBytes)))
        : DEFAULT_TERMINAL_READ_MAX_BYTES;
      const full = await sessionService.readTranscriptTail(session.transcriptPath, maxBytes, { raw: true });
      const since = typeof args.since === "number" && Number.isFinite(args.since)
        ? Math.max(0, Math.floor(args.since))
        : 0;
      const data = since > 0 ? full.slice(Math.min(since, full.length)) : full;
      return {
        terminalId,
        data,
        nextSince: since + data.length,
      };
    },

    writeTerminal(args: ChatTerminalWriteArgs): { ok: true } {
      if (!args || typeof args.data !== "string") {
        throw new Error("terminal.write requires string data.");
      }
      const ptyId = cleanOptionalId(args.ptyId);
      let entry: PtyEntry | null = null;
      if (ptyId) {
        const candidate = ptys.get(ptyId);
        if (!candidate || candidate.disposed) throw new Error(`Terminal PTY '${ptyId}' is not running.`);
        entry = candidate;
      } else {
        const terminalId = resolveTerminalId(args);
        if (!terminalId) throw new Error("terminal.write requires terminalId, ptyId, or an active chat terminal.");
        const live = liveEntryBySessionId(terminalId);
        if (!live) throw new Error(`Terminal session '${terminalId}' is not running.`);
        entry = live[1];
      }
      entry.pty.write(args.data);
      tryCliUserTitleFromWrite(entry, args.data);
      setRuntimeState(entry.sessionId, "running");
      scheduleIdleTransition(entry.sessionId);
      return { ok: true };
    },

    signalTerminal(args: ChatTerminalSignalArgs): { ok: true } {
      if (!args || (args.signal !== "SIGINT" && args.signal !== "SIGTERM" && args.signal !== "SIGKILL")) {
        throw new Error("terminal.signal requires SIGINT, SIGTERM, or SIGKILL.");
      }
      const ptyId = cleanOptionalId(args.ptyId);
      let live: [string, PtyEntry] | null = null;
      if (ptyId) {
        const candidate = ptys.get(ptyId);
        if (candidate && !candidate.disposed) live = [ptyId, candidate];
      } else {
        const terminalId = resolveTerminalId(args);
        if (terminalId) live = liveEntryBySessionId(terminalId);
      }
      if (!live) throw new Error("No running terminal matched the requested signal target.");
      const [liveId, entry] = live;
      try {
        if (args.signal === "SIGINT") {
          entry.pty.write("\x03");
        } else {
          entry.pty.kill(args.signal);
        }
      } catch (err) {
        logger.warn("pty.signal_failed", { ptyId: liveId, signal: args.signal, err: String(err) });
        throw err;
      }
      return { ok: true };
    },

    resize({ ptyId, cols, rows }: { ptyId: string; cols: number; rows: number }): void {
      const entry = ptys.get(ptyId);
      if (!entry) return;
      const safe = clampDims(cols, rows);
      if (entry.lastResizeCols === safe.cols && entry.lastResizeRows === safe.rows) return;
      try {
        entry.pty.resize(safe.cols, safe.rows);
        entry.lastResizeCols = safe.cols;
        entry.lastResizeRows = safe.rows;
      } catch (err) {
        logger.warn("pty.resize_failed", { ptyId, err: String(err) });
      }
    },

    /**
     * Write to the active PTY for a given session id. Returns true when the
     * write was forwarded; false when no live PTY exists for the session
     * (e.g. iOS attached after the host process exited — the caller should
     * surface a "session inactive" hint and skip the write).
     */
    writeBySessionId(sessionId: string, data: string): boolean {
      if (!sessionId || typeof data !== "string") return false;
      const entry = Array.from(ptys.values()).find(
        (candidate) => candidate.sessionId === sessionId && !candidate.disposed,
      );
      if (!entry) return false;
      try {
        entry.pty.write(data);
        tryCliUserTitleFromWrite(entry, data);
        setRuntimeState(entry.sessionId, "running");
        scheduleIdleTransition(entry.sessionId);
        return true;
      } catch (err) {
        logger.warn("pty.write_by_session_failed", { sessionId, err: String(err) });
        return false;
      }
    },

    /**
     * Resize the active PTY for a given session id. Mobile clients call this
     * when their visible terminal viewport changes (orientation flip, split
     * view, font-size change). Returns true on success.
     */
    resizeBySessionId(sessionId: string, cols: number, rows: number): boolean {
      if (!sessionId) return false;
      const entry = Array.from(ptys.values()).find(
        (candidate) => candidate.sessionId === sessionId && !candidate.disposed,
      );
      if (!entry) return false;
      const safe = clampDims(cols, rows);
      if (entry.lastResizeCols === safe.cols && entry.lastResizeRows === safe.rows) return true;
      try {
        entry.pty.resize(safe.cols, safe.rows);
        entry.lastResizeCols = safe.cols;
        entry.lastResizeRows = safe.rows;
        return true;
      } catch (err) {
        logger.warn("pty.resize_by_session_failed", { sessionId, err: String(err) });
        return false;
      }
    },

    getRuntimeState(sessionId: string, fallbackStatus: TerminalSessionStatus): TerminalRuntimeState {
      return computeRuntimeState(sessionId, fallbackStatus);
    },

    enrichSessions<T extends TerminalSessionSummary>(rows: T[]): T[] {
      return rows.map((row) => {
        const live = liveEntryBySessionId(row.id);
        const fallbackStatus = live ? "running" : row.status;
        return {
          ...row,
          ...(live
            ? {
                ptyId: live[0],
                status: "running" as const,
                endedAt: null,
                exitCode: null,
              }
            : {}),
          runtimeState: computeRuntimeState(row.id, fallbackStatus),
          chatSessionId: live
            ? terminalChatSessions.get(row.id) ?? live[1].chatSessionId ?? row.chatSessionId ?? null
            : terminalChatSessions.get(row.id) ?? row.chatSessionId ?? null,
        };
      });
    },

    dispose({ ptyId, sessionId }: { ptyId: string; sessionId?: string }): void {
      const entry = ptys.get(ptyId);
      if (!entry) {
        if (!sessionId) return;
        const session = sessionService.get(sessionId);
        if (!session) return;
        // The renderer can outlive the pty map (for example after app restart). Allow closing by session id
        // so stale sessions do not get stuck in a "running" state forever.
        const endedAt = new Date().toISOString();
        sessionService.end({ sessionId, endedAt, exitCode: null, status: "disposed" });
        backfillResumeTargetFromTranscriptBestEffort(sessionId, session.toolType ?? null, "orphan-dispose");
        clearIdleTimer(sessionId);
        setRuntimeState(sessionId, "killed", { touch: false });
        runtimeStates.delete(sessionId);
        try {
          onSessionRuntimeSignal?.({
            laneId: session.laneId,
            sessionId,
            runtimeState: "killed",
            lastOutputPreview: session.lastOutputPreview ?? null,
            at: endedAt
          });
        } catch {
          // ignore callback failures
        }
        summarizeSessionBestEffort(sessionId);
        emitPtyExit({ laneId: session.laneId, sessionId }, { ptyId, sessionId, exitCode: null });
        if (session.tracked) {
          try {
            onSessionEnded?.({ laneId: session.laneId, sessionId, exitCode: null });
          } catch {
            // ignore
          }
        }
        logger.warn("pty.dispose_orphaned", { ptyId, sessionId });
        return;
      }
      if (entry.disposed) return;
      entry.disposed = true;
      if (entry.aiTitleTimer) {
        clearTimeout(entry.aiTitleTimer);
        entry.aiTitleTimer = null;
      }
      clearToolAutoCloseTimer(ptyId);
      flushQueuedPtyData(entry, { ptyId, sessionId: entry.sessionId });
      cleanupEntryPaths(entry);
      try {
        entry.pty.kill();
      } catch {
        // ignore
      }
      const endedAt = new Date().toISOString();
      sessionService.end({ sessionId: entry.sessionId, endedAt, exitCode: null, status: "disposed" });
      scheduleTranscriptDependentWork(entry, "dispose");
      clearIdleTimer(entry.sessionId);
      setRuntimeState(entry.sessionId, "killed", { touch: false });
      runtimeStates.delete(entry.sessionId);
      try {
        onSessionRuntimeSignal?.({
          laneId: entry.laneId,
          sessionId: entry.sessionId,
          runtimeState: "killed",
          lastOutputPreview: entry.latestPreviewLine ?? entry.lastPreviewWritten ?? null,
          at: endedAt
        });
      } catch {
        // ignore callback failures
      }
      emitPtyExit(entry, { ptyId, sessionId: entry.sessionId, exitCode: null });
      ptys.delete(ptyId);

      if (!entry.tracked) {
        return;
      }

      try {
        onSessionEnded?.({ laneId: entry.laneId, sessionId: entry.sessionId, exitCode: null });
      } catch {
        // ignore
      }
    },

    disposeAll(): void {
      for (const ptyId of [...ptys.keys()]) {
        try {
          this.dispose({ ptyId });
        } catch {
          // ignore
        }
      }
    },

    disposeForLane(laneId: string): number {
      let disposed = 0;
      for (const [ptyId, entry] of [...ptys.entries()]) {
        if (entry.laneId !== laneId) continue;
        try {
          this.dispose({ ptyId });
          disposed += 1;
        } catch {
          // ignore individual failures; teardown should never block
        }
      }
      return disposed;
    },

    countActiveForLane(laneId: string): number {
      let count = 0;
      for (const entry of ptys.values()) {
        if (entry.laneId !== laneId) continue;
        if (!entry.disposed) count += 1;
      }
      return count;
    },

    onData(listener: PtyDataListener): () => void {
      dataListeners.add(listener);
      return () => {
        dataListeners.delete(listener);
      };
    },

    onExit(listener: PtyExitListener): () => void {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    }
  };
}
