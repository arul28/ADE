import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import type { IPty, IWindowsPtyForkOptions } from "node-pty";
import type * as ptyNs from "node-pty";
import * as HeadlessXterm from "@xterm/headless";
import type { IBufferCell } from "@xterm/headless";
import * as XtermSerialize from "@xterm/addon-serialize";
import type { Logger } from "../logging/logger";
import {
  issueBuiltInBrowserActorCapability,
  revokeBuiltInBrowserActorCapability,
} from "../builtInBrowser/builtInBrowserActorCapabilities";
import type { createLaneService } from "../lanes/laneService";
import { resolveLaneLaunchContext } from "../lanes/laneLaunchContext";
import type { createSessionService } from "../sessions/sessionService";
import type { ProcessRegistryService } from "../runtime/processRegistryService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { DiskPressureMonitor } from "../storage/diskPressure";
import { readHistoryFileSync, reinflateHistoryFile } from "../storage/historyCompression";
import {
  resolveCodexComputerUseMcpConfig,
  type CodexComputerUseMcpConfig,
} from "../../utils/codexComputerUse";
import { runGit } from "../git/git";
import { resolveOpenCodeBinaryPath } from "../opencode/openCodeBinaryManager";
import { resolveCliSpawnInvocation } from "../shared/processExecution";
import type { ResourceAttributionRoot, ResourceAttributionRootKind } from "./resourceUsageSampling";
import { augmentProcessPathWithShellAndKnownCliDirs, getPathEnvValue, setPathEnvValue, splitPathEntries } from "../ai/cliExecutableResolver";
import type {
  PtyDataEvent,
  PtyExitEvent,
  PtyCreateArgs,
  PtyCreateResult,
  PtyDisposeResult,
  PtyResumeSessionArgs,
  PtyResumeSessionResult,
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
  TerminalResumeProvider,
  TerminalRuntimeState,
  TerminalSessionStatus,
  TerminalSessionSummary,
  TerminalToolType,
} from "../../../shared/types";
import {
  isTrackedAgentCliToolType,
  PTY_SEND_PRE_DELIVERY_ERROR_CODE,
} from "../../../shared/types";
import { isProviderSlashCommandInput } from "../../../shared/chatSlashCommands";
import {
  isClaudeBinaryCommand,
  sanitizeTrackedCliPromptSeed,
  shellCommandLineArgIndex,
  trackedCliTitleFromPromptSeed,
  withClaudePluginInCommandLine,
  withCodexNoAltScreen,
} from "../../../shared/cliLaunch";
import { claudeAgentSkillPluginRoots } from "../skills/agentSkillRuntimeService";
import { stripAnsi } from "../../utils/ansiStrip";
import { summarizeTerminalSession } from "../../utils/sessionSummary";
import { derivePreviewFromChunk } from "../../utils/terminalPreview";
import {
  buildOpenCodeReplayResumeCommand,
  buildTrackedCliResumeCommand,
  defaultResumeCommandForTool,
  extractResumeCommandFromOutput,
  normalizeResumeCommand,
  parseTrackedCliLaunchConfig,
  parseTrackedCliResumeCommand,
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
// Delay before the early CLI title pass so a slice of session output exists to
// summarize (seed + transcript). The deterministic name shows until then.
export const EARLY_CLI_AI_TITLE_DELAY_MS = 5_000;
const MAX_STARTUP_COMMAND_DELAY_MS = 1000;

function normalizeStartupCommandDelayMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_STARTUP_COMMAND_DELAY_MS, Math.floor(value)))
    : 0;
}

export type NodePtySpawnHelperExecutableResult =
  | { status: "skipped"; reason: "non_darwin" | "unsupported_arch" | "package_root_unresolved" }
  | { status: "already_executable"; path: string }
  | { status: "chmod_applied"; path: string }
  | { status: "failed"; path?: string; error: string };

/** Interactive agent TUIs often hide useful text in an alt-screen, so titles come from the first submitted user prompt instead of startup output. */
const CLI_USER_TITLE_TOOL_TYPES = new Set<TerminalToolType>(["claude", "codex", "cursor-cli", "droid", "opencode"]);

function shouldScheduleOutputSnippetTitle(tool: TerminalToolType | null): boolean {
  if (!tool || tool === "shell") return false;
  return !CLI_USER_TITLE_TOOL_TYPES.has(tool);
}

const CLI_USER_TITLE_SEED_MIN_LEN = 3;
const CODEX_THREAD_NAME_SCAN_BYTES = 512 * 1024;
const CLAUDE_TITLE_SCAN_BYTES = 512 * 1024;
const CLAUDE_STORAGE_MATCH_START_SKEW_MS = 1_000;
/** A resumed PTY that exits nonzero within this window never actually launched. */
const RESUME_LAUNCH_FAILURE_WINDOW_MS = 5_000;
// Live capture itself stops after 60 seconds. Ninety seconds covers Codex CLI
// startup plus modest write/timestamp skew without admitting unrelated launches
// several minutes later; storage backfill keeps its wider historical window.
const CODEX_LIVE_CAPTURE_MAX_START_DELTA_MS = 90_000;
// ADE's delivered text lands after session_meta plus any restored context, so
// the ownership scan reaches well past the first few KB while staying bounded.
const CODEX_OWNERSHIP_NEEDLE_SCAN_BYTES = 160 * 1024;
/** Shorter slices are not distinctive enough to prove a rollout is ours. */
const CODEX_OWNERSHIP_NEEDLE_MIN_LEN = 24;
const CODEX_OWNERSHIP_NEEDLE_MAX_LEN = 200;
const CLAUDE_STORAGE_MATCH_END_SKEW_MS = 5_000;
const PTY_DATA_BATCH_INTERVAL_MS = 50;
// Echo latency is dominated by the data batch window. After a user keystroke
// the very next flush races the user's perception, so batch on a much shorter
// window for a brief period following any write to the PTY.
const PTY_DATA_INTERACTIVE_BATCH_INTERVAL_MS = 8;
const PTY_DATA_INTERACTIVE_WINDOW_MS = 1_000;
const PTY_DATA_BATCH_MAX_CHARS = 64 * 1024;
const PTY_DATA_SUMMARY_INTERVAL_MS = 10_000;
const PTY_LIVE_SESSION_RESYNC_INTERVAL_MS = 1_000;
const DEFAULT_TERMINAL_READ_MAX_BYTES = 220_000;
const LIVE_TRANSCRIPT_TAIL_BUFFER_CHARS = 2_000_000;
const TERMINAL_SNAPSHOT_DEBOUNCE_MS = 500;
const TERMINAL_SNAPSHOT_SCROLLBACK = 2_000;
const TERMINAL_SNAPSHOT_TRANSCRIPT_FALLBACK_BYTES = 220_000;
const PTY_SEND_DEFAULT_COLS = 100;
const PTY_SEND_DEFAULT_ROWS = 30;
const OPENCODE_REPLAY_RESUME_ENV = "ADE_OPENCODE_REPLAY_RESUME";
const AGENT_CLI_INPUT_CLEAR_TO_END_KEY = "\x05";
const AGENT_CLI_INPUT_CLEAR_TO_START_KEY = "\x15";
const AGENT_CLI_BRACKETED_PASTE_START = "\x1b[200~";
const AGENT_CLI_BRACKETED_PASTE_END = "\x1b[201~";
const AGENT_CLI_INPUT_CHUNK_SIZE = 64;
const AGENT_CLI_INPUT_CHUNK_DELAY_MS = 5;
const AGENT_CLI_INPUT_CLEAR_DELAY_MS = 25;
const AGENT_CLI_LINE_SUBMIT_KEY = "\r";
const AGENT_CLI_SUBMIT_DELAY_MS = 25;
const CODEX_CLI_PASTE_SUBMIT_DELAY_MS = 180;
const CURSOR_CLI_PASTE_SUBMIT_DELAY_MS = 500;
const AGENT_CLI_READY_TIMEOUT_MS = 20_000;
const CODEX_CLI_READY_TIMEOUT_MS = 60_000;
const AGENT_CLI_READY_POLL_MS = 100;
const AGENT_CLI_READY_QUIET_MS = 600;
const PTY_PROCESS_TREE_KILL_DELAY_MS = 1500;
const PTY_PROCESS_SCAN_SIGNAL_DELAY_MS = 100;
const PTY_PROCESS_SCAN_TIMEOUT_MS = 250;
const PTY_PROCESS_SCAN_MAX_BYTES = 512 * 1024;

let cachedOpenCodeReplayResumeSupport: boolean | null = null;

function killPidBestEffort(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(Math.trunc(pid), signal);
  } catch {
    // The process may have already exited.
  }
}

function killPtyProcessGroupBestEffort(rootPid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32" || !Number.isFinite(rootPid) || rootPid <= 0) return false;
  try {
    // node-pty's POSIX backend uses forkpty(3); forkpty's login_tty(3) creates
    // a new session, making the child both session and process-group leader.
    // Targeting `-pid` therefore signals the PTY group in one syscall, instead
    // of recursively running synchronous `pgrep` calls on the main thread.
    process.kill(-Math.trunc(rootPid), signal);
    return true;
  } catch {
    return false;
  }
}

type PtyTreeProcess = {
  pid: number;
  parentPid: number;
  processGroupId: number;
  foregroundProcessGroupId: number;
};

type PtyTreeProcessScan = {
  processes: PtyTreeProcess[];
  succeeded: boolean;
};

function parsePtyTreeProcesses(
  stdout: string,
  rootPid: number,
  knownProcessGroupIds: ReadonlySet<number> = new Set(),
): PtyTreeProcess[] {
  const rows = stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s*$/);
    if (!match) return [];
    const [pid, parentPid, processGroupId, foregroundProcessGroupId] = match.slice(1).map((value) =>
      Number.parseInt(value, 10)
    );
    if (![pid, parentPid, processGroupId, foregroundProcessGroupId].every(Number.isFinite)) return [];
    return [{ pid, parentPid, processGroupId, foregroundProcessGroupId }];
  });
  const selectedPids = new Set<number>(
    rows.some((row) => row.pid === rootPid) ? [rootPid] : [],
  );
  const selectedProcessGroups = new Set<number>(knownProcessGroupIds);
  for (const row of rows) {
    if (knownProcessGroupIds.has(row.processGroupId)) selectedPids.add(row.pid);
  }
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) {
      if (
        !selectedPids.has(row.pid)
        && (selectedPids.has(row.parentPid) || selectedProcessGroups.has(row.processGroupId))
      ) {
        selectedPids.add(row.pid);
        added = true;
      }
      if (!selectedPids.has(row.pid)) continue;
      if (row.processGroupId > 1 && !selectedProcessGroups.has(row.processGroupId)) {
        selectedProcessGroups.add(row.processGroupId);
        added = true;
      }
      if (
        row.foregroundProcessGroupId > 1
        && !selectedProcessGroups.has(row.foregroundProcessGroupId)
      ) {
        selectedProcessGroups.add(row.foregroundProcessGroupId);
        added = true;
      }
    }
  }
  return rows.filter((row) =>
    selectedPids.has(row.pid) || selectedProcessGroups.has(row.processGroupId)
  );
}

function collectPtyTreeProcesses(
  rootPid: number,
  knownProcessGroupIds: ReadonlySet<number> = new Set(),
): Promise<PtyTreeProcessScan> {
  if (process.platform === "win32" || !Number.isFinite(rootPid) || rootPid <= 0) {
    return Promise.resolve({ processes: [], succeeded: false });
  }
  return new Promise((resolve) => {
    try {
      execFile(
        "ps",
        ["-axo", "pid=,ppid=,pgid=,tpgid="],
        {
          encoding: "utf8",
          timeout: PTY_PROCESS_SCAN_TIMEOUT_MS,
          maxBuffer: PTY_PROCESS_SCAN_MAX_BYTES,
          windowsHide: true,
        },
        (error, stdout) => {
          resolve(error
            ? { processes: [], succeeded: false }
            : {
                processes: parsePtyTreeProcesses(String(stdout ?? ""), rootPid, knownProcessGroupIds),
                succeeded: true,
              });
        },
      );
    } catch {
      resolve({ processes: [], succeeded: false });
    }
  });
}

function signalPtyTreeProcesses(
  processes: readonly PtyTreeProcess[],
  signal: NodeJS.Signals,
): void {
  const processGroups = new Set(processes
    .map((entry) => entry.processGroupId)
    .filter((processGroupId) => processGroupId > 1 && processGroupId !== process.pid));
  for (const processGroupId of processGroups) {
    try {
      process.kill(-processGroupId, signal);
    } catch {
      // A group may have exited between the process scan and signal.
    }
  }
  for (const { pid } of [...processes].reverse()) {
    killPidBestEffort(pid, signal);
  }
}

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

type ClaudeStorageSessionLookupArgs = {
  cwd: string;
  startedAt?: string | null;
  endedAt?: string | null;
  maxStartDeltaMs?: number;
};

function hasEnvValue(env: NodeJS.ProcessEnv, key: string): boolean {
  return typeof env[key] === "string" && env[key]!.trim().length > 0;
}

function openCodeSupportsReplayResume(): boolean {
  const override = process.env[OPENCODE_REPLAY_RESUME_ENV]?.trim().toLowerCase();
  if (override === "1" || override === "true" || override === "yes") return true;
  if (override === "0" || override === "false" || override === "no") return false;
  if (cachedOpenCodeReplayResumeSupport != null) return cachedOpenCodeReplayResumeSupport;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    delete env.FORCE_COLOR;
    const executable = resolveOpenCodeBinaryPath() ?? "opencode";
    const result = spawnSync(executable, ["run", "--help"], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 512 * 1024,
      env,
    });
    const output = `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
    cachedOpenCodeReplayResumeSupport = result.status === 0
      && /\b--replay\b/.test(output)
      && /\b--interactive\b/.test(output);
    return cachedOpenCodeReplayResumeSupport;
  } catch {
    cachedOpenCodeReplayResumeSupport = false;
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ptySendPreDeliveryError(
  message: string,
): Error & { code: typeof PTY_SEND_PRE_DELIVERY_ERROR_CODE } {
  return Object.assign(new Error(message), { code: PTY_SEND_PRE_DELIVERY_ERROR_CODE });
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
  ownerSessionId?: string | null;
  spawnLineage?: PtyCreateArgs["spawnLineage"];
}): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    ADE_PROJECT_ROOT: args.projectRoot,
    ADE_LANE_ID: args.laneId,
  };
  const terminalOwnerSessionId = args.chatSessionId ?? args.ownerSessionId ?? null;
  if (terminalOwnerSessionId) {
    next.ADE_CHAT_SESSION_ID = terminalOwnerSessionId;
    next.ADE_BROWSER_ACTOR_TOKEN = issueBuiltInBrowserActorCapability({
      chatSessionId: terminalOwnerSessionId,
      laneId: args.laneId,
      projectRoot: args.projectRoot,
      tabCollection: null,
    });
  } else {
    delete next.ADE_CHAT_SESSION_ID;
    delete next.ADE_BROWSER_ACTOR_TOKEN;
  }
  if (args.spawnLineage) {
    next.ADE_PARENT_CHAT_SESSION_ID = args.spawnLineage.parentChatSessionId;
    next.ADE_SPAWN_KIND = args.spawnLineage.spawnKind ?? "";
  } else {
    // The daemon itself may run inside a spawned agent shell that inherited
    // these; without lineage they must not leak into unrelated terminals.
    delete next.ADE_PARENT_CHAT_SESSION_ID;
    delete next.ADE_SPAWN_KIND;
  }
  return next;
}

function isCliPlaceholderTitle(title: string | null | undefined, toolType: TerminalToolType | null | undefined): boolean {
  const normalized = String(title ?? "").trim().toLowerCase();
  if (!normalized.length) return true;
  if (isProviderSlashCommandInput(normalized)) return true;
  if (toolType === "codex") return normalized === "codex" || normalized === "codex cli" || normalized === "codex session";
  if (toolType === "claude") return normalized === "claude" || normalized === "claude cli" || normalized === "claude session" || normalized === "claude code";
  return false;
}

function normalizePtySessionTitle(title: unknown): string {
  const trimmed = typeof title === "string" ? title.trim() : "";
  return trimmed.length ? trimmed : "Terminal";
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

function extractLatestOscWindowTitle(entry: PtyEntry, data: string): string {
  const combined = `${entry.runtimeWindowTitleScanBuffer}${data}`.slice(-2048);
  const titlePattern = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let match: RegExpExecArray | null;
  let latestRawTitle = "";
  let latestEnd = 0;
  while ((match = titlePattern.exec(combined))) {
    latestRawTitle = match[1] ?? "";
    latestEnd = titlePattern.lastIndex;
  }

  const partialStart = combined.lastIndexOf("\x1b]");
  entry.runtimeWindowTitleScanBuffer = partialStart >= latestEnd
    ? combined.slice(partialStart)
    : "";

  if (!latestRawTitle.trim()) return "";
  return sanitizeGeneratedCliTitle(
    latestRawTitle
      .replace(/^[\s\u2800-\u28ff\u2022\u00b7.:-]+/u, "")
      .trim(),
  );
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
  /** Logical UTF-8 byte offset immediately after all output observed so far. */
  transcriptBytesWritten: number;
  /** Logical offset represented by byte zero of the retained transcript file. */
  transcriptBaseOffset: number;
  /** Bytes currently retained in the transcript file (including buffered writes). */
  transcriptRetainedBytes: number;
  transcriptRolloverInProgress: boolean;
  transcriptRolloverPromise: Promise<void> | null;
  transcriptRolloverPendingChunks: Buffer[];
  transcriptRolloverPendingBytes: number;
  transcriptRolloverPendingTrimmed: boolean;
  transcriptPausedForRollover: boolean;
  transcriptWriteDisabled: boolean;
  transcriptLastErrorAt: number;
  lastPreviewWriteAt: number;
  lastSessionResyncCheckAt: number;
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
  attentionRequested: boolean;
  disposed: boolean;
  createdAt: number;
  cleanupPaths: string[];
  lastResizeCols: number | null;
  lastResizeRows: number | null;
  /** Last size set by a non-mobile caller, restored when a phone detaches. */
  lastDesktopCols: number | null;
  lastDesktopRows: number | null;
  pendingDataChunks: string[];
  pendingDataChars: number;
  pendingDataTimer: ReturnType<typeof setTimeout> | null;
  /** A trailing UTF-16 high surrogate held until the next PTY output chunk. */
  pendingOutputHighSurrogate: string;
  /** Routes canonical Unicode output through every live/transcript consumer. */
  processOutputData: ((data: string) => void) | null;
  /** Epoch ms of the last user write; shortens the data batch window. */
  lastUserInputAt: number;
  /** Monotonic generation used to detect user takeover of deferred input. */
  userInputGeneration: number;
  terminalSnapshot: TerminalSnapshotMirror | null;
  recentOutputTail: string;
  runtimeWindowTitleScanBuffer: string;
  /** Output-snippet title timer (skipped for interactive Claude/Codex; see CLI user-title path). */
  aiTitleTimer: ReturnType<typeof setTimeout> | null;
  startupTimer: ReturnType<typeof setTimeout> | null;
  initialInputTimer: ReturnType<typeof setTimeout> | null;
  cliUserTitleLineBuffer: string;
  cliUserTitleCommitted: boolean;
  /**
   * For a resume/reattach launch only: the terminal end state this launch took
   * over. If the new process dies immediately (a launch failure — a bad flag,
   * a missing binary, a shell usage error), closeEntry restores this instead
   * of stamping the row `failed`, so a still-resumable session does not become
   * permanently dead-looking. `running` is deliberately unrepresentable here.
   */
  priorEndState: {
    status: Exclude<TerminalSessionStatus, "running">;
    exitCode: number | null;
    endedAt: string | null;
  } | null;
};

function isHighSurrogateCodeUnit(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogateCodeUnit(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function replaceUnpairedSurrogates(value: string): string {
  let normalized = "";
  let segmentStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (isHighSurrogateCodeUnit(codeUnit)) {
      if (index + 1 < value.length && isLowSurrogateCodeUnit(value.charCodeAt(index + 1))) {
        index += 1;
        continue;
      }
    } else if (!isLowSurrogateCodeUnit(codeUnit)) {
      continue;
    }
    normalized += `${value.slice(segmentStart, index)}\uFFFD`;
    segmentStart = index + 1;
  }
  return segmentStart === 0 ? value : `${normalized}${value.slice(segmentStart)}`;
}

/**
 * A per-launch ownership marker: a bounded, contiguous slice of the text ADE
 * itself delivers to this Codex process. Codex writes that text into its
 * rollout, so finding the slice there proves the rollout belongs to this
 * launch — not to some other Codex process that happens to share the worktree
 * and the launch window.
 *
 * The slice is taken from the user's own prompt when there is one: everything
 * ahead of it is ADE's fixed session-guidance preamble, which every ADE Codex
 * launch emits and therefore cannot distinguish two of them from each other.
 */
function codexOwnershipNeedleFromDeliveredText(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  if (!text.trim().length) return null;
  const promptMarker = /\bUser prompt:[ \t]*\n?/iu.exec(text);
  const distinctive = promptMarker
    ? text.slice(promptMarker.index + promptMarker[0].length)
    : text;
  const trimmed = distinctive.trim();
  if (!trimmed.length) return null;
  let needle = trimmed.slice(0, CODEX_OWNERSHIP_NEEDLE_MAX_LEN);
  // A slice that ends mid-surrogate would JSON-escape differently than the
  // whole pair Codex wrote, so drop the dangling half.
  if (needle.length > 0 && isHighSurrogateCodeUnit(needle.charCodeAt(needle.length - 1))) {
    needle = needle.slice(0, -1);
  }
  needle = needle.trimEnd();
  return needle.length >= CODEX_OWNERSHIP_NEEDLE_MIN_LEN ? needle : null;
}

/**
 * Codex launches carry ADE's prompt one of two ways: typed into the PTY as
 * initial input, or pushed onto argv as the trailing positional prompt (see
 * `usePromptArg` in shared/cliLaunch). Either is text we know this process
 * received; nothing else on the command line is ours to claim.
 */
function codexLaunchOwnershipNeedle(args: {
  initialInput: string;
  args: readonly string[];
}): string | null {
  const fromInitialInput = codexOwnershipNeedleFromDeliveredText(args.initialInput);
  if (fromInitialInput) return fromInitialInput;
  const trailingArg = args.args.length ? args.args[args.args.length - 1] ?? "" : "";
  if (trailingArg.startsWith("-")) return null;
  return codexOwnershipNeedleFromDeliveredText(trailingArg);
}

/**
 * Rollout JSONL holds the delivered text inside JSON strings, so newlines and
 * quotes arrive escaped. Match the raw slice (it may sit in a plain-text field)
 * and its JSON-escaped form (the usual case).
 */
function rolloutTextContainsOwnershipNeedle(rolloutText: string, needle: string): boolean {
  if (rolloutText.includes(needle)) return true;
  const escaped = JSON.stringify(needle).slice(1, -1);
  return escaped !== needle && rolloutText.includes(escaped);
}

function takeCanonicalPtyOutput(entry: PtyEntry, data: string, final = false): string {
  let value = entry.pendingOutputHighSurrogate
    ? `${entry.pendingOutputHighSurrogate}${data}`
    : data;
  entry.pendingOutputHighSurrogate = "";
  if (!final && value.length > 0 && isHighSurrogateCodeUnit(value.charCodeAt(value.length - 1))) {
    entry.pendingOutputHighSurrogate = value.slice(-1);
    value = value.slice(0, -1);
  }
  return replaceUnpairedSurrogates(value);
}

type HostReadyPty = IPty & {
  __adePtyHostReady?: Promise<void>;
};

function terminatePtyProcessTree(
  entry: Pick<PtyEntry, "pty" | "sessionId" | "toolTypeHint">,
  signal: NodeJS.Signals,
  logger: Logger,
): void {
  const rootPid = typeof entry.pty.pid === "number" && Number.isFinite(entry.pty.pid)
    ? Math.trunc(entry.pty.pid)
    : null;
  if (!rootPid) {
    try {
      entry.pty.kill(signal);
    } catch {
      // No numeric PID is available for a direct fallback.
    }
    return;
  }
  if (process.platform === "win32") {
    try {
      entry.pty.kill(signal);
    } catch {
      killPidBestEffort(rootPid, signal);
    }
    if (signal === "SIGKILL") return;
    const timer = setTimeout(() => {
      try {
        process.kill(rootPid, 0);
      } catch {
        return;
      }
      try {
        execFile(
          "taskkill",
          ["/pid", String(rootPid), "/T", "/F"],
          { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
          (error) => {
            if (error) return;
            logger.warn("pty.process_tree_force_killed", {
              sessionId: entry.sessionId,
              toolType: entry.toolTypeHint,
              rootPid,
              pids: [rootPid],
            });
          },
        );
      } catch {
        // taskkill may be unavailable; the initial node-pty signal still ran.
      }
    }, PTY_PROCESS_TREE_KILL_DELAY_MS);
    timer.unref?.();
    return;
  }

  let initialProcesses: PtyTreeProcess[] = [];
  let initialSignalDispatched = false;
  const dispatchInitialSignal = (processes: readonly PtyTreeProcess[]) => {
    if (initialSignalDispatched) return;
    initialSignalDispatched = true;
    killPtyProcessGroupBestEffort(rootPid, signal);
    try {
      entry.pty.kill(signal);
    } catch {
      killPidBestEffort(rootPid, signal);
    }
    signalPtyTreeProcesses(processes, signal);
  };
  const initialProcessScan = collectPtyTreeProcesses(rootPid);
  const signalFallbackTimer = setTimeout(() => {
    dispatchInitialSignal([]);
  }, PTY_PROCESS_SCAN_SIGNAL_DELAY_MS);
  signalFallbackTimer.unref?.();
  void initialProcessScan.then(({ processes }) => {
    initialProcesses = processes;
    clearTimeout(signalFallbackTimer);
    const signalAlreadyDispatched = initialSignalDispatched;
    dispatchInitialSignal(processes);
    if (signalAlreadyDispatched) signalPtyTreeProcesses(processes, signal);
  });
  if (signal === "SIGKILL") return;
  const timer = setTimeout(() => {
    const knownProcessGroupIds = new Set(initialProcesses.flatMap((process) => [
      process.processGroupId,
      process.foregroundProcessGroupId,
    ]).filter((processGroupId) => processGroupId > 1));
    void collectPtyTreeProcesses(rootPid, knownProcessGroupIds).then(({ processes: currentProcesses, succeeded }) => {
      if (!succeeded) {
        // A saturated host can time out the fallback `ps` scan precisely when
        // cleanup matters most. Do not interpret an unavailable scan as proof
        // that the tree exited: force the known PTY/root groups once more so a
        // surviving child cannot keep a lane worktree busy indefinitely.
        killPtyProcessGroupBestEffort(rootPid, "SIGKILL");
        killPidBestEffort(rootPid, "SIGKILL");
        signalPtyTreeProcesses(initialProcesses, "SIGKILL");
        logger.warn("pty.process_tree_force_killed", {
          sessionId: entry.sessionId,
          toolType: entry.toolTypeHint,
          rootPid,
          pids: Array.from(new Set([rootPid, ...initialProcesses.map(({ pid }) => pid)])),
          processScanFailed: true,
        });
        return;
      }
      if (currentProcesses.length === 0) return;
      signalPtyTreeProcesses(currentProcesses, "SIGKILL");
      logger.warn("pty.process_tree_force_killed", {
        sessionId: entry.sessionId,
        toolType: entry.toolTypeHint,
        rootPid,
        pids: Array.from(new Set(currentProcesses.map(({ pid }) => pid))),
      });
    });
  }, PTY_PROCESS_TREE_KILL_DELAY_MS);
  timer.unref?.();
}

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
  writeDisabled: boolean;
};

function cleanShellSpec(file: string): ShellSpec {
  const name = path.basename(file).toLowerCase();
  if (name === "zsh") return { file, args: ["-f"], env: { ZDOTDIR: "/var/empty" } };
  if (name === "bash") return { file, args: ["--noprofile", "--norc"], env: { BASH_ENV: "" } };
  if (name === "fish") return { file, args: ["--no-config"] };
  return { file, args: [], env: { ENV: "" } };
}

function loginShellSpec(file: string): ShellSpec {
  const name = path.basename(file).toLowerCase();
  if (name === "zsh" || name === "bash") return { file, args: ["-l"] };
  if (name === "fish") return { file, args: ["--login"] };
  return { file, args: [] };
}

function resolveShellCandidates(options: { clean?: boolean; login?: boolean } = {}): ShellSpec[] {
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
  return uniq.map((file) => {
    if (options.clean) return cleanShellSpec(file);
    if (options.login) return loginShellSpec(file);
    return { file, args: [] };
  });
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

function directShellLaunchForCommandLine(commandLine: string): Pick<PtyCreateArgs, "command" | "args"> {
  if (process.platform === "win32") return {};
  const trimmed = commandLine.trim();
  if (!trimmed) return {};
  return {
    command: "/bin/bash",
    args: ["--noprofile", "--norc", "-lc", trimmed],
  };
}

function isOpenCodeToolType(toolType: TerminalToolType | null): boolean {
  return toolType === "opencode" || toolType === "opencode-chat" || toolType === "opencode-orchestrated";
}

function isOpenCodeCommandName(command: string): boolean {
  const basename = command.trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return basename === "opencode" || basename === "opencode.exe" || basename === "opencode.cmd" || basename === "opencode.bat";
}

function resolveDirectOpenCodeCommand(command: string, toolType: TerminalToolType | null): string {
  if (!isOpenCodeToolType(toolType) || !isOpenCodeCommandName(command)) return command;
  return resolveOpenCodeBinaryPath() ?? command;
}

function withBundledOpenCodeCommandLine(commandLine: string, toolType: TerminalToolType | null): string {
  if (!isOpenCodeToolType(toolType)) return commandLine;
  const bundled = resolveOpenCodeBinaryPath();
  if (!bundled) return commandLine;
  return commandLine.replace(/(^|\s)opencode(?=\s|$)/, `$1${quotePosixShellArg(bundled)}`);
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
  const tail = value.slice(value.length - maxChars);
  return tail.length > 0 && isLowSurrogateCodeUnit(tail.charCodeAt(0))
    ? tail.slice(1)
    : tail;
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

/**
 * Forward-scan to the first safe place a transcript page may start: the byte
 * after a newline, or an ESC (0x1B) opening a fresh escape sequence — so a
 * page never begins mid-escape-sequence. Returns 0 (raw start) when the page
 * contains neither.
 */
export function scanToTranscriptPageBoundary(page: Buffer): number {
  for (let index = 0; index < page.length; index += 1) {
    const byte = page[index];
    if (byte === 0x1b) return index;
    if (byte === 0x0a) return index + 1;
  }
  return 0;
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
  const isOpenCode = args.toolType === "opencode" || args.toolType === "opencode-orchestrated";

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

export type PtyResourceAttribution = {
  activePtyCount: number;
  roots: ResourceAttributionRoot[];
};

// Explicit spawn metadata → disjoint attribution role. Shell-like terminals
// stay "shell"; anything without a recognized provider identity is "unknown"
// rather than guessed from command lines.
function attributionRootKindForToolType(toolType: TerminalToolType | null): ResourceAttributionRootKind {
  if (toolType == null || toolType === "shell") return "shell";
  if (toolType === "other") return "unknown";
  return "provider-agent";
}

function isCodexTrackedCliToolType(toolType: TerminalToolType | null | undefined): toolType is "codex" | "codex-orchestrated" {
  return toolType === "codex" || toolType === "codex-orchestrated";
}

function isClaudeTrackedCliToolType(toolType: TerminalToolType | null | undefined): toolType is "claude" | "claude-orchestrated" {
  return toolType === "claude" || toolType === "claude-orchestrated";
}

function hasClaudePluginRoot(args: string[], pluginRoot: string): boolean {
  return args.some((arg, index) =>
    (arg === "--plugin-dir" && args[index + 1] === pluginRoot)
    || arg === `--plugin-dir=${pluginRoot}`,
  );
}

/**
 * `args` are the argv of whatever `command` is actually spawned — which is the
 * Claude binary for ordinary launches but `/bin/bash ... -lc "<command line>"`
 * for resume and reattach launches. Prepending Claude flags to a shell's argv
 * makes bash die with "invalid option", so the flag goes wherever the `claude`
 * token really lives: the argv for a direct Claude spawn, the -lc command line
 * for a shell wrapper, and the startup command written into an interactive
 * shell.
 */
function withBundledClaudePlugin(
  command: string | null,
  args: string[],
  startupCommand: string,
  toolType: TerminalToolType | null,
  env: NodeJS.ProcessEnv,
): { args: string[]; startupCommand: string } {
  if (!isClaudeTrackedCliToolType(toolType)) {
    return { args, startupCommand };
  }
  const pluginRoot = claudeAgentSkillPluginRoots(env)[0];
  if (!pluginRoot) return { args, startupCommand };

  let normalizedArgs = args;
  if (isClaudeBinaryCommand(command)) {
    if (!hasClaudePluginRoot(args, pluginRoot)) {
      normalizedArgs = ["--plugin-dir", pluginRoot, ...args];
    }
  } else if (command?.trim()) {
    const commandLineIndex = shellCommandLineArgIndex(args);
    if (commandLineIndex >= 0) {
      const rewritten = withClaudePluginInCommandLine(args[commandLineIndex]!, pluginRoot);
      if (rewritten !== args[commandLineIndex]) {
        normalizedArgs = args.slice();
        normalizedArgs[commandLineIndex] = rewritten;
      }
    }
  }
  return {
    args: normalizedArgs,
    startupCommand: withClaudePluginInCommandLine(startupCommand, pluginRoot),
  };
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

function isNodeModulesBinPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  const userYarnGlobalBin = path
    .join(os.homedir(), ".config", "yarn", "global", "node_modules", ".bin")
    .replace(/\\/g, "/")
    .toLowerCase();
  return normalized.endsWith("/node_modules/.bin") && normalized !== userYarnGlobalBin;
}

function looksLikeCodexCommand(command: string | null | undefined): boolean {
  const trimmed = String(command ?? "").trim();
  return /^codex(?:\s|$)/.test(trimmed);
}

function shouldPreferUserCodexPath(args: {
  toolType: TerminalToolType | null;
  directCommand?: string | null;
  startupCommand?: string | null;
}): boolean {
  return isCodexTrackedCliToolType(args.toolType)
    || looksLikeCodexCommand(args.directCommand)
    || looksLikeCodexCommand(args.startupCommand);
}

function withUserCodexCliPathPriority(
  env: NodeJS.ProcessEnv,
  args: { toolType: TerminalToolType | null; directCommand?: string | null; startupCommand?: string | null },
): NodeJS.ProcessEnv {
  if (!shouldPreferUserCodexPath(args)) return env;
  const pathValue = getPathEnvValue(env);
  const entries = splitPathEntries(pathValue);
  const nodeModulesEntries = entries.filter(isNodeModulesBinPath);
  if (nodeModulesEntries.length === 0) return env;
  const nonNodeModulesEntries = entries.filter((entry) => !isNodeModulesBinPath(entry));
  const next = { ...env };
  // ADE's dev/package dependency bin can shadow the user's already-updated
  // Codex CLI and send every Work launch into Codex's update-and-restart flow.
  // Keep node_modules bins as a last-resort fallback, but never let them win.
  setPathEnvValue(next, [...nonNodeModulesEntries, ...nodeModulesEntries].join(path.delimiter));
  return next;
}

function withResolvedCliLaunchPath(
  env: NodeJS.ProcessEnv,
  options: { includeInteractiveShell?: boolean } = {},
): NodeJS.ProcessEnv {
  const next = { ...env };
  setPathEnvValue(next, augmentProcessPathWithShellAndKnownCliDirs({
    env: next,
    includeInteractiveShell: options.includeInteractiveShell,
  }));
  return next;
}

function isCodexCliUpdateTranscript(text: string): boolean {
  const normalized = stripAnsi(text).replace(/\r/g, "\n").toLowerCase();
  if (!normalized.trim()) return false;
  return normalized.includes("update available!")
    || normalized.includes("updating codex via")
    || normalized.includes("npm install -g @openai/codex")
    || normalized.includes("update ran successfully! please restart codex")
    || normalized.includes("please restart codex");
}

function hasProviderStorageBackfillEvidence(provider: TerminalResumeProvider, text: string): boolean {
  const visible = stripAnsi(text).replace(/\r/g, "\n");
  const normalized = visible.toLowerCase();
  if (!normalized.trim()) return false;
  if (provider === "codex") {
    if (isCodexCliUpdateTranscript(visible)) return false;
    return /OpenAI Codex/i.test(visible)
      || /\bmodel:\s*(?!loading\b)\S+/i.test(visible)
      || visible.includes("›");
  }
  if (provider === "claude") {
    return normalized.includes("claude code") || visible.includes("❯");
  }
  if (provider === "droid") {
    return /\bfactory droid\b/i.test(visible)
      || /\bdroid\s+(?:session|chat|workspace|permission|autonomy|mode|ready)\b/i.test(visible);
  }
  if (provider === "opencode") {
    if (
      normalized.includes("login required")
      || normalized.includes("authentication required")
      || normalized.includes("not authenticated")
      || normalized.includes("please log in")
      || normalized.includes("sign in")
      || normalized.includes("api key required")
      || normalized.includes("no api key")
      || normalized.includes("provider not configured")
      || normalized.includes("no provider configured")
      || normalized.includes("update available")
      || normalized.includes("update required")
    ) {
      return false;
    }
    return /^\s*opencode\s*$/im.test(visible)
      || normalized.includes("message opencode")
      || normalized.includes("what do you want")
      || normalized.includes("thought for")
      || normalized.includes("tokens");
  }
  return false;
}

function resumeProviderDisplayName(provider: TerminalResumeProvider): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  if (provider === "cursor") return "Cursor";
  if (provider === "droid") return "Droid";
  if (provider === "opencode") return "OpenCode";
  return "Agent";
}

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const TRANSCRIPT_ROLLOVER_TARGET_BYTES = MAX_TRANSCRIPT_BYTES / 2;
const TRANSCRIPT_ROLLOVER_STATE_VERSION = 1;
const RESUME_TARGET_MISSING_COOLDOWN_MS = 10 * 60_000;
const RESUME_SCAN_WINDOW_MS = 60_000;

type TranscriptRolloverState = {
  version: typeof TRANSCRIPT_ROLLOVER_STATE_VERSION;
  baseOffset: number;
  retainedBytes: number;
};

type TranscriptRolloverJournal = {
  version: typeof TRANSCRIPT_ROLLOVER_STATE_VERSION;
  previousBaseOffset: number;
  previousRetainedBytes: number;
  nextBaseOffset: number;
  nextRetainedBytes: number;
};

type ResolvedTranscriptRolloverState = TranscriptRolloverState & {
  recoveredJournal: boolean;
};

function transcriptRolloverStatePath(transcriptPath: string): string {
  return `${transcriptPath}.rollover.json`;
}

function transcriptRolloverJournalPath(transcriptPath: string): string {
  return `${transcriptPath}.rollover.pending.json`;
}

function transcriptRolloverBackupPath(transcriptPath: string): string {
  return `${transcriptPath}.rollover.previous`;
}

function transcriptRolloverTempPattern(transcriptPath: string): RegExp {
  const escapedName = path.basename(transcriptPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escapedName}(?:\\.rollover(?:\\.pending)?\\.json)?\\.\\d+\\.[^.]+\\.tmp$`,
  );
}

function removeTranscriptRolloverTempFilesSync(transcriptPath: string): void {
  const directory = path.dirname(transcriptPath);
  const pattern = transcriptRolloverTempPattern(transcriptPath);
  let names: string[] = [];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    try {
      fs.unlinkSync(path.join(directory, name));
    } catch {
      // Best-effort cleanup of a temp file left by an interrupted atomic write.
    }
  }
}

function isSafeTranscriptOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseTranscriptRolloverState(raw: unknown): TranscriptRolloverState | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<TranscriptRolloverState>;
  if (
    candidate.version !== TRANSCRIPT_ROLLOVER_STATE_VERSION
    || !isSafeTranscriptOffset(candidate.baseOffset)
    || !isSafeTranscriptOffset(candidate.retainedBytes)
  ) return null;
  return candidate as TranscriptRolloverState;
}

function parseTranscriptRolloverJournal(raw: unknown): TranscriptRolloverJournal | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<TranscriptRolloverJournal>;
  if (
    candidate.version !== TRANSCRIPT_ROLLOVER_STATE_VERSION
    || !isSafeTranscriptOffset(candidate.previousBaseOffset)
    || !isSafeTranscriptOffset(candidate.previousRetainedBytes)
    || !isSafeTranscriptOffset(candidate.nextBaseOffset)
    || !isSafeTranscriptOffset(candidate.nextRetainedBytes)
  ) return null;
  return candidate as TranscriptRolloverJournal;
}

function readJsonFileBestEffort(filePath: string): unknown {
  try {
    return JSON.parse(String(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Resolve the logical byte window represented by the retained file. Old
 * transcripts have no sidecar and therefore retain the legacy [0, size)
 * mapping. The small journal makes the file replacement + sidecar update
 * recoverable if the process exits between those two atomic renames.
 */
function loadTranscriptRolloverStateSync(
  transcriptPath: string,
  retainedBytes: number,
): ResolvedTranscriptRolloverState {
  const state = parseTranscriptRolloverState(
    readJsonFileBestEffort(transcriptRolloverStatePath(transcriptPath)),
  );
  const journal = parseTranscriptRolloverJournal(
    readJsonFileBestEffort(transcriptRolloverJournalPath(transcriptPath)),
  );

  if (journal) {
    if (state?.baseOffset === journal.nextBaseOffset) {
      return { ...state, retainedBytes, recoveredJournal: true };
    }
    // During replacement the previous file is atomically renamed aside before
    // the new retained tail takes its place. Presence of both files therefore
    // identifies the new generation even when old/new byte sizes are equal.
    if (fs.existsSync(transcriptRolloverBackupPath(transcriptPath)) && fs.existsSync(transcriptPath)) {
      return {
        version: TRANSCRIPT_ROLLOVER_STATE_VERSION,
        baseOffset: journal.nextBaseOffset,
        retainedBytes,
        recoveredJournal: true,
      };
    }
    return {
      version: TRANSCRIPT_ROLLOVER_STATE_VERSION,
      baseOffset: journal.previousBaseOffset,
      retainedBytes,
      recoveredJournal: true,
    };
  }

  return {
    version: TRANSCRIPT_ROLLOVER_STATE_VERSION,
    baseOffset: state?.baseOffset ?? 0,
    retainedBytes,
    recoveredJournal: false,
  };
}

async function writeFileDurableTemp(filePath: string, data: Buffer | string): Promise<string> {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tmpPath, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    return tmpPath;
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

async function writeFileAtomicAsync(filePath: string, data: Buffer | string): Promise<void> {
  const tmpPath = await writeFileDurableTemp(filePath, data);
  try {
    await fs.promises.rename(tmpPath, filePath);
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

async function restoreInterruptedTranscriptReplacement(transcriptPath: string): Promise<void> {
  const journal = parseTranscriptRolloverJournal(
    readJsonFileBestEffort(transcriptRolloverJournalPath(transcriptPath)),
  );
  if (!journal) return;
  const backupPath = transcriptRolloverBackupPath(transcriptPath);
  if (!fs.existsSync(backupPath) || fs.existsSync(transcriptPath)) return;
  await fs.promises.rename(backupPath, transcriptPath);
}

async function clearCompletedTranscriptRolloverTransaction(transcriptPath: string): Promise<void> {
  const backupPath = transcriptRolloverBackupPath(transcriptPath);
  try {
    await fs.promises.unlink(backupPath);
  } catch {
    // Keep the journal if a material backup still exists; the next process can
    // retry cleanup without mistaking the backup for an active transaction.
    if (fs.existsSync(backupPath)) return;
  }
  await fs.promises.unlink(transcriptRolloverJournalPath(transcriptPath)).catch(() => {});
}

async function readFileTailBuffer(filePath: string, maxBytes: number): Promise<{ tail: Buffer; size: number }> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, "r");
    const stat = await handle.stat();
    const size = Math.max(0, Number(stat.size) || 0);
    const start = Math.max(0, size - Math.max(0, maxBytes));
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return { tail: buffer.subarray(0, Math.max(0, bytesRead)), size };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function utf8SafeTail(buffer: Buffer, maxBytes: number): Buffer {
  let start = Math.max(0, buffer.length - Math.max(0, maxBytes));
  while (start < buffer.length && (buffer[start]! & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return buffer.subarray(start);
}

function utf8CompletePrefixLength(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lead = buffer.length - 1;
  while (lead >= 0 && (buffer[lead]! & 0b1100_0000) === 0b1000_0000) {
    lead -= 1;
  }
  if (lead < 0) return 0;
  const leadByte = buffer[lead]!;
  const expectedLength = (leadByte & 0b1000_0000) === 0
    ? 1
    : (leadByte & 0b1110_0000) === 0b1100_0000
      ? 2
      : (leadByte & 0b1111_0000) === 0b1110_0000
        ? 3
        : (leadByte & 0b1111_1000) === 0b1111_0000
          ? 4
          : 1;
  return lead + expectedLength <= buffer.length ? buffer.length : lead;
}

function decodeTranscriptPage(
  page: Buffer,
  startOffset: number,
  boundary: number,
): { data: string; startOffset: number; endOffset: number } {
  const completeEnd = utf8CompletePrefixLength(page);
  if (completeEnd <= boundary) {
    const emptyOffset = startOffset + completeEnd;
    return { data: "", startOffset: emptyOffset, endOffset: emptyOffset };
  }
  return {
    data: page.subarray(boundary, completeEnd).toString("utf8"),
    startOffset: startOffset + boundary,
    endOffset: startOffset + completeEnd,
  };
}

function isNoSpaceError(error: unknown): boolean {
  const code = typeof error === "object" && error != null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b(ENOSPC|EDQUOT|no space left on device|disk quota exceeded)\b/i.test(message);
}

function getPtyHostReadyPromise(pty: IPty): Promise<void> | null {
  const ready = (pty as HostReadyPty).__adePtyHostReady;
  if (ready && typeof ready.then === "function") {
    return ready;
  }
  return null;
}

function resumeTargetIdForProvider(
  session: TerminalSessionSummary,
  provider: TerminalResumeProvider,
): string | null {
  const metadataTargetId = session.resumeMetadata?.provider === provider
    ? sanitizeResumeTargetId(session.resumeMetadata.targetId ?? null)
    : null;
  if (metadataTargetId) return metadataTargetId;

  const parsedResumeCommand = parseTrackedCliResumeCommand(session.resumeCommand, session.toolType);
  return parsedResumeCommand?.provider === provider
    ? sanitizeResumeTargetId(parsedResumeCommand.targetId ?? null)
    : null;
}

export function createPtyService({
  projectRoot,
  transcriptsDir,
  laneService,
  sessionService,
  processRegistry,
  aiIntegrationService,
  projectConfigService,
  getLaneRuntimeEnv,
  getSessionLinearEnv,
  getAdeCliAgentEnv,
  logger,
  broadcastData,
  broadcastExit,
  onSessionEnded,
  onSessionRuntimeSignal,
  onSessionUserInput,
  diskPressureMonitor,
  loadPty,
  disposePtyBackend
}: {
  projectRoot: string;
  transcriptsDir: string;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
  processRegistry?: ProcessRegistryService | null;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService>;
  projectConfigService?: ReturnType<typeof createProjectConfigService>;
  getLaneRuntimeEnv?: (laneId: string) => Promise<Record<string, string>> | Record<string, string>;
  /**
   * Per-session Linear context env (`ADE_LINEAR_ISSUE_IDS`,
   * `ADE_LINEAR_CONTEXT_FILE`) for a CLI terminal agent, keyed by the session's
   * chat/session id. Lets a CLI agent read its attached Linear issues without
   * Linear creds, mirroring the SDK chat path's `buildAgentRuntimeEnv`.
   */
  getSessionLinearEnv?: (args: { sessionId: string; chatSessionId: string | null }) => Record<string, string> | null;
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
  onSessionUserInput?: (args: { laneId: string; sessionId: string }) => void;
  diskPressureMonitor?: DiskPressureMonitor | null;
  loadPty: () => typeof ptyNs;
  disposePtyBackend?: () => void;
}) {
  const ptys = new Map<string, PtyEntry>();
  const runtimeStates = new Map<string, RuntimeStateEntry>();
  const dataListeners = new Set<PtyDataListener>();
  const exitListeners = new Set<PtyExitListener>();
  const terminalChatSessions = new Map<string, string>();
  const activeTerminalByChatSession = new Map<string, string>();
  const activeAuxiliaryTerminalByChatSession = new Map<string, string>();
  const missingResumeTargetBackfillFailures = new Map<string, { toolType: TerminalToolType | null; checkedAtMs: number }>();
  const claudeTitleCaptureKeys = new Set<string>();
  const resumeRuntimeFlights = new Map<string, Promise<PtyCreateResult>>();
  const submitInputFlights = new Map<string, Promise<boolean>>();
  // Dedup concurrent reattachChatCli calls for the same chatSessionId so we
  // never spawn two PTYs racing to `claude --resume <same-id>`.
  const reattachChatCliFlights = new Map<string, Promise<ChatTerminalReattachResult>>();
  let ptyDataSummaryTimer: ReturnType<typeof setTimeout> | null = null;
  let ptyDataSummaryStartedAt = Date.now();
  let ptyDataChunkCount = 0;
  let ptyDataBatchCount = 0;
  let ptyDataCharCount = 0;
  let ptyDataMaxBatchChars = 0;
  const terminalSnapshotDir = path.join(projectRoot, ".ade", "cache", "terminal-snapshots");
  const ownerPid = processRegistry?.pid ?? null;
  const ownerProcessStartedAt = processRegistry?.startedAt ?? null;

  const getResourceAttribution = (): PtyResourceAttribution => {
    const liveEntries = Array.from(ptys.values()).filter((entry) => !entry.disposed);
    const roots: ResourceAttributionRoot[] = [];
    for (const entry of liveEntries) {
      const pid = entry.pty.pid;
      if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) continue;
      roots.push({ pid, kind: attributionRootKindForToolType(entry.toolTypeHint) });
    }
    return { activePtyCount: liveEntries.length, roots };
  };

  const isOwnedByLivePeerRuntime = (session: {
    ownerPid?: number | null;
    ownerProcessStartedAt?: string | null;
  }): boolean => {
    if (ownerPid == null) return false;
    if (session.ownerPid == null) return false;
    if (session.ownerPid === ownerPid) return false;
    const ownerStartedAt = typeof session.ownerProcessStartedAt === "string"
      ? session.ownerProcessStartedAt.trim()
      : "";
    if (ownerStartedAt) {
      return processRegistry?.isProcessIdentityLive(session.ownerPid, ownerStartedAt) === true;
    }
    return processRegistry?.isPidLive(session.ownerPid) === true;
  };

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
      return { terminal, serializeAddon, flushTimer: null, lastErrorAt: 0, writeDisabled: false };
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
    if (mirror.writeDisabled) return;
    const snapshot = buildTerminalSnapshot(entry);
    if (!snapshot) return;
    let tmpPath: string | null = null;
    try {
      fs.mkdirSync(terminalSnapshotDir, { recursive: true });
      const finalPath = safeTerminalSnapshotPathFor(entry.sessionId);
      tmpPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmpPath, `${JSON.stringify(snapshot)}\n`, "utf8");
      fs.renameSync(tmpPath, finalPath);
    } catch (err) {
      if (tmpPath) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // Best effort; snapshot persistence must never block live terminal output.
        }
      }
      const now = Date.now();
      if (now - mirror.lastErrorAt > 10_000) {
        mirror.lastErrorAt = now;
        logger.warn("pty.terminal_snapshot_write_failed", { sessionId: entry.sessionId, err: String(err) });
      }
      if (isNoSpaceError(err)) {
        mirror.writeDisabled = true;
      }
    }
  };

  const scheduleTerminalSnapshotWrite = (entry: PtyEntry, delayMs = TERMINAL_SNAPSHOT_DEBOUNCE_MS): void => {
    const mirror = entry.terminalSnapshot;
    if (!mirror || mirror.writeDisabled || !entry.tracked || entry.disposed) return;
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

  const resolveTitleReasoningEffort = (): string | null => {
    const si = getSessionIntelligence();
    const raw = si?.titles?.reasoningEffort;
    return typeof raw === "string" && raw.trim().length ? raw.trim() : null;
  };

  // Generate an early CLI session title from the first user input PLUS a slice
  // of the actual session output, so the name reflects what the session is doing
  // (e.g. "Inspect GitHub login screenshot") rather than echoing the opening
  // line ("Take a look at …"). Runs once, a few seconds after the first input so
  // some output exists, and never overwrites a user rename. The on-complete pass
  // refines it later.
  const runEarlyCliAiTitle = async (entry: PtyEntry, seed: string): Promise<void> => {
    if (entry.disposed) return;
    if (!aiIntegrationService || aiIntegrationService.getMode() === "guest") return;
    if (!isTitleGenerationEnabled()) return;
    const session = sessionService.get(entry.sessionId);
    if (!session) return;
    if (isSessionManuallyNamed(sessionService, entry.sessionId)) {
      logger.info("pty.cli_user_title_skipped_user_renamed", { sessionId: entry.sessionId });
      return;
    }
    const laneName = session.laneName?.trim() || "Current lane";
    const outputSlice = stripAnsi(entry.recentOutputTail).replace(/\r/g, "\n").trim().slice(-4000);
    const titleModelId = resolveTitleModelId();
    const titleReasoningEffort = resolveTitleReasoningEffort();
    const prompt = [
      "Write a concise title for this CLI coding session.",
      "Return only plain text, max 80 characters, no punctuation at the end.",
      "Base it on what the session is actually doing, not the literal opening words.",
      "",
      `Lane: ${laneName}`,
      `Session type: ${session.toolType ?? "terminal"}`,
      "Primary request (first submitted user input):",
      seed,
      ...(outputSlice ? ["", "Session output so far:", outputSlice] : []),
    ].join("\n");
    const capturedAi = aiIntegrationService;
    try {
      const result = await capturedAi.summarizeTerminal({
        cwd: entry.boundCwd || entry.laneWorktreePath,
        prompt,
        taskType: "session_title",
        timeoutMs: PTY_AI_TITLE_TIMEOUT_MS,
        ...(titleModelId ? { model: titleModelId } : {}),
        ...(titleReasoningEffort ? { reasoningEffort: titleReasoningEffort } : {}),
      });
      if (entry.disposed) return;
      const title = sanitizeGeneratedCliTitle(result.text);
      if (!title) return;
      if (isSessionManuallyNamed(sessionService, entry.sessionId)) {
        logger.info("pty.cli_user_title_skipped_user_renamed", { sessionId: entry.sessionId });
        return;
      }
      sessionService.updateMeta({ sessionId: entry.sessionId, title, manuallyNamed: false });
    } catch (err) {
      logger.warn("pty.cli_user_title_generation_failed", {
        sessionId: entry.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
      const seed = sanitizeTrackedCliPromptSeed(segment);
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
        const fallbackTitle = trackedCliTitleFromPromptSeed(seed);
        if (fallbackTitle) {
          sessionService.updateMeta({ sessionId: entry.sessionId, title: fallbackTitle, manuallyNamed: false });
        }
      }
      if (!aiIntegrationService || aiIntegrationService.getMode() === "guest") return;
      if (!isTitleGenerationEnabled()) return;

      // Defer the AI title briefly so it can read a slice of the session's actual
      // output (seed + transcript) rather than echoing the opening line. The
      // deterministic fallback set above shows in the meantime. Fires once; the
      // aiTitleTimer field is unused for interactive CLI tool types otherwise.
      entry.aiTitleTimer = setTimeout(() => {
        entry.aiTitleTimer = null;
        void runEarlyCliAiTitle(entry, seed);
      }, EARLY_CLI_AI_TITLE_DELAY_MS);
      if (entry.aiTitleTimer.unref) entry.aiTitleTimer.unref();
      return;
    }

    if (entry.cliUserTitleLineBuffer.length > 8000) {
      entry.cliUserTitleLineBuffer = entry.cliUserTitleLineBuffer.slice(-4000);
    }
  };

  const adoptCliRuntimeWindowTitle = (entry: PtyEntry, data: string): void => {
    if (!CLI_USER_TITLE_TOOL_TYPES.has(entry.toolTypeHint ?? "shell")) return;
    if (aiIntegrationService && aiIntegrationService.getMode() !== "guest" && isTitleGenerationEnabled()) return;
    const title = extractLatestOscWindowTitle(entry, data);
    if (!title) return;
    if (isSessionManuallyNamed(sessionService, entry.sessionId)) {
      logger.info("pty.cli_runtime_window_title_skipped_user_renamed", { sessionId: entry.sessionId });
      return;
    }
    const session = sessionService.get(entry.sessionId);
    if (!session || session.title?.trim() === title) return;
    sessionService.updateMeta({ sessionId: entry.sessionId, title, manuallyNamed: false });
    logger.info("pty.cli_runtime_window_title_adopted", {
      sessionId: entry.sessionId,
      toolType: entry.toolTypeHint,
      titleLength: title.length,
    });
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
            const summaryReasoningEffort = typeof si?.summaries?.reasoningEffort === "string" && si.summaries.reasoningEffort.trim().length
              ? si.summaries.reasoningEffort.trim()
              : undefined;

            const aiSummary = await aiIntegrationService!.summarizeTerminal({
              cwd: summaryCwd || laneService.getLaneBaseAndBranch(session.laneId).worktreePath,
              prompt,
              ...(summaryModelId ? { model: summaryModelId } : {}),
              ...(summaryReasoningEffort ? { reasoningEffort: summaryReasoningEffort } : {}),
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
              const titleReasoningEffort = resolveTitleReasoningEffort();
              const titleResult = await aiIntegrationService!.summarizeTerminal({
                cwd: summaryCwd || laneService.getLaneBaseAndBranch(session.laneId).worktreePath,
                prompt: titlePrompt,
                taskType: "session_title",
                timeoutMs: PTY_AI_TITLE_TIMEOUT_MS,
                ...(titleModelId ? { model: titleModelId } : {}),
                ...(titleReasoningEffort ? { reasoningEffort: titleReasoningEffort } : {}),
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
    entry: Pick<PtyEntry, "sessionId" | "toolTypeHint" | "transcriptStream" | "transcriptRolloverPromise" | "laneWorktreePath" | "boundCwd">,
    reason: "close" | "dispose" | "orphan-dispose",
  ): void => {
    void Promise.resolve(entry.transcriptRolloverPromise)
      .catch(() => {})
      .then(() => endTranscriptStream(entry.transcriptStream))
      .finally(() => {
        backfillResumeTargetFromTranscriptBestEffort(entry.sessionId, entry.toolTypeHint, reason, entry.boundCwd);
        summarizeSessionBestEffort(entry.sessionId, {
          laneWorktreePath: entry.laneWorktreePath,
          boundCwd: entry.boundCwd,
        });
      });
  };

  const disableTranscriptWrite = (entry: PtyEntry, err: unknown): void => {
    if (entry.transcriptWriteDisabled) return;
    entry.transcriptWriteDisabled = true;
    const stream = entry.transcriptStream;
    entry.transcriptStream = null;
    if (entry.transcriptPausedForRollover) {
      entry.transcriptPausedForRollover = false;
      try {
        entry.pty.resume();
      } catch {
        // Live output remains authoritative even when transcript persistence fails.
      }
    }
    const now = Date.now();
    if (now - entry.transcriptLastErrorAt > 10_000) {
      entry.transcriptLastErrorAt = now;
      logger.warn("pty.transcript_write_failed", {
        sessionId: entry.sessionId,
        code: typeof err === "object" && err != null && "code" in err
          ? String((err as { code?: unknown }).code ?? "")
          : null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      stream?.destroy?.();
    } catch {
      // Transcript persistence is best effort; live PTY output continues.
    }
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
   * When ADE has launch timing, only accept one timestamped JSONL inside this
   * PTY's lifetime; otherwise fall back to the most recently modified direct
   * session file for older rows.
   */
  const resolveClaudeSessionFromStorage = (args: ClaudeStorageSessionLookupArgs): ClaudeStorageSessionMatch | null => {
    try {
      const claudeProjectDir = claudeProjectDirForCwd(args.cwd);
      if (!fs.existsSync(claudeProjectDir)) return null;

      const requestedStartedAtMs = Date.parse(args.startedAt ?? "");
      const hasStartedAt = Number.isFinite(requestedStartedAtMs);
      const requestedEndedAtMs = Date.parse(args.endedAt ?? "");
      const hasEndedAt = Number.isFinite(requestedEndedAtMs);
      const maxStartDeltaMs = typeof args.maxStartDeltaMs === "number" ? args.maxStartDeltaMs : 10 * 60_000;
      const windowStartMs = requestedStartedAtMs - CLAUDE_STORAGE_MATCH_START_SKEW_MS;
      const windowEndMs = (hasEndedAt ? requestedEndedAtMs : requestedStartedAtMs + maxStartDeltaMs)
        + CLAUDE_STORAGE_MATCH_END_SKEW_MS;
      const entries = fs.readdirSync(claudeProjectDir, { withFileTypes: true }) as Array<string | fs.Dirent>;
      let newest: { name: string; mtimeMs: number } | null = null;
      const timestampMatches: Array<{ name: string; score: number; mtimeMs: number }> = [];
      for (const entry of entries) {
        const name = typeof entry === "string" ? entry : entry.name;
        const isFile = typeof entry === "string" ? true : entry.isFile();
        if (!isFile || !name.endsWith(".jsonl")) continue;
        const uuid = name.replace(/\.jsonl$/, "");
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) continue;

        const filePath = path.join(claudeProjectDir, name);
        const stat = fs.statSync(filePath);
        if (hasStartedAt) {
          const firstLine = readJsonlFirstLine(filePath);
          if (!firstLine) continue;
          let firstRecord: Record<string, unknown>;
          try {
            firstRecord = JSON.parse(firstLine) as Record<string, unknown>;
          } catch {
            continue;
          }
          const recordCwd = typeof firstRecord.cwd === "string" ? firstRecord.cwd.trim() : "";
          if (recordCwd && recordCwd !== args.cwd) continue;
          const timestamp = typeof firstRecord.timestamp === "string" ? firstRecord.timestamp : "";
          const timestampMs = Date.parse(timestamp);
          if (!Number.isFinite(timestampMs)) continue;
          if (timestampMs < windowStartMs || timestampMs > windowEndMs) continue;
          const score = Math.abs(timestampMs - requestedStartedAtMs);
          if (score > maxStartDeltaMs) continue;
          timestampMatches.push({ name, score, mtimeMs: stat.mtimeMs });
          continue;
        }

        if (!newest || stat.mtimeMs > newest.mtimeMs) {
          newest = { name, mtimeMs: stat.mtimeMs };
        }
      }
      if (hasStartedAt && timestampMatches.length !== 1) return null;
      const selected = hasStartedAt
        ? timestampMatches[0]!
        : newest;
      if (!selected) return null;
      // UUID is the filename without .jsonl extension
      const uuid = selected.name.replace(/\.jsonl$/, "");
      // Only consider if modified within the last 5 minutes (to avoid picking up stale sessions)
      if (!hasStartedAt && Date.now() - selected.mtimeMs > 5 * 60 * 1000) return null;
      const filePath = path.join(claudeProjectDir, selected.name);
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
   * `ownershipNeedle`, when the caller has one, additionally requires the rollout
   * to contain text this launch delivered — see `codexLaunchOwnershipNeedle`.
   */
  const resolveCodexSessionFromStorage = (args: {
    cwd: string;
    startedAt?: string | null;
    maxStartDeltaMs?: number;
    notBeforeMs?: number;
    excludedIds?: ReadonlySet<string>;
    ownershipNeedle?: string | null;
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
        if (args.excludedIds?.has(id)) continue;
        if (args.ownershipNeedle) {
          const prefix = readFilePrefix(candidate.filePath, CODEX_OWNERSHIP_NEEDLE_SCAN_BYTES);
          if (!prefix || !rolloutTextContainsOwnershipNeedle(prefix, args.ownershipNeedle)) continue;
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
      const executable = resolveOpenCodeBinaryPath() ?? "opencode";
      const result = spawnSync(executable, ["session", "list", "--format", "json", "--max-count", "80"], {
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

  /**
   * The directory a session's agent actually ran in. Transcripts live under the
   * project root even for lane sessions, so the transcript path is only a
   * fallback: every storage backfill below matches on an exact cwd, and a lane
   * session's rollout records the lane worktree, not the project root.
   */
  const resolveSessionRunCwd = (session: TerminalSessionSummary): string | null => {
    let worktreePath = "";
    try {
      worktreePath = (laneService.getLaneBaseAndBranch(session.laneId).worktreePath ?? "").trim();
    } catch {
      // Deleted lane: fall back to the transcript-derived directory.
    }
    if (worktreePath) return worktreePath;
    return inferSessionCwdFromTranscriptPath(session.transcriptPath);
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
    if (!isTrackedAgentCliToolType(effectiveToolType)) return false;
    const existingTargetId = sanitizeResumeTargetId(session.resumeMetadata?.targetId ?? null);
    if (existingTargetId) {
      const cwd = sessionCwd ?? resolveSessionRunCwd(session);
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
    if (isCodexTrackedCliToolType(effectiveToolType) && isCodexCliUpdateTranscript(transcript)) {
      missingResumeTargetBackfillFailures.set(sessionId, {
        toolType: effectiveToolType,
        checkedAtMs: Date.now(),
      });
      logger.warn("pty.resume_target_backfill_skipped_codex_update", {
        sessionId,
        toolType: effectiveToolType,
        reason,
      });
      return false;
    }
    const detected = extractResumeCommandFromOutput(transcript, effectiveToolType);
    if (detected) {
      missingResumeTargetBackfillFailures.delete(sessionId);
      sessionService.setResumeCommand(sessionId, detected);
      logger.info("pty.resume_target_backfilled", { sessionId, toolType: effectiveToolType, reason, source: "transcript" });
      return true;
    }

    // Strategy 2: Read the session/thread ID from the CLI's local storage
    const cwd = sessionCwd ?? resolveSessionRunCwd(session);
    const effectiveProvider = providerFromTool(effectiveToolType);
    const hasStorageBackfillEvidence = effectiveProvider
      ? hasProviderStorageBackfillEvidence(effectiveProvider, transcript)
      : false;

    if (isClaudeTrackedCliToolType(effectiveToolType) && cwd && hasStorageBackfillEvidence) {
      const claudeSession = resolveClaudeSessionFromStorage({
        cwd,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        maxStartDeltaMs: 10 * 60_000,
      });
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
    if ((effectiveToolType === "codex" || effectiveToolType === "codex-orchestrated") && cwd && hasStorageBackfillEvidence) {
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

    if (effectiveToolType === "droid" && cwd && reason !== "resume-launch" && hasStorageBackfillEvidence) {
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

    if ((effectiveToolType === "opencode" || effectiveToolType === "opencode-orchestrated") && cwd && reason !== "resume-launch" && hasStorageBackfillEvidence) {
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

  const listOtherAdoptedCodexTargetIds = (sessionId: string): Set<string> => {
    const adoptedIds = new Set<string>();
    for (const candidate of sessionService.list({ limit: null })) {
      if (candidate.id === sessionId) continue;
      const targetId = resumeTargetIdForProvider(candidate, "codex");
      if (targetId) adoptedIds.add(targetId);
    }
    return adoptedIds;
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
    ownershipNeedle: string | null = null,
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
      let excludedIds: Set<string>;
      try {
        excludedIds = listOtherAdoptedCodexTargetIds(sessionId);
      } catch (err) {
        // Capturing no target is safer than assigning a thread when the
        // cross-session ownership check could not run.
        logger.warn("pty.codex_session_id_exclusion_query_failed", {
          sessionId,
          source,
          attempt,
          err: String(err),
        });
        return false;
      }
      // There is deliberately no FIXED text gate here. ADE used to require the
      // "ADE session guidance" preamble marker in the rollout, but only the
      // Work-tab CLI preamble ever emits it — goal launches send
      // `<codex_internal_context source="goal">` instead — so the gate was
      // closed for nearly every real session and thread ids were essentially
      // never captured live.
      //
      // Mis-adoption safety for concurrent Codex runs in the SAME worktree has
      // three layers:
      //  1. the per-launch ownership needle, when this launch delivered text of
      //     its own: only a rollout containing that text can be adopted, which
      //     is what actually rules out an unrelated Codex process that merely
      //     shares the cwd and the window;
      //  2. a narrow launch window (including the existing not-before floor);
      //  3. exclusion of thread ids already owned by every other terminal row —
      //     an adopted id stays excluded even when the needle matches.
      // Timestamp proximity still breaks ties among the remaining candidates,
      // but does not claim that rollout write order uniquely proves which PTY
      // launched a thread. A bare interactive `codex` with nothing typed has no
      // ownership signal to demand, so it falls back to layers 2 and 3 alone
      // and keeps that residual window.
      const codexSession = resolveCodexSessionFromStorage({
        cwd,
        startedAt,
        maxStartDeltaMs: CODEX_LIVE_CAPTURE_MAX_START_DELTA_MS,
        ...(startedAtFinite !== null ? { notBeforeMs: startedAtFinite - 1_000 } : {}),
        excludedIds,
        ownershipNeedle,
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
        ownership: ownershipNeedle ? "launch-text" : "window",
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

  const flushPendingPtyOutput = (entry: PtyEntry): void => {
    const trailing = takeCanonicalPtyOutput(entry, "", true);
    if (trailing) entry.processOutputData?.(trailing);
  };

  const closeEntry = (ptyId: string, exitCode: number | null) => {
    const entry = ptys.get(ptyId);
    if (!entry) return;
    if (entry.disposed) return;
    flushPendingPtyOutput(entry);
    entry.processOutputData = null;
    entry.disposed = true;
    entry.attentionRequested = false;
    sessionService.clearAttentionRequest(entry.sessionId);
    if (!entry.chatSessionId && isTrackedAgentCliToolType(entry.toolTypeHint)) {
      revokeBuiltInBrowserActorCapability(entry.sessionId);
    }
    if (entry.aiTitleTimer) {
      clearTimeout(entry.aiTitleTimer);
      entry.aiTitleTimer = null;
    }
    if (entry.startupTimer) {
      clearTimeout(entry.startupTimer);
      entry.startupTimer = null;
    }
    if (entry.initialInputTimer) {
      clearTimeout(entry.initialInputTimer);
      entry.initialInputTimer = null;
    }
    cleanupEntryPaths(entry);
    flushPreview(entry);
    // Release the live-tail buffer (up to LIVE_TRANSCRIPT_TAIL_BUFFER_CHARS
    // per session). Disposed entries linger in the `ptys` map for replacement
    // lookups; without this, every ended terminal would keep its 2 MB tail
    // pinned indefinitely.
    entry.recentOutputTail = "";

    const endedAt = new Date().toISOString();
    let status = statusFromExit(exitCode);
    let endExitCode = exitCode;
    let endEndedAt = endedAt;
    // A resume that dies on launch must not clobber the row it took over: the
    // prior session is still resumable, and stamping it failed/exit-2 makes it
    // look permanently dead. Only an *immediate* nonzero exit counts as a
    // launch failure (a bad flag, a missing binary, a shell usage error) —
    // once the CLI has actually been running, a real nonzero exit is its own.
    const priorEndState = entry.priorEndState;
    if (
      priorEndState
      && status === "failed"
      && Date.now() - entry.createdAt <= RESUME_LAUNCH_FAILURE_WINDOW_MS
    ) {
      logger.warn("pty.resume_launch_failed_status_preserved", {
        sessionId: entry.sessionId,
        ptyId,
        exitCode,
        priorStatus: priorEndState.status,
      });
      status = priorEndState.status;
      endExitCode = priorEndState.exitCode;
      endEndedAt = priorEndState.endedAt ?? endedAt;
    }
    sessionService.end({ sessionId: entry.sessionId, endedAt: endEndedAt, exitCode: endExitCode, status });
    flushTerminalSnapshot(entry);
    scheduleTranscriptDependentWork(entry, "close");
    clearIdleTimer(entry.sessionId);
    const finalRuntimeState = runtimeFromStatus(status);
    setRuntimeState(entry.sessionId, finalRuntimeState, { touch: false });
    runtimeStates.delete(entry.sessionId);
    if (
      entry.chatSessionId
      && isChatCliRoutingEntry(entry)
      && activeTerminalByChatSession.get(entry.chatSessionId) === entry.sessionId
    ) {
      const replacement = liveChatCliEntriesFor(entry.chatSessionId)[0] ?? null;
      if (replacement) {
        activeTerminalByChatSession.set(entry.chatSessionId, replacement.sessionId);
      } else {
        activeTerminalByChatSession.delete(entry.chatSessionId);
      }
    }
    if (
      entry.chatSessionId
      && isAuxiliaryRoutingEntry(entry)
      && activeAuxiliaryTerminalByChatSession.get(entry.chatSessionId) === entry.sessionId
    ) {
      const replacement = liveAuxiliaryEntriesFor(entry.chatSessionId)[0] ?? null;
      if (replacement) {
        activeAuxiliaryTerminalByChatSession.set(entry.chatSessionId, replacement.sessionId);
      } else {
        activeAuxiliaryTerminalByChatSession.delete(entry.chatSessionId);
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

  const attachTranscriptStreamErrorHandler = (entry: PtyEntry, stream: fs.WriteStream): void => {
    stream.on("error", (err) => disableTranscriptWrite(entry, err));
  };

  const queueTranscriptRolloverChunk = (entry: PtyEntry, chunk: Buffer): void => {
    entry.transcriptRolloverPendingChunks.push(chunk);
    entry.transcriptRolloverPendingBytes += chunk.length;
    if (entry.transcriptRolloverPendingBytes <= MAX_TRANSCRIPT_BYTES) return;

    // pause() provides the normal backpressure path. Keep a bounded tail as a
    // defensive fallback for a backend that cannot pause or has already
    // queued callbacks; older pending bytes cannot be part of the retained
    // contiguous window once they are dropped, so the rollover also drops the
    // preceding file tail.
    const tail = utf8SafeTail(
      Buffer.concat(entry.transcriptRolloverPendingChunks, entry.transcriptRolloverPendingBytes),
      MAX_TRANSCRIPT_BYTES,
    );
    entry.transcriptRolloverPendingChunks = [tail];
    entry.transcriptRolloverPendingBytes = tail.length;
    entry.transcriptRolloverPendingTrimmed = true;
  };

  const openTranscriptAppendStream = (entry: PtyEntry): fs.WriteStream => {
    const stream = fs.createWriteStream(entry.transcriptPath, { flags: "a" });
    attachTranscriptStreamErrorHandler(entry, stream);
    return stream;
  };

  const rollTranscript = async (entry: PtyEntry): Promise<void> => {
    try {
      // Output is normally paused, but loop if a backend delivered already-
      // queued chunks while the async file replacement was in flight.
      while (!entry.transcriptWriteDisabled) {
        const previousStream = entry.transcriptStream;
        entry.transcriptStream = null;
        await endTranscriptStream(previousStream);
        if (entry.transcriptWriteDisabled) return;

        const pendingChunks = entry.transcriptRolloverPendingChunks;
        const pendingBytes = entry.transcriptRolloverPendingBytes;
        const pendingTrimmed = entry.transcriptRolloverPendingTrimmed;
        const rolloverEndOffset = entry.transcriptBytesWritten;
        entry.transcriptRolloverPendingChunks = [];
        entry.transcriptRolloverPendingBytes = 0;
        entry.transcriptRolloverPendingTrimmed = false;

        const pending = pendingChunks.length === 1
          ? pendingChunks[0]!
          : Buffer.concat(pendingChunks, pendingBytes);
        const oldTailBudget = pendingTrimmed
          ? 0
          : Math.max(0, Math.min(
              TRANSCRIPT_ROLLOVER_TARGET_BYTES,
              MAX_TRANSCRIPT_BYTES - pending.length,
            ));
        const previous = await readFileTailBuffer(entry.transcriptPath, oldTailBudget);
        const oldTail = utf8SafeTail(previous.tail, oldTailBudget);
        const retained = oldTail.length > 0
          ? Buffer.concat([oldTail, pending], oldTail.length + pending.length)
          : pending;
        const nextBaseOffset = Math.max(0, rolloverEndOffset - retained.length);
        const state: TranscriptRolloverState = {
          version: TRANSCRIPT_ROLLOVER_STATE_VERSION,
          baseOffset: nextBaseOffset,
          retainedBytes: retained.length,
        };
        const journal: TranscriptRolloverJournal = {
          version: TRANSCRIPT_ROLLOVER_STATE_VERSION,
          previousBaseOffset: entry.transcriptBaseOffset,
          previousRetainedBytes: previous.size,
          nextBaseOffset,
          nextRetainedBytes: retained.length,
        };

        await writeFileAtomicAsync(
          transcriptRolloverJournalPath(entry.transcriptPath),
          `${JSON.stringify(journal)}\n`,
        );
        const retainedTmpPath = await writeFileDurableTemp(entry.transcriptPath, retained);
        const backupPath = transcriptRolloverBackupPath(entry.transcriptPath);
        await fs.promises.unlink(backupPath).catch(() => {});
        await fs.promises.rename(entry.transcriptPath, backupPath);
        try {
          await fs.promises.rename(retainedTmpPath, entry.transcriptPath);
        } catch (error) {
          await fs.promises.rename(backupPath, entry.transcriptPath).catch(() => {});
          await fs.promises.unlink(retainedTmpPath).catch(() => {});
          throw error;
        }
        entry.transcriptBaseOffset = nextBaseOffset;
        entry.transcriptRetainedBytes = retained.length;
        await writeFileAtomicAsync(
          transcriptRolloverStatePath(entry.transcriptPath),
          `${JSON.stringify(state)}\n`,
        );
        await clearCompletedTranscriptRolloverTransaction(entry.transcriptPath);
        if (entry.disposed) return;

        // If output arrived despite pause(), either append it while the file
        // still fits or run another bounded rollover without resuming first.
        if (
          entry.transcriptRolloverPendingTrimmed
          || entry.transcriptRetainedBytes + entry.transcriptRolloverPendingBytes > MAX_TRANSCRIPT_BYTES
        ) {
          continue;
        }

        const stream = openTranscriptAppendStream(entry);
        entry.transcriptStream = stream;
        for (const chunk of entry.transcriptRolloverPendingChunks) {
          stream.write(chunk);
          entry.transcriptRetainedBytes += chunk.length;
        }
        entry.transcriptRolloverPendingChunks = [];
        entry.transcriptRolloverPendingBytes = 0;
        entry.transcriptRolloverPendingTrimmed = false;
        entry.transcriptRolloverInProgress = false;
        if (entry.transcriptPausedForRollover) {
          entry.transcriptPausedForRollover = false;
          try {
            entry.pty.resume();
          } catch (err) {
            logger.warn("pty.transcript_rollover_resume_failed", {
              sessionId: entry.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return;
      }
    } catch (err) {
      disableTranscriptWrite(entry, err);
    } finally {
      entry.transcriptRolloverInProgress = false;
      entry.transcriptRolloverPromise = null;
    }
  };

  const beginTranscriptRollover = (entry: PtyEntry, firstChunk: Buffer): void => {
    entry.transcriptRolloverInProgress = true;
    queueTranscriptRolloverChunk(entry, firstChunk);
    // Publish the promise before pause(): a backend is allowed to surface an
    // exit synchronously from pause, and close/dispose must still await the
    // queued transcript replacement before transcript-dependent work starts.
    entry.transcriptRolloverPromise = Promise.resolve().then(() => rollTranscript(entry));
    try {
      entry.pty.pause();
      entry.transcriptPausedForRollover = true;
    } catch {
      // The bounded pending tail above is the fallback when pause is absent.
    }
  };

  const writeTranscript = (entry: PtyEntry, data: string) => {
    if (!entry.tracked || entry.transcriptWriteDisabled) return;
    try {
      const chunk = Buffer.from(data, "utf8");
      entry.transcriptBytesWritten += chunk.length;
      if (entry.transcriptRolloverInProgress) {
        queueTranscriptRolloverChunk(entry, chunk);
        return;
      }
      const stream = entry.transcriptStream;
      if (!stream || stream.destroyed) {
        disableTranscriptWrite(entry, new Error("Transcript stream is closed"));
        return;
      }
      if (entry.transcriptRetainedBytes + chunk.length > MAX_TRANSCRIPT_BYTES) {
        beginTranscriptRollover(entry, chunk);
        return;
      }
      stream.write(chunk);
      entry.transcriptRetainedBytes += chunk.length;
    } catch (err) {
      disableTranscriptWrite(entry, err);
    }
  };

  const appendRecentOutput = (entry: PtyEntry, data: string) => {
    if (!data) return;
    entry.recentOutputTail = tailString(`${entry.recentOutputTail}${data}`, LIVE_TRANSCRIPT_TAIL_BUFFER_CHARS);
  };

  const outputClearsSettledState = (entry: PtyEntry): boolean =>
    !(entry.tracked && isTrackedAgentCliToolType(entry.toolTypeHint));

  const flushPreview = (entry: PtyEntry) => {
    const candidate = (entry.latestPreviewLine ?? "").trim();
    if (!candidate) return;
    if (candidate === entry.lastPreviewWritten) return;
    entry.lastPreviewWritten = candidate;
    sessionService.setLastOutputPreview(entry.sessionId, candidate, {
      clearSettled: outputClearsSettledState(entry),
    });
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
    // Refresh the activity timestamp on every throttled output tick — even when
    // the derived preview line is blank or unchanged — so a tracked session
    // emitting steady but non-preview-changing output (spinners, repeated
    // status lines) is not wrongly flagged idle by the stale-session detector.
    if (entry.tracked) {
      sessionService.touchSessionActivity(
        entry.sessionId,
        new Date(now).toISOString(),
        { clearSettled: outputClearsSettledState(entry) },
      );
    }
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

  const resyncLiveSessionRowIfNeeded = (entry: PtyEntry, ptyId: string): void => {
    if (!entry.tracked || entry.disposed) return;
    const now = Date.now();
    if (now - entry.lastSessionResyncCheckAt < PTY_LIVE_SESSION_RESYNC_INTERVAL_MS) return;
    entry.lastSessionResyncCheckAt = now;

    const session = sessionService.get(entry.sessionId);
    if (!session) return;
    if (session.status === "running" && session.ptyId === ptyId) return;
    const previousStatus = session.status;
    const previousPtyId = session.ptyId ?? null;
    const previousEndedAt = session.endedAt ?? null;
    const toolType = session.toolType ?? entry.toolTypeHint ?? null;
    if (
      ownerPid != null
      && session.ownerPid != null
      && session.ownerPid !== ownerPid
      && processRegistry?.isProcessIdentityLive(session.ownerPid, session.ownerProcessStartedAt)
    ) {
      logger.warn("pty.live_session_row_resync_skipped_owned_by_peer", {
        ptyId,
        sessionId: entry.sessionId,
        ownerPid: session.ownerPid,
        currentPid: ownerPid,
        previousStatus,
      });
      return;
    }

    sessionService.reattach({
      sessionId: entry.sessionId,
      ptyId,
      startedAt: session.startedAt,
      ...(ownerPid != null ? { ownerPid } : {}),
      ...(ownerProcessStartedAt != null ? { ownerProcessStartedAt } : {}),
    });
    setRuntimeState(entry.sessionId, "running");
    logger.warn("pty.live_session_row_resynced", {
      ptyId,
      sessionId: entry.sessionId,
      previousStatus,
      previousPtyId,
      previousEndedAt,
      toolType,
    });
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
    // writeTranscript advances the logical UTF-8 byte counter synchronously in
    // the same onData tick. Rollover may move the retained file's byte zero,
    // but the live end offset therefore remains monotonic for dedupe/recovery.
    const offset = entry.tracked
      && !entry.transcriptWriteDisabled
      ? entry.transcriptBytesWritten
      : null;
    emitPtyDataNow(entry, { ...ids, data, offset });
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
    const interactive = Date.now() - entry.lastUserInputAt < PTY_DATA_INTERACTIVE_WINDOW_MS;
    entry.pendingDataTimer = setTimeout(() => {
      flushQueuedPtyData(entry, ids);
    }, interactive ? PTY_DATA_INTERACTIVE_BATCH_INTERVAL_MS : PTY_DATA_BATCH_INTERVAL_MS);
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

  const isChatCliRoutingEntry = (entry: PtyEntry): boolean =>
    isPersistedChatToolType(entry.toolTypeHint);

  const isAuxiliaryRoutingEntry = (entry: PtyEntry): boolean =>
    !isChatCliRoutingEntry(entry);

  const liveChatCliEntriesFor = (chatSessionId: string): PtyEntry[] =>
    Array.from(ptys.values())
      .filter((entry) => (
        entry.chatSessionId === chatSessionId
        && !entry.disposed
        && isChatCliRoutingEntry(entry)
      ))
      .sort((a, b) => b.createdAt - a.createdAt);

  const liveAuxiliaryEntriesFor = (chatSessionId: string): PtyEntry[] =>
    Array.from(ptys.values())
      .filter((entry) => (
        entry.chatSessionId === chatSessionId
        && !entry.disposed
        && isAuxiliaryRoutingEntry(entry)
      ))
      .sort((a, b) => b.createdAt - a.createdAt);

  const activeEntryFromMap = (
    map: Map<string, string>,
    chatSessionId: string,
    predicate: (entry: PtyEntry) => boolean,
  ): PtyEntry | null => {
    const sessionId = map.get(chatSessionId) ?? null;
    if (!sessionId) return null;
    const live = liveEntryBySessionId(sessionId);
    if (live && live[1].chatSessionId === chatSessionId && predicate(live[1])) return live[1];
    map.delete(chatSessionId);
    return null;
  };

  const activeChatCliEntryFor = (chatSessionId: string): PtyEntry | null => {
    const active = activeEntryFromMap(activeTerminalByChatSession, chatSessionId, isChatCliRoutingEntry);
    if (active) return active;
    const replacement = liveChatCliEntriesFor(chatSessionId)[0] ?? null;
    if (replacement) activeTerminalByChatSession.set(chatSessionId, replacement.sessionId);
    return replacement;
  };

  const activeAuxiliaryEntryFor = (chatSessionId: string): PtyEntry | null => {
    const active = activeEntryFromMap(activeAuxiliaryTerminalByChatSession, chatSessionId, isAuxiliaryRoutingEntry);
    if (active) return active;
    const replacement = liveAuxiliaryEntriesFor(chatSessionId)[0] ?? null;
    if (replacement) activeAuxiliaryTerminalByChatSession.set(chatSessionId, replacement.sessionId);
    return replacement;
  };

  const promoteActiveChatCliTerminal = (
    chatSessionId: string,
    sessionId: string,
    toolType: TerminalToolType | null,
  ): void => {
    if (!isPersistedChatToolType(toolType)) return;
    activeTerminalByChatSession.set(chatSessionId, sessionId);
  };

  const promoteActiveAuxiliaryTerminal = (
    chatSessionId: string,
    sessionId: string,
    toolType: TerminalToolType | null,
  ): void => {
    if (isPersistedChatToolType(toolType)) return;
    activeAuxiliaryTerminalByChatSession.set(chatSessionId, sessionId);
  };

  const promoteActiveChatTerminal = (
    chatSessionId: string,
    sessionId: string,
    toolType: TerminalToolType | null,
  ): void => {
    if (isPersistedChatToolType(toolType)) {
      promoteActiveChatCliTerminal(chatSessionId, sessionId, toolType);
    } else {
      promoteActiveAuxiliaryTerminal(chatSessionId, sessionId, toolType);
    }
  };

  const codexReadyRegion = (text: string): string => {
    const lastPrompt = text.lastIndexOf("›");
    if (lastPrompt < 0) return text;
    const lastHeader = text.lastIndexOf("OpenAI Codex", lastPrompt);
    const lastModel = text.lastIndexOf("model:", lastPrompt);
    const start = Math.max(0, lastHeader >= 0 ? lastHeader : lastModel >= 0 ? lastModel : lastPrompt - 4000);
    return text.slice(start);
  };

  const lastIndexOfAny = (text: string, needles: readonly string[]): number => {
    return needles.reduce((latest, needle) => Math.max(latest, text.lastIndexOf(needle)), -1);
  };

  const providerReadyMarkerVisible = (provider: TerminalResumeProvider, text: string): boolean => {
    const normalized = text.toLowerCase();
    if (provider === "codex") {
      const codexText = codexReadyRegion(text);
      if (isCodexCliUpdateTranscript(codexText)) return false;
      const hasPrompt = codexText.includes("›");
      const hasSessionMarker =
        /OpenAI Codex/i.test(codexText)
        || /\bmodel:\s*\S+/i.test(codexText)
        || /\/model\s+to\s+change/i.test(codexText)
        || /\bgpt-[\w.-]+/i.test(codexText);
      const loadingIndex = codexText.search(/\bmodel:\s*loading\b/i);
      const loadedModelMatches = Array.from(codexText.matchAll(/\bmodel:\s*(?!loading\b)\S+/gi));
      const lastLoadedModelIndex = loadedModelMatches.at(-1)?.index ?? -1;
      const startingIndex = codexText.lastIndexOf("Starting MCP servers");
      const startupSettledIndex = Math.max(
        codexText.lastIndexOf("MCP startup incomplete"),
        codexText.lastIndexOf("MCP client for `"),
      );
      const noActiveThreadIndex = codexText.lastIndexOf("No active thread is available");
      const lastPromptIndex = codexText.lastIndexOf("›");
      return hasPrompt
        && hasSessionMarker
        && (loadingIndex < 0 || lastLoadedModelIndex > loadingIndex)
        && (startingIndex < 0 || startupSettledIndex > startingIndex)
        && (noActiveThreadIndex < 0 || lastPromptIndex > noActiveThreadIndex);
    }
    if (provider === "claude") {
      return text.includes("❯");
    }
    if (provider === "cursor") {
      const lastBlockerIndex = lastIndexOfAny(normalized, [
        "workspace trust required",
        "do you trust the content of this directory",
        "login required",
        "authentication required",
        "not authenticated",
        "please log in",
        "sign in",
        "update available",
        "update required",
      ]);
      const lastReadyPromptIndex = Math.max(
        normalized.lastIndexOf("plan, search, build anything"),
        normalized.lastIndexOf("use /skills"),
        normalized.lastIndexOf("add a follow-up"),
      );
      return lastReadyPromptIndex >= 0 && lastReadyPromptIndex > lastBlockerIndex;
    }
    if (provider === "opencode") {
      const lastBlockerIndex = lastIndexOfAny(normalized, [
        "login required",
        "authentication required",
        "not authenticated",
        "please log in",
        "sign in",
        "api key required",
        "no api key",
        "provider not configured",
        "no provider configured",
        "update available",
        "update required",
      ]);
      const lastReadyIndex = lastIndexOfAny(normalized, [
        "opencode",
        "what do you want",
        "message opencode",
        "thought for",
        "tokens",
      ]);
      return lastReadyIndex >= 0 && lastReadyIndex > lastBlockerIndex;
    }
    if (provider === "droid") {
      const lastBlockerIndex = lastIndexOfAny(normalized, [
        "login required",
        "authentication required",
        "not authenticated",
        "please log in",
        "sign in",
        "api key required",
        "no api key",
        "factory api key",
        "update available",
        "update required",
      ]);
      const lastReadyIndex = lastIndexOfAny(normalized, [
        "what do you want",
        "what would you like",
        "message droid",
      ]);
      return lastReadyIndex >= 0 && lastReadyIndex > lastBlockerIndex;
    }
    return false;
  };

  const waitForAgentCliInputReady = async (
    sessionId: string,
    provider: TerminalResumeProvider,
    timeoutMs = AGENT_CLI_READY_TIMEOUT_MS,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    let stableReadyText = "";
    let stableReadySince = 0;
    while (Date.now() < deadline) {
      const readiness = agentCliInputReadiness(sessionId, provider);
      if (!readiness) return false;
      if (readiness.readyNow) return true;
      if (provider === "codex" && readiness.markerVisible) {
        if (readiness.text === stableReadyText) {
          if (stableReadySince > 0 && Date.now() - stableReadySince >= AGENT_CLI_READY_QUIET_MS) {
            return true;
          }
        } else {
          stableReadyText = readiness.text;
          stableReadySince = Date.now();
        }
      } else {
        stableReadyText = "";
        stableReadySince = 0;
      }
      await delay(AGENT_CLI_READY_POLL_MS);
    }
    logger.warn("pty.agent_cli_ready_wait_timeout", { sessionId, provider, timeoutMs });
    return false;
  };

  const agentCliInputReadiness = (
    sessionId: string,
    provider: TerminalResumeProvider,
  ): { markerVisible: boolean; readyNow: boolean; text: string } | null => {
    const live = liveEntryBySessionId(sessionId);
    if (!live || live[1].disposed) return null;
    const entry = live[1];
    const outputTail = stripAnsi(entry.recentOutputTail).replace(/\r/g, "\n");
    const visibleText = entry.terminalSnapshot
      ? visibleRowsFromTerminal(entry.terminalSnapshot.terminal)
        .map((row) => row.text)
        .join("\n")
      : "";
    const readinessText = visibleText.trim().length > 0 ? visibleText : outputTail;
    const runtime = runtimeStates.get(sessionId);
    const quietForMs = runtime ? Date.now() - runtime.lastActivityAt : 0;
    const markerVisible = providerReadyMarkerVisible(provider, readinessText);
    return {
      markerVisible,
      readyNow: markerVisible && quietForMs >= AGENT_CLI_READY_QUIET_MS,
      text: readinessText,
    };
  };

  const agentCliInputReadyNow = (
    sessionId: string,
    provider: TerminalResumeProvider,
  ): boolean => {
    return agentCliInputReadiness(sessionId, provider)?.readyNow ?? false;
  };

  const writeAgentCliInput = async (
    write: (data: string) => boolean,
    inputText: string,
    provider: TerminalResumeProvider,
  ): Promise<boolean> => {
    // Codex binds Ctrl-U to "kill to beginning of line"; move to end first so
    // saved single-line drafts are cleared even when the cursor starts at col 0.
    // Send these as separate PTY writes. Some full-screen TUIs process batched
    // control bytes before their prompt state settles, leaving restored drafts
    // in the composer underneath ADE's pasted prompt.
    if (!write(AGENT_CLI_INPUT_CLEAR_TO_END_KEY)) return false;
    await delay(AGENT_CLI_INPUT_CLEAR_DELAY_MS);
    if (!write(AGENT_CLI_INPUT_CLEAR_TO_START_KEY)) return false;
    await delay(AGENT_CLI_INPUT_CLEAR_DELAY_MS);
    if (provider === "codex") {
      return write(`${AGENT_CLI_BRACKETED_PASTE_START}${inputText}${AGENT_CLI_BRACKETED_PASTE_END}`);
    }
    for (let index = 0; index < inputText.length; index += AGENT_CLI_INPUT_CHUNK_SIZE) {
      if (!write(inputText.slice(index, index + AGENT_CLI_INPUT_CHUNK_SIZE))) return false;
      if (index + AGENT_CLI_INPUT_CHUNK_SIZE < inputText.length) {
        await delay(AGENT_CLI_INPUT_CHUNK_DELAY_MS);
      }
    }
    return true;
  };

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
    const fallbackStatus = live ? "running" : summary.status;
    let active = false;
    if (chatSessionId) {
      if (isPersistedChatToolType(summary.toolType)) {
        active = activeChatCliEntryFor(chatSessionId)?.sessionId === summary.id;
      } else {
        active = activeAuxiliaryEntryFor(chatSessionId)?.sessionId === summary.id;
      }
    }
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
      active,
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
    ptyId?: string | null;
    chatSessionId?: string | null;
  }): string | null => {
    const terminalId = cleanOptionalId(args.terminalId);
    if (terminalId) {
      if (!sessionService.get(terminalId)) {
        const liveByPtyId = ptys.get(terminalId);
        if (liveByPtyId && !liveByPtyId.disposed) return liveByPtyId.sessionId;
      }
      return terminalId;
    }
    const ptyId = cleanOptionalId(args.ptyId);
    if (ptyId) return ptys.get(ptyId)?.sessionId ?? null;
    const chatSessionId = cleanOptionalId(args.chatSessionId);
    if (!chatSessionId) return null;
    // Auxiliary terminals (shell, App Control, etc.) — never route chat-CLI rows.
    return activeAuxiliaryEntryFor(chatSessionId)?.sessionId ?? null;
  };

  const buildSessionActionResult = (
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

  const assertAgentCliSessionAction = (
    sessionId: string,
    session: TerminalSessionSummary | null,
    action: "continued" | "resumed",
  ): void => {
    if (session?.tracked === false) {
      throw ptySendPreDeliveryError(`Terminal session '${sessionId}' is not tracked and cannot be ${action}.`);
    }
    if (session && (session.toolType === "shell" || isPersistedChatToolType(session.toolType))) {
      throw ptySendPreDeliveryError(`Terminal session '${sessionId}' is not an agent CLI session.`);
    }
  };

  const resolveEndedResumeSession = async (
    sessionId: string,
    session: TerminalSessionSummary | null,
  ): Promise<{ session: TerminalSessionSummary; provider: TerminalResumeProvider }> => {
    if (!session) throw ptySendPreDeliveryError(`Terminal session '${sessionId}' was not found.`);

    const provider = session.resumeMetadata?.provider ?? providerFromTool(session.toolType);
    if (!provider) throw ptySendPreDeliveryError(`Terminal session '${sessionId}' does not have a resumable CLI provider.`);

    const throwMissingResumeTarget = (): never => {
      const displayName = resumeProviderDisplayName(provider);
      throw ptySendPreDeliveryError(
        `${displayName} exited before ADE could capture a concrete resume target. Start a new ${displayName} session.`,
      );
    };
    let resolvedSession = session;
    let storedResumeTargetId = resumeTargetIdForProvider(resolvedSession, provider);
    if (!storedResumeTargetId && provider !== "cursor" && isTrackedAgentCliToolType(resolvedSession.toolType)) {
      const cwd = resolveSessionRunCwd(resolvedSession);
      const backfilled = await tryBackfillResumeTarget(sessionId, resolvedSession.toolType, "resume-launch", cwd);
      const updatedSession = backfilled ? sessionService.get(sessionId) : null;
      if (updatedSession) {
        resolvedSession = updatedSession;
        storedResumeTargetId = resumeTargetIdForProvider(resolvedSession, provider);
      }
    }
    if (
      provider === "codex"
      && isCodexTrackedCliToolType(resolvedSession.toolType)
      && !storedResumeTargetId
    ) {
      const transcript = await sessionService.readTranscriptTail(resolvedSession.transcriptPath, 220_000);
      if (isCodexCliUpdateTranscript(transcript)) {
        throw ptySendPreDeliveryError(
          "Codex updated and exited before ADE could create a resumable thread. Start a new Codex session.",
        );
      }
      return throwMissingResumeTarget();
    }
    if (!storedResumeTargetId && provider !== "cursor") {
      throwMissingResumeTarget();
    }

    return { session: resolvedSession, provider };
  };

  const resumeLaunchOverrides = (
    args: Pick<
      PtySendToSessionArgs,
      | "model"
      | "reasoningEffort"
      | "fastMode"
      | "permissionMode"
      | "codexApprovalPolicy"
      | "codexSandbox"
      | "codexConfigSource"
    >,
  ) => ({
    model: typeof args.model === "string" && args.model.trim().length
      ? args.model.trim()
      : undefined,
    reasoningEffort: typeof args.reasoningEffort === "string" && args.reasoningEffort.trim().length
      ? args.reasoningEffort.trim()
      : undefined,
    fastMode: typeof args.fastMode === "boolean" ? args.fastMode : undefined,
    permissionMode: typeof args.permissionMode === "string" && args.permissionMode.trim().length
      ? args.permissionMode
      : undefined,
    codexApprovalPolicy: args.codexApprovalPolicy === "untrusted"
      || args.codexApprovalPolicy === "on-request"
      || args.codexApprovalPolicy === "on-failure"
      || args.codexApprovalPolicy === "never"
      ? args.codexApprovalPolicy
      : undefined,
    codexSandbox: args.codexSandbox === "read-only"
      || args.codexSandbox === "workspace-write"
      || args.codexSandbox === "danger-full-access"
      ? args.codexSandbox
      : undefined,
    codexConfigSource: args.codexConfigSource === "flags" || args.codexConfigSource === "config-toml"
      ? args.codexConfigSource
      : undefined,
  });

  const buildResumeCommandForSession = (
    session: TerminalSessionSummary,
    provider: TerminalResumeProvider,
    overrides: ReturnType<typeof resumeLaunchOverrides> & { prompt?: string | null },
    codexComputerUse: CodexComputerUseMcpConfig | null = null,
  ): { command: string | null; promptAtLaunch: boolean } => {
    const prompt = typeof overrides.prompt === "string" && overrides.prompt.trim().length
      ? overrides.prompt
      : null;
    const parsedResumeCommand = parseTrackedCliResumeCommand(session.resumeCommand, session.toolType);
    const metadata = session.resumeMetadata
      ?? (parsedResumeCommand?.provider === provider
        ? {
            provider,
            targetKind: provider === "codex" ? "thread" : "session",
            targetId: parsedResumeCommand.targetId,
            launch: parseTrackedCliLaunchConfig(session.resumeCommand ?? "", session.toolType) ?? {},
          } satisfies TerminalResumeMetadata
        : null);
    const metadataOverrides = provider === "cursor"
      ? { ...overrides, prompt: null }
      : provider === "codex"
        ? { ...overrides, codexComputerUse }
        : overrides;
    const metadataResumeCommand = metadata
      ? buildTrackedCliResumeCommand(metadata, metadataOverrides)
      : null;
    const rawResumeCommand = metadataResumeCommand != null
      ? metadataResumeCommand
      : normalizeResumeCommand(session.resumeCommand, session.toolType);
    const command = provider === "codex" && rawResumeCommand
      ? withCodexNoAltScreen(rawResumeCommand)
      : rawResumeCommand;
    return { command, promptAtLaunch: Boolean(command && prompt && metadataResumeCommand && provider !== "cursor") };
  };

  const getOrCreateResumeFlight = (
    session: TerminalSessionSummary,
    resumeCommand: string,
    args: Pick<PtySendToSessionArgs, "cols" | "rows">,
  ): { flight: Promise<PtyCreateResult>; created: boolean } => {
    let flight = resumeRuntimeFlights.get(session.id);
    if (flight) return { flight, created: false };

    const { cols, rows } = clampDims(
      typeof args.cols === "number" ? args.cols : PTY_SEND_DEFAULT_COLS,
      typeof args.rows === "number" ? args.rows : PTY_SEND_DEFAULT_ROWS,
    );
    flight = service.create({
      sessionId: session.id,
      laneId: session.laneId,
      cols,
      rows,
      title: session.goal?.trim() || session.title || "Terminal",
      tracked: session.tracked,
      toolType: session.toolType,
      startupCommand: resumeCommand,
      ...directShellLaunchForCommandLine(resumeCommand),
    });
    resumeRuntimeFlights.set(session.id, flight);
    void flight
      .finally(() => {
        if (resumeRuntimeFlights.get(session.id) === flight) {
          resumeRuntimeFlights.delete(session.id);
        }
      })
      .catch(() => {});

    return { flight, created: true };
  };

  const clearTrackedCliTurnStartMarkers = (sessionId: string): void => {
    const session = sessionService.get(sessionId);
    if (
      session?.settledAt
      || session?.settleOverride
      || session?.attentionRequestedAt
      || session?.lastTurnFailedAt
    ) {
      sessionService.clearTurnStartMarkers(sessionId);
    }
  };

  const markPtyUserInput = (entry: PtyEntry): void => {
    entry.lastUserInputAt = Date.now();
    entry.userInputGeneration += 1;
    if (entry.tracked && isTrackedAgentCliToolType(entry.toolTypeHint)) {
      clearTrackedCliTurnStartMarkers(entry.sessionId);
      entry.attentionRequested = false;
      onSessionUserInput?.({ laneId: entry.laneId, sessionId: entry.sessionId });
      return;
    }
    if (entry.attentionRequested) {
      entry.attentionRequested = false;
      sessionService.clearAttentionRequest(entry.sessionId);
    }
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
      const { laneId } = args;
      const title = normalizePtySessionTitle(args.title);
      const chatSessionId = cleanOptionalId(args.chatSessionId);
      const launchContext = resolveLaneLaunchContext({
        laneService,
        projectRoot,
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
        throw ptySendPreDeliveryError(`Terminal session '${requestedSessionId}' was not found.`);
      }
      if (existingSession && existingSession.laneId !== laneId) {
        throw new Error(`Terminal session '${requestedSessionId}' belongs to lane '${existingSession.laneId}', not '${laneId}'.`);
      }
      if (existingSession && !existingSession.tracked) {
        throw ptySendPreDeliveryError(`Terminal session '${requestedSessionId}' is not tracked and cannot be resumed.`);
      }
      // Snapshot only a real terminal end state before reattach/backfill can
      // overwrite it. A row may still say `running` after its owning brain
      // died; capturing that stale state would make closeEntry restore a dead
      // relaunch to `running`. Leaving it null makes closeEntry persist the new
      // failure, while detached/completed/failed restore byte-for-byte.
      const priorEndState = existingSession && existingSession.status !== "running"
        ? {
          status: existingSession.status,
          exitCode: existingSession.exitCode ?? null,
          endedAt: existingSession.endedAt ?? null,
        }
        : null;
      const liveAttachedEntry = existingSession
        ? Array.from(ptys.entries()).find(([, entry]) => entry.sessionId === existingSession.id && !entry.disposed)
        : null;
      if (existingSession && liveAttachedEntry) {
        const [attachedPtyId, attachedEntry] = liveAttachedEntry;
        if (chatSessionId) {
          attachedEntry.chatSessionId = chatSessionId;
          terminalChatSessions.set(existingSession.id, chatSessionId);
          promoteActiveChatTerminal(chatSessionId, existingSession.id, attachedEntry.toolTypeHint);
          if (existingSession.chatSessionId !== chatSessionId) {
            try { sessionService.setChatSessionId(existingSession.id, chatSessionId); } catch {}
          }
        }
        const needsSessionResync = existingSession.status !== "running" || existingSession.ptyId !== attachedPtyId;
        if (needsSessionResync) {
          sessionService.reattach({
            sessionId: existingSession.id,
            ptyId: attachedPtyId,
            startedAt: existingSession.startedAt,
            ...(ownerPid != null ? { ownerPid } : {}),
            ...(ownerProcessStartedAt != null ? { ownerProcessStartedAt } : {}),
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
      // Reaching here always spawns a NEW PTY/process — the live-attach case
      // returned above — so resuming a tracked CLI session whose PTY is gone
      // is a new launch and must be gated too, not only brand-new sessions.
      if (tracked && isTrackedAgentCliToolType(toolTypeHint)) {
        const decision = diskPressureMonitor?.canPerform("cli_launch");
        if (decision && !decision.allowed) {
          throw Object.assign(new Error(decision.message), { code: decision.code });
        }
      }
      const requestedStartupCommand = typeof args.startupCommand === "string" ? args.startupCommand.trim() : "";
      const requestedInitialInput = typeof args.initialInput === "string" ? args.initialInput : "";
      const requestedResumeMetadata = args.resumeMetadata ?? null;
      let initialResumeMetadata = existingSession?.resumeMetadata
        ?? requestedResumeMetadata
        ?? buildInitialResumeMetadata({
          toolType: toolTypeHint,
          startupCommand: requestedStartupCommand,
        });
      let initialResumeCommand = existingSession?.resumeCommand
        ?? (requestedResumeMetadata ? buildTrackedCliResumeCommand(requestedResumeMetadata) : defaultResumeCommandForTool(toolTypeHint));
      const transcriptPath = tracked
        ? (existingSession?.transcriptPath?.trim() || safeTranscriptPathFor(sessionId))
        : "";
      let startupCommand = withBundledOpenCodeCommandLine(requestedStartupCommand.trim(), toolTypeHint);
      const cleanupPaths: string[] = [];

      let transcriptStream: fs.WriteStream | null = null;
      let transcriptBytesWritten = 0;
      let transcriptBaseOffset = 0;
      let transcriptRetainedBytes = 0;
      let transcriptJournalRecovered = false;
      let transcriptWriteDisabled = false;
      let transcriptLastErrorAt = 0;
      if (tracked) {
        try {
          fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
          await restoreInterruptedTranscriptReplacement(transcriptPath);
          await reinflateHistoryFile(transcriptPath);
          try {
            transcriptRetainedBytes = fs.existsSync(transcriptPath) ? fs.statSync(transcriptPath).size : 0;
            const rolloverState = loadTranscriptRolloverStateSync(transcriptPath, transcriptRetainedBytes);
            transcriptBaseOffset = rolloverState.baseOffset;
            transcriptBytesWritten = transcriptBaseOffset + transcriptRetainedBytes;
            transcriptJournalRecovered = rolloverState.recoveredJournal;
          } catch {
            transcriptBytesWritten = 0;
            transcriptBaseOffset = 0;
            transcriptRetainedBytes = 0;
          }
          if (transcriptJournalRecovered) {
            await writeFileAtomicAsync(
              transcriptRolloverStatePath(transcriptPath),
              `${JSON.stringify({
                version: TRANSCRIPT_ROLLOVER_STATE_VERSION,
                baseOffset: transcriptBaseOffset,
                retainedBytes: transcriptRetainedBytes,
              } satisfies TranscriptRolloverState)}\n`,
            );
            await clearCompletedTranscriptRolloverTransaction(transcriptPath);
          }
          if (transcriptBaseOffset > 0 || transcriptJournalRecovered) {
            removeTranscriptRolloverTempFilesSync(transcriptPath);
          }
          transcriptStream = fs.createWriteStream(transcriptPath, { flags: "a" });
          transcriptStream.on("error", (err) => {
            const entry = ptys.get(ptyId);
            if (entry) {
              disableTranscriptWrite(entry, err);
              return;
            }
            const now = Date.now();
            if (now - transcriptLastErrorAt > 10_000) {
              transcriptLastErrorAt = now;
              logger.warn("pty.transcript_write_failed", {
                sessionId,
                code: typeof err === "object" && err != null && "code" in err
                  ? String((err as { code?: unknown }).code ?? "")
                  : null,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            transcriptWriteDisabled = true;
          });
        } catch (err) {
          transcriptWriteDisabled = true;
          transcriptLastErrorAt = Date.now();
          logger.warn("pty.transcript_open_failed", {
            sessionId,
            code: typeof err === "object" && err != null && "code" in err
              ? String((err as { code?: unknown }).code ?? "")
              : null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
          ownerPid,
          ownerProcessStartedAt,
        });
        setRuntimeState(sessionId, "running");

        // Attach any requested Linear issues to the freshly-created session row
        // BEFORE env is built below, so getSessionLinearEnv resolves them and the
        // spawned CLI agent inherits ADE_LINEAR_* (and the lane-mirror link lands
        // now that the terminal row exists). Best-effort: never block the spawn.
        if (Array.isArray(args.linearIssues) && args.linearIssues.length) {
          try {
            laneService.attachLinearIssueToSession?.({
              chatSessionId: sessionId,
              issues: args.linearIssues,
              role: "worked",
              source: "chat_attach",
              includeInPr: true,
              closeOnMerge: false,
              evidence: { chatSessionId: sessionId },
            });
          } catch (error) {
            logger.warn("pty.session_linear_attach_failed", {
              sessionId,
              issueCount: args.linearIssues.length,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Best-effort head SHA at start; do not block terminal creation.
        Promise.resolve()
          .then(async () => {
            const sha = await computeHeadShaBestEffort(cwd || worktreePath);
            if (sha) sessionService.setHeadShaStart(sessionId, sha);
          })
          .catch(() => {});
      }

      const requestedDirectCommand = typeof args.command === "string" ? args.command.trim() : "";
      const directCommand = resolveDirectOpenCodeCommand(requestedDirectCommand, toolTypeHint);
      let directArgs = Array.isArray(args.args) ? args.args.filter((value): value is string => typeof value === "string") : [];

      const laneRuntimeEnv = (await getLaneRuntimeEnv?.(laneId)) ?? {};
      const sessionLinearEnv = getSessionLinearEnv?.({ sessionId, chatSessionId }) ?? {};
      const explicitNoColor = hasEnvKey(args.env ?? {}, "NO_COLOR") || hasEnvKey(laneRuntimeEnv, "NO_COLOR");
      const explicitForceColor = hasEnvKey(args.env ?? {}, "FORCE_COLOR") || hasEnvKey(laneRuntimeEnv, "FORCE_COLOR");
      const inheritedProcessEnv = { ...process.env };
      // The desktop/runtime itself may be launched from an agent shell. Do not
      // leak that host role into an ordinary terminal; tracked agent CLIs set
      // their role explicitly below.
      delete inheritedProcessEnv.ADE_DEFAULT_ROLE;
      const baseLaunchEnv = {
        ...inheritedProcessEnv,
        ...laneRuntimeEnv,
        ...sessionLinearEnv,
        ...(args.env ?? {})
      };
      if (explicitNoColor && !explicitForceColor) {
        delete baseLaunchEnv.FORCE_COLOR;
      }
      // Resume launches re-enter create() without args.spawnLineage — recover
      // it from the persisted resume metadata so a resumed spawned CLI keeps
      // its parent env (self-reporting + nested lineage).
      const persistedParentSessionId = isTrackedAgentCliToolType(toolTypeHint)
        ? existingSession?.resumeMetadata?.orchestrationParentSessionId?.trim() || null
        : null;
      const effectiveSpawnLineage = args.spawnLineage
        ?? (persistedParentSessionId
          ? {
              parentChatSessionId: persistedParentSessionId,
              spawnKind: existingSession?.resumeMetadata?.spawnKind ?? null,
            }
          : null);
      const contextLaunchEnv = withAdeTerminalContextEnv(baseLaunchEnv, {
        projectRoot,
        laneId,
        chatSessionId,
        ownerSessionId: isTrackedAgentCliToolType(toolTypeHint) ? sessionId : null,
        spawnLineage: effectiveSpawnLineage,
      });
      let launchEnv = withInteractiveTerminalColorEnv(
        getAdeCliAgentEnv?.(contextLaunchEnv) ?? contextLaunchEnv,
        { preserveNoColor: explicitNoColor },
      );
      if (isTrackedAgentCliToolType(toolTypeHint)) {
        launchEnv.ADE_DEFAULT_ROLE = "agent";
      }
      launchEnv = withResolvedCliLaunchPath(launchEnv, {
        includeInteractiveShell: Boolean(directCommand || startupCommand),
      });
      const shouldBackfillResumeTarget =
        existingSession
        && isTrackedAgentCliToolType(toolTypeHint)
        && !sanitizeResumeTargetId(existingSession.resumeMetadata?.targetId ?? null);
      if (shouldBackfillResumeTarget) {
        const backfilled = await tryBackfillResumeTarget(sessionId, toolTypeHint, "resume-launch", cwd);
        const updatedSession = backfilled ? sessionService.get(sessionId) : null;
        if (updatedSession?.resumeCommand?.trim()) {
          initialResumeCommand = updatedSession.resumeCommand.trim();
          initialResumeMetadata = updatedSession.resumeMetadata ?? initialResumeMetadata;
          startupCommand = withBundledOpenCodeCommandLine(initialResumeCommand, toolTypeHint);
        }
      }
      const claudePluginLaunch = withBundledClaudePlugin(
        directCommand,
        directArgs,
        startupCommand,
        toolTypeHint,
        launchEnv,
      );
      directArgs = claudePluginLaunch.args;
      startupCommand = claudePluginLaunch.startupCommand;
      launchEnv = withUserCodexCliPathPriority(launchEnv, {
        toolType: toolTypeHint,
        directCommand,
        startupCommand,
      });

      let pty: IPty;
      let selectedShell: ShellSpec | null = null;
      const useLoginInteractiveShell = toolTypeHint === "shell" && !directCommand && !startupCommand;
      const shellCandidates = resolveShellCandidates({
        clean: Boolean(directCommand || startupCommand),
        login: useLoginInteractiveShell,
      });
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
            const hostReady = getPtyHostReadyPromise(created);
            if (hostReady) await hostReady;
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
              const hostReady = getPtyHostReadyPromise(created);
              if (hostReady) await hostReady;
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
        sessionService.reattach({
          sessionId,
          ptyId,
          startedAt: existingSession.startedAt,
          ...(ownerPid != null ? { ownerPid } : {}),
          ...(ownerProcessStartedAt != null ? { ownerProcessStartedAt } : {}),
        });
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
        transcriptBaseOffset,
        transcriptRetainedBytes,
        transcriptRolloverInProgress: false,
        transcriptRolloverPromise: null,
        transcriptRolloverPendingChunks: [],
        transcriptRolloverPendingBytes: 0,
        transcriptRolloverPendingTrimmed: false,
        transcriptPausedForRollover: false,
        transcriptWriteDisabled,
        transcriptLastErrorAt,
        lastPreviewWriteAt: 0,
        lastSessionResyncCheckAt: 0,
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
        attentionRequested: false,
        disposed: false,
        createdAt: Date.now(),
        cleanupPaths,
        lastResizeCols: null,
        lastResizeRows: null,
        lastDesktopCols: cols,
        lastDesktopRows: rows,
        pendingDataChunks: [],
        pendingDataChars: 0,
        pendingDataTimer: null,
        pendingOutputHighSurrogate: "",
        processOutputData: null,
        lastUserInputAt: 0,
        userInputGeneration: 0,
        terminalSnapshot: tracked ? createTerminalSnapshotMirror(cols, rows) : null,
        recentOutputTail: "",
        runtimeWindowTitleScanBuffer: "",
        aiTitleTimer: null,
        startupTimer: null,
        initialInputTimer: null,
        cliUserTitleLineBuffer: "",
        cliUserTitleCommitted: false,
        priorEndState,
      };
      ptys.set(ptyId, entry);
      if (chatSessionId) {
        terminalChatSessions.set(sessionId, chatSessionId);
        promoteActiveChatTerminal(chatSessionId, sessionId, toolTypeHint);
        if (existingSession && existingSession.chatSessionId !== chatSessionId) {
          try { sessionService.setChatSessionId(sessionId, chatSessionId); } catch {}
        }
      }

      // Buffer initial output for AI title generation
      let titleOutputBuffer = "";
      let titleBufferFull = false;

      const processOutputData = (data: string): void => {
        // Late chunks can arrive after closeEntry()/dispose() has flushed the
        // final buffer and emitted ptyExit. Bail out so post-teardown data
        // can't re-arm pendingDataTimer, mutate previews/runtime state, or
        // emit ptyData after ptyExit while transcript summarization is in
        // flight.
        if (entry.disposed) return;
        resyncLiveSessionRowIfNeeded(entry, ptyId);
        appendRecentOutput(entry, data);
        adoptCliRuntimeWindowTitle(entry, data);
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
        } else {
          clearIdleTimer(sessionId);
        }
        emitRuntimeSignalThrottled(entry, runtimeState);

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
      };
      entry.processOutputData = processOutputData;

      pty.onData((rawData) => {
        if (entry.disposed) return;
        const data = takeCanonicalPtyOutput(entry, rawData);
        if (data) processOutputData(data);
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
        const writeStartupCommand = () => {
          entry.startupTimer = null;
          if (entry.disposed) return;
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
        };
        const startupDelayMs = normalizeStartupCommandDelayMs(args.startupDelayMs);
        if (startupDelayMs > 0) {
          entry.startupTimer = setTimeout(writeStartupCommand, startupDelayMs);
          entry.startupTimer.unref?.();
        } else {
          writeStartupCommand();
        }
      }

      if (requestedInitialInput.length > 0) {
        const normalizedInitialInput = requestedInitialInput.replace(/\r\n?/g, "\n");
        const provider = providerFromTool(toolTypeHint);
        const defaultInitialInputReadyTimeoutMs = provider === "codex"
          ? CODEX_CLI_READY_TIMEOUT_MS
          : AGENT_CLI_READY_TIMEOUT_MS;
        const requestedInitialInputReadyTimeoutMs = args.initialInputReadyTimeoutMs;
        const parsedInitialInputReadyTimeoutMs = Math.floor(
          Number(requestedInitialInputReadyTimeoutMs ?? defaultInitialInputReadyTimeoutMs) || 0,
        );
        const initialInputReadyTimeoutMs = Math.max(
          AGENT_CLI_READY_TIMEOUT_MS,
          Math.min(
            300_000,
            parsedInitialInputReadyTimeoutMs,
          ),
        );
        if (
          requestedInitialInputReadyTimeoutMs != null
          && parsedInitialInputReadyTimeoutMs !== initialInputReadyTimeoutMs
        ) {
          logger.warn("pty.initial_input_ready_timeout_clamped", {
            ptyId,
            sessionId,
            requestedTimeoutMs: requestedInitialInputReadyTimeoutMs,
            effectiveTimeoutMs: initialInputReadyTimeoutMs,
            minTimeoutMs: AGENT_CLI_READY_TIMEOUT_MS,
            maxTimeoutMs: 300_000,
          });
        }
        const initialInputUserGeneration = entry.userInputGeneration;
        const writeInitialInput = async (): Promise<void> => {
          entry.initialInputTimer = null;
          if (entry.disposed) throw new Error("Terminal session closed before initial input could be sent.");
          const userTookControl = (): boolean => entry.userInputGeneration !== initialInputUserGeneration;
          try {
            if (provider) {
              while (!await waitForAgentCliInputReady(sessionId, provider, initialInputReadyTimeoutMs)) {
                if (entry.disposed || !liveEntryBySessionId(sessionId)) {
                  throw new Error("Terminal session closed before initial input could be sent.");
                }
                if (userTookControl()) {
                  logger.info("pty.initial_input_cancelled_user_takeover", {
                    ptyId,
                    sessionId,
                    cwd,
                    toolType: toolTypeHint,
                    provider,
                  });
                  return;
                }
                if (args.awaitInitialInput || provider !== "codex") {
                  logger.warn("pty.initial_input_skipped_not_ready", {
                    ptyId,
                    sessionId,
                    cwd,
                    toolType: toolTypeHint,
                    provider,
                  });
                  throw new Error(`${provider} CLI did not become ready; initial input was not sent.`);
                }
                logger.warn("pty.initial_input_retrying_not_ready", {
                  ptyId,
                  sessionId,
                  cwd,
                  toolType: toolTypeHint,
                  provider,
                  timeoutMs: initialInputReadyTimeoutMs,
                });
              }
              if (entry.disposed) throw new Error("Terminal session closed before initial input could be sent.");
              if (userTookControl()) {
                logger.info("pty.initial_input_cancelled_user_takeover", {
                  ptyId,
                  sessionId,
                  cwd,
                  toolType: toolTypeHint,
                  provider,
                });
                return;
              }
            }
            if (provider) {
              const submittedInitialInput = normalizedInitialInput.trim();
              if (submittedInitialInput.length > 0) {
                tryCliUserTitleFromWrite(entry, `${submittedInitialInput}\r`);
                const wrote = await writeAgentCliInput((data) => {
                  pty.write(data);
                  return true;
                }, submittedInitialInput, provider);
                if (!wrote) throw new Error("PTY rejected initial input writes.");
                const submitDelayMs = provider === "codex"
                  ? CODEX_CLI_PASTE_SUBMIT_DELAY_MS
                  : provider === "cursor"
                    ? CURSOR_CLI_PASTE_SUBMIT_DELAY_MS
                    : AGENT_CLI_SUBMIT_DELAY_MS;
                await delay(submitDelayMs);
                pty.write(AGENT_CLI_LINE_SUBMIT_KEY);
              }
            } else {
              pty.write(`\x1b[200~${normalizedInitialInput}\x1b[201~\r`);
            }
            setRuntimeState(sessionId, "running");
            scheduleIdleTransition(sessionId);
          } catch (err) {
            logger.warn("pty.initial_input_failed", {
              ptyId,
              sessionId,
              cwd,
              toolType: toolTypeHint,
              err: String(err),
            });
            throw err;
          }
        };
        const failInitialInputLaunch = (err: unknown): void => {
          if (entry.disposed) return;
          logger.warn("pty.initial_input_launch_failed", {
            ptyId,
            sessionId,
            cwd,
            toolType: toolTypeHint,
            err: String(err),
          });
        };
        const initialInputDelayMs = Math.max(0, Math.min(10_000, Math.floor(Number(args.initialInputDelayMs ?? 0) || 0)));
        if (args.awaitInitialInput) {
          try {
            if (initialInputDelayMs > 0) await delay(initialInputDelayMs);
            await writeInitialInput();
          } catch (err) {
            logger.warn("pty.initial_input_await_failed_closing", {
              ptyId,
              sessionId,
              cwd,
              toolType: toolTypeHint,
              err: String(err),
            });
            terminatePtyProcessTree(entry, "SIGTERM", logger);
            closeEntry(ptyId, 1);
            throw err;
          }
        } else if (initialInputDelayMs > 0) {
          entry.initialInputTimer = setTimeout(() => {
            void writeInitialInput().catch(failInitialInputLaunch);
          }, initialInputDelayMs);
          entry.initialInputTimer.unref?.();
        } else {
          void writeInitialInput().catch(failInitialInputLaunch);
        }
      }

      if (
        !existingSession
        && (toolTypeHint === "codex" || toolTypeHint === "codex-orchestrated")
        && cwd
      ) {
        // Derived from what this launch delivers, not from what it succeeds in
        // delivering: if the write never lands the rollout never carries the
        // needle, and capture is skipped rather than guessed at.
        scheduleCodexSessionIdCaptureBestEffort(
          sessionId,
          cwd,
          startedAt,
          codexLaunchOwnershipNeedle({ initialInput: requestedInitialInput, args: directArgs }),
        );
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
          const titleReasoningEffort = resolveTitleReasoningEffort();
          capturedAi
            .summarizeTerminal({
              cwd: entry.boundCwd || entry.laneWorktreePath,
              prompt,
              taskType: "session_title",
              timeoutMs: PTY_AI_TITLE_TIMEOUT_MS,
              ...(titleModelId ? { model: titleModelId } : {}),
              ...(titleReasoningEffort ? { reasoningEffort: titleReasoningEffort } : {}),
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

    canAcceptScheduledTurn(sessionId: string): boolean {
      const normalizedSessionId = sessionId.trim();
      const session = normalizedSessionId ? sessionService.get(normalizedSessionId) : null;
      if (!session?.tracked || !isTrackedAgentCliToolType(session.toolType)) return false;
      if (isOwnedByLivePeerRuntime(session)) return false;
      const live = liveEntryBySessionId(normalizedSessionId);
      if (!live) return true;
      const provider = session.resumeMetadata?.provider
        ?? providerFromTool(session.toolType ?? live[1].toolTypeHint);
      return provider != null && agentCliInputReadyNow(normalizedSessionId, provider);
    },

    async sendToSession(args: PtySendToSessionArgs): Promise<PtySendToSessionResult> {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!sessionId) throw new Error("Session id is required.");
      if (!text) throw new Error("Message text is required.");

      const session = sessionService.get(sessionId);
      assertAgentCliSessionAction(sessionId, session, "continued");
      if (session && isOwnedByLivePeerRuntime(session)) {
        throw ptySendPreDeliveryError(
          `Terminal session '${sessionId}' is owned by another live ADE runtime.`,
        );
      }
      const writeSubmittedText = async (
        targetSessionId: string,
        inputText: string,
        provider: TerminalResumeProvider,
        options: { waitForReady?: boolean } = {},
      ): Promise<boolean> => {
        const previous = submitInputFlights.get(targetSessionId) ?? Promise.resolve(true);
        const submitKey = AGENT_CLI_LINE_SUBMIT_KEY;
        const flight = previous
          .catch(() => true)
          .then(async () => {
            if (options.waitForReady) {
              const ready = await waitForAgentCliInputReady(targetSessionId, provider);
              if (!ready) return false;
            }
            const textWritten = await writeAgentCliInput(
              (data) => service.writeBySessionId(targetSessionId, data),
              inputText,
              provider,
            );
            if (!textWritten) return false;
            await delay(provider === "codex"
              ? CODEX_CLI_PASTE_SUBMIT_DELAY_MS
              : provider === "cursor"
                ? CURSOR_CLI_PASTE_SUBMIT_DELAY_MS
                : AGENT_CLI_SUBMIT_DELAY_MS);
            return service.writeBySessionId(targetSessionId, submitKey);
          });
        submitInputFlights.set(targetSessionId, flight);
        try {
          return await flight;
        } finally {
          if (submitInputFlights.get(targetSessionId) === flight) {
            submitInputFlights.delete(targetSessionId);
          }
        }
      };

      const live = liveEntryBySessionId(sessionId);
      if (live) {
        const [ptyId, entry] = live;
        const provider = session?.resumeMetadata?.provider ?? providerFromTool(session?.toolType ?? entry.toolTypeHint);
        if (!provider) throw ptySendPreDeliveryError(`Terminal session '${sessionId}' does not have a resumable CLI provider.`);
        const written = await writeSubmittedText(sessionId, text, provider, {
          waitForReady: provider === "cursor",
        });
        if (!written) throw new Error(`Terminal session '${sessionId}' is not accepting input.`);
        return buildSessionActionResult(
          { ptyId, sessionId, pid: entry.pty.pid ?? null },
          { resumed: false, reusedExistingRuntime: true },
        );
      }

      const resolvedResume = await resolveEndedResumeSession(sessionId, session);
      let resumableSession = resolvedResume.session;
      const provider = resolvedResume.provider;
      const overrides = resumeLaunchOverrides(args);
      const resetsStoredCodexPermissionProfile = provider === "codex"
        && overrides.permissionMode !== undefined;
      const launchOverridePatch = {
        ...(overrides.model !== undefined ? { model: overrides.model } : {}),
        ...(overrides.reasoningEffort !== undefined ? { reasoningEffort: overrides.reasoningEffort } : {}),
        ...(overrides.fastMode !== undefined ? { fastMode: overrides.fastMode } : {}),
        ...(overrides.permissionMode !== undefined ? { permissionMode: overrides.permissionMode } : {}),
        ...(overrides.codexApprovalPolicy !== undefined
          ? { codexApprovalPolicy: overrides.codexApprovalPolicy }
          : resetsStoredCodexPermissionProfile
            ? { codexApprovalPolicy: null }
            : {}),
        ...(overrides.codexSandbox !== undefined
          ? { codexSandbox: overrides.codexSandbox }
          : resetsStoredCodexPermissionProfile
            ? { codexSandbox: null }
            : {}),
        ...(overrides.codexConfigSource !== undefined
          ? { codexConfigSource: overrides.codexConfigSource }
          : resetsStoredCodexPermissionProfile
            ? { codexConfigSource: null }
            : {}),
      };
      if (resumableSession.resumeMetadata && Object.keys(launchOverridePatch).length > 0) {
        resumableSession = sessionService.updateMeta({
          sessionId,
          resumeMetadata: {
            ...resumableSession.resumeMetadata,
            launch: {
              ...resumableSession.resumeMetadata.launch,
              ...launchOverridePatch,
            },
          },
        }) ?? resumableSession;
      }
      const launchMetadata = resumableSession.resumeMetadata?.launch;
      const openCodeReplayCommand = provider === "opencode"
        && resumableSession.resumeMetadata?.provider === "opencode"
        && openCodeSupportsReplayResume()
        ? buildOpenCodeReplayResumeCommand({
            permissionMode: overrides.permissionMode ?? resumableSession.resumeMetadata.launch.permissionMode ?? null,
            targetId: sanitizeResumeTargetId(resumableSession.resumeMetadata.targetId ?? null),
            model: overrides.model ?? launchMetadata?.model ?? null,
            reasoningEffort: overrides.reasoningEffort ?? launchMetadata?.reasoningEffort ?? null,
            fastMode: overrides.fastMode ?? launchMetadata?.fastMode ?? launchMetadata?.codexFastMode ?? null,
            prompt: text,
          })
        : null;
      const codexComputerUse = provider === "codex"
        ? await resolveCodexComputerUseMcpConfig()
        : null;
      // Resolve Computer Use before this single-flight snapshot. Once the
      // snapshot is taken, command construction and flight creation must stay
      // synchronous so a concurrent send cannot also assume its prompt will be
      // embedded in the newly launched command.
      const resumeFlightAlreadyInProgress = resumeRuntimeFlights.has(sessionId);
      const builtResume = buildResumeCommandForSession(
        resumableSession,
        provider,
        {
          ...overrides,
          ...(!openCodeReplayCommand && !resumeFlightAlreadyInProgress ? { prompt: text } : {}),
        },
        codexComputerUse,
      );
      const promptAtLaunch = !openCodeReplayCommand && !resumeFlightAlreadyInProgress && builtResume.promptAtLaunch;
      const resumeCommand = openCodeReplayCommand ?? builtResume.command;
      if (!resumeCommand) {
        throw ptySendPreDeliveryError(`Terminal session '${sessionId}' does not have a resume command.`);
      }

      const { flight, created: resumeFlightCreated } = getOrCreateResumeFlight(resumableSession, resumeCommand, args);
      const created = await flight;
      // The message itself may be embedded in the provider's launch command,
      // so there is not always a later PTY write that can mark the new turn.
      // Wait until launch succeeds before clearing the previous turn's state.
      clearTrackedCliTurnStartMarkers(sessionId);
      if ((resumeFlightCreated && Boolean(openCodeReplayCommand)) || promptAtLaunch) {
        return buildSessionActionResult(created, { resumed: true, reusedExistingRuntime: false });
      }

      const written = await writeSubmittedText(created.sessionId, text, provider, {
        waitForReady: provider === "cursor" || resumeFlightAlreadyInProgress || !resumeFlightCreated,
      });
      if (!written) {
        logger.warn("pty.resume_send_input_failed_preserved", {
          sessionId,
          ptyId: created.ptyId,
          provider,
        });
        throw new Error(`Terminal session '${sessionId}' could not receive the message.`);
      }

      return buildSessionActionResult(created, { resumed: true, reusedExistingRuntime: false });
    },

    async resumeSession(args: PtyResumeSessionArgs): Promise<PtyResumeSessionResult> {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) throw new Error("Session id is required.");

      const session = sessionService.get(sessionId);
      assertAgentCliSessionAction(sessionId, session, "resumed");

      const live = liveEntryBySessionId(sessionId);
      if (live) {
        const [ptyId, entry] = live;
        return buildSessionActionResult(
          { ptyId, sessionId, pid: entry.pty.pid ?? null },
          { resumed: false, reusedExistingRuntime: true },
        );
      }

      const { session: resumableSession, provider } = await resolveEndedResumeSession(sessionId, session);
      const codexComputerUse = provider === "codex"
        ? await resolveCodexComputerUseMcpConfig()
        : null;
      const { command: resumeCommand } = buildResumeCommandForSession(
        resumableSession,
        provider,
        resumeLaunchOverrides(args),
        codexComputerUse,
      );
      if (!resumeCommand) {
        throw new Error(`Terminal session '${sessionId}' does not have a resume command.`);
      }

      const { flight } = getOrCreateResumeFlight(resumableSession, resumeCommand, args);
      const created = await flight;
      return buildSessionActionResult(created, { resumed: true, reusedExistingRuntime: false });
    },

    write({ ptyId, data }: { ptyId: string; data: string }): void {
      const entry = ptys.get(ptyId);
      if (!entry) return;
      try {
        markPtyUserInput(entry);
        entry.pty.write(data);
        tryCliUserTitleFromWrite(entry, data);
        setRuntimeState(entry.sessionId, "running");
        scheduleIdleTransition(entry.sessionId);
      } catch (err) {
        logger.warn("pty.write_failed", { ptyId, err: String(err) });
      }
    },

    markSessionAttentionRequested(sessionId: string): void {
      const live = liveEntryBySessionId(sessionId);
      if (live) live[1].attentionRequested = true;
    },

    setSessionRuntimeState(sessionId: string, runtimeState: TerminalRuntimeState): boolean {
      const live = liveEntryBySessionId(sessionId);
      if (!live) return false;
      const [, entry] = live;
      setRuntimeState(sessionId, runtimeState);
      if (runtimeState === "running") {
        scheduleIdleTransition(sessionId);
      } else {
        clearIdleTimer(sessionId);
      }
      emitRuntimeSignalThrottled(entry, runtimeState);
      return true;
    },

    listTerminals(args: ChatTerminalListArgs = {}): ChatTerminalSession[] {
      const chatSessionId = cleanOptionalId(args.chatSessionId);
      const laneId = cleanOptionalId(args.laneId);
      const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(500, Math.floor(args.limit)))
        : 200;
      const summaries = service.enrichSessions(sessionService.list({
        ...(laneId ? { laneId } : {}),
        limit,
      }));
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

    activeForChat(args?: Partial<ChatTerminalActiveForChatArgs> | null): ChatTerminalSession | null {
      const chatSessionId = cleanOptionalId(args?.chatSessionId);
      if (!chatSessionId) return null;
      const chatCli = activeChatCliEntryFor(chatSessionId);
      if (chatCli) {
        const session = sessionService.get(chatCli.sessionId);
        if (session) {
          promoteActiveChatCliTerminal(chatSessionId, chatCli.sessionId, session.toolType);
          return terminalSessionFromSummary(session);
        }
      }
      const auxiliary = activeAuxiliaryEntryFor(chatSessionId);
      if (!auxiliary) return null;
      const session = sessionService.get(auxiliary.sessionId);
      return session ? terminalSessionFromSummary(session) : null;
    },

    async reattachChatCli(args: ChatTerminalReattachArgs): Promise<ChatTerminalReattachResult> {
      const chatSessionId = cleanOptionalId(args?.chatSessionId);
      if (!chatSessionId) throw new Error("terminal.reattachChatCli requires chatSessionId.");

      // Fast path: an existing live PTY is already bound. Skip the dedup map to
      // keep the no-op cost low.
      const liveChatCli = activeChatCliEntryFor(chatSessionId);
      if (liveChatCli) {
        const liveActive = liveEntryBySessionId(liveChatCli.sessionId);
        if (liveActive) {
          promoteActiveChatCliTerminal(chatSessionId, liveChatCli.sessionId, liveChatCli.toolTypeHint);
          return {
            terminalId: liveChatCli.sessionId,
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
          ? buildTrackedCliResumeCommand(
              session.resumeMetadata,
              session.resumeMetadata.provider === "codex"
                ? { codexComputerUse: await resolveCodexComputerUseMcpConfig() }
                : {},
            )
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
          ...directShellLaunchForCommandLine(resumeCommand),
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
      if (!terminalId) throw new Error("terminal.read requires terminalId, ptyId, or an active chat terminal.");
      const session = sessionService.get(terminalId);
      if (!session) throw new Error(`Terminal session '${terminalId}' was not found.`);
      if (isPersistedChatToolType(session.toolType)) {
        throw new Error(`Session '${terminalId}' is an agent chat session, not a terminal.`);
      }
      const maxBytes = typeof args.maxBytes === "number" && Number.isFinite(args.maxBytes)
        ? Math.max(1, Math.min(MAX_TRANSCRIPT_BYTES, Math.floor(args.maxBytes)))
        : DEFAULT_TERMINAL_READ_MAX_BYTES;
      const diskTail = await sessionService.readTranscriptTail(session.transcriptPath, maxBytes, { raw: true });
      const live = liveEntryBySessionId(terminalId)?.[1].recentOutputTail ?? "";
      const full = mergeTranscriptTailWithLiveOutput(diskTail, live, maxBytes);
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
      try {
        markPtyUserInput(entry);
        entry.pty.write(args.data);
        tryCliUserTitleFromWrite(entry, args.data);
        setRuntimeState(entry.sessionId, "running");
        scheduleIdleTransition(entry.sessionId);
      } catch (err) {
        logger.warn("pty.terminal_write_failed", { sessionId: entry.sessionId, err: String(err) });
        throw err;
      }
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
          terminatePtyProcessTree(entry, args.signal, logger);
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
      // The ptyId-based path is only driven by the desktop renderer: remember
      // its size (even when the resize itself dedupes) so a mobile-driven
      // resize can be undone when the phone detaches.
      entry.lastDesktopCols = safe.cols;
      entry.lastDesktopRows = safe.rows;
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
      const live = liveEntryBySessionId(sessionId);
      if (!live) return false;
      const [, entry] = live;
      try {
        markPtyUserInput(entry);
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

    /** Whether a live (non-disposed) PTY currently backs `sessionId`. */
    hasLivePty(sessionId: string): boolean {
      if (!sessionId) return false;
      return liveEntryBySessionId(sessionId) != null;
    },

    /**
     * Resize the active PTY for a given session id. Mobile clients call this
     * when their visible terminal viewport changes (orientation flip, split
     * view, font-size change). Returns true on success.
     */
    resizeBySessionId(sessionId: string, cols: number, rows: number, opts?: { source?: "desktop" | "mobile" }): boolean {
      if (!sessionId) return false;
      const live = liveEntryBySessionId(sessionId);
      if (!live) return false;
      const [, entry] = live;
      const safe = clampDims(cols, rows);
      // A mobile viewport must never become the desktop-preferred size — it
      // is restored from lastDesktop* when the phone detaches.
      if (opts?.source !== "mobile") {
        entry.lastDesktopCols = safe.cols;
        entry.lastDesktopRows = safe.rows;
      }
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

    /**
     * Resize the active PTY for a session back to the last desktop-preferred
     * size. Called when the last subscribed mobile peer detaches so a phone's
     * viewport does not linger on the desktop terminal. Returns true when a
     * restore was performed.
     */
    restoreDesktopSizeBySessionId(sessionId: string): boolean {
      if (!sessionId) return false;
      const live = liveEntryBySessionId(sessionId);
      if (!live) return false;
      const [, entry] = live;
      const cols = entry.lastDesktopCols;
      const rows = entry.lastDesktopRows;
      if (cols == null || rows == null) return false;
      if (entry.lastResizeCols === cols && entry.lastResizeRows === rows) return false;
      try {
        entry.pty.resize(cols, rows);
        entry.lastResizeCols = cols;
        entry.lastResizeRows = rows;
        resizeTerminalSnapshot(entry, cols, rows);
        return true;
      } catch (err) {
        logger.warn("pty.restore_desktop_size_failed", { sessionId, err: String(err) });
        return false;
      }
    },

    getRuntimeState(sessionId: string, fallbackStatus: TerminalSessionStatus): TerminalRuntimeState {
      return computeRuntimeState(sessionId, fallbackStatus);
    },

    isSessionOwnedByLivePeerRuntime(session: {
      ownerPid?: number | null;
      ownerProcessStartedAt?: string | null;
    }): boolean {
      return isOwnedByLivePeerRuntime(session);
    },

    list(args: Parameters<typeof sessionService.list>[0] = {}): TerminalSessionSummary[] {
      return service.enrichSessions(sessionService.list(args));
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

    /**
     * Logical UTF-8 byte window currently represented by the retained file.
     * `startOffset` advances after rollover; `endOffset` never rewinds. The
     * end is based on flushed bytes, so it can briefly trail live pty_data
     * offsets while the WriteStream is draining.
     */
    getTranscriptWindow(sessionId: string): {
      startOffset: number;
      endOffset: number;
      retainedBytes: number;
    } | null {
      const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
      if (!normalizedSessionId) return null;
      const session = sessionService.get(normalizedSessionId);
      const transcriptPath = session?.transcriptPath?.trim();
      if (!transcriptPath) return null;
      try {
        const readablePath = fs.existsSync(transcriptPath)
          ? transcriptPath
          : fs.existsSync(`${transcriptPath}.gz`)
            ? `${transcriptPath}.gz`
            : transcriptPath;
        const retainedBytes = readablePath.endsWith(".gz")
          ? readHistoryFileSync(readablePath).length
          : Math.max(0, Number(fs.statSync(readablePath).size) || 0);
        const live = liveEntryBySessionId(normalizedSessionId)?.[1] ?? null;
        const baseOffset = live?.transcriptBaseOffset
          ?? loadTranscriptRolloverStateSync(transcriptPath, retainedBytes).baseOffset;
        return {
          startOffset: baseOffset,
          endOffset: baseOffset + retainedBytes,
          retainedBytes,
        };
      } catch {
        return null;
      }
    },

    /**
     * Return one exact contiguous transcript suffix with logical offsets.
     * For a live PTY, the recent-output buffer is authoritative through the
     * in-memory logical end even while WriteStream bytes are unflushed. For an
     * inactive/no-output PTY, this falls back to the flushed retained range.
     * The result may contain fewer than maxBytes; callers must use the
     * returned offsets rather than infer them from a file size.
     */
    async readTranscriptSnapshot(args: {
      sessionId: string;
      maxBytes: number;
      alignStartToSafeBoundary?: boolean;
    }): Promise<{ data: string; startOffset: number; endOffset: number } | null> {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return null;
      const session = sessionService.get(sessionId);
      if (!session?.transcriptPath?.trim()) return null;
      const maxBytes = Number.isFinite(args.maxBytes)
        ? Math.max(1, Math.min(MAX_TRANSCRIPT_BYTES, Math.floor(args.maxBytes)))
        : DEFAULT_TERMINAL_READ_MAX_BYTES;
      const live = liveEntryBySessionId(sessionId)?.[1] ?? null;
      if (
        live
        && live.tracked
        && !live.transcriptWriteDisabled
        && live.recentOutputTail.length > 0
      ) {
        const encoded = Buffer.from(live.recentOutputTail, "utf8");
        const logicalEnd = live.transcriptBytesWritten;
        const recentStart = Math.max(0, logicalEnd - encoded.length);
        const window = service.getTranscriptWindow(sessionId);
        const requestedStart = Math.max(
          window?.startOffset ?? recentStart,
          logicalEnd - maxBytes,
        );

        let suffix: Buffer;
        let logicalStart: number;
        const flushedEnd = Math.min(window?.endOffset ?? recentStart, logicalEnd);
        if (requestedStart < recentStart && flushedEnd >= recentStart) {
          const disk = await service.readTranscriptRange({
            sessionId,
            startOffset: requestedStart,
            endOffset: flushedEnd,
          });
          if (disk && disk.endOffset >= recentStart) {
            const liveStart = Math.min(encoded.length, disk.endOffset - recentStart);
            suffix = Buffer.concat([
              Buffer.from(disk.data, "utf8"),
              encoded.subarray(liveStart),
            ]);
            logicalStart = disk.startOffset;
          } else {
            // The WriteStream is farther behind than the bounded live tail.
            // Returning only the exact contiguous tail is safer than claiming
            // a snapshot that silently contains a logical gap.
            suffix = utf8SafeTail(encoded, maxBytes);
            logicalStart = Math.max(recentStart, logicalEnd - suffix.length);
          }
        } else {
          suffix = utf8SafeTail(encoded, maxBytes);
          logicalStart = Math.max(recentStart, logicalEnd - suffix.length);
        }
        if (suffix.length > maxBytes) {
          suffix = utf8SafeTail(suffix, maxBytes);
          logicalStart = logicalEnd - suffix.length;
        }
        let boundary = logicalStart > 0 && args.alignStartToSafeBoundary
          ? scanToTranscriptPageBoundary(suffix)
          : 0;
        while (boundary < suffix.length && (suffix[boundary]! & 0b1100_0000) === 0b1000_0000) {
          boundary += 1;
        }
        return {
          data: suffix.subarray(boundary).toString("utf8"),
          startOffset: logicalStart + boundary,
          endOffset: logicalEnd,
        };
      }

      const window = service.getTranscriptWindow(sessionId);
      if (!window) return null;
      return service.readTranscriptRange({
        sessionId,
        startOffset: Math.max(window.startOffset, window.endOffset - maxBytes),
        endOffset: window.endOffset,
        alignStartToSafeBoundary: args.alignStartToSafeBoundary,
      });
    },

    /**
     * Read an exact logical byte range of a session transcript (mobile history
     * paging / delta resume). After rollover, logical byte zero is no longer
     * retained: requested offsets are clamped to the retained [base, end)
     * window and the achieved logical offsets are reported back. The
     * transcript WriteStream buffers, so the retained end can briefly lag live
     * pty_data offsets. When
     * `alignStartToSafeBoundary` is set, a non-zero start is scanned forward
     * to the byte after a `\n` or to an ESC byte so a page never begins
     * mid-escape-sequence. Both ends are adjusted to UTF-8 code-point
     * boundaries. Returns null when the session is unknown or has no
     * transcript.
     */
    async readTranscriptRange(args: {
      sessionId: string;
      startOffset: number;
      endOffset: number;
      alignStartToSafeBoundary?: boolean;
    }): Promise<{ data: string; startOffset: number; endOffset: number } | null> {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return null;
      const session = sessionService.get(sessionId);
      const transcriptPath = session?.transcriptPath?.trim();
      if (!transcriptPath) return null;
      let fd: number | null = null;
      try {
        const readablePath = fs.existsSync(transcriptPath)
          ? transcriptPath
          : fs.existsSync(`${transcriptPath}.gz`)
            ? `${transcriptPath}.gz`
            : transcriptPath;
        if (readablePath.endsWith(".gz")) {
          const full = readHistoryFileSync(readablePath);
          const rolloverState = loadTranscriptRolloverStateSync(transcriptPath, full.length);
          const retainedStart = rolloverState.baseOffset;
          const retainedEnd = retainedStart + full.length;
          const end = Math.max(retainedStart, Math.min(Math.floor(args.endOffset), retainedEnd));
          const start = Math.min(Math.max(retainedStart, Math.floor(args.startOffset)), end);
          if (end <= start) return { data: "", startOffset: end, endOffset: end };
          const physicalStart = start - retainedStart;
          const physicalEnd = end - retainedStart;
          const page = full.subarray(physicalStart, physicalEnd);
          let boundary = start > 0 && args.alignStartToSafeBoundary
            ? scanToTranscriptPageBoundary(page)
            : 0;
          while (boundary < page.length && (page[boundary]! & 0b1100_0000) === 0b1000_0000) {
            boundary += 1;
          }
          return decodeTranscriptPage(page, start, boundary);
        }
        const fileSize = Math.max(0, Number(fs.statSync(transcriptPath).size) || 0);
        const live = liveEntryBySessionId(sessionId)?.[1] ?? null;
        const retainedStart = live?.transcriptBaseOffset
          ?? loadTranscriptRolloverStateSync(transcriptPath, fileSize).baseOffset;
        const retainedEnd = retainedStart + fileSize;
        const end = Math.max(retainedStart, Math.min(Math.floor(args.endOffset), retainedEnd));
        const start = Math.min(Math.max(retainedStart, Math.floor(args.startOffset)), end);
        if (end <= start) return { data: "", startOffset: end, endOffset: end };
        fd = fs.openSync(transcriptPath, "r");
        const buf = Buffer.alloc(end - start);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, start - retainedStart);
        const page = buf.subarray(0, Math.max(0, bytesRead));
        let boundary = 0;
        if (start > 0) {
          if (args.alignStartToSafeBoundary) {
            boundary = scanToTranscriptPageBoundary(page);
          }
          while (boundary < page.length && (page[boundary]! & 0b1100_0000) === 0b1000_0000) {
            boundary += 1;
          }
        }
        return decodeTranscriptPage(page, start, boundary);
      } catch {
        return null;
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            // Ignore close errors on best-effort transcript reads.
          }
        }
      }
    },

    enrichSessions<T extends TerminalSessionSummary>(rows: T[]): T[] {
      return rows.map((row) => {
        const live = liveEntryBySessionId(row.id);
        const ownedByLivePeer = !live && row.status === "running" && isOwnedByLivePeerRuntime(row);
        const runningWithoutReachablePty = !live
          && row.status === "running"
          && !isPersistedChatToolType(row.toolType ?? null);
        const idlePersistedChatRuntime = !live
          && row.status === "running"
          && isPersistedChatToolType(row.toolType ?? null)
          && computeRuntimeState(row.id, row.status) === "running";
        const isDetachedFromThisRuntime = ownedByLivePeer || runningWithoutReachablePty;
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
            : isDetachedFromThisRuntime
              ? {
                  ptyId: null,
                  status: "detached" as const,
                }
              : {}),
          runtimeState: isDetachedFromThisRuntime
            ? "exited"
            : idlePersistedChatRuntime
              ? "idle"
              : computeRuntimeState(row.id, fallbackStatus),
          chatSessionId: live
            ? terminalChatSessions.get(row.id) ?? live[1].chatSessionId ?? row.chatSessionId ?? null
            : terminalChatSessions.get(row.id) ?? row.chatSessionId ?? null,
        };
      });
    },

    dispose({ ptyId, sessionId }: { ptyId: string; sessionId?: string }): PtyDisposeResult {
      const entry = ptys.get(ptyId);
      if (!entry) {
        if (!sessionId) return { disposed: false, reason: "missing" };
        const session = sessionService.get(sessionId);
        if (!session) return { disposed: false, reason: "missing" };
        if (session.status && session.status !== "running") return { disposed: false, reason: "not-running" };
        if (session.ptyId && session.ptyId !== ptyId) return { disposed: false, reason: "session-mismatch" };
        if (
          ownerPid != null
          && session.ownerPid != null
          && session.ownerPid !== ownerPid
          && processRegistry?.isProcessIdentityLive(session.ownerPid, session.ownerProcessStartedAt)
        ) {
          logger.warn("pty.dispose_skipped_owned_by_peer", {
            ptyId,
            sessionId,
            ownerPid: session.ownerPid,
            currentPid: ownerPid,
          });
          return { disposed: false, reason: "owned-by-peer" };
        }
        // The renderer can outlive the pty map (for example after app restart). Allow closing by session id
        // so stale sessions do not get stuck in a "running" state forever.
        const endedAt = new Date().toISOString();
        sessionService.clearAttentionRequest(sessionId);
        sessionService.end({ sessionId, endedAt, exitCode: null, status: "disposed" });
        if (!session.chatSessionId && isTrackedAgentCliToolType(session.toolType)) {
          revokeBuiltInBrowserActorCapability(sessionId);
        }
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
        return { disposed: true, reason: "orphaned" };
      }
      if (sessionId && entry.sessionId !== sessionId) {
        return { disposed: false, reason: "session-mismatch" };
      }
      if (entry.disposed) return { disposed: false, reason: "already-disposed" };
      flushPendingPtyOutput(entry);
      entry.processOutputData = null;
      entry.disposed = true;
      entry.attentionRequested = false;
      sessionService.clearAttentionRequest(entry.sessionId);
      if (!entry.chatSessionId && isTrackedAgentCliToolType(entry.toolTypeHint)) {
        revokeBuiltInBrowserActorCapability(entry.sessionId);
      }
      if (entry.aiTitleTimer) {
        clearTimeout(entry.aiTitleTimer);
        entry.aiTitleTimer = null;
      }
      if (entry.startupTimer) {
        clearTimeout(entry.startupTimer);
        entry.startupTimer = null;
      }
      if (entry.initialInputTimer) {
        clearTimeout(entry.initialInputTimer);
        entry.initialInputTimer = null;
      }
      flushQueuedPtyData(entry, { ptyId, sessionId: entry.sessionId });
      cleanupEntryPaths(entry);
      // Release the live-tail buffer; see closeEntry for rationale.
      entry.recentOutputTail = "";
      terminatePtyProcessTree(entry, "SIGTERM", logger);
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
        return { disposed: true, reason: "disposed" };
      }

      try {
        onSessionEnded?.({ laneId: entry.laneId, sessionId: entry.sessionId, exitCode: null });
      } catch {
        // ignore
      }
      return { disposed: true, reason: "disposed" };
    },

    disposeAll(): void {
      for (const ptyId of [...ptys.keys()]) {
        try {
          service.dispose({ ptyId });
        } catch {
          // ignore
        }
      }
      try {
        disposePtyBackend?.();
      } catch {
        // Backend teardown is best-effort; service disposal must never crash callers.
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

    isTranscriptPathActive(filePath: string): boolean {
      const normalized = path.resolve(filePath);
      for (const entry of ptys.values()) {
        if (!entry.disposed && path.resolve(entry.transcriptPath) === normalized) return true;
      }
      return false;
    },

    /** Remove rollover bookkeeping after the owning transcript is deleted. */
    removeTranscriptRolloverArtifacts(transcriptPath: string): void {
      const normalized = typeof transcriptPath === "string" ? transcriptPath.trim() : "";
      if (!normalized) return;
      for (const artifactPath of [
        transcriptRolloverStatePath(normalized),
        transcriptRolloverJournalPath(normalized),
        transcriptRolloverBackupPath(normalized),
      ]) {
        try {
          fs.unlinkSync(artifactPath);
        } catch {
          // Deletion is best effort and idempotent.
        }
      }
      removeTranscriptRolloverTempFilesSync(normalized);
    },

    getResourceAttribution,

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
