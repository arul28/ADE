import fs from "node:fs";
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
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { buildCodexMcpConfigFlags, resolveAdeMcpServerLaunch, resolveUnifiedRuntimeRoot } from "../orchestrator/unifiedOrchestratorAdapter";
import { shellEscapeArg } from "../orchestrator/baseOrchestratorAdapter";
import type {
  PtyDataEvent,
  PtyExitEvent,
  PtyCreateArgs,
  PtyCreateResult,
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
  runtimeStateFromOsc133Chunk
} from "../../utils/terminalSessionSignals";

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
};

type RuntimeStateEntry = {
  state: TerminalRuntimeState;
  updatedAt: number;
  lastActivityAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

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
    "ai-orchestrated",
    "codex-chat",
    "claude-chat",
    "ai-chat",
    "cursor",
    "aider",
    "continue",
    "other"
  ];
  return (allowed as string[]).includes(value) ? (value as TerminalToolType) : "other";
}

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_LIMIT_NOTICE = "\n[ADE] transcript limit reached (8MB). Further output omitted.\n";

function writeExternalClaudeMcpConfig(args: {
  projectRoot: string;
  workspaceRoot: string;
  sessionId: string;
}): string {
  const runtimeRoot = resolveUnifiedRuntimeRoot();
  const launch = resolveAdeMcpServerLaunch({
    projectRoot: args.projectRoot,
    workspaceRoot: args.workspaceRoot,
    runtimeRoot,
    runId: args.sessionId,
    attemptId: args.sessionId,
    defaultRole: "external",
  });
  const configDir = resolveAdeLayout(args.projectRoot).mcpConfigsDir;
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, `terminal-${args.sessionId}.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        ade: {
          command: launch.command,
          args: launch.cmdArgs,
          env: launch.env,
        },
      },
    }, null, 2),
    "utf8",
  );
  return configPath;
}

function enrichStartupCommandForAdeMcp(args: {
  projectRoot: string;
  workspaceRoot: string;
  toolType: TerminalToolType | null;
  sessionId: string;
  startupCommand: string;
}): { startupCommand: string; cleanupPaths: string[] } {
  const trimmed = args.startupCommand.trim();
  if (!trimmed.length) return { startupCommand: trimmed, cleanupPaths: [] };
  if (args.toolType === "claude") {
    const configPath = writeExternalClaudeMcpConfig({
      projectRoot: args.projectRoot,
      workspaceRoot: args.workspaceRoot,
      sessionId: args.sessionId,
    });
    return {
      startupCommand: `${trimmed} --mcp-config ${shellEscapeArg(configPath)}`,
      cleanupPaths: [configPath],
    };
  }
  if (args.toolType === "codex") {
    const flags = buildCodexMcpConfigFlags({
      projectRoot: args.projectRoot,
      workspaceRoot: args.workspaceRoot,
      runtimeRoot: resolveUnifiedRuntimeRoot(),
      runId: args.sessionId,
      attemptId: args.sessionId,
      defaultRole: "external",
    });
    return {
      startupCommand: `${trimmed} ${flags.join(" ")}`.trim(),
      cleanupPaths: [],
    };
  }
  return { startupCommand: trimmed, cleanupPaths: [] };
}

export function createPtyService({
  projectRoot,
  transcriptsDir,
  laneService,
  sessionService,
  aiIntegrationService,
  projectConfigService,
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
  /** Timers for auto-closing tool-typed PTYs when the CLI tool exits back to shell prompt */
  const toolAutoCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const getSessionIntelligence = () => {
    const ai = projectConfigService?.get().effective.ai;
    return ai?.sessionIntelligence;
  };

  const isTitleGenerationEnabled = (): boolean => {
    const si = getSessionIntelligence();
    const ai = projectConfigService?.get().effective.ai;
    return si?.titles?.enabled ?? (ai?.chat as any)?.autoTitleEnabled ?? true;
  };

  const resolveTitleModelId = (): string | undefined => {
    const si = getSessionIntelligence();
    const raw = si?.titles?.modelId;
    return typeof raw === "string" && raw.trim().length ? raw.trim() : undefined;
  };

  /** Only orchestrated worker sessions auto-close after the wrapped CLI exits back to shell. */
  const TOOL_TYPES_WITH_AUTO_CLOSE = new Set<TerminalToolType>([
    "claude-orchestrated",
    "codex-orchestrated",
    "ai-orchestrated"
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
          const refreshOnComplete = getSessionIntelligence()?.titles?.refreshOnComplete
            ?? (projectConfigService?.get().effective.ai?.chat as any)?.autoTitleRefreshOnComplete
            ?? true;
          if (refreshOnComplete && isTitleGenerationEnabled()) {
            try {
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
                timeoutMs: 8_000,
                ...(titleModelId ? { model: titleModelId } : {}),
              });
              const finalTitle = titleResult.text.trim().replace(/\s+/g, " ").slice(0, 80);
              if (finalTitle) {
                // Guard: skip if user renamed the session while the AI call was in-flight
                const current = sessionService.get(sessionId);
                if (current && current.title !== session.title) {
                  logger.info("pty.session_title_refresh_skipped_user_renamed", { sessionId });
                } else {
                  sessionService.updateMeta({ sessionId, title: finalTitle });
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

  const closeEntry = (ptyId: string, exitCode: number | null) => {
    const entry = ptys.get(ptyId);
    if (!entry) return;
    if (entry.disposed) return;
    entry.disposed = true;
    clearToolAutoCloseTimer(ptyId);

    try {
      entry.transcriptStream?.end();
    } catch {
      // ignore
    }
    cleanupEntryPaths(entry);
    flushPreview(entry);

    const endedAt = new Date().toISOString();
    const status = statusFromExit(exitCode);
    sessionService.end({ sessionId: entry.sessionId, endedAt, exitCode, status });
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
    summarizeSessionBestEffort(entry.sessionId, {
      laneWorktreePath: entry.laneWorktreePath,
      boundCwd: entry.boundCwd,
    });

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

    broadcastExit({ ptyId, sessionId: entry.sessionId, exitCode });
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

  return {
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

      const ptyId = randomUUID();
      const sessionId = randomUUID();
      const startedAt = new Date().toISOString();
      const tracked = args.tracked !== false;
      const toolTypeHint = normalizeToolType(args.toolType);
      const requestedStartupCommand = typeof args.startupCommand === "string" ? args.startupCommand.trim() : "";
      const initialResumeCommand = defaultResumeCommandForTool(toolTypeHint);
      const transcriptPath = safeTranscriptPathFor(sessionId);
      const enrichedLaunch = enrichStartupCommandForAdeMcp({
        projectRoot,
        workspaceRoot: cwd,
        toolType: toolTypeHint,
        sessionId,
        startupCommand: requestedStartupCommand,
      });
      const startupCommand = enrichedLaunch.startupCommand;

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

      sessionService.create({
        sessionId,
        laneId,
        ptyId,
        tracked,
        title,
        startedAt,
        transcriptPath: tracked ? transcriptPath : "",
        toolType: toolTypeHint,
        resumeCommand: initialResumeCommand
      });
      setRuntimeState(sessionId, "running");

      // Best-effort head SHA at start; do not block terminal creation.
      Promise.resolve()
        .then(async () => {
          const sha = await computeHeadShaBestEffort(cwd || worktreePath);
          if (sha) sessionService.setHeadShaStart(sessionId, sha);
        })
        .catch(() => {});

      const shellCandidates = resolveShellCandidates();
      let pty: IPty;
      let selectedShell: ShellSpec | null = null;
      try {
        const ptyLib = loadPty();
        const opts: IWindowsPtyForkOptions = {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: { ...process.env }
        };
        let lastErr: unknown = null;
        let created: IPty | null = null;
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
          selectedShell: selectedShell?.file ?? null,
          shellCandidates: shellCandidates.map((shell) => shell.file),
          envShell: process.env.SHELL ?? "",
          envPath: process.env.PATH ?? "",
          resourcesPath: process.resourcesPath ?? "",
          err: String(err),
        });
        for (const cleanupPath of enrichedLaunch.cleanupPaths) {
          try {
            fs.unlinkSync(cleanupPath);
          } catch {
            // best effort
          }
        }
        try {
          transcriptStream?.end();
        } catch {
          // ignore
        }
        sessionService.end({ sessionId, endedAt: new Date().toISOString(), exitCode: null, status: "failed" });
        clearIdleTimer(sessionId);
        setRuntimeState(sessionId, "exited", { touch: false });
        runtimeStates.delete(sessionId);
        summarizeSessionBestEffort(sessionId, {
          laneWorktreePath: worktreePath,
          boundCwd: cwd,
        });
        broadcastExit({ ptyId, sessionId, exitCode: null });
        throw err;
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
        cleanupPaths: enrichedLaunch.cleanupPaths,
      };
      ptys.set(ptyId, entry);

      // Buffer initial output for AI title generation
      let titleOutputBuffer = "";
      let titleBufferFull = false;

      pty.onData((data) => {
        writeTranscript(entry, data);
        updatePreviewThrottled(entry, data);
        broadcastData({ ptyId, sessionId, data });

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

      // Fire-and-forget: after 6s, attempt AI title generation for non-shell sessions
      if (aiIntegrationService && aiIntegrationService.getMode() !== "guest") {
        const capturedAi = aiIntegrationService;
        setTimeout(() => {
          if (entry.disposed) return;

          if (!isTitleGenerationEnabled()) return;

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
              timeoutMs: 8_000,
              ...(titleModelId ? { model: titleModelId } : {}),
            })
            .then((result) => {
              const title = result.text.trim().replace(/\s+/g, " ").slice(0, 80);
              if (title) {
                // Guard: skip if user renamed the session while the AI call was in-flight
                const current = sessionService.get(sessionId);
                if (current && current.title !== session.title) {
                  logger.info("pty.session_title_skipped_user_renamed", { sessionId });
                } else {
                  sessionService.updateMeta({ sessionId, title });
                }
              }
            })
            .catch((err) => {
              logger.warn("pty.session_title_generation_failed", {
                sessionId,
                error: err instanceof Error ? err.message : String(err)
              });
            });
        }, 6000);
      }

      logger.info("pty.create", { ptyId, sessionId, laneId, cwd, shell: selectedShell?.file ?? "unknown" });

      return { ptyId, sessionId };
    },

    write({ ptyId, data }: { ptyId: string; data: string }): void {
      const entry = ptys.get(ptyId);
      if (!entry) return;
      try {
        entry.pty.write(data);
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
        broadcastExit({ ptyId, sessionId, exitCode: null });
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
      clearToolAutoCloseTimer(ptyId);
      try {
        entry.transcriptStream?.end();
      } catch {
        // ignore
      }
      cleanupEntryPaths(entry);
      try {
        entry.pty.kill();
      } catch {
        // ignore
      }
      const endedAt = new Date().toISOString();
      sessionService.end({ sessionId: entry.sessionId, endedAt, exitCode: null, status: "disposed" });
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
      summarizeSessionBestEffort(entry.sessionId, {
        laneWorktreePath: entry.laneWorktreePath,
        boundCwd: entry.boundCwd,
      });
      broadcastExit({ ptyId, sessionId: entry.sessionId, exitCode: null });
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
    }
  };
}
