import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { IPty, IWindowsPtyForkOptions } from "node-pty";
import type * as ptyNs from "node-pty";
import * as HeadlessXterm from "@xterm/headless";
import type { IBufferCell } from "@xterm/headless";
import * as XtermSerialize from "@xterm/addon-serialize";
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
  PtySendToSessionArgs,
  PtySendToSessionResult,
  ChatTerminalActiveForChatArgs,
  ChatTerminalListArgs,
  ChatTerminalReadArgs,
  ChatTerminalReadResult,
  ChatTerminalReattachArgs,
  ChatTerminalReattachResult,
  ChatTerminalResizeArgs,
  ChatTerminalSession,
  ChatTerminalSignalArgs,
  ChatTerminalWriteArgs,
  ChatTerminalPreviewArgs,
  ChatTerminalPreviewResult,
  TerminalSerializedSnapshot,
  TerminalSnapshotCell,
  TerminalSnapshotRow,
  TerminalResumeMetadata,
  TerminalRuntimeState,
  TerminalSessionStatus,
  TerminalSessionSummary,
  TerminalToolType
} from "../../../shared/types";
import { isProviderSlashCommandInput } from "../../../shared/chatSlashCommands";
import { withCodexNoAltScreen } from "../../../shared/cliLaunch";
import { stripAnsi } from "../../utils/ansiStrip";
import { summarizeTerminalSession } from "../../utils/sessionSummary";
import { derivePreviewFromChunk } from "../../utils/terminalPreview";
import {
  buildTrackedCliResumeCommand,
  defaultResumeCommandForTool,
  extractResumeCommandFromOutput,
  normalizeResumeCommand,
  parseTrackedCliLaunchConfig,
  providerFromTool,
  runtimeStateFromOsc133Chunk,
  sanitizeResumeTargetId,
} from "../../utils/terminalSessionSignals";

type HeadlessXtermModule = typeof HeadlessXterm;
type XtermSerializeModule = typeof XtermSerialize;

const headlessXtermModule = ((HeadlessXterm as unknown as { default?: HeadlessXtermModule }).default
  ?? HeadlessXterm) as HeadlessXtermModule;
const xtermSerializeModule = ((XtermSerialize as unknown as { default?: XtermSerializeModule }).default
  ?? XtermSerialize) as XtermSerializeModule;
const { Terminal: HeadlessTerminal } = headlessXtermModule;
const { SerializeAddon } = xtermSerializeModule;

/** Delay before auto-generating a title from CLI output; keep in sync with tests. */
export const PTY_AI_TITLE_DEBOUNCE_MS = 6000;
export const PTY_AI_TITLE_TIMEOUT_MS = 60_000;

export type NodePtySpawnHelperExecutableResult =
  | { status: "skipped"; reason: "non_darwin" | "unsupported_arch" | "package_root_unresolved" }
  | { status: "already_executable"; path: string }
  | { status: "chmod_applied"; path: string }
  | { status: "failed"; path?: string; error: string };

/** Interactive agent TUIs often hide useful text in an alt-screen, so titles come from the first submitted user prompt instead of startup output. */
const CLI_USER_TITLE_TOOL_TYPES = new Set<TerminalToolType>(["claude", "codex", "cursor-cli", "droid", "opencode"]);

function shouldScheduleOutputSnippetTitle(tool: TerminalToolType | null): boolean {
  if (!tool || tool === "shell" || tool === "run-shell") return false;
  return !CLI_USER_TITLE_TOOL_TYPES.has(tool);
}

const CLI_USER_TITLE_SEED_MIN_LEN = 3;
const CLI_USER_TITLE_SEED_MAX_LEN = 180;
const CLI_USER_TITLE_FALLBACK_MAX_LEN = 72;
const CODEX_ADE_GUIDANCE_SCAN_BYTES = 160 * 1024;
const CODEX_THREAD_NAME_SCAN_BYTES = 512 * 1024;
const CLAUDE_TITLE_SCAN_BYTES = 512 * 1024;
const PTY_DATA_BATCH_INTERVAL_MS = 16;
const PTY_DATA_BATCH_MAX_CHARS = 64 * 1024;
const PTY_DATA_SUMMARY_INTERVAL_MS = 10_000;
const DEFAULT_TERMINAL_READ_MAX_BYTES = 220_000;
const LIVE_TRANSCRIPT_TAIL_BUFFER_CHARS = 2_000_000;
const TERMINAL_SNAPSHOT_DEBOUNCE_MS = 500;
const TERMINAL_SNAPSHOT_SCROLLBACK = 2_000;
const TERMINAL_SNAPSHOT_TRANSCRIPT_FALLBACK_BYTES = 220_000;
const PTY_SEND_DEFAULT_COLS = 100;
const PTY_SEND_DEFAULT_ROWS = 30;
const CLAUDE_INITIAL_INPUT_CONFIRM_DELAY_MS = 1200;

type CodexStorageSessionMatch = {
  id: string;
  filePath: string;
  threadName: string | null;
};

type ClaudeStorageSessionMatch = {
  id: string;
  filePath: string;
  title: string | null;
};

function hasEnvValue(env: NodeJS.ProcessEnv, key: string): boolean {
  return typeof env[key] === "string" && env[key]!.trim().length > 0;
}

function hasEnvKey(env: NodeJS.ProcessEnv, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key);
}

function resolveNodePtyPrebuildDir(platform: NodeJS.Platform, arch: string): string | null {
  if (platform !== "darwin") return null;
  if (arch === "arm64") return "darwin-arm64";
  if (arch === "x64") return "darwin-x64";
  return null;
}

function resolveNodePtyPackageRoot(): string | null {
  try {
    if (typeof require !== "function" || typeof require.resolve !== "function") return null;
    return path.dirname(require.resolve("node-pty/package.json"));
  } catch {
    return null;
  }
}

export function ensureNodePtySpawnHelperExecutable({
  packageRoot,
  platform = process.platform,
  arch = process.arch,
}: {
  packageRoot?: string | null;
  platform?: NodeJS.Platform;
  arch?: string;
} = {}): NodePtySpawnHelperExecutableResult {
  if (platform !== "darwin") {
    return { status: "skipped", reason: "non_darwin" };
  }

  const prebuildDir = resolveNodePtyPrebuildDir(platform, arch);
  if (!prebuildDir) {
    return { status: "skipped", reason: "unsupported_arch" };
  }

  const root = packageRoot?.trim() || resolveNodePtyPackageRoot();
  if (!root) {
    return { status: "skipped", reason: "package_root_unresolved" };
  }

  const helperPath = path.join(root, "prebuilds", prebuildDir, "spawn-helper");
  try {
    const stat = fs.statSync(helperPath);
    const mode = typeof stat.mode === "number" ? stat.mode : 0;
    if ((mode & 0o111) !== 0) {
      return { status: "already_executable", path: helperPath };
    }
    fs.chmodSync(helperPath, mode | 0o111);
    return { status: "chmod_applied", path: helperPath };
  } catch (err) {
    return {
      status: "failed",
      path: helperPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function withInteractiveTerminalColorEnv(
  env: NodeJS.ProcessEnv,
  opts: { preserveNoColor?: boolean } = {},
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  if (!opts.preserveNoColor) {
    delete next.NO_COLOR;
  }
  const term = next.TERM?.trim().toLowerCase() ?? "";
  if (!term || term === "dumb") {
    next.TERM = "xterm-256color";
  }
  if (!hasEnvValue(next, "COLORTERM")) {
    next.COLORTERM = "truecolor";
  }
  if (!hasEnvKey(next, "NO_COLOR") && !hasEnvValue(next, "FORCE_COLOR")) {
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
  const naturalLanguageSlashTitle = seed.startsWith("/") && !isProviderSlashCommandInput(seed)
    ? seed.slice(1).trim()
    : seed;
  const cleaned = trimPromptLeadIn(naturalLanguageSlashTitle)
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
  let title = stripAnsi(raw)
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N})\]]+$/gu, "")
    .trim()
    .slice(0, 80)
    .trim();
  if (!title.length) return "";
  if (isProviderSlashCommandInput(title)) return "";
  if (title.startsWith("/")) {
    title = title.slice(1).trim();
    if (!title.length) return "";
  }
  const collapsed = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const rejected = new Set([
    "model", "models", "status", "help", "clear", "compact", "resume",
    "chat", "session", "claude", "claude code", "claude chat", "claude cli", "codex", "codex cli",
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
  terminalSnapshot: TerminalSnapshotMirror | null;
  recentOutputTail: string;
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

type ShellSpec = { file: string; args: string[]; env?: Record<string, string> };

type HeadlessTerminalInstance = InstanceType<typeof HeadlessTerminal>;
type SerializeAddonInstance = InstanceType<typeof SerializeAddon>;

type TerminalSnapshotMirror = {
  terminal: HeadlessTerminalInstance;
  serializeAddon: SerializeAddonInstance;
  flushTimer: ReturnType<typeof setTimeout> | null;
  lastErrorAt: number;
};

function cleanShellSpec(file: string): ShellSpec {
  const name = path.basename(file).toLowerCase();
  if (name === "zsh") return { file, args: ["-f"], env: { ZDOTDIR: "/var/empty" } };
  if (name === "bash") return { file, args: ["--noprofile", "--norc"], env: { BASH_ENV: "" } };
  if (name === "fish") return { file, args: ["--no-config"] };
  return { file, args: [], env: { ENV: "" } };
}

function resolveShellCandidates(options: { clean?: boolean } = {}): ShellSpec[] {
  if (process.platform === "win32") {
    return options.clean
      ? [
          { file: "powershell.exe", args: ["-NoLogo", "-NoProfile"] },
          { file: "cmd.exe", args: ["/d"] },
        ]
      : [
          { file: "powershell.exe", args: [] },
          { file: "cmd.exe", args: [] },
        ];
  }
  const candidates: string[] = [];
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv) candidates.push(fromEnv);
  candidates.push("/bin/zsh", "/bin/bash", "/bin/sh");
  const uniq = Array.from(new Set(candidates.filter(Boolean)));
  return uniq.map((file) => options.clean ? cleanShellSpec(file) : { file, args: [] });
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
  if (exitCode === 130 || exitCode === 143) return "disposed";
  return "failed";
}

function tailString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}

function computeSuffixPrefixOverlap(left: string, right: string, maxChars = 12_000): number {
  if (!left.length || !right.length) return 0;
  const cap = Math.min(maxChars, left.length, right.length);
  if (cap <= 0) return 0;

  const rightHead = right.slice(0, cap);
  const leftTail = left.slice(left.length - cap);
  const prefixLengths = new Array<number>(rightHead.length).fill(0);
  for (let index = 1, matched = 0; index < rightHead.length; index += 1) {
    while (matched > 0 && rightHead[index] !== rightHead[matched]) {
      matched = prefixLengths[matched - 1] ?? 0;
    }
    if (rightHead[index] === rightHead[matched]) matched += 1;
    prefixLengths[index] = matched;
  }

  let matched = 0;
  for (let index = 0; index < leftTail.length; index += 1) {
    while (matched > 0 && leftTail[index] !== rightHead[matched]) {
      matched = prefixLengths[matched - 1] ?? 0;
    }
    if (leftTail[index] === rightHead[matched]) matched += 1;
    if (matched === rightHead.length && index < leftTail.length - 1) {
      matched = prefixLengths[matched - 1] ?? 0;
    }
  }
  return matched;
}

function mergeTranscriptTailWithLiveOutput(transcriptTail: string, liveOutputTail: string, maxChars: number): string {
  if (!liveOutputTail) return tailString(transcriptTail, maxChars);
  if (!transcriptTail) return tailString(liveOutputTail, maxChars);
  const overlap = computeSuffixPrefixOverlap(transcriptTail, liveOutputTail, maxChars);
  return tailString(`${transcriptTail}${liveOutputTail.slice(overlap)}`, maxChars);
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
  const match = command.match(/--session-id(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match?.[1] ?? null;
}

function buildInitialResumeMetadata(args: {
  toolType: TerminalToolType | null;
  startupCommand: string;
}): TerminalResumeMetadata | null {
  const parsedLaunch = parseTrackedCliLaunchConfig(args.startupCommand, args.toolType);
  const isClaude = isClaudeTrackedCliToolType(args.toolType);
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

function isClaudeTrackedCliToolType(toolType: TerminalToolType | null | undefined): toolType is "claude" | "claude-orchestrated" {
  return toolType === "claude" || toolType === "claude-orchestrated";
}

function isPersistedChatToolType(toolType: TerminalToolType | null): boolean {
  return toolType === "codex-chat"
    || toolType === "claude-chat"
    || toolType === "opencode-chat"
    || toolType === "cursor"
    || toolType === "droid-chat";
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
  const claudeTitleCaptureKeys = new Set<string>();
  const resumeRuntimeFlights = new Map<string, Promise<PtyCreateResult>>();
  // Dedup concurrent reattachChatCli calls for the same chatSessionId so we
  // never spawn two PTYs racing to `claude --resume <same-id>`.
  const reattachChatCliFlights = new Map<string, Promise<ChatTerminalReattachResult>>();
  /** Timers for auto-closing tool-typed PTYs when the CLI tool exits back to shell prompt */
  const toolAutoCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let ptyDataSummaryTimer: ReturnType<typeof setTimeout> | null = null;
  let ptyDataSummaryStartedAt = Date.now();
  let ptyDataChunkCount = 0;
  let ptyDataBatchCount = 0;
  let ptyDataCharCount = 0;
  let ptyDataMaxBatchChars = 0;
  const terminalSnapshotDir = path.join(projectRoot, ".ade", "cache", "terminal-snapshots");

  const getSessionIntelligence = () => {
    const ai = projectConfigService?.get().effective.ai;
    return ai?.sessionIntelligence;
  };

  const safeTerminalSnapshotPathFor = (sessionId: string): string => {
    const safeName = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(terminalSnapshotDir, `${safeName}.json`);
  };

  const fgColorMode = (cell: { isFgPalette(): boolean; isFgRGB(): boolean }): TerminalSnapshotCell["fgMode"] => {
    if (cell.isFgRGB()) return "rgb";
    if (cell.isFgPalette()) return "palette";
    return "default";
  };

  const bgColorMode = (cell: { isBgDefault(): boolean; isBgPalette(): boolean; isBgRGB(): boolean }): TerminalSnapshotCell["bgMode"] => {
    if (cell.isBgRGB()) return "rgb";
    if (cell.isBgPalette()) return "palette";
    return "default";
  };

  type TerminalCellLike = IBufferCell;

  const snapshotCellFromXtermCell = (cell: TerminalCellLike | undefined): TerminalSnapshotCell => {
    if (!cell || cell.getWidth() === 0 || cell.isInvisible()) {
      return { text: " ", fg: null, bg: null, fgMode: "default", bgMode: "default" };
    }
    const fgMode = fgColorMode(cell);
    const bgMode = bgColorMode(cell);
    return {
      text: cell.getChars() || " ",
      fg: fgMode === "default" ? null : cell.getFgColor(),
      bg: bgMode === "default" ? null : cell.getBgColor(),
      fgMode,
      bgMode,
      ...(cell.isBold() ? { bold: true } : {}),
      ...(cell.isDim() ? { dim: true } : {}),
      ...(cell.isItalic() ? { italic: true } : {}),
      ...(cell.isUnderline() ? { underline: true } : {}),
      ...(cell.isInverse() ? { inverse: true } : {}),
      ...(cell.isStrikethrough() ? { strikethrough: true } : {}),
    };
  };

  const visibleRowsFromTerminal = (terminal: HeadlessTerminalInstance): TerminalSnapshotRow[] => {
    const buffer = terminal.buffer.active;
    const start = Math.max(0, buffer.viewportY);
    const reusable = buffer.getNullCell() as unknown as TerminalCellLike;
    const rows: TerminalSnapshotRow[] = [];
    for (let y = 0; y < terminal.rows; y += 1) {
      const line = buffer.getLine(start + y);
      if (!line) {
        rows.push({ cells: [], text: "", wrapped: false });
        continue;
      }
      const cells: TerminalSnapshotCell[] = [];
      for (let x = 0; x < terminal.cols; x += 1) {
        cells.push(snapshotCellFromXtermCell(line.getCell(x, reusable) as unknown as TerminalCellLike | undefined));
      }
      rows.push({
        cells,
        text: line.translateToString(true),
        wrapped: line.isWrapped,
      });
    }
    return rows;
  };

  const createTerminalSnapshotMirror = (cols: number, rows: number): TerminalSnapshotMirror | null => {
    try {
      const safe = clampDims(cols, rows);
      const terminal = new HeadlessTerminal({
        allowProposedApi: true,
        cols: safe.cols,
        rows: safe.rows,
        scrollback: TERMINAL_SNAPSHOT_SCROLLBACK,
      });
      const serializeAddon = new SerializeAddon();
      terminal.loadAddon(serializeAddon as Parameters<HeadlessTerminalInstance["loadAddon"]>[0]);
      return { terminal, serializeAddon, flushTimer: null, lastErrorAt: 0 };
    } catch (err) {
      logger.warn("pty.terminal_snapshot_init_failed", { err: String(err) });
      return null;
    }
  };

  const buildTerminalSnapshot = (entry: PtyEntry): TerminalSerializedSnapshot | null => {
    const mirror = entry.terminalSnapshot;
    if (!mirror || !entry.tracked) return null;
    const session = sessionService.get(entry.sessionId);
    const status = session?.status ?? "running";
    const runtimeState = computeRuntimeState(entry.sessionId, status);
    const buffer = mirror.terminal.buffer.active;
    return {
      version: 1,
      terminalId: entry.sessionId,
      cols: mirror.terminal.cols,
      rows: mirror.terminal.rows,
      capturedAt: new Date().toISOString(),
      status,
      runtimeState,
      bufferType: buffer.type,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      serialized: mirror.serializeAddon.serialize({ scrollback: TERMINAL_SNAPSHOT_SCROLLBACK }),
      visibleRows: visibleRowsFromTerminal(mirror.terminal),
    };
  };

  const writeTerminalSnapshot = (entry: PtyEntry): void => {
    if (!entry.tracked) return;
    const mirror = entry.terminalSnapshot;
    if (!mirror) return;
    const snapshot = buildTerminalSnapshot(entry);
    if (!snapshot) return;
    try {
      fs.mkdirSync(terminalSnapshotDir, { recursive: true });
      const finalPath = safeTerminalSnapshotPathFor(entry.sessionId);
      const tmpPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmpPath, `${JSON.stringify(snapshot)}\n`, "utf8");
      fs.renameSync(tmpPath, finalPath);
    } catch (err) {
      const now = Date.now();
      if (now - mirror.lastErrorAt > 10_000) {
        mirror.lastErrorAt = now;
        logger.warn("pty.terminal_snapshot_write_failed", { sessionId: entry.sessionId, err: String(err) });
      }
    }
  };

  const scheduleTerminalSnapshotWrite = (entry: PtyEntry, delayMs = TERMINAL_SNAPSHOT_DEBOUNCE_MS): void => {
    const mirror = entry.terminalSnapshot;
    if (!mirror || !entry.tracked || entry.disposed) return;
    if (mirror.flushTimer) return;
    mirror.flushTimer = setTimeout(() => {
      mirror.flushTimer = null;
      writeTerminalSnapshot(entry);
    }, delayMs);
    mirror.flushTimer.unref?.();
  };

  const feedTerminalSnapshot = (entry: PtyEntry, data: string): void => {
    const mirror = entry.terminalSnapshot;
    if (!mirror || !entry.tracked || entry.disposed || !data) return;
    try {
      mirror.terminal.write(data, () => {
        scheduleTerminalSnapshotWrite(entry);
      });
    } catch (err) {
      const now = Date.now();
      if (now - mirror.lastErrorAt > 10_000) {
        mirror.lastErrorAt = now;
        logger.warn("pty.terminal_snapshot_feed_failed", { sessionId: entry.sessionId, err: String(err) });
      }
    }
  };

  const flushTerminalSnapshot = (entry: PtyEntry): void => {
    const mirror = entry.terminalSnapshot;
    if (!mirror) return;
    if (mirror.flushTimer) {
      clearTimeout(mirror.flushTimer);
      mirror.flushTimer = null;
    }
    writeTerminalSnapshot(entry);
  };

  const resizeTerminalSnapshot = (entry: PtyEntry, cols: number, rows: number): void => {
    const mirror = entry.terminalSnapshot;
    if (!mirror) return;
    try {
      const safe = clampDims(cols, rows);
      if (mirror.terminal.cols === safe.cols && mirror.terminal.rows === safe.rows) return;
      mirror.terminal.resize(safe.cols, safe.rows);
      scheduleTerminalSnapshotWrite(entry, 0);
    } catch (err) {
      const now = Date.now();
      if (now - mirror.lastErrorAt > 10_000) {
        mirror.lastErrorAt = now;
        logger.warn("pty.terminal_snapshot_resize_failed", { sessionId: entry.sessionId, err: String(err) });
      }
    }
  };

  const readStoredTerminalSnapshot = (sessionId: string): TerminalSerializedSnapshot | null => {
    try {
      const raw = fs.readFileSync(safeTerminalSnapshotPathFor(sessionId), "utf8");
      const parsed = JSON.parse(raw) as TerminalSerializedSnapshot;
      if (parsed?.version !== 1 || parsed.terminalId !== sessionId) return null;
      return parsed;
    } catch {
      return null;
    }
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
      // Claude Code writes its own generated `ai-title` into local session
      // storage. Keep ADE's prompt summarizer out of this path so that native
      // Claude names win when they arrive.
      if (isClaudeTrackedCliToolType(entry.toolTypeHint)) return;
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
      const live = Array.from(ptys.values()).find((entry) => entry.sessionId === sessionId && !entry.disposed) ?? null;
      if (live?.tracked && onSessionRuntimeSignal) {
        const at = new Date(current.updatedAt).toISOString();
        live.lastRuntimeSignalAt = current.updatedAt;
        live.lastRuntimeSignalState = "idle";
        live.lastRuntimeSignalPreview = live.latestPreviewLine ?? live.lastPreviewWritten ?? null;
        try {
          onSessionRuntimeSignal({
            laneId: live.laneId,
            sessionId: live.sessionId,
            runtimeState: "idle",
            lastOutputPreview: live.lastRuntimeSignalPreview,
            at,
          });
        } catch {
          // ignore callback failures
        }
      }
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
        const summaryToolType = session.toolType ?? null;
        const summaryTargetId = sanitizeResumeTargetId(session.resumeMetadata?.targetId ?? null);
        const titleCaptureCwd = summaryCwd || laneService.getLaneBaseAndBranch(session.laneId).worktreePath;
        if (
          summaryTargetId
          && isClaudeTrackedCliToolType(summaryToolType)
          && titleCaptureCwd
        ) {
          scheduleClaudeRuntimeTitleCaptureBestEffort(sessionId, summaryTargetId, titleCaptureCwd);
        }

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

  function claudeProjectDirForCwd(cwd: string): string {
    return path.join(os.homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
  }

  function claudeSessionFilePathForCwd(cwd: string, claudeSessionId: string): string {
    return path.join(claudeProjectDirForCwd(cwd), `${claudeSessionId}.jsonl`);
  }

  /**
   * Try to find the Claude session from Claude's local JSONL storage.
   * Claude Code stores conversations at ~/.claude/projects/<escaped-cwd>/<uuid>.jsonl.
   * We find the most recently modified JSONL in the project dir and return its UUID
   * plus any runtime-generated title Claude has already written.
   */
  const resolveClaudeSessionFromStorage = (cwd: string): ClaudeStorageSessionMatch | null => {
    try {
      const claudeProjectDir = claudeProjectDirForCwd(cwd);
      if (!fs.existsSync(claudeProjectDir)) return null;

      // Find the most recently modified .jsonl that is a direct session (not in subagents/)
      const entries = fs.readdirSync(claudeProjectDir, { withFileTypes: true }) as Array<string | fs.Dirent>;
      let newest: { name: string; mtimeMs: number } | null = null;
      for (const entry of entries) {
        const name = typeof entry === "string" ? entry : entry.name;
        const isFile = typeof entry === "string" ? true : entry.isFile();
        if (!isFile || !name.endsWith(".jsonl")) continue;
        const stat = fs.statSync(path.join(claudeProjectDir, name));
        if (!newest || stat.mtimeMs > newest.mtimeMs) {
          newest = { name, mtimeMs: stat.mtimeMs };
        }
      }
      if (!newest) return null;
      // UUID is the filename without .jsonl extension
      const uuid = newest.name.replace(/\.jsonl$/, "");
      // Basic UUID format check
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) return null;
      // Only consider if modified within the last 5 minutes (to avoid picking up stale sessions)
      if (Date.now() - newest.mtimeMs > 5 * 60 * 1000) return null;
      const filePath = path.join(claudeProjectDir, newest.name);
      return {
        id: uuid,
        filePath,
        title: readClaudeRuntimeTitle(filePath, uuid),
      };
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

  function readFileSuffix(filePath: string, maxBytes = 512 * 1024): string | null {
    let fd: number | null = null;
    try {
      const size = Math.max(0, Number(fs.statSync(filePath).size) || 0);
      const readBytes = Math.min(maxBytes, size);
      if (readBytes <= 0) return null;
      fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(readBytes);
      const bytesRead = fs.readSync(fd, buf, 0, readBytes, Math.max(0, size - readBytes));
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

  function titleFromClaudeRecord(record: unknown, claudeSessionId: string): string | null {
    if (!record || typeof record !== "object") return null;
    const obj = record as Record<string, unknown>;
    const recordSessionId = typeof obj.sessionId === "string" ? obj.sessionId.trim() : "";
    if (recordSessionId && recordSessionId !== claudeSessionId) return null;
    const type = typeof obj.type === "string" ? obj.type : "";
    if (type === "ai-title") {
      return sanitizeGeneratedCliTitle(typeof obj.aiTitle === "string" ? obj.aiTitle : "");
    }
    if (type === "custom-title") {
      return sanitizeGeneratedCliTitle(typeof obj.customTitle === "string" ? obj.customTitle : "");
    }
    return null;
  }

  function readClaudeRuntimeTitle(filePath: string, claudeSessionId: string): string | null {
    const prefix = readFilePrefix(filePath, CLAUDE_TITLE_SCAN_BYTES) ?? "";
    const suffix = readFileSuffix(filePath, CLAUDE_TITLE_SCAN_BYTES) ?? "";
    const text = prefix && suffix && prefix !== suffix ? `${prefix}\n${suffix}` : (suffix || prefix);
    if (!text) return null;
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const title = titleFromClaudeRecord(JSON.parse(lines[i]!), claudeSessionId);
        if (title) return title;
      } catch {
        // Ignore malformed or partial JSONL fragments from prefix/suffix reads.
      }
    }
    return null;
  }

  function sanitizeCodexRuntimeThreadName(raw: unknown): string | null {
    const title = sanitizeGeneratedCliTitle(typeof raw === "string" ? raw : "");
    if (!title) return null;
    const normalized = title.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "").trim();
    if (/^ade-[a-z0-9_-]+$/iu.test(normalized)) return null;
    return title;
  }

  function threadNameFromCodexRecord(record: unknown, codexSessionId: string): string | null {
    if (!record || typeof record !== "object") return null;
    const obj = record as Record<string, unknown>;
    const payload = obj.payload && typeof obj.payload === "object" ? obj.payload as Record<string, unknown> : obj;
    const type = typeof payload.type === "string" ? payload.type : typeof obj.type === "string" ? obj.type : "";
    const method = typeof obj.method === "string" ? obj.method : typeof payload.method === "string" ? payload.method : "";
    const params = payload.params && typeof payload.params === "object" ? payload.params as Record<string, unknown> : payload;
    const threadId = typeof params.thread_id === "string"
      ? params.thread_id
      : typeof params.threadId === "string"
        ? params.threadId
        : "";
    const isNameUpdate =
      type === "thread_name_updated"
      || type === "thread_updated"
      || method === "thread/name/updated"
      || method === "thread/updated";
    if (!isNameUpdate) return null;
    if (threadId && threadId !== codexSessionId) return null;
    return sanitizeCodexRuntimeThreadName(
      params.thread_name
      ?? params.threadName
      ?? params.name
      ?? params.title,
    );
  }

  function readCodexThreadNameFromSessionFile(filePath: string, codexSessionId: string): string | null {
    const prefix = readFilePrefix(filePath, CODEX_THREAD_NAME_SCAN_BYTES) ?? "";
    const suffix = readFileSuffix(filePath, CODEX_THREAD_NAME_SCAN_BYTES) ?? "";
    const text = prefix && suffix && prefix !== suffix ? `${prefix}\n${suffix}` : (suffix || prefix);
    if (!text) return null;
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const title = threadNameFromCodexRecord(JSON.parse(lines[i]!), codexSessionId);
        if (title) return title;
      } catch {
        // Ignore malformed or partial JSONL fragments from prefix/suffix reads.
      }
    }
    return null;
  }

  function readCodexThreadNameFromIndex(codexSessionId: string): string | null {
    const indexPath = path.join(os.homedir(), ".codex", "session_index.jsonl");
    const text = readFileSuffix(indexPath, CODEX_THREAD_NAME_SCAN_BYTES);
    if (!text) return null;
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const entry = JSON.parse(lines[i]!) as Record<string, unknown>;
        if (entry.id !== codexSessionId) continue;
        const title = sanitizeCodexRuntimeThreadName(entry.thread_name ?? entry.threadName ?? entry.name);
        if (title) return title;
      } catch {
        // Ignore malformed or partial JSONL fragments.
      }
    }
    return null;
  }

  function readCodexRuntimeThreadName(filePath: string, codexSessionId: string): string | null {
    return readCodexThreadNameFromIndex(codexSessionId)
      ?? readCodexThreadNameFromSessionFile(filePath, codexSessionId);
  }

  /**
   * Try to find the Codex session ID from Codex's local storage.
   * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
   * Each JSONL starts with a session_meta event containing `payload.id` and `payload.cwd`.
   * We score recent candidates by cwd match and closeness to ADE's session startedAt.
   */
  const resolveCodexSessionFromStorage = (args: {
    cwd: string;
    startedAt?: string | null;
    maxStartDeltaMs?: number;
    notBeforeMs?: number;
    requiredText?: string;
  }): CodexStorageSessionMatch | null => {
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

      let bestMatch: { id: string; filePath: string; score: number; mtimeMs: number } | null = null;
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
          // ADE's injected session guidance can land after a large session_meta
          // line plus restored context, so scan beyond the first few KB while
          // still keeping the live poll bounded.
          const prefix = readFilePrefix(candidate.filePath, CODEX_ADE_GUIDANCE_SCAN_BYTES);
          if (!prefix?.includes(args.requiredText)) continue;
        }

        if (!hasStartedAt) {
          return {
            id,
            filePath: candidate.filePath,
            threadName: readCodexRuntimeThreadName(candidate.filePath, id),
          };
        }

        const payloadTimestamp = typeof payload?.timestamp === "string" ? payload.timestamp : "";
        const payloadTimestampMs = Date.parse(payloadTimestamp);
        const referenceMs = Number.isFinite(payloadTimestampMs) ? payloadTimestampMs : candidate.mtimeMs;
        if (typeof args.notBeforeMs === "number" && referenceMs < args.notBeforeMs) continue;
        const score = Math.abs(referenceMs - requestedStartedAtMs);
        if (typeof args.maxStartDeltaMs === "number" && score > args.maxStartDeltaMs) continue;
        if (!bestMatch || score < bestMatch.score || (score === bestMatch.score && candidate.mtimeMs > bestMatch.mtimeMs)) {
          bestMatch = { id, filePath: candidate.filePath, score, mtimeMs: candidate.mtimeMs };
        }
      }
      return bestMatch
        ? {
            id: bestMatch.id,
            filePath: bestMatch.filePath,
            threadName: readCodexRuntimeThreadName(bestMatch.filePath, bestMatch.id),
          }
        : null;
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
    const existingTargetId = sanitizeResumeTargetId(session.resumeMetadata?.targetId ?? null);
    if (existingTargetId) {
      const cwd = sessionCwd ?? inferSessionCwdFromTranscriptPath(session.transcriptPath);
      if (isClaudeTrackedCliToolType(effectiveToolType) && cwd) {
        scheduleClaudeRuntimeTitleCaptureBestEffort(sessionId, existingTargetId, cwd);
      }
      return true;
    }
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

    if (isClaudeTrackedCliToolType(effectiveToolType) && cwd) {
      const claudeSession = resolveClaudeSessionFromStorage(cwd);
      if (claudeSession) {
        const resumeCmd = `claude --resume ${claudeSession.id}`;
        missingResumeTargetBackfillFailures.delete(sessionId);
        sessionService.setResumeCommand(sessionId, resumeCmd);
        adoptClaudeRuntimeTitle(sessionId, claudeSession.title, "claude-storage-backfill");
        scheduleClaudeRuntimeTitleCaptureBestEffort(sessionId, claudeSession.id, cwd);
        logger.info("pty.resume_target_backfilled", { sessionId, toolType: effectiveToolType, reason, source: "claude-storage", claudeSessionId: claudeSession.id });
        return true;
      }
    }

    // The session-list and resume-launch paths both need this Codex storage
    // fallback. Fresh launches still use the live capture watcher below; this
    // path handles existing tracked sessions whose transcript did not yield a
    // usable Codex thread id before the user types to continue.
    if ((effectiveToolType === "codex" || effectiveToolType === "codex-orchestrated") && cwd) {
      const codexSession = resolveCodexSessionFromStorage({
        cwd,
        startedAt: session.startedAt,
        maxStartDeltaMs: 10 * 60_000,
      });
      if (codexSession) {
        const resumeCmd = `codex resume ${codexSession.id}`;
        missingResumeTargetBackfillFailures.delete(sessionId);
        sessionService.setResumeCommand(sessionId, resumeCmd);
        adoptCodexRuntimeThreadName(sessionId, codexSession.threadName, "codex-storage-backfill");
        scheduleCodexRuntimeTitleCaptureBestEffort(sessionId, codexSession.id, codexSession.filePath);
        logger.info("pty.resume_target_backfilled", { sessionId, toolType: effectiveToolType, reason, source: "codex-storage", codexSessionId: codexSession.id });
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
  const CODEX_TITLE_POLL_DELAYS_MS = [2_000, 5_000, 12_000, 30_000, 60_000];
  const CLAUDE_TITLE_POLL_DELAYS_MS = [1_000, 2_500, 5_000, 12_000, 30_000, 60_000];
  const CODEX_LIVE_CAPTURE_HARD_TIMEOUT_MS = 60_000;
  const CODEX_WATCH_DEBOUNCE_MS = 200;

  const adoptClaudeRuntimeTitle = (
    sessionId: string,
    rawTitle: string | null | undefined,
    source: string,
  ): boolean => {
    const title = sanitizeGeneratedCliTitle(rawTitle ?? "");
    if (!title) return false;
    if (isSessionManuallyNamed(sessionService, sessionId)) {
      logger.info("pty.claude_runtime_title_skipped_user_renamed", { sessionId, source });
      return true;
    }
    const session = sessionService.get(sessionId);
    if (!session) return true;
    if (session.title?.trim() === title) return true;
    sessionService.updateMeta({ sessionId, title, manuallyNamed: false });
    logger.info("pty.claude_runtime_title_adopted", {
      sessionId,
      source,
      titleLength: title.length,
    });
    return true;
  };

  const scheduleClaudeRuntimeTitleCaptureBestEffort = (
    sessionId: string,
    claudeSessionId: string | null | undefined,
    cwd: string,
  ): void => {
    const cleanClaudeSessionId = sanitizeResumeTargetId(claudeSessionId ?? null);
    if (!cleanClaudeSessionId) return;
    const key = `${sessionId}:${cleanClaudeSessionId}`;
    if (claudeTitleCaptureKeys.has(key)) return;
    claudeTitleCaptureKeys.add(key);

    const filePath = claudeSessionFilePathForCwd(cwd, cleanClaudeSessionId);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const cleanup = (): void => {
      claudeTitleCaptureKeys.delete(key);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
    const tryTitle = (source: string): boolean => {
      const title = readClaudeRuntimeTitle(filePath, cleanClaudeSessionId);
      return adoptClaudeRuntimeTitle(sessionId, title, source);
    };

    if (tryTitle("claude-storage-initial")) {
      cleanup();
      return;
    }

    for (let i = 0; i < CLAUDE_TITLE_POLL_DELAYS_MS.length; i += 1) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        try {
          if (tryTitle(`claude-storage-poll-${i}`)) cleanup();
        } catch (err) {
          logger.warn("pty.claude_runtime_title_capture_failed", { sessionId, attempt: i, err: String(err) });
        } finally {
          if (i === CLAUDE_TITLE_POLL_DELAYS_MS.length - 1) cleanup();
        }
      }, CLAUDE_TITLE_POLL_DELAYS_MS[i]);
      timer.unref?.();
      timers.add(timer);
    }
  };

  const adoptCodexRuntimeThreadName = (
    sessionId: string,
    rawTitle: string | null | undefined,
    source: string,
  ): boolean => {
    const title = sanitizeCodexRuntimeThreadName(rawTitle ?? "");
    if (!title) return false;
    if (isSessionManuallyNamed(sessionService, sessionId)) {
      logger.info("pty.codex_runtime_title_skipped_user_renamed", { sessionId, source });
      return true;
    }
    const session = sessionService.get(sessionId);
    if (!session) return true;
    if (session.title?.trim() === title) return true;
    sessionService.updateMeta({ sessionId, title, manuallyNamed: false });
    logger.info("pty.codex_runtime_title_adopted", {
      sessionId,
      source,
      titleLength: title.length,
    });
    return true;
  };

  const scheduleCodexRuntimeTitleCaptureBestEffort = (
    sessionId: string,
    codexSessionId: string,
    filePath: string,
  ): void => {
    const tryTitle = (source: string): boolean => {
      const title = readCodexRuntimeThreadName(filePath, codexSessionId);
      return adoptCodexRuntimeThreadName(sessionId, title, source);
    };

    if (tryTitle("codex-storage-initial")) return;
    for (let i = 0; i < CODEX_TITLE_POLL_DELAYS_MS.length; i += 1) {
      const timer = setTimeout(() => {
        tryTitle(`codex-storage-poll-${i}`);
      }, CODEX_TITLE_POLL_DELAYS_MS[i]);
      timer.unref?.();
    }
  };

  // Codex CLI has no pre-assigned session ID flag (unlike Claude's --session-id), so the
  // rollout JSONL is the only handle on the session's UUID. We watch the day directory for
  // the file's appearance, then store the UUID directly for resume and separately adopt any
  // runtime-generated thread name Codex writes. A staggered poll covers environments where
  // fs.watch is missing/unreliable (network mounts, Linux on some FSes, the test harness).
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
      if (sanitizeResumeTargetId(session.resumeMetadata?.targetId ?? null)) {
        cleanup();
        return true;
      }
      const codexSession = resolveCodexSessionFromStorage({
        cwd,
        startedAt,
        maxStartDeltaMs: 5 * 60_000,
        ...(startedAtFinite !== null ? { notBeforeMs: startedAtFinite - 1_000 } : {}),
        requiredText: "ADE session guidance",
      });
      if (!codexSession) return false;

      captured = true;
      const resumeCmd = `codex resume ${codexSession.id}`;
      sessionService.setResumeCommand(sessionId, resumeCmd);
      adoptCodexRuntimeThreadName(sessionId, codexSession.threadName, "codex-storage-live");
      scheduleCodexRuntimeTitleCaptureBestEffort(sessionId, codexSession.id, codexSession.filePath);
      logger.info("pty.codex_session_id_captured_live", {
        sessionId,
        codexSessionId: codexSession.id,
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
    // Release the live-tail buffer (up to LIVE_TRANSCRIPT_TAIL_BUFFER_CHARS
    // per session). Disposed entries linger in the `ptys` map for replacement
    // lookups; without this, every ended terminal would keep its 2 MB tail
    // pinned indefinitely.
    entry.recentOutputTail = "";

    const endedAt = new Date().toISOString();
    const status = statusFromExit(exitCode);
    sessionService.end({ sessionId: entry.sessionId, endedAt, exitCode, status });
    flushTerminalSnapshot(entry);
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

  const appendRecentOutput = (entry: PtyEntry, data: string) => {
    if (!data) return;
    entry.recentOutputTail = tailString(`${entry.recentOutputTail}${data}`, LIVE_TRANSCRIPT_TAIL_BUFFER_CHARS);
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
      toolType: summary.toolType,
      goal: summary.goal,
      status: fallbackStatus,
      runtimeState: computeRuntimeState(summary.id, fallbackStatus),
      active: Boolean(activeTerminalId && activeTerminalId === summary.id),
      startedAt: summary.startedAt,
      endedAt: live ? null : summary.endedAt,
      exitCode: live ? null : summary.exitCode,
      pid: live?.[1].pty.pid ?? null,
      resumeCommand: summary.resumeCommand,
      resumeMetadata: summary.resumeMetadata ?? null,
      lastOutputPreview: live?.[1].latestPreviewLine ?? summary.lastOutputPreview,
      summary: summary.summary,
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

  const service = {
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

      const laneRuntimeEnv = (await getLaneRuntimeEnv?.(laneId)) ?? {};
      const explicitNoColor = hasEnvKey(args.env ?? {}, "NO_COLOR") || hasEnvKey(laneRuntimeEnv, "NO_COLOR");
      const baseLaunchEnv = {
        ...process.env,
        ...laneRuntimeEnv,
        ...(args.env ?? {})
      };
      const contextLaunchEnv = withAdeTerminalContextEnv(baseLaunchEnv, {
        projectRoot,
        laneId,
        chatSessionId,
      });
      const launchEnv = withInteractiveTerminalColorEnv(
        getAdeCliAgentEnv?.(contextLaunchEnv) ?? contextLaunchEnv,
        { preserveNoColor: explicitNoColor },
      );
      const shouldBackfillResumeTarget =
        existingSession
        && isTrackedCliToolType(toolTypeHint)
        && !sanitizeResumeTargetId(existingSession.resumeMetadata?.targetId ?? null);
      if (shouldBackfillResumeTarget) {
        const backfilled = await tryBackfillResumeTarget(sessionId, toolTypeHint, "resume-launch", cwd);
        const updatedSession = backfilled ? sessionService.get(sessionId) : null;
        if (updatedSession?.resumeCommand?.trim()) {
          initialResumeCommand = updatedSession.resumeCommand.trim();
          initialResumeMetadata = updatedSession.resumeMetadata ?? initialResumeMetadata;
          startupCommand = initialResumeCommand;
        }
      }

      let pty: IPty;
      let selectedShell: ShellSpec | null = null;
      const directCommand = typeof args.command === "string" ? args.command.trim() : "";
      const directArgs = Array.isArray(args.args) ? args.args.filter((value): value is string => typeof value === "string") : [];
      const useCleanInteractiveShell = toolTypeHint === "shell" && !directCommand && !startupCommand;
      const shellCandidates = resolveShellCandidates({ clean: useCleanInteractiveShell });
      let launchedDirectCommand = false;
      try {
        const spawnHelperRepair = ensureNodePtySpawnHelperExecutable();
        if (spawnHelperRepair.status === "chmod_applied") {
          logger.info("pty.spawn_helper_chmod_applied", { path: spawnHelperRepair.path });
        } else if (spawnHelperRepair.status === "failed") {
          logger.warn("pty.spawn_helper_chmod_failed", {
            path: spawnHelperRepair.path ?? "",
            err: spawnHelperRepair.error,
          });
        }
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
              created = ptyLib.spawn(shell.file, shell.args, {
                ...opts,
                env: shell.env ? { ...launchEnv, ...shell.env } : launchEnv,
              });
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
        terminalSnapshot: tracked ? createTerminalSnapshotMirror(cols, rows) : null,
        recentOutputTail: "",
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
        appendRecentOutput(entry, data);
        writeTranscript(entry, data);
        feedTerminalSnapshot(entry, data);
        updatePreviewThrottled(entry, data);
        enqueuePtyData(entry, { ptyId, sessionId, data });

        const prevState = runtimeStates.get(sessionId)?.state ?? "running";
        const markerState = runtimeStateFromOsc133Chunk(data, prevState);
        const runtimeState = markerState === prevState && prevState === "idle" && data.length > 0
          ? "running"
          : markerState;
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

        // Continuation-command scanning runs an ANSI strip + 2 regex passes over a
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
      if (isClaudeTrackedCliToolType(toolTypeHint) && cwd) {
        scheduleClaudeRuntimeTitleCaptureBestEffort(
          sessionId,
          initialResumeMetadata?.provider === "claude" ? initialResumeMetadata.targetId : null,
          cwd,
        );
      }

      // Fire-and-forget: after 6s, attempt AI title from initial PTY output
      // (not used for interactive agent TUIs, which title from native runtime
      // storage or the first submitted user input).
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

    async sendToSession(args: PtySendToSessionArgs): Promise<PtySendToSessionResult> {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!sessionId) throw new Error("Session id is required.");
      if (!text) throw new Error("Message text is required.");

      const buildResult = (
        created: PtyCreateResult,
        flags: { resumed: boolean; reusedExistingRuntime: boolean },
      ): PtySendToSessionResult => {
        const session = sessionService.get(created.sessionId);
        const enriched = session ? service.enrichSessions([session])[0] ?? session : null;
        return {
          ...created,
          session: enriched,
          resumed: flags.resumed,
          reusedExistingRuntime: flags.reusedExistingRuntime,
        };
      };

      const live = liveEntryBySessionId(sessionId);
      if (live) {
        const [ptyId, entry] = live;
        const written = service.writeBySessionId(sessionId, `${text}\r`);
        if (!written) throw new Error(`Terminal session '${sessionId}' is not accepting input.`);
        return buildResult(
          { ptyId, sessionId, pid: entry.pty.pid ?? null },
          { resumed: false, reusedExistingRuntime: true },
        );
      }

      const session = sessionService.get(sessionId);
      if (!session) throw new Error(`Terminal session '${sessionId}' was not found.`);
      if (!session.tracked) throw new Error(`Terminal session '${sessionId}' is not tracked and cannot be continued.`);
      if (session.toolType === "shell" || session.toolType === "run-shell" || isPersistedChatToolType(session.toolType)) {
        throw new Error(`Terminal session '${sessionId}' is not an agent CLI session.`);
      }

      const provider = session.resumeMetadata?.provider ?? providerFromTool(session.toolType);
      if (!provider) throw new Error(`Terminal session '${sessionId}' does not have a resumable CLI provider.`);

      const requestedModel = typeof args.model === "string" && args.model.trim().length
        ? args.model.trim()
        : null;
      const requestedReasoningEffort = typeof args.reasoningEffort === "string" && args.reasoningEffort.trim().length
        ? args.reasoningEffort.trim()
        : null;
      const requestedPermissionMode = typeof args.permissionMode === "string" && args.permissionMode.trim().length
        ? args.permissionMode
        : null;
      const metadataResumeCommand = session.resumeMetadata
        ? buildTrackedCliResumeCommand(session.resumeMetadata, {
          model: requestedModel,
          reasoningEffort: requestedReasoningEffort,
          permissionMode: requestedPermissionMode,
        })
        : null;
      const rawResumeCommand = metadataResumeCommand != null
        ? metadataResumeCommand
        : normalizeResumeCommand(session.resumeCommand, session.toolType);
      const resumeCommand = provider === "codex" && rawResumeCommand
        ? withCodexNoAltScreen(rawResumeCommand)
        : rawResumeCommand;
      if (!resumeCommand) {
        throw new Error(`Terminal session '${sessionId}' does not have a resume command.`);
      }

      let resumeFlight = resumeRuntimeFlights.get(sessionId);
      if (!resumeFlight) {
        const { cols, rows } = clampDims(
          typeof args.cols === "number" ? args.cols : PTY_SEND_DEFAULT_COLS,
          typeof args.rows === "number" ? args.rows : PTY_SEND_DEFAULT_ROWS,
        );
        resumeFlight = service.create({
          sessionId,
          laneId: session.laneId,
          cols,
          rows,
          title: session.goal?.trim() || session.title || "Terminal",
          tracked: session.tracked,
          toolType: session.toolType,
          startupCommand: resumeCommand,
        });
        resumeRuntimeFlights.set(sessionId, resumeFlight);
        void resumeFlight
          .finally(() => {
            if (resumeRuntimeFlights.get(sessionId) === resumeFlight) {
              resumeRuntimeFlights.delete(sessionId);
            }
          })
          .catch(() => {});
      }

      const created = await resumeFlight;
      const written = service.writeBySessionId(created.sessionId, `${text}\r`);
      if (!written) {
        try {
          service.dispose({ ptyId: created.ptyId, sessionId: created.sessionId });
        } catch {
          // Best effort; preserve the send failure for the caller.
        }
        throw new Error(`Terminal session '${sessionId}' could not receive the message.`);
      }

      if (provider === "claude") {
        const confirmTimer = setTimeout(() => {
          const confirmWritten = service.writeBySessionId(created.sessionId, "\r");
          if (!confirmWritten) {
            logger.warn("pty.send_to_session_claude_initial_input_confirm_failed", {
              sessionId: created.sessionId,
              ptyId: created.ptyId,
            });
          }
        }, CLAUDE_INITIAL_INPUT_CONFIRM_DELAY_MS);
        confirmTimer.unref?.();
      }

      return buildResult(created, { resumed: true, reusedExistingRuntime: false });
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
        .filter((summary) => !isPersistedChatToolType(summary.toolType))
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

    async reattachChatCli(args: ChatTerminalReattachArgs): Promise<ChatTerminalReattachResult> {
      const chatSessionId = cleanOptionalId(args?.chatSessionId);
      if (!chatSessionId) throw new Error("terminal.reattachChatCli requires chatSessionId.");

      // Fast path: an existing live PTY is already bound. Skip the dedup map to
      // keep the no-op cost low.
      const activeTerminalId = activeTerminalByChatSession.get(chatSessionId) ?? null;
      if (activeTerminalId) {
        const liveActive = liveEntryBySessionId(activeTerminalId);
        if (liveActive) {
          return {
            terminalId: activeTerminalId,
            ptyId: liveActive[0],
            pid: liveActive[1].pty.pid ?? null,
            relaunched: false,
          };
        }
      }

      // Single-flight dedup: concurrent callers (chat composer + App Control,
      // rapid sends, etc.) must not each launch a fresh `claude --resume` PTY.
      // Whoever wins the create wins; everyone else awaits the same Promise.
      const existing = reattachChatCliFlights.get(chatSessionId);
      if (existing) return existing;

      const flight = (async (): Promise<ChatTerminalReattachResult> => {
        // For chat-CLI sessions the chat session id and terminal session id are the same.
        const session = sessionService.get(chatSessionId);
        if (!session) {
          throw new Error(`Chat CLI session '${chatSessionId}' was not found.`);
        }
        if (!session.tracked) {
          throw new Error(`Chat CLI session '${chatSessionId}' is not tracked and cannot be reattached.`);
        }
        if (!isPersistedChatToolType(session.toolType)) {
          throw new Error(`Session '${chatSessionId}' is not a chat CLI session.`);
        }

        const resumeCommand = session.resumeMetadata
          ? buildTrackedCliResumeCommand(session.resumeMetadata, {
            model: null,
            reasoningEffort: null,
            permissionMode: null,
          })
          : normalizeResumeCommand(session.resumeCommand, session.toolType);
        if (!resumeCommand) {
          throw new Error(`Chat CLI session '${chatSessionId}' has no resume command available.`);
        }

        const { cols, rows } = clampDims(
          typeof args.cols === "number" ? args.cols : PTY_SEND_DEFAULT_COLS,
          typeof args.rows === "number" ? args.rows : PTY_SEND_DEFAULT_ROWS,
        );

        const created = await service.create({
          sessionId: chatSessionId,
          laneId: session.laneId,
          chatSessionId,
          cols,
          rows,
          title: session.title || session.goal || "Chat CLI",
          tracked: true,
          toolType: session.toolType,
          startupCommand: resumeCommand,
        });

        logger.info("pty.reattach_chat_cli", {
          chatSessionId,
          toolType: session.toolType,
        });

        return {
          terminalId: created.sessionId,
          ptyId: created.ptyId,
          pid: created.pid,
          relaunched: true,
        };
      })();

      reattachChatCliFlights.set(chatSessionId, flight);
      try {
        return await flight;
      } finally {
        if (reattachChatCliFlights.get(chatSessionId) === flight) {
          reattachChatCliFlights.delete(chatSessionId);
        }
      }
    },

    async readTerminal(args: ChatTerminalReadArgs = {}): Promise<ChatTerminalReadResult> {
      const terminalId = resolveTerminalId(args);
      if (!terminalId) throw new Error("terminal.read requires terminalId or an active chat terminal.");
      const session = sessionService.get(terminalId);
      if (!session) throw new Error(`Terminal session '${terminalId}' was not found.`);
      if (isPersistedChatToolType(session.toolType)) {
        throw new Error(`Session '${terminalId}' is an agent chat session, not a terminal.`);
      }
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

    async previewTerminal(args: ChatTerminalPreviewArgs = {}): Promise<ChatTerminalPreviewResult> {
      const terminalId = resolveTerminalId(args);
      if (!terminalId) throw new Error("terminal.preview requires terminalId or an active chat terminal.");
      const session = sessionService.get(terminalId);
      if (!session) throw new Error(`Terminal session '${terminalId}' was not found.`);
      if (isPersistedChatToolType(session.toolType)) {
        throw new Error(`Session '${terminalId}' is an agent chat session, not a terminal.`);
      }
      const live = liveEntryBySessionId(terminalId);
      if (live) {
        flushTerminalSnapshot(live[1]);
      }
      const maxBytes = typeof args.maxBytes === "number" && Number.isFinite(args.maxBytes)
        ? Math.max(1, Math.min(MAX_TRANSCRIPT_BYTES, Math.floor(args.maxBytes)))
        : TERMINAL_SNAPSHOT_TRANSCRIPT_FALLBACK_BYTES;
      const readTranscriptPreview = async (): Promise<string> =>
        sessionService.readTranscriptTail(session.transcriptPath, maxBytes, {
          raw: true,
          alignToLineBoundary: true,
        });
      const snapshot = readStoredTerminalSnapshot(terminalId);
      if (snapshot) {
        let transcript: string | null = null;
        if (session.status !== "running") {
          try {
            transcript = await readTranscriptPreview();
          } catch (err) {
            logger.warn("pty.terminal_preview_transcript_read_failed", {
              terminalId,
              err: String(err),
            });
          }
        }
        return {
          terminalId,
          session: terminalSessionFromSummary(session),
          source: "snapshot",
          snapshot,
          transcript: transcript || null,
          capturedAt: snapshot.capturedAt,
        };
      }

      const transcript = await readTranscriptPreview();
      return {
        terminalId,
        session: terminalSessionFromSummary(session),
        source: transcript ? "transcript" : "empty",
        snapshot: null,
        transcript: transcript || null,
        capturedAt: new Date().toISOString(),
      };
    },

    async writeTerminal(args: ChatTerminalWriteArgs): Promise<{ ok: true }> {
      if (!args || typeof args.data !== "string") {
        throw new Error("terminal.write requires string data.");
      }
      const ptyId = cleanOptionalId(args.ptyId);
      let entry: PtyEntry | null = null;
      if (ptyId) {
        // Explicit ptyId: never auto-reattach by ptyId; preserve the throw if the entry is missing.
        const candidate = ptys.get(ptyId);
        if (!candidate || candidate.disposed) throw new Error(`Terminal PTY '${ptyId}' is not running.`);
        entry = candidate;
      } else {
        const terminalId = resolveTerminalId(args);
        const chatSessionId = cleanOptionalId(args.chatSessionId);
        let live = terminalId ? liveEntryBySessionId(terminalId) : null;
        if (!live) {
          // The PTY is gone. If this is a chat-CLI session and we have a chatSessionId or a terminalId that
          // matches a chat-CLI tracked session record, auto-reattach via reattachChatCli.
          const reattachKey = chatSessionId ?? terminalId ?? null;
          if (reattachKey) {
            const session = sessionService.get(reattachKey);
            if (
              session
              && session.tracked
              && isPersistedChatToolType(session.toolType)
            ) {
              const created = await service.reattachChatCli({ chatSessionId: reattachKey });
              live = liveEntryBySessionId(created.terminalId);
            }
          }
        }
        if (!live) {
          if (!terminalId) {
            // No live terminal could be resolved from args and no chat-CLI auto-reattach applies.
            // Preserve the historical contract for callers that pass chatSessionId without a live target.
            throw new Error("terminal.write requires terminalId, ptyId, or an active chat terminal.");
          }
          throw new Error(`Terminal session '${terminalId}' is not running.`);
        }
        entry = live[1];
      }
      entry.pty.write(args.data);
      tryCliUserTitleFromWrite(entry, args.data);
      setRuntimeState(entry.sessionId, "running");
      scheduleIdleTransition(entry.sessionId);
      return { ok: true };
    },

    resizeTerminal(args: ChatTerminalResizeArgs): { ok: true; cols: number; rows: number } {
      if (!args) throw new Error("terminal.resize requires terminalId, ptyId, or an active chat terminal.");
      const ptyId = cleanOptionalId(args.ptyId);
      let live: [string, PtyEntry] | null = null;
      if (ptyId) {
        const candidate = ptys.get(ptyId);
        if (candidate && !candidate.disposed) live = [ptyId, candidate];
      } else {
        const terminalId = resolveTerminalId(args);
        if (terminalId) live = liveEntryBySessionId(terminalId);
      }
      if (!live) throw new Error("No running terminal matched the requested resize target.");
      const [liveId, entry] = live;
      const safe = clampDims(args.cols, args.rows);
      if (entry.lastResizeCols === safe.cols && entry.lastResizeRows === safe.rows) {
        return { ok: true, cols: safe.cols, rows: safe.rows };
      }
      try {
        entry.pty.resize(safe.cols, safe.rows);
        entry.lastResizeCols = safe.cols;
        entry.lastResizeRows = safe.rows;
        resizeTerminalSnapshot(entry, safe.cols, safe.rows);
        return { ok: true, cols: safe.cols, rows: safe.rows };
      } catch (err) {
        logger.warn("pty.terminal_resize_failed", { ptyId: liveId, err: String(err) });
        throw err;
      }
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
        resizeTerminalSnapshot(entry, safe.cols, safe.rows);
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
        resizeTerminalSnapshot(entry, safe.cols, safe.rows);
        return true;
      } catch (err) {
        logger.warn("pty.resize_by_session_failed", { sessionId, err: String(err) });
        return false;
      }
    },

    getRuntimeState(sessionId: string, fallbackStatus: TerminalSessionStatus): TerminalRuntimeState {
      return computeRuntimeState(sessionId, fallbackStatus);
    },

    async readTranscriptTail(args: {
      sessionId: string;
      maxBytes: number;
      raw?: boolean;
      alignToLineBoundary?: boolean;
    }): Promise<string> {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return "";
      const session = sessionService.get(sessionId);
      if (!session) return "";
      const maxBytes = Number.isFinite(args.maxBytes)
        ? Math.max(1024, Math.min(MAX_TRANSCRIPT_BYTES, Math.floor(args.maxBytes)))
        : DEFAULT_TERMINAL_READ_MAX_BYTES;
      const diskTail = await sessionService.readTranscriptTail(session.transcriptPath, maxBytes, {
        raw: true,
        alignToLineBoundary: args.alignToLineBoundary,
      });
      // A Work terminal can mount after the CLI has already drawn its first TUI
      // frame, while the transcript WriteStream is still buffered. Merge the
      // live tail so hydration can replay that initial screen state.
      const live = liveEntryBySessionId(sessionId)?.[1].recentOutputTail ?? "";
      const merged = mergeTranscriptTailWithLiveOutput(diskTail, live, maxBytes);
      return args.raw ? merged : stripAnsi(merged);
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
      // Release the live-tail buffer; see closeEntry for rationale.
      entry.recentOutputTail = "";
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
          service.dispose({ ptyId });
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
          service.dispose({ ptyId });
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

    // Used by project-context rebalancing to decide whether a project still
    // has user work that would be destroyed by eviction. ANY live PTY (running
    // CLI, shell, agent process) protects the whole context.
    hasLiveSessions(): boolean {
      for (const entry of ptys.values()) {
        if (!entry.disposed) return true;
      }
      return false;
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
  return service;
}
