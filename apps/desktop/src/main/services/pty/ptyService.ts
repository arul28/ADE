import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IPty, IWindowsPtyForkOptions } from "node-pty";
import type * as ptyNs from "node-pty";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import { resolveLaneLaunchContext } from "../lanes/laneLaunchContext";
import type { createSessionService } from "../sessions/sessionService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createProjectConfigService } from "../config/projectConfigService";
import { runGit } from "../git/git";
import type {
  PtyDataEvent,
  PtyExitEvent,
  PtyCreateArgs,
  PtyCreateResult,
  TerminalResumeMetadata,
  TerminalRuntimeState,
  TerminalSessionStatus,
  TerminalSessionSummary,
  TerminalToolType
} from "../../../shared/types";
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

/** Claude/Codex TUIs often hide useful text in an alt-screen, so snippet-based titles fail; titles come from the first PTY write that ends with \\r (submitted prompt) instead. */
const CLI_USER_TITLE_TOOL_TYPES = new Set<TerminalToolType>(["claude", "codex"]);

function shouldScheduleOutputSnippetTitle(tool: TerminalToolType | null): boolean {
  if (!tool || tool === "shell" || tool === "run-shell") return false;
  return !CLI_USER_TITLE_TOOL_TYPES.has(tool);
}

const CLI_USER_TITLE_SEED_MIN_LEN = 3;
const CLI_USER_TITLE_SEED_MAX_LEN = 180;

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
    "claude-orchestrated",
    "codex-orchestrated",
    "opencode-orchestrated",
    "codex-chat",
    "claude-chat",
    "opencode-chat",
    "cursor",
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

  // Extract pre-assigned --session-id from Claude startup command
  const preAssignedId = isClaude ? extractClaudeSessionIdFromCommand(args.startupCommand) : null;

  if (parsedLaunch) {
    return {
      provider: isCodex ? "codex" : "claude",
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
  return null;
}

function isTrackedCliToolType(toolType: TerminalToolType | null): toolType is "claude" | "codex" | "claude-orchestrated" | "codex-orchestrated" {
  return toolType === "claude" || toolType === "codex" || toolType === "claude-orchestrated" || toolType === "codex-orchestrated";
}

function inferSessionCwdFromTranscriptPath(transcriptPath: string | null | undefined): string | null {
  if (!transcriptPath) return null;
  const normalized = transcriptPath.replace(/\\/g, "/");
  const markerIndex = normalized.indexOf("/.ade/transcripts/");
  if (markerIndex < 0) return null;
  return transcriptPath.slice(0, markerIndex) || null;
}

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_LIMIT_NOTICE = "\n[ADE] transcript limit reached (8MB). Further output omitted.\n";

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
  /** Timers for auto-closing tool-typed PTYs when the CLI tool exits back to shell prompt */
  const toolAutoCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
      if (!aiIntegrationService || aiIntegrationService.getMode() === "guest") return;
      if (!isTitleGenerationEnabled()) return;
      if (isSessionManuallyNamed(sessionService, entry.sessionId)) {
        logger.info("pty.cli_user_title_skipped_user_renamed", { sessionId: entry.sessionId });
        return;
      }

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
          timeoutMs: 8_000,
          ...(titleModelId ? { model: titleModelId } : {}),
        })
        .then((result) => {
          if (entry.disposed) return;
          const title = result.text.trim().replace(/\s+/g, " ").slice(0, 80);
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
                timeoutMs: 8_000,
                ...(titleModelId ? { model: titleModelId } : {}),
              });
              const finalTitle = titleResult.text.trim().replace(/\s+/g, " ").slice(0, 80);
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

  /**
   * Try to find the Codex session ID from Codex's local storage.
   * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
   * Each JSONL starts with a session_meta event containing `payload.id` and `payload.cwd`.
   * We score recent candidates by cwd match and closeness to ADE's session startedAt.
   */
  const resolveCodexSessionIdFromStorage = (args: { cwd: string; startedAt?: string | null }): string | null => {
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

        if (!hasStartedAt) return id;

        const payloadTimestamp = typeof payload?.timestamp === "string" ? payload.timestamp : "";
        const payloadTimestampMs = Date.parse(payloadTimestamp);
        const referenceMs = Number.isFinite(payloadTimestampMs) ? payloadTimestampMs : candidate.mtimeMs;
        const score = Math.abs(referenceMs - requestedStartedAtMs);
        if (!bestMatch || score < bestMatch.score || (score === bestMatch.score && candidate.mtimeMs > bestMatch.mtimeMs)) {
          bestMatch = { id, score, mtimeMs: candidate.mtimeMs };
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
    reason: "close" | "dispose" | "orphan-dispose" | "session-list",
    sessionCwd?: string | null,
  ): Promise<boolean> => {
    const session = sessionService.get(sessionId);
    if (!session?.tracked) return false;
    const effectiveToolType = preferredToolType ?? session.toolType ?? null;
    if (!isTrackedCliToolType(effectiveToolType)) return false;
    if (session.resumeMetadata?.targetId?.trim()) return true;

    // Strategy 1: Try parsing the transcript for an explicit resume command
    const transcript = await sessionService.readTranscriptTail(session.transcriptPath, 220_000);
    const detected = extractResumeCommandFromOutput(transcript, effectiveToolType);
    if (detected) {
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
        sessionService.setResumeCommand(sessionId, resumeCmd);
        logger.info("pty.resume_target_backfilled", { sessionId, toolType: effectiveToolType, reason, source: "claude-storage", claudeSessionId });
        return true;
      }
    }

    if ((effectiveToolType === "codex" || effectiveToolType === "codex-orchestrated") && cwd) {
      const codexSessionId = resolveCodexSessionIdFromStorage({ cwd, startedAt: session.startedAt });
      if (codexSessionId) {
        const resumeCmd = `codex resume ${codexSessionId}`;
        sessionService.setResumeCommand(sessionId, resumeCmd);
        logger.info("pty.resume_target_backfilled", { sessionId, toolType: effectiveToolType, reason, source: "codex-storage", codexSessionId });
        return true;
      }
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

  const CODEX_LIVE_CAPTURE_DELAYS_MS = [1_500, 3_500, 8_000, 20_000];

  // Codex CLI has no pre-assigned session ID flag (unlike Claude's --session-id), so the
  // rollout JSONL is the only handle on the session's UUID. Polling once it exists lets resume
  // survive app crashes, orphaned PTYs, or long-lived sessions that outlast the transcript-scan
  // window on dispose.
  const scheduleCodexSessionIdCaptureBestEffort = (
    sessionId: string,
    cwd: string,
    startedAt: string,
  ): void => {
    const poll = (attempt: number): void => {
      const timer = setTimeout(() => {
        try {
          const session = sessionService.get(sessionId);
          if (!session) return;
          if (session.resumeMetadata?.targetId?.trim()) return;
          const codexSessionId = resolveCodexSessionIdFromStorage({ cwd, startedAt });
          if (codexSessionId) {
            sessionService.setResumeCommand(sessionId, `codex resume ${codexSessionId}`);
            logger.info("pty.codex_session_id_captured_live", { sessionId, codexSessionId, attempt });
            return;
          }
          if (attempt + 1 < CODEX_LIVE_CAPTURE_DELAYS_MS.length) poll(attempt + 1);
        } catch (err) {
          logger.warn("pty.codex_session_id_capture_failed", { sessionId, attempt, err: String(err) });
        }
      }, CODEX_LIVE_CAPTURE_DELAYS_MS[attempt]);
      timer.unref?.();
    };
    poll(0);
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

  const emitPtyData = (entry: PtyEntry, event: PtyDataEvent) => {
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
      const launchContext = resolveLaneLaunchContext({
        laneService,
        laneId,
        requestedCwd: args.cwd,
        purpose: "start a terminal session",
      });
      const { laneWorktreePath: worktreePath, cwd } = launchContext;
      const { cols, rows } = clampDims(args.cols, args.rows);

      const requestedSessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      const existingSession = requestedSessionId.length
        ? sessionService.get(requestedSessionId)
        : null;
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
      const initialResumeCommand = existingSession?.resumeCommand ?? defaultResumeCommandForTool(toolTypeHint);
      const initialResumeMetadata = existingSession?.resumeMetadata ?? buildInitialResumeMetadata({
        toolType: toolTypeHint,
        startupCommand: requestedStartupCommand,
      });
      const transcriptPath = tracked
        ? (existingSession?.transcriptPath?.trim() || safeTranscriptPathFor(sessionId))
        : "";
      const startupCommand = requestedStartupCommand.trim();
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
      const launchEnv = getAdeCliAgentEnv?.(baseLaunchEnv) ?? baseLaunchEnv;
      const shellCandidates = resolveShellCandidates();
      let pty: IPty;
      let selectedShell: ShellSpec | null = null;
      const directCommand = typeof args.command === "string" ? args.command.trim() : "";
      const directArgs = Array.isArray(args.args) ? args.args.filter((value): value is string => typeof value === "string") : [];
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
            created = ptyLib.spawn(directCommand, directArgs, opts);
          } catch (err) {
            lastErr = err;
          }
        } else {
          for (const shell of shellCandidates) {
            try {
              created = ptyLib.spawn(shell.file, shell.args, opts);
              selectedShell = shell;
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

      if (
        existingSession
        && isTrackedCliToolType(toolTypeHint)
        && !existingSession.resumeMetadata?.targetId?.trim()
      ) {
        logger.warn("pty.resume_target_missing", {
          sessionId,
          ptyId,
          toolType: toolTypeHint,
          reason: "resume-launch",
        });
      }

      const entry: PtyEntry = {
        pty,
        laneId,
        laneWorktreePath: worktreePath,
        boundCwd: cwd,
        sessionId,
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
        aiTitleTimer: null,
        cliUserTitleLineBuffer: "",
        cliUserTitleCommitted: false,
      };
      ptys.set(ptyId, entry);

      // Buffer initial output for AI title generation
      let titleOutputBuffer = "";
      let titleBufferFull = false;

      pty.onData((data) => {
        writeTranscript(entry, data);
        updatePreviewThrottled(entry, data);
        emitPtyData(entry, { ptyId, sessionId, data });

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

        if (!entry.resumeCommand || entry.resumeCommandIsFallback) {
          entry.resumeScanBuffer = `${entry.resumeScanBuffer}${data}`.slice(-12_000);
          const detected = extractResumeCommandFromOutput(entry.resumeScanBuffer, entry.toolTypeHint);
          if (detected && detected !== entry.resumeCommand) {
            entry.resumeCommand = detected;
            entry.resumeCommandIsFallback = false;
            sessionService.setResumeCommand(sessionId, detected);
          }
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

      if (startupCommand) {
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
              timeoutMs: 8_000,
              ...(titleModelId ? { model: titleModelId } : {}),
            })
            .then((result) => {
              const title = result.text.trim().replace(/\s+/g, " ").slice(0, 80);
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

    resize({ ptyId, cols, rows }: { ptyId: string; cols: number; rows: number }): void {
      const entry = ptys.get(ptyId);
      if (!entry) return;
      const safe = clampDims(cols, rows);
      try {
        entry.pty.resize(safe.cols, safe.rows);
      } catch (err) {
        logger.warn("pty.resize_failed", { ptyId, err: String(err) });
      }
    },

    getRuntimeState(sessionId: string, fallbackStatus: TerminalSessionStatus): TerminalRuntimeState {
      const runtime = runtimeStates.get(sessionId);
      if (runtime) return runtime.state;
      return runtimeFromStatus(fallbackStatus);
    },

    enrichSessions<T extends TerminalSessionSummary>(rows: T[]): T[] {
      return rows.map((row) => ({
        ...row,
        runtimeState: this.getRuntimeState(row.id, row.status)
      }));
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
