import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import type { IPty } from "node-pty";
import type * as TerminalSessionSignals from "../../utils/terminalSessionSignals";
import { buildOpenCodeReplayResumeCommand as buildCanonicalOpenCodeReplayResumeCommand } from "../../../shared/cliLaunch";
import { isPtySendPreDeliveryError } from "../../../shared/types";
import { expectNoJargon } from "../../../test/jargonGuard";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const existsSyncResults = new Map<string, boolean>();
  const realpathOverrides = new Map<string, string>();
  const dirEntries = new Map<string, string[]>();
  const fileContents = new Map<string, string>();
  const fileStats = new Map<string, { size?: number; mtimeMs?: number; mode?: number; isDirectory?: boolean }>();
  const openFiles = new Map<number, string>();
  let nextFd = 100;
  let nextRandomByte = 1;
  return {
    existsSyncResults,
    realpathOverrides,
    dirEntries,
    fileContents,
    fileStats,
    openFiles,
    mkdirSync: vi.fn(),
    existsSync: vi.fn((p: string) => existsSyncResults.get(p) ?? true),
    lstatSync: vi.fn((p: string) => {
      if ((existsSyncResults.get(p) ?? true) === false) {
        const error = new Error(`ENOENT: no such file or directory, lstat '${p}'`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
    }),
    realpathSync: Object.assign(
      vi.fn((p: string) => p),
      { native: vi.fn((p: string) => p) },
    ),
    statSync: vi.fn((p: string) => {
      if ((existsSyncResults.get(p) ?? true) === false) {
        const error = new Error(`ENOENT: no such file or directory, stat '${p}'`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      const stat = fileStats.get(p);
      return {
        size: stat?.size ?? fileContents.get(p)?.length ?? 0,
        mtimeMs: stat?.mtimeMs ?? 0,
        mode: stat?.mode ?? 0o040755,
        isDirectory: () => stat?.isDirectory ?? true,
        isFile: () => !(stat?.isDirectory ?? true),
      };
    }),
    readdirSync: vi.fn((p: string) => dirEntries.get(p) ?? []),
    openSync: vi.fn((p: string) => {
      const fd = nextFd++;
      openFiles.set(fd, p);
      return fd;
    }),
    readSync: vi.fn((fd: number, buf: Buffer, offset: number, length: number, position: number) => {
      const filePath = openFiles.get(fd) ?? "";
      const content = Buffer.from(fileContents.get(filePath) ?? "", "utf8");
      const slice = content.subarray(position, position + length);
      slice.copy(buf, offset);
      return slice.length;
    }),
    closeSync: vi.fn((fd: number) => {
      openFiles.delete(fd);
    }),
    chmodSync: vi.fn(),
    createWriteStream: vi.fn((filePath: string, options?: { flags?: string }) => {
      const listeners: Record<"finish" | "error", Set<(err?: Error) => void>> = {
        finish: new Set<() => void>(),
        error: new Set<(err?: Error) => void>(),
      };
      const stream: any = {
        writableFinished: false,
        destroyed: false,
        write: vi.fn((value: string | Buffer) => {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
          const previousSize = fileStats.get(filePath)?.size
            ?? Buffer.byteLength(fileContents.get(filePath) ?? "", "utf8");
          const previous = options?.flags === "a" ? (fileContents.get(filePath) ?? "") : "";
          fileContents.set(filePath, `${previous}${chunk.toString("utf8")}`);
          fileStats.set(filePath, { ...fileStats.get(filePath), size: previousSize + chunk.length });
          return true;
        }),
        on: vi.fn((event: "finish" | "error", cb: (err?: Error) => void) => {
          listeners[event].add(cb);
          return stream;
        }),
        once: vi.fn((event: "finish" | "error", cb: (err?: Error) => void) => {
          listeners[event]?.add(cb);
          return stream;
        }),
        removeListener: vi.fn((event: "finish" | "error", cb: (err?: Error) => void) => {
          listeners[event]?.delete(cb);
          return stream;
        }),
        destroy: vi.fn(() => {
          stream.destroyed = true;
          return stream;
        }),
        _emitError: (err: Error) => {
          for (const listener of listeners.error) listener(err);
        },
        end: vi.fn((cb?: () => void) => {
          Promise.resolve().then(() => {
            stream.writableFinished = true;
            cb?.();
            for (const listener of listeners.finish) listener();
          });
          return stream;
        }),
      };
      return stream;
    }),
    promises: {
      stat: vi.fn(async (filePath: string) => {
        if (!fileContents.has(filePath) && !fileStats.has(filePath)) {
          const error = new Error(`ENOENT: no such file or directory, stat '${filePath}'`) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return {
          size: fileStats.get(filePath)?.size
            ?? Buffer.byteLength(fileContents.get(filePath) ?? "", "utf8"),
          isFile: () => true,
        };
      }),
      open: vi.fn(async (filePath: string, flags: string) => {
        if (flags === "wx" && (fileContents.has(filePath) || fileStats.has(filePath))) {
          const error = new Error(`EEXIST: file already exists, open '${filePath}'`) as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        }
        return {
          stat: vi.fn(async () => ({
            size: fileStats.get(filePath)?.size
              ?? Buffer.byteLength(fileContents.get(filePath) ?? "", "utf8"),
          })),
          read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
            const content = Buffer.from(fileContents.get(filePath) ?? "", "utf8");
            const slice = content.subarray(position, position + length);
            slice.copy(buffer, offset);
            return { bytesRead: slice.length, buffer };
          }),
          writeFile: vi.fn(async (value: string | Buffer) => {
            const content = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
            fileContents.set(filePath, content.toString("utf8"));
            fileStats.set(filePath, { ...fileStats.get(filePath), size: content.length });
          }),
          sync: vi.fn(async () => {}),
          close: vi.fn(async () => {}),
        };
      }),
      rename: vi.fn(async (from: string, to: string) => {
        if (fileContents.has(from)) fileContents.set(to, fileContents.get(from) ?? "");
        if (fileStats.has(from)) fileStats.set(to, { ...fileStats.get(from) });
        fileContents.delete(from);
        fileStats.delete(from);
        existsSyncResults.set(from, false);
        existsSyncResults.set(to, true);
      }),
      unlink: vi.fn(async (filePath: string) => {
        fileContents.delete(filePath);
        fileStats.delete(filePath);
        existsSyncResults.set(filePath, false);
      }),
    },
    readFileSync: vi.fn((p: string) => {
      if (!fileContents.has(p)) {
        const error = new Error(`ENOENT: no such file or directory, open '${p}'`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return fileContents.get(p) ?? "";
    }),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    randomUUID: vi.fn(() => "uuid-" + Math.random().toString(36).slice(2, 10)),
    randomBytes: vi.fn(() => Buffer.alloc(32, nextRandomByte++ % 256)),
    runGit: vi.fn(async () => ({ exitCode: 0, stdout: "abc123\n", stderr: "" })),
    stripAnsi: vi.fn((t: string) => t),
    summarizeTerminalSession: vi.fn(() => "test summary"),
    derivePreviewFromChunk: vi.fn(() => ({ nextLine: "", preview: "preview" })),
    defaultResumeCommandForTool: vi.fn(() => null),
    extractResumeCommandFromOutput: vi.fn(() => null),
    parseTrackedCliLaunchConfig: vi.fn(() => null),
    runtimeStateFromOsc133Chunk: vi.fn(() => "running"),
    resolveOpenCodeBinaryPath: vi.fn<[], string | null>(() => null),
    resolveCodexComputerUseMcpConfig: vi.fn(async (): Promise<{
      command: string;
      args: ["mcp"];
      enabled: true;
    } | null> => null),
    execFileSync: vi.fn((_file?: unknown, _args?: unknown) => ""),
    execFile: vi.fn((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        (callback as (...callbackArgs: unknown[]) => void)(null, "", "");
      }
      return { kill: vi.fn() };
    }),
    spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
  };
});

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  const dynamicDefault = new Proxy({} as typeof actual, {
    get(_target, property) {
      const implementation = process.platform === "win32" ? actual.win32 : actual.posix;
      const value = implementation[property as keyof typeof implementation];
      return typeof value === "function" ? value.bind(implementation) : value;
    },
  });
  return { ...actual, default: dynamicDefault };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const homedir = () => process.platform === "win32" ? actual.homedir() : "/Users/ade-test";
  return {
    ...actual,
    homedir,
    default: { ...actual, homedir },
  };
});

vi.mock("node:fs", () => ({
  default: {
    existsSync: mocks.existsSync,
    lstatSync: mocks.lstatSync,
    realpathSync: mocks.realpathSync,
    mkdirSync: mocks.mkdirSync,
    statSync: mocks.statSync,
    readdirSync: mocks.readdirSync,
    openSync: mocks.openSync,
    readSync: mocks.readSync,
    closeSync: mocks.closeSync,
    chmodSync: mocks.chmodSync,
    createWriteStream: mocks.createWriteStream,
    readFileSync: mocks.readFileSync,
    unlinkSync: mocks.unlinkSync,
    writeFileSync: mocks.writeFileSync,
    renameSync: mocks.renameSync,
    promises: mocks.promises,
  },
  existsSync: mocks.existsSync,
  lstatSync: mocks.lstatSync,
  realpathSync: mocks.realpathSync,
  mkdirSync: mocks.mkdirSync,
  statSync: mocks.statSync,
  readdirSync: mocks.readdirSync,
  openSync: mocks.openSync,
  readSync: mocks.readSync,
  closeSync: mocks.closeSync,
  chmodSync: mocks.chmodSync,
  createWriteStream: mocks.createWriteStream,
  readFileSync: mocks.readFileSync,
  unlinkSync: mocks.unlinkSync,
  writeFileSync: mocks.writeFileSync,
  renameSync: mocks.renameSync,
  promises: mocks.promises,
}));

vi.mock("node:crypto", () => ({
  randomBytes: mocks.randomBytes,
  randomUUID: mocks.randomUUID,
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
  execFileSync: mocks.execFileSync,
  spawnSync: mocks.spawnSync,
}));

vi.mock("../git/git", () => ({
  runGit: mocks.runGit,
}));

vi.mock("../../utils/ansiStrip", () => ({
  stripAnsi: mocks.stripAnsi,
}));

vi.mock("../../utils/sessionSummary", () => ({
  summarizeTerminalSession: mocks.summarizeTerminalSession,
}));

vi.mock("../../utils/terminalPreview", () => ({
  derivePreviewFromChunk: mocks.derivePreviewFromChunk,
}));

vi.mock("../../utils/terminalSessionSignals", async () => {
  const actual = await vi.importActual<typeof TerminalSessionSignals>(
    "../../utils/terminalSessionSignals",
  );
  return {
    ...actual,
    defaultResumeCommandForTool: mocks.defaultResumeCommandForTool,
    extractResumeCommandFromOutput: mocks.extractResumeCommandFromOutput,
    runtimeStateFromOsc133Chunk: mocks.runtimeStateFromOsc133Chunk,
  };
});

vi.mock("../opencode/openCodeBinaryManager", () => ({
  resolveOpenCodeBinaryPath: mocks.resolveOpenCodeBinaryPath,
}));

vi.mock("../../utils/codexComputerUse", () => ({
  resolveCodexComputerUseMcpConfig: mocks.resolveCodexComputerUseMcpConfig,
}));

import {
  createPtyService,
  ensureNodePtySpawnHelperExecutable,
  materializeRuntimeCliLaunch,
  PTY_AI_TITLE_DEBOUNCE_MS,
  PTY_AI_TITLE_TIMEOUT_MS,
  EARLY_CLI_AI_TITLE_DELAY_MS,
} from "./ptyService";
import { resolveBuiltInBrowserActorCapability } from "../builtInBrowser/builtInBrowserActorCapabilities";

const originalPlatform = process.platform;
const originalHome = process.env.HOME;
const originalShell = process.env.SHELL;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockPty(): IPty & { _emitter: EventEmitter } {
  const emitter = new EventEmitter();
  return {
    _emitter: emitter,
    pid: 12345,
    cols: 80,
    rows: 24,
    process: "/bin/zsh",
    handleFlowControl: false,
    onData: (cb: (data: string) => void) => {
      emitter.on("data", cb);
      return { dispose: () => { emitter.removeListener("data", cb); } };
    },
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      emitter.on("exit", cb);
      return { dispose: () => { emitter.removeListener("exit", cb); } };
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    clear: vi.fn(),
  } as any;
}

function createHarness(overrides: {
  aiIntegrationService?: {
    getMode: ReturnType<typeof vi.fn>;
    summarizeTerminal: ReturnType<typeof vi.fn>;
  } | null;
  processRegistry?: {
    pid: number;
    startedAt?: string | null;
    isPidLive: ReturnType<typeof vi.fn>;
    isProcessIdentityLive?: ReturnType<typeof vi.fn>;
  } | null;
  diskPressureMonitor?: {
    canPerform: ReturnType<typeof vi.fn>;
  } | null;
  getAdeCliAgentEnv?: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
} = {}) {
  const mockPty = createMockPty();
  const broadcastData = vi.fn();
  const broadcastExit = vi.fn();
  const onSessionEnded = vi.fn();
  const onSessionRuntimeSignal = vi.fn();

  const sessionStore = new Map<string, any>();
  const sessionService = {
    create: vi.fn((args: any) => {
      sessionStore.set(args.sessionId, {
        ...args,
        id: args.sessionId,
        status: "running",
        laneName: "Test lane",
        laneId: args.laneId,
        manuallyNamed: false,
        ownerPid: args.ownerPid ?? null,
        settledAt: null,
        attentionRequestedAt: null,
        attentionMessage: null,
        lastTurnFailedAt: null,
      });
    }),
    end: vi.fn((args: any) => {
      const s = sessionStore.get(args.sessionId);
      if (s) {
        s.status = args.status;
        s.exitCode = args.exitCode;
        s.endedAt = args.endedAt;
        s.ptyId = null;
      }
    }),
    reattach: vi.fn((args: any) => {
      const session = sessionStore.get(args.sessionId);
      if (!session) return null;
      Object.assign(session, {
        ptyId: args.ptyId,
        status: "running",
        endedAt: null,
        exitCode: null,
        ...(args.ownerPid !== undefined ? { ownerPid: args.ownerPid } : {}),
        ...(args.ownerProcessStartedAt !== undefined ? { ownerProcessStartedAt: args.ownerProcessStartedAt } : {}),
      });
      return session;
    }),
    get: vi.fn((id: string) => sessionStore.get(id) ?? null),
    list: vi.fn((args: { laneId?: string; status?: string; limit?: number | null; toolTypes?: string[] } = {}) => {
      const sessions = Array.from(sessionStore.values())
        .filter((session) => !args.laneId || session.laneId === args.laneId)
        .filter((session) => !args.status || session.status === args.status)
        .filter((session) => !args.toolTypes?.length || args.toolTypes.includes(session.toolType));
      return args.limit === null ? sessions : sessions.slice(0, args.limit ?? 200);
    }),
    setSummary: vi.fn(),
    setLastOutputPreview: vi.fn((sessionId: string, preview: string, opts?: { clearSettled?: boolean }) => {
      const session = sessionStore.get(sessionId);
      if (!session) return;
      session.lastOutputPreview = preview;
      session.lastOutputAt = new Date().toISOString();
      if (opts?.clearSettled) session.settledAt = null;
    }),
    touchSessionActivity: vi.fn((sessionId: string, at: string, opts?: { clearSettled?: boolean }) => {
      const session = sessionStore.get(sessionId);
      if (!session) return;
      session.lastOutputAt = at;
      if (opts?.clearSettled !== false) session.settledAt = null;
    }),
    settleSession: vi.fn((sessionId: string, opts?: { settledAt?: string }) => {
      const session = sessionStore.get(sessionId);
      if (!session) return false;
      session.settledAt = opts?.settledAt ?? new Date().toISOString();
      session.attentionRequestedAt = null;
      session.attentionMessage = null;
      return true;
    }),
    clearTurnStartMarkers: vi.fn((sessionId: string) => {
      const session = sessionStore.get(sessionId);
      if (!session) return false;
      session.settledAt = null;
      session.attentionRequestedAt = null;
      session.attentionMessage = null;
      session.lastTurnFailedAt = null;
      return true;
    }),
    clearAttentionRequest: vi.fn((sessionId: string) => {
      const session = sessionStore.get(sessionId);
      if (!session) return false;
      session.attentionRequestedAt = null;
      session.attentionMessage = null;
      return true;
    }),
    setResumeCommand: vi.fn((sessionId: string, resumeCommand: string | null) => {
      const session = sessionStore.get(sessionId);
      if (!session) return;
      session.resumeCommand = resumeCommand;
    }),
    setHeadShaStart: vi.fn(),
    setHeadShaEnd: vi.fn(),
    updateMeta: vi.fn((args: any) => {
      const session = sessionStore.get(args.sessionId);
      if (!session) return null;
      Object.assign(session, {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
        ...(args.manuallyNamed !== undefined ? { manuallyNamed: args.manuallyNamed } : {}),
        ...(args.resumeMetadata !== undefined ? { resumeMetadata: args.resumeMetadata } : {}),
      });
      return session;
    }),
    readTranscriptTail: vi.fn(async () => "transcript content"),
  };

  const laneService = {
    getLaneBaseAndBranch: vi.fn(() => ({
      worktreePath: "/tmp/test-worktree",
      baseRef: "origin/main",
      branchRef: "feature/test",
    })),
    attachLinearIssueToSession: vi.fn((args: { chatSessionId: string; issues: unknown[] }) =>
      args.issues.map((issue) => ({ issue }))),
  };

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const loadPty = vi.fn(() => ({
    spawn: vi.fn(() => mockPty),
  }));

  const service = createPtyService({
    projectRoot: "/tmp/test-project",
    transcriptsDir: "/tmp/transcripts",
    laneService: laneService as any,
    sessionService: sessionService as any,
    ...(overrides.processRegistry !== undefined ? { processRegistry: overrides.processRegistry as any } : {}),
    ...(overrides.aiIntegrationService ? { aiIntegrationService: overrides.aiIntegrationService as any } : {}),
    ...(overrides.diskPressureMonitor !== undefined ? { diskPressureMonitor: overrides.diskPressureMonitor as any } : {}),
    ...(overrides.getAdeCliAgentEnv ? { getAdeCliAgentEnv: overrides.getAdeCliAgentEnv } : {}),
    logger: logger as any,
    broadcastData,
    broadcastExit,
    onSessionEnded,
    onSessionRuntimeSignal,
    loadPty: loadPty as any,
  });

  return {
    service,
    mockPty,
    broadcastData,
    broadcastExit,
    onSessionEnded,
    onSessionRuntimeSignal,
    sessionService,
    laneService,
    logger,
    loadPty,
  };
}

function seedCodexRollout({
  id,
  cwd,
  startedAt,
  mtime,
  records = [],
  originator,
  parentThreadId,
}: {
  id: string;
  cwd: string;
  startedAt: string;
  mtime: number | string | Date;
  records?: unknown[];
  /** Mirrors `session_meta.payload.originator` — ADE's per-launch nonce lands here. */
  originator?: string;
  /** Set on subagent rollouts, which fork from a parent thread. */
  parentThreadId?: string;
}): { filePath: string; body: string } {
  const date = new Date(startedAt);
  const sessionsBase = path.join(os.homedir(), ".codex", "sessions");
  const dirPath = path.join(
    sessionsBase,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  );
  const filePath = path.join(dirPath, `rollout-${startedAt.replace(/[:.]/g, "-")}-${id}.jsonl`);
  const body = [
    JSON.stringify({
      timestamp: startedAt,
      type: "session_meta",
      payload: {
        id,
        timestamp: startedAt,
        cwd,
        ...(originator ? { originator } : {}),
        ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
      },
    }),
    ...records.map((record) => JSON.stringify(record)),
  ].join("\n") + "\n";
  const mtimeMs = mtime instanceof Date
    ? mtime.getTime()
    : typeof mtime === "number"
      ? mtime
      : Date.parse(mtime);

  mocks.existsSyncResults.set(sessionsBase, true);
  mocks.existsSyncResults.set(dirPath, true);
  mocks.dirEntries.set(dirPath, Array.from(new Set([
    ...(mocks.dirEntries.get(dirPath) ?? []),
    path.basename(filePath),
  ])));
  mocks.fileContents.set(filePath, body);
  mocks.fileStats.set(filePath, {
    size: Buffer.byteLength(body, "utf8"),
    mtimeMs,
    isDirectory: false,
  });
  return { filePath, body };
}

/** Mirrors `workTabCliPrompt`: a fixed ADE preamble, then the user's prompt. */
function adeCodexPrompt(userPrompt: string): string {
  return [
    "ADE session guidance. Treat this as operating guidance for the CLI session",
    "and keep it in mind while handling the user prompt below.",
    "",
    "User prompt:",
    userPrompt,
  ].join("\n");
}

const OWNED_PROMPT = "extract the pty pump helpers and keep the transcript tests green";

/** A user turn as Codex records it in the rollout — the text lands JSON-escaped. */
function codexUserMessageRecord(text: string): unknown {
  return {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}

function createDetachedResumableSession(
  sessionService: ReturnType<typeof createHarness>["sessionService"],
  {
    sessionId,
    startedAt = "2026-04-09T12:00:00.000Z",
    endedAt = "2026-04-09T12:30:00.000Z",
  }: {
    sessionId: string;
    startedAt?: string;
    endedAt?: string;
  },
): void {
  sessionService.create({
    sessionId,
    laneId: "lane-1",
    ptyId: null,
    tracked: true,
    title: "Claude CLI",
    startedAt,
    transcriptPath: `/tmp/transcripts/${sessionId}.log`,
    toolType: "claude",
    resumeCommand: "claude --resume claude-session-123",
    resumeMetadata: {
      provider: "claude",
      targetKind: "session",
      targetId: "claude-session-123",
      launch: { permissionMode: "default" },
    },
  });
  sessionService.end({
    sessionId,
    endedAt,
    exitCode: null,
    status: "detached",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ptyService", () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalShell == null) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Most fixtures below exercise the long-standing POSIX PTY contract. Keep
    // that platform explicit so running the suite on Windows does not silently
    // turn every default shell/process-group assertion into a ConPTY one.
    // Windows-native cases opt back into win32 with setPlatform("win32").
    setPlatform("linux");
    process.env.HOME = "/Users/ade-test";
    process.env.SHELL = "/bin/zsh";
    mocks.existsSyncResults.clear();
    mocks.realpathOverrides.clear();
    mocks.dirEntries.clear();
    mocks.fileContents.clear();
    mocks.fileStats.clear();
    mocks.openFiles.clear();
    const resolveRealpath = (p: string) => mocks.realpathOverrides.get(p) ?? path.resolve(p);
    mocks.realpathSync.mockImplementation((p: string) => resolveRealpath(p));
    mocks.realpathSync.native.mockImplementation((p: string) => resolveRealpath(p));
    mocks.existsSyncResults.set("/tmp/test-worktree", true);
    let counter = 0;
    mocks.randomUUID.mockImplementation(() => `uuid-${++counter}`);
    mocks.runtimeStateFromOsc133Chunk.mockReturnValue("running");
    mocks.defaultResumeCommandForTool.mockReturnValue(null);
    mocks.extractResumeCommandFromOutput.mockReturnValue(null);
    mocks.derivePreviewFromChunk.mockReturnValue({ nextLine: "", preview: "preview" });
    mocks.resolveOpenCodeBinaryPath.mockReturnValue(null);
    mocks.resolveCodexComputerUseMcpConfig.mockResolvedValue(null);
    mocks.execFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        (callback as (...callbackArgs: unknown[]) => void)(null, "", "");
      }
      return { kill: vi.fn() };
    });
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
  });

  it("materializes fresh provider launch wrappers on the owning runtime platform", () => {
    const launch = {
      provider: "droid" as const,
      permissionMode: "full-auto" as const,
      model: "droid/model-a",
      initialPrompt: "Inspect the remote lane.",
    };

    setPlatform("win32");
    const windows = materializeRuntimeCliLaunch(launch, "C:\\repo\\lane");
    expect(windows.command).toBe("powershell.exe");
    expect(windows.env?.ADE_AGENT_SKILLS_DIRS).toContain(";");

    setPlatform("linux");
    const linux = materializeRuntimeCliLaunch(launch, "/repo/lane");
    expect(linux.command).toBe("/bin/bash");
    expect(linux.env?.ADE_AGENT_SKILLS_DIRS).toMatch(/^\/repo\/lane\/\.cursor\/skills:/);
    expect(linux.env?.ADE_AGENT_SKILLS_DIRS).not.toContain(";");
  });

  describe("resource attribution roots", () => {
    it("classifies live PTY roots from explicit spawn metadata without sampling processes", async () => {
      const { service } = createHarness();

      await service.create({
        laneId: "lane-1",
        title: "Interactive shell",
        cols: 80,
        rows: 24,
      });
      mocks.spawnSync.mockClear();

      const attribution = service.getResourceAttribution();

      expect(mocks.spawnSync).not.toHaveBeenCalled();
      expect(attribution).toEqual({
        activePtyCount: 1,
        roots: [{ pid: 12345, kind: "shell" }],
      });
    });

    it("classifies tracked provider CLIs as provider-agent roots", async () => {
      const { service } = createHarness();

      await service.create({
        laneId: "lane-1",
        title: "Codex session",
        cols: 80,
        rows: 24,
        toolType: "codex",
        startupCommand: "codex",
      });

      expect(service.getResourceAttribution()).toEqual({
        activePtyCount: 1,
        roots: [{ pid: 12345, kind: "provider-agent" }],
      });
    });

    it("reports no roots when no PTYs are active", () => {
      const { service } = createHarness();
      expect(service.getResourceAttribution()).toEqual({ activePtyCount: 0, roots: [] });
    });
  });

  describe("ensureNodePtySpawnHelperExecutable", () => {
    it("adds executable bits to the Darwin node-pty spawn helper", () => {
      const packageRoot = "/tmp/node-pty";
      const helperPath = path.join(packageRoot, "prebuilds", "darwin-arm64", "spawn-helper");
      mocks.fileStats.set(helperPath, { size: 123, mode: 0o100644, isDirectory: false } as any);

      const result = ensureNodePtySpawnHelperExecutable({
        packageRoot,
        platform: "darwin",
        arch: "arm64",
      });

      expect(result).toEqual({ status: "chmod_applied", path: helperPath });
      expect(mocks.chmodSync).toHaveBeenCalledWith(helperPath, 0o100755);
    });

    it("leaves already executable Darwin node-pty spawn helpers alone", () => {
      const packageRoot = "/tmp/node-pty";
      const helperPath = path.join(packageRoot, "prebuilds", "darwin-arm64", "spawn-helper");
      mocks.fileStats.set(helperPath, { size: 123, mode: 0o100755, isDirectory: false } as any);

      const result = ensureNodePtySpawnHelperExecutable({
        packageRoot,
        platform: "darwin",
        arch: "arm64",
      });

      expect(result).toEqual({ status: "already_executable", path: helperPath });
      expect(mocks.chmodSync).not.toHaveBeenCalled();
    });

    it("skips non-Darwin platforms", () => {
      const result = ensureNodePtySpawnHelperExecutable({
        packageRoot: "/tmp/node-pty",
        platform: "linux",
        arch: "arm64",
      });

      expect(result).toEqual({ status: "skipped", reason: "non_darwin" });
      expect(mocks.chmodSync).not.toHaveBeenCalled();
    });
  });

  describe("create", () => {
    it("creates a PTY and returns ptyId, sessionId, and pid", async () => {
      const { service } = createHarness();
      const result = await service.create({
        laneId: "lane-1",
        title: "Test terminal",
        cols: 80,
        rows: 24,
      });
      expect(result.ptyId).toBe("uuid-1");
      expect(result.sessionId).toBe("uuid-2");
      expect(result.pid).toBe(12345);
    });

    it("attaches requested Linear issues to the new session before spawn (FIX 5)", async () => {
      const { service, laneService } = createHarness();
      const issue = { id: "issue-1", identifier: "ADE-77" };
      const result = await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        tracked: true,
        linearIssues: [issue as any],
      });

      // The attach runs against the freshly-created session id so the lane mirror
      // lands and getSessionLinearEnv can resolve ADE_LINEAR_* for the spawn.
      expect(laneService.attachLinearIssueToSession).toHaveBeenCalledWith(
        expect.objectContaining({
          chatSessionId: result.sessionId,
          issues: [issue],
        }),
      );
    });

    it("does not attach Linear issues when none are requested", async () => {
      const { service, laneService } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "Plain shell",
        cols: 80,
        rows: 24,
        tracked: true,
      });
      expect(laneService.attachLinearIssueToSession).not.toHaveBeenCalled();
    });

    it("waits for a supervised PTY host spawn before returning", async () => {
      const { service, mockPty } = createHarness();
      let resolveReady!: () => void;
      (mockPty as unknown as IPty & { __adePtyHostReady: Promise<void> }).__adePtyHostReady = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });

      let settled = false;
      const resultPromise = service.create({
        laneId: "lane-1",
        title: "Hosted terminal",
        cols: 80,
        rows: 24,
      }).then((result) => {
        settled = true;
        return result;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);

      resolveReady();
      const result = await resultPromise;
      expect(settled).toBe(true);
      expect(result.pid).toBe(12345);
    });

    it("keeps the PTY live when transcript persistence hits ENOSPC", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, broadcastData, logger } = createHarness();
        const created = await service.create({
          laneId: "lane-1",
          title: "Test terminal",
          cols: 80,
          rows: 24,
        });
        const stream = mocks.createWriteStream.mock.results.at(-1)?.value as {
          write: ReturnType<typeof vi.fn>;
          destroy: ReturnType<typeof vi.fn>;
          _emitError: (err: Error) => void;
        };
        const error = new Error("ENOSPC: no space left on device, write") as NodeJS.ErrnoException;
        error.code = "ENOSPC";

        stream._emitError(error);
        stream.write.mockClear();
        mockPty._emitter.emit("data", "still live after disk-full transcript failure");
        await vi.advanceTimersByTimeAsync(60);

        expect(stream.destroy).toHaveBeenCalled();
        expect(stream.write).not.toHaveBeenCalled();
        expect(broadcastData).toHaveBeenCalledWith(expect.objectContaining({
          sessionId: created.sessionId,
          data: "still live after disk-full transcript failure",
        }));
        expect(logger.warn).toHaveBeenCalledWith("pty.transcript_write_failed", expect.objectContaining({
          sessionId: created.sessionId,
          code: "ENOSPC",
        }));
      } finally {
        vi.useRealTimers();
      }
    });

    it("starts plain shell sessions as login shells with user startup files", async () => {
      const previousShell = process.env.SHELL;
      process.env.SHELL = "/bin/zsh";
      try {
        const { service, loadPty } = createHarness();
        await service.create({
          laneId: "lane-1",
          title: "Shell",
          cols: 80,
          rows: 24,
          toolType: "shell",
        });

        const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        expect(ptyLib.spawn).toHaveBeenCalledWith(
          "/bin/zsh",
          ["-l"],
          expect.objectContaining({
            env: expect.not.objectContaining({
              ZDOTDIR: "/var/empty",
            }),
          }),
        );
      } finally {
        if (previousShell == null) delete process.env.SHELL;
        else process.env.SHELL = previousShell;
      }
    });

    it("starts command-backed shell sessions without reading user startup files", async () => {
      const previousShell = process.env.SHELL;
      const previousPath = process.env.PATH;
      process.env.SHELL = "/bin/zsh";
      process.env.PATH = "/usr/bin";
      mocks.execFileSync.mockImplementation((_file, args) => {
        const shellFlag = Array.isArray(args) ? args[0] : null;
        if (shellFlag === "-lc") return "__ADE_PATH_START__/login/bin:/usr/bin__ADE_PATH_END__";
        if (shellFlag === "-ic") return "__ADE_PATH_START__/custom/nvm/bin:/usr/bin__ADE_PATH_END__";
        return "";
      });
      try {
        const { service, loadPty, mockPty } = createHarness();
        await service.create({
          laneId: "lane-1",
          title: "Shell command",
          cols: 80,
          rows: 24,
          toolType: "shell",
          startupCommand: "npm test",
        });

        const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        expect(ptyLib.spawn).toHaveBeenCalledWith(
          "/bin/zsh",
          ["-f"],
          expect.objectContaining({
            env: expect.objectContaining({
              ZDOTDIR: "/var/empty",
            }),
          }),
        );
        const opts = ptyLib.spawn.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
        const pathEntries = opts?.env?.PATH?.split(path.delimiter) ?? [];
        expect(pathEntries).toEqual(expect.arrayContaining([
          "/usr/bin",
          "/login/bin",
          "/custom/nvm/bin",
          "/opt/homebrew/bin",
          path.join(os.homedir(), ".asdf", "shims"),
          path.join(os.homedir(), ".mise", "shims"),
        ]));
        expect(mocks.execFileSync).toHaveBeenCalledWith(
          "/bin/zsh",
          ["-ic", expect.stringContaining("__ADE_PATH_START__")],
          expect.objectContaining({ env: expect.objectContaining({ SHELL: "/bin/zsh" }) }),
        );
        expect(mockPty.write).toHaveBeenCalledWith("npm test\r");
      } finally {
        if (previousShell == null) delete process.env.SHELL;
        else process.env.SHELL = previousShell;
        if (previousPath == null) delete process.env.PATH;
        else process.env.PATH = previousPath;
        mocks.execFileSync.mockImplementation(() => "");
      }
    });

    it("honors cmd.exe for native Windows shell sessions", async () => {
      const previousShell = process.env.SHELL;
      setPlatform("win32");
      process.env.SHELL = "cmd.exe";
      try {
        const { service, loadPty } = createHarness();
        await service.create({
          laneId: "lane-1",
          title: "Command Prompt",
          cols: 80,
          rows: 24,
          toolType: "shell",
        });

        const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        expect(ptyLib.spawn).toHaveBeenCalledWith("cmd.exe", [], expect.any(Object));
      } finally {
        setPlatform(originalPlatform);
        if (previousShell == null) delete process.env.SHELL;
        else process.env.SHELL = previousShell;
      }
    });

    it("starts configured Git Bash cleanly without routing through WSL", async () => {
      const previousShell = process.env.SHELL;
      setPlatform("win32");
      process.env.SHELL = "C:\\Program Files\\Git\\bin\\bash.exe";
      try {
        const { service, loadPty } = createHarness();
        await service.create({
          laneId: "lane-1",
          title: "Git Bash command",
          cols: 80,
          rows: 24,
          toolType: "shell",
          startupCommand: "npm test",
        });

        const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        expect(ptyLib.spawn).toHaveBeenCalledWith(
          "C:\\Program Files\\Git\\bin\\bash.exe",
          ["--noprofile", "--norc"],
          expect.objectContaining({ env: expect.objectContaining({ BASH_ENV: "" }) }),
        );
        expect(ptyLib.spawn).not.toHaveBeenCalledWith("wsl.exe", expect.anything(), expect.anything());
      } finally {
        setPlatform(originalPlatform);
        if (previousShell == null) delete process.env.SHELL;
        else process.env.SHELL = previousShell;
      }
    });

    it("uses a caller-provided sessionId when creating a new tracked session", async () => {
      const { service, sessionService } = createHarness();
      const result = await service.create({
        sessionId: "session-process-start",
        laneId: "lane-1",
        title: "Test terminal",
        cols: 80,
        rows: 24,
      });

      expect(result.ptyId).toBe("uuid-1");
      expect(result.sessionId).toBe("session-process-start");
      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-process-start",
          laneId: "lane-1",
        }),
      );
    });

    it("can spawn a direct command with merged lane env", async () => {
      const harness = createHarness();
      const getLaneRuntimeEnv = vi.fn(async () => ({
        PORT: "3100",
        HOSTNAME: "lane-1.localhost",
      }));
      const ptyService = createPtyService({
        projectRoot: "/tmp/test-project",
        transcriptsDir: "/tmp/transcripts",
        laneService: harness.laneService as any,
        sessionService: harness.sessionService as any,
        getLaneRuntimeEnv,
        logger: harness.logger as any,
        broadcastData: vi.fn(),
        broadcastExit: vi.fn(),
        onSessionEnded: vi.fn(),
        onSessionRuntimeSignal: vi.fn(),
        loadPty: harness.loadPty as any,
      });

      await ptyService.create({
        laneId: "lane-1",
        title: "Direct command",
        cols: 80,
        rows: 24,
        command: "npm",
        args: ["run", "dev"],
        env: { CUSTOM_FLAG: "1", TERM: "", COLORTERM: "", FORCE_COLOR: "", NO_COLOR: "" },
      });

      const ptyLib = harness.loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      expect(ptyLib.spawn).toHaveBeenCalledWith(
        "npm",
        ["run", "dev"],
        expect.objectContaining({
          env: expect.objectContaining({
            PORT: "3100",
            HOSTNAME: "lane-1.localhost",
            CUSTOM_FLAG: "1",
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            NO_COLOR: "",
            FORCE_COLOR: "",
          }),
        }),
      );
    });

    it("uses ADE's bundled OpenCode runtime for direct OpenCode CLI terminals", async () => {
      const bundledOpenCode = "/Applications/ADE.app/Contents/Resources/app.asar.unpacked/node_modules/opencode-darwin-arm64/bin/opencode";
      mocks.resolveOpenCodeBinaryPath.mockReturnValue(bundledOpenCode);
      const { service, loadPty, mockPty } = createHarness();

      await service.create({
        laneId: "lane-1",
        title: "OpenCode CLI",
        cols: 80,
        rows: 24,
        toolType: "opencode",
        command: "opencode",
        args: ["--model", "openai/gpt-5.4", "--prompt", "fix the test"],
        startupCommand: "OPENCODE_CONFIG_CONTENT='{}' opencode --model openai/gpt-5.4 --prompt 'fix the test'",
      });

      const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      expect(ptyLib.spawn).toHaveBeenCalledWith(
        bundledOpenCode,
        ["--model", "openai/gpt-5.4", "--prompt", "fix the test"],
        expect.any(Object),
      );
      expect(mockPty.write).not.toHaveBeenCalled();
    });

    it("uses ADE's bundled OpenCode runtime when typing OpenCode startup commands", async () => {
      mocks.resolveOpenCodeBinaryPath.mockReturnValue("/tmp/ADE Runtime/opencode");
      const { service, mockPty } = createHarness();

      await service.create({
        laneId: "lane-1",
        title: "OpenCode resume",
        cols: 80,
        rows: 24,
        toolType: "opencode",
        startupCommand: "OPENCODE_CONFIG_CONTENT='{}' opencode --continue",
      });

      expect(mockPty.write).toHaveBeenCalledWith("OPENCODE_CONFIG_CONTENT='{}' '/tmp/ADE Runtime/opencode' --continue\r");
    });

    it("exports ADE chat terminal context to spawned shells", async () => {
      const { service, loadPty } = createHarness();

      await service.create({
        laneId: "lane-1",
        title: "Chat context",
        cols: 80,
        rows: 24,
        chatSessionId: "chat-42",
      });

      const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      const spawnArgs = ptyLib.spawn.mock.calls.at(-1);
      const opts = spawnArgs?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(opts?.env).toEqual(expect.objectContaining({
        ADE_CHAT_SESSION_ID: "chat-42",
        ADE_LANE_ID: "lane-1",
        ADE_PROJECT_ROOT: "/tmp/test-project",
      }));
      expect(opts?.env?.ADE_DEFAULT_ROLE).not.toBe("agent");
    });

    it("exports tracked CLI session identity as the attached terminal owner", async () => {
      const { service, loadPty } = createHarness();

      const result = await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        command: "codex",
      });

      const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      const spawnArgs = ptyLib.spawn.mock.calls.at(-1);
      const opts = spawnArgs?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(opts?.env).toEqual(expect.objectContaining({
        ADE_DEFAULT_ROLE: "agent",
        ADE_CHAT_SESSION_ID: result.sessionId,
        ADE_LANE_ID: "lane-1",
        ADE_PROJECT_ROOT: "/tmp/test-project",
      }));
      const actorToken = opts?.env?.ADE_BROWSER_ACTOR_TOKEN;
      expect(resolveBuiltInBrowserActorCapability(actorToken)).toMatchObject({
        chatSessionId: result.sessionId,
        laneId: "lane-1",
        projectRoot: "/tmp/test-project",
      });

      service.dispose({ ptyId: result.ptyId, sessionId: result.sessionId });

      expect(resolveBuiltInBrowserActorCapability(actorToken)).toBeNull();
    });

    it("exports spawn lineage without replacing the tracked CLI session identity", async () => {
      const { service, loadPty } = createHarness();

      const result = await service.create({
        laneId: "lane-1",
        title: "Codex child",
        cols: 80,
        rows: 24,
        toolType: "codex",
        command: "codex",
        spawnLineage: {
          parentChatSessionId: "parent-session-1",
          spawnKind: null,
        },
      });

      const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      const spawnArgs = ptyLib.spawn.mock.calls.at(-1);
      const opts = spawnArgs?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(opts?.env).toEqual(expect.objectContaining({
        ADE_CHAT_SESSION_ID: result.sessionId,
        ADE_PARENT_CHAT_SESSION_ID: "parent-session-1",
        ADE_SPAWN_KIND: "",
      }));
      expect(opts?.env?.ADE_CHAT_SESSION_ID).not.toBe("parent-session-1");
    });

    it("strips inherited parent lineage env when the launch has no spawn lineage", async () => {
      const previousParent = process.env.ADE_PARENT_CHAT_SESSION_ID;
      const previousKind = process.env.ADE_SPAWN_KIND;
      // The daemon can itself run inside a spawned agent shell; those inherited
      // vars must not leak into terminals created without lineage.
      process.env.ADE_PARENT_CHAT_SESSION_ID = "inherited-parent";
      process.env.ADE_SPAWN_KIND = "subagent";
      try {
        const { service, loadPty } = createHarness();
        await service.create({
          laneId: "lane-1",
          title: "Codex plain",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
        });
        const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        const opts = ptyLib.spawn.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
        expect(opts?.env).toBeDefined();
        expect(opts?.env).not.toHaveProperty("ADE_PARENT_CHAT_SESSION_ID");
        expect(opts?.env).not.toHaveProperty("ADE_SPAWN_KIND");
      } finally {
        if (previousParent === undefined) delete process.env.ADE_PARENT_CHAT_SESSION_ID;
        else process.env.ADE_PARENT_CHAT_SESSION_ID = previousParent;
        if (previousKind === undefined) delete process.env.ADE_SPAWN_KIND;
        else process.env.ADE_SPAWN_KIND = previousKind;
      }
    });

    it("publishes an explicit waiting-input runtime state for a live tracked CLI", async () => {
      const { service, onSessionRuntimeSignal } = createHarness();
      const result = await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        command: "codex",
      });
      onSessionRuntimeSignal.mockClear();

      expect(service.setSessionRuntimeState(result.sessionId, "waiting-input")).toBe(true);
      expect(service.getRuntimeState(result.sessionId, "running")).toBe("waiting-input");
      expect(onSessionRuntimeSignal).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-1",
        sessionId: result.sessionId,
        runtimeState: "waiting-input",
      }));
    });

    it("refuses only new tracked CLI launches when storage is exhausted", async () => {
      let exhausted = false;
      const canPerform = vi.fn(() => exhausted
        ? {
            allowed: false,
            state: "exhausted",
            code: "disk_full",
            message: "Your computer is almost out of storage. ADE can't safely start a new CLI session until you free up space.",
          }
        : { allowed: true, state: "normal" });
      const { service, loadPty } = createHarness({ diskPressureMonitor: { canPerform } });

      const existing = await service.create({
        laneId: "lane-1",
        title: "Existing Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        command: "codex",
      });
      exhausted = true;

      await expect(service.create({
        laneId: "lane-1",
        title: "New Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        command: "codex",
      })).rejects.toMatchObject({
        code: "disk_full",
        message: "Your computer is almost out of storage. ADE can't safely start a new CLI session until you free up space.",
      });
      await expect(service.create({
        laneId: "lane-1",
        sessionId: existing.sessionId,
        title: "Existing Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        command: "codex",
      })).resolves.toMatchObject({ sessionId: existing.sessionId });
      await expect(service.create({
        laneId: "lane-1",
        title: "Plain shell",
        cols: 80,
        rows: 24,
        toolType: "shell",
      })).resolves.toBeTruthy();

      expect(canPerform).toHaveBeenCalledTimes(2);
      const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      expect(ptyLib.spawn).toHaveBeenCalled();
      const refusal = canPerform.mock.results.find((result) => result.value.allowed === false)?.value.message;
      expectNoJargon(refusal);
    });

    it("does not leak an inherited ADE chat session into unlinked terminals", async () => {
      const previous = process.env.ADE_CHAT_SESSION_ID;
      process.env.ADE_CHAT_SESSION_ID = "outer-chat";
      try {
        const { service, loadPty } = createHarness();

        await service.create({
          laneId: "lane-1",
          title: "Unlinked terminal",
          cols: 80,
          rows: 24,
        });

        const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        const spawnArgs = ptyLib.spawn.mock.calls.at(-1);
        const opts = spawnArgs?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
        expect(opts?.env?.ADE_CHAT_SESSION_ID).toBeUndefined();
        expect(opts?.env).toEqual(expect.objectContaining({
          ADE_LANE_ID: "lane-1",
          ADE_PROJECT_ROOT: "/tmp/test-project",
        }));
      } finally {
        if (previous === undefined) delete process.env.ADE_CHAT_SESSION_ID;
        else process.env.ADE_CHAT_SESSION_ID = previous;
      }
    });

    it("preserves explicit terminal color environment overrides", async () => {
      const { service, loadPty } = createHarness();

      await service.create({
        laneId: "lane-1",
        title: "Color env",
        cols: 80,
        rows: 24,
        env: {
          TERM: "screen-256color",
          COLORTERM: "24bit",
          FORCE_COLOR: "2",
        },
      });

      const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      const spawnArgs = ptyLib.spawn.mock.calls.at(-1);
      const opts = spawnArgs?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(opts?.env).toEqual(expect.objectContaining({
        TERM: "screen-256color",
        COLORTERM: "24bit",
        FORCE_COLOR: "2",
      }));
    });

    it("does not force color when NO_COLOR is set", async () => {
      const { service, loadPty } = createHarness();

      await service.create({
        laneId: "lane-1",
        title: "No color env",
        cols: 80,
        rows: 24,
        env: {
          NO_COLOR: "1",
          FORCE_COLOR: "",
        },
      });

      const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      const spawnArgs = ptyLib.spawn.mock.calls.at(-1);
      const opts = spawnArgs?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(opts?.env).toEqual(expect.objectContaining({
        NO_COLOR: "1",
        FORCE_COLOR: "",
      }));
    });

    it("does not force color when NO_COLOR is explicitly empty", async () => {
      const { service, loadPty } = createHarness();

      await service.create({
        laneId: "lane-1",
        title: "Empty no color env",
        cols: 80,
        rows: 24,
        env: {
          NO_COLOR: "",
        },
      });

      const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      const spawnArgs = ptyLib.spawn.mock.calls.at(-1);
      const opts = spawnArgs?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(opts?.env).toEqual(expect.objectContaining({
        NO_COLOR: "",
      }));
      expect(opts?.env?.FORCE_COLOR).toBeUndefined();
    });

    it("does not leak inherited NO_COLOR into interactive terminal launches", async () => {
      const previousNoColor = process.env.NO_COLOR;
      const previousForceColor = process.env.FORCE_COLOR;
      process.env.NO_COLOR = "1";
      delete process.env.FORCE_COLOR;
      try {
        const { service, loadPty } = createHarness();

        await service.create({
          laneId: "lane-1",
          title: "Inherited color env",
          cols: 80,
          rows: 24,
        });

        const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        const spawnArgs = ptyLib.spawn.mock.calls.at(-1);
        const opts = spawnArgs?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
        expect(opts?.env?.NO_COLOR).toBeUndefined();
        expect(opts?.env).toEqual(expect.objectContaining({
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          FORCE_COLOR: "1",
        }));
      } finally {
        if (previousNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = previousNoColor;
        if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
        else process.env.FORCE_COLOR = previousForceColor;
      }
    });

    it("does not type startupCommand preview into direct command sessions", async () => {
      const { service, mockPty } = createHarness();

      await service.create({
        laneId: "lane-1",
        title: "Direct worker",
        cols: 80,
        rows: 24,
        command: "codex",
        args: ["exec", "-"],
        startupCommand: "ADE_RUN_ID=run-1 exec codex exec - < prompt.txt",
      });

      expect(mockPty.write).not.toHaveBeenCalled();
    });

    it("sends direct command initialInput separately from startupCommand previews", async () => {
      const { service, mockPty } = createHarness();

      await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        command: "codex",
        args: ["--no-alt-screen", "--model", "gpt-5.4"],
        startupCommand: "codex --no-alt-screen --model gpt-5.4",
        initialInput: "ADE session guidance\r\nUser prompt:\r\nhello",
      });

      expect(mockPty.write).toHaveBeenCalledTimes(1);
      expect(mockPty.write).toHaveBeenCalledWith("\x1b[200~ADE session guidance\nUser prompt:\nhello\x1b[201~\r");
    });

    it("injects the validated bundled plugin into tracked Claude CLI launches", async () => {
      const pluginRoot = "/Applications/ADE.app/Contents/Resources/agent-skills";
      const repositoryPluginRoot = "/tmp/lane/apps/desktop/resources/agent-skills";
      mocks.fileStats.set(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { isDirectory: false });
      mocks.fileStats.set(path.join(repositoryPluginRoot, ".claude-plugin", "plugin.json"), { isDirectory: false });
      const { service, loadPty } = createHarness({
        getAdeCliAgentEnv: (env) => ({
          ...env,
          ADE_AGENT_SKILLS_DIRS: [repositoryPluginRoot, pluginRoot].join(path.delimiter),
          ADE_BUNDLED_AGENT_SKILLS_DIR: pluginRoot,
        }),
      });

      await service.create({
        laneId: "lane-1",
        title: "Claude CLI",
        cols: 80,
        rows: 24,
        toolType: "claude",
        command: "claude",
        args: ["--plugin-dir=/tmp/custom-plugin", "--permission-mode", "default"],
        startupCommand: "claude --plugin-dir=/tmp/custom-plugin --permission-mode default",
      });

      const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      expect(ptyLib.spawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["--plugin-dir", pluginRoot]),
        expect.any(Object),
      );
      expect(ptyLib.spawn.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining([
        "--plugin-dir=/tmp/custom-plugin",
      ]));
      expect(ptyLib.spawn.mock.calls.at(-1)?.[1]).not.toEqual(expect.arrayContaining([
        repositoryPluginRoot,
      ]));
    });

    it("injects the bundled Claude plugin into env-prefixed shell fallback commands", async () => {
      const pluginRoot = "/Applications/ADE Preview.app/Contents/Resources/agent-skills";
      mocks.fileStats.set(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { isDirectory: false });
      const { service, mockPty, loadPty } = createHarness({
        getAdeCliAgentEnv: (env) => ({
          ...env,
          ADE_AGENT_SKILLS_DIRS: pluginRoot,
          ADE_BUNDLED_AGENT_SKILLS_DIR: pluginRoot,
        }),
      });
      const spawn = vi.fn((command: string) => {
        if (command === "claude") throw new Error("ENOENT");
        return mockPty;
      });
      loadPty.mockImplementationOnce(() => ({ spawn: spawn as any }));

      await service.create({
        laneId: "lane-1",
        title: "Claude CLI",
        cols: 80,
        rows: 24,
        toolType: "claude",
        command: "claude",
        args: ["--plugin-dir=/tmp/custom-plugin", "--permission-mode", "default"],
        startupCommand: "ADE_RUN_ID='run 1' ADE_DEFAULT_ROLE=agent claude --plugin-dir=/tmp/custom-plugin --permission-mode default",
      });

      expect(mockPty.write).toHaveBeenCalledWith(
        "ADE_RUN_ID='run 1' ADE_DEFAULT_ROLE=agent claude --plugin-dir \"/Applications/ADE Preview.app/Contents/Resources/agent-skills\" --plugin-dir=/tmp/custom-plugin --permission-mode default\r",
      );
    });

    it("does not duplicate the bundled Claude plugin in env-prefixed startup commands", async () => {
      const pluginRoot = "/Applications/ADE Preview.app/Contents/Resources/agent-skills";
      mocks.fileStats.set(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { isDirectory: false });
      const startupCommand = `ADE_RUN_ID=run-1 claude --plugin-dir "${pluginRoot}" --plugin-dir=/tmp/custom-plugin`;
      const { service, mockPty } = createHarness({
        getAdeCliAgentEnv: (env) => ({
          ...env,
          ADE_AGENT_SKILLS_DIRS: pluginRoot,
          ADE_BUNDLED_AGENT_SKILLS_DIR: pluginRoot,
        }),
      });

      await service.create({
        laneId: "lane-1",
        title: "Claude CLI",
        cols: 80,
        rows: 24,
        toolType: "claude",
        startupCommand,
      });

      expect(mockPty.write).toHaveBeenCalledWith(`${startupCommand}\r`);
    });

    it("routes the bundled Claude plugin into the -lc command line of shell-wrapped resume launches", async () => {
      // Regression: resume/reattach launches spawn `/bin/bash --noprofile
      // --norc -lc "claude …"`. Prepending --plugin-dir to that argv makes
      // bash itself die with "invalid option" (exit 2), which used to kill
      // every Claude resume.
      const pluginRoot = "/Applications/ADE.app/Contents/Resources/agent-skills";
      mocks.fileStats.set(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { isDirectory: false });
      const { service, loadPty } = createHarness({
        getAdeCliAgentEnv: (env) => ({
          ...env,
          ADE_AGENT_SKILLS_DIRS: pluginRoot,
          ADE_BUNDLED_AGENT_SKILLS_DIR: pluginRoot,
        }),
      });

      await service.create({
        laneId: "lane-1",
        title: "Claude CLI",
        cols: 80,
        rows: 24,
        toolType: "claude",
        command: "/bin/bash",
        args: ["--noprofile", "--norc", "-lc", "claude --resume claude-session-123"],
      });

      const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      const [spawnedCommand, spawnedArgs] = ptyLib.spawn.mock.calls.at(-1) as [string, string[]];
      expect(spawnedCommand).toBe("/bin/bash");
      // bash's own argv must be untouched apart from the rewritten -lc payload.
      expect(spawnedArgs.slice(0, 3)).toEqual(["--noprofile", "--norc", "-lc"]);
      expect(spawnedArgs).toHaveLength(4);
      expect(spawnedArgs[3]).toBe(`claude --plugin-dir "${pluginRoot}" --resume claude-session-123`);
    });

    it("keeps a resumable session's prior status when the resume launch dies immediately", async () => {
      // Regression: a resume whose spawned shell exits nonzero right away used
      // to stamp the reused row failed/exit-2, making a still-resumable
      // detached session look permanently dead.
      const { service, sessionService, mockPty } = createHarness();
      createDetachedResumableSession(sessionService, { sessionId: "session-resume-status" });

      await service.create({
        sessionId: "session-resume-status",
        laneId: "lane-1",
        title: "Claude CLI",
        cols: 80,
        rows: 24,
        toolType: "claude",
        startupCommand: "claude --resume claude-session-123",
      });

      mockPty._emitter.emit("exit", { exitCode: 2 });

      const session = sessionService.get("session-resume-status");
      expect(session.status).toBe("detached");
      expect(session.exitCode).toBeNull();
      expect(session.endedAt).toBe("2026-04-09T12:30:00.000Z");
    });

    it("does not restore a stale running status when a resume launch dies immediately", async () => {
      // A brain restart can leave a running row without a live PTY. That row
      // is eligible for relaunch, but it is not a valid prior end state.
      const { service, sessionService, mockPty } = createHarness();
      sessionService.create({
        sessionId: "session-stale-running",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Claude CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-stale-running.log",
        toolType: "claude",
        resumeCommand: "claude --resume claude-session-123",
        resumeMetadata: {
          provider: "claude",
          targetKind: "session",
          targetId: "claude-session-123",
          launch: { permissionMode: "default" },
        },
      });

      await service.create({
        sessionId: "session-stale-running",
        laneId: "lane-1",
        title: "Claude CLI",
        cols: 80,
        rows: 24,
        toolType: "claude",
        startupCommand: "claude --resume claude-session-123",
      });

      mockPty._emitter.emit("exit", { exitCode: 2 });

      const session = sessionService.get("session-stale-running");
      expect(session.status).toBe("failed");
      expect(session.exitCode).toBe(2);
      expect(session.endedAt).not.toBeNull();
      expect(session.ptyId).toBeNull();
    });

    it("captures a live Codex thread id from a rollout without the ADE guidance marker", async () => {
      // Regression: live capture used to require the string "ADE session
      // guidance" in the rollout, which only the Work-tab CLI preamble emits.
      // Goal-launched sessions never wrote it, so thread ids were essentially
      // never captured live. Identification is cwd + timestamp proximity.
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);
        // A goal launch: no "ADE session guidance" anywhere in the rollout.
        seedCodexRollout({
          id: "thread-goal",
          cwd: "/tmp/test-worktree",
          startedAt: fakeNow.toISOString(),
          mtime: fakeNow,
          records: [{ type: "event_msg", payload: { message: "<codex_internal_context source=\"goal\">" } }],
        });

        const { service, sessionService } = createHarness();
        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
        });

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(sessionId, "codex resume thread-goal");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not adopt a same-cwd Codex rollout that predates the session", async () => {
      // The existing not-before floor must continue rejecting rollouts that
      // were already present before this launch.
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);
        const otherStartedAt = "2026-04-15T21:00:00.000Z";
        seedCodexRollout({
          id: "thread-other",
          cwd: "/tmp/test-worktree",
          startedAt: otherStartedAt,
          mtime: fakeNow,
        });

        const { service, sessionService } = createHarness();
        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
        });

        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(sessionId, "codex resume thread-other");
      } finally {
        vi.useRealTimers();
      }
    });

    it("excludes Codex rollout ids already adopted by other terminal sessions", async () => {
      vi.useFakeTimers();
      try {
        const launchAt = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(launchAt);
        const { service, sessionService } = createHarness();

        sessionService.create({
          sessionId: "session-owned-metadata",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt: launchAt.toISOString(),
          transcriptPath: "/tmp/transcripts/session-owned-metadata.log",
          toolType: "codex",
          resumeMetadata: {
            provider: "codex",
            targetKind: "thread",
            targetId: "thread-owned-metadata",
            launch: { permissionMode: "default" },
          },
        });
        sessionService.create({
          sessionId: "session-owned-command",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt: launchAt.toISOString(),
          transcriptPath: "/tmp/transcripts/session-owned-command.log",
          toolType: "codex",
          resumeCommand: "codex resume thread-owned-command",
        });

        const atOffset = (offsetMs: number) => new Date(launchAt.getTime() + offsetMs).toISOString();
        seedCodexRollout({
          id: "thread-owned-metadata",
          cwd: "/tmp/test-worktree",
          startedAt: atOffset(400),
          mtime: launchAt.getTime() + 400,
        });
        seedCodexRollout({
          id: "thread-owned-command",
          cwd: "/tmp/test-worktree",
          startedAt: atOffset(500),
          mtime: launchAt.getTime() + 500,
        });
        seedCodexRollout({
          id: "thread-this-session",
          cwd: "/tmp/test-worktree",
          startedAt: atOffset(800),
          mtime: launchAt.getTime() + 800,
        });

        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
        });

        expect(sessionService.list).toHaveBeenCalledWith({ limit: null });
        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(
          sessionId,
          "codex resume thread-this-session",
        );
        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          sessionId,
          expect.stringMatching(/thread-owned-(metadata|command)/),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses a 90-second window for live Codex rollout capture", async () => {
      vi.useFakeTimers();
      try {
        const launchAt = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(launchAt);
        const atOffset = (offsetMs: number) => new Date(launchAt.getTime() + offsetMs).toISOString();
        seedCodexRollout({
          id: "thread-too-late",
          cwd: "/tmp/test-worktree",
          startedAt: atOffset(90_001),
          mtime: launchAt.getTime() + 90_001,
        });

        const { service, sessionService } = createHarness();
        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
        });

        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          sessionId,
          "codex resume thread-too-late",
        );

        seedCodexRollout({
          id: "thread-in-window",
          cwd: "/tmp/test-worktree",
          startedAt: atOffset(90_000),
          mtime: launchAt.getTime() + 90_000,
        });
        await vi.advanceTimersByTimeAsync(500);

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(
          sessionId,
          "codex resume thread-in-window",
        );
        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          sessionId,
          "codex resume thread-too-late",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not adopt a same-cwd in-window rollout that lacks this launch's delivered text", async () => {
      // The window plus the already-adopted exclusion cannot tell a concurrent
      // unrelated Codex process in the same worktree from this one. When this
      // launch delivered text of its own, the rollout has to contain it.
      vi.useFakeTimers();
      try {
        const launchAt = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(launchAt);
        seedCodexRollout({
          id: "thread-foreign",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 300).toISOString(),
          mtime: launchAt.getTime() + 300,
          records: [codexUserMessageRecord("someone else's unrelated codex prompt in this worktree")],
        });

        const { service, sessionService } = createHarness();
        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          initialInput: adeCodexPrompt(OWNED_PROMPT),
        });
        await vi.advanceTimersByTimeAsync(60_000);

        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          sessionId,
          expect.stringContaining("thread-foreign"),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("adopts the rollout carrying this launch's delivered text over a closer unrelated one", async () => {
      vi.useFakeTimers();
      try {
        const launchAt = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(launchAt);
        // Deliberately closer to the launch instant than ours, so plain
        // timestamp proximity would pick it.
        seedCodexRollout({
          id: "thread-foreign",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 300).toISOString(),
          mtime: launchAt.getTime() + 300,
          records: [codexUserMessageRecord("someone else's unrelated codex prompt in this worktree")],
        });
        seedCodexRollout({
          id: "thread-ours",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 800).toISOString(),
          mtime: launchAt.getTime() + 800,
          records: [codexUserMessageRecord(adeCodexPrompt(OWNED_PROMPT))],
        });

        const { service, sessionService } = createHarness();
        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          initialInput: adeCodexPrompt(OWNED_PROMPT),
        });

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(sessionId, "codex resume thread-ours");
        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          sessionId,
          expect.stringContaining("thread-foreign"),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("matches delivered text whose quotes and newlines are JSON-escaped in the rollout", async () => {
      vi.useFakeTimers();
      try {
        const launchAt = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(launchAt);
        const prompt = "fix the \"adopted id\" guard\nand add a regression test for it";
        const { body } = seedCodexRollout({
          id: "thread-escaped",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 400).toISOString(),
          mtime: launchAt.getTime() + 400,
          records: [codexUserMessageRecord(adeCodexPrompt(prompt))],
        });
        // The rollout stores the prompt inside a JSON string, so the raw text is
        // not literally present — matching has to go through the escaped form.
        expect(body).not.toContain(prompt);

        const { service, sessionService } = createHarness();
        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          initialInput: adeCodexPrompt(prompt),
        });

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(sessionId, "codex resume thread-escaped");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps an already-adopted rollout excluded even when it carries this launch's text", async () => {
      vi.useFakeTimers();
      try {
        const launchAt = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(launchAt);
        const { service, sessionService } = createHarness();

        sessionService.create({
          sessionId: "session-owner",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt: launchAt.toISOString(),
          transcriptPath: "/tmp/transcripts/session-owner.log",
          toolType: "codex",
          resumeCommand: "codex resume thread-owned-needle",
        });
        seedCodexRollout({
          id: "thread-owned-needle",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 400).toISOString(),
          mtime: launchAt.getTime() + 400,
          records: [codexUserMessageRecord(adeCodexPrompt(OWNED_PROMPT))],
        });

        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          initialInput: adeCodexPrompt(OWNED_PROMPT),
        });
        await vi.advanceTimersByTimeAsync(60_000);

        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          sessionId,
          expect.stringContaining("thread-owned-needle"),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("tells apart prompts that share a long head and diverge later", async () => {
      // Regression: the needle used to be a 200-character head slice, so two
      // launches whose prompts opened identically were indistinguishable. The
      // needle now spans the whole delivered prompt.
      vi.useFakeTimers();
      try {
        const launchAt = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(launchAt);
        const sharedHead = `${"re-run the pty ownership audit and keep the transcript tests green; ".repeat(4)}then`;
        expect(sharedHead.length).toBeGreaterThan(200);
        const ourPrompt = `${sharedHead} extract the codex rollout helpers`;
        const theirPrompt = `${sharedHead} rewrite the claude storage backfill`;

        // Closer to the launch instant than ours, so timestamp proximity alone
        // would pick it, and identical for the first 200 characters.
        seedCodexRollout({
          id: "thread-shared-head",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 300).toISOString(),
          mtime: launchAt.getTime() + 300,
          records: [codexUserMessageRecord(adeCodexPrompt(theirPrompt))],
        });
        seedCodexRollout({
          id: "thread-full-text",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 800).toISOString(),
          mtime: launchAt.getTime() + 800,
          records: [codexUserMessageRecord(adeCodexPrompt(ourPrompt))],
        });

        const { service, sessionService } = createHarness();
        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          initialInput: adeCodexPrompt(ourPrompt),
        });

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(sessionId, "codex resume thread-full-text");
        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          sessionId,
          expect.stringContaining("thread-shared-head"),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("stamps a distinct ownership nonce on every Codex launch environment", async () => {
      const { service, loadPty } = createHarness();
      const launchCodex = async (): Promise<string> => {
        await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
        });
        const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        const env = (ptyLib.spawn.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        return String(env?.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? "");
      };

      const first = await launchCodex();
      const second = await launchCodex();
      // The `ade` prefix keeps usage attribution counting these as ADE-launched.
      expect(first).toMatch(/^ade_pty_.+/);
      expect(second).toMatch(/^ade_pty_.+/);
      expect(second).not.toBe(first);
    });

    it("leaves an explicitly configured Codex originator override alone", async () => {
      const { service, loadPty } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        command: "codex",
        args: ["--no-alt-screen"],
        env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "my_own_client" },
      });

      const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      const env = (ptyLib.spawn.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
      expect(env?.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBe("my_own_client");
    });

    it("adopts by launch nonce when two same-worktree launches share the same prompt", async () => {
      // The case the needle cannot decide: same worktree, same launch window,
      // byte-identical prompts. Only the nonce ADE stamped on this launch, which
      // Codex writes back as the rollout originator, separates them.
      vi.useFakeTimers();
      try {
        const launchAt = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(launchAt);
        const prompt = adeCodexPrompt(OWNED_PROMPT);

        const { service, sessionService, loadPty } = createHarness();
        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          initialInput: prompt,
        });

        const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        const env = (ptyLib.spawn.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        const nonce = String(env?.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? "");
        expect(nonce).not.toBe("");

        // The twin launch: same cwd, same text, closer to the launch instant.
        seedCodexRollout({
          id: "thread-twin",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 200).toISOString(),
          mtime: launchAt.getTime() + 200,
          originator: "ade_pty_ffffffffffffffffffffffffffffffff",
          records: [codexUserMessageRecord(prompt)],
        });
        seedCodexRollout({
          id: "thread-nonce",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 900).toISOString(),
          mtime: launchAt.getTime() + 900,
          originator: nonce,
          records: [codexUserMessageRecord(prompt)],
        });
        await vi.advanceTimersByTimeAsync(500);

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(sessionId, "codex resume thread-nonce");
        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          sessionId,
          expect.stringContaining("thread-twin"),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("adopts by launch nonce when the prompt is too short to be a needle", async () => {
      // Prompts under the needle minimum carry no ownership signal of their own,
      // which used to leave short-prompt launches racing on timestamps.
      vi.useFakeTimers();
      try {
        const launchAt = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(launchAt);
        const prompt = adeCodexPrompt("ship it");

        const { service, sessionService, loadPty } = createHarness();
        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          initialInput: prompt,
        });

        const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        const env = (ptyLib.spawn.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        const nonce = String(env?.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? "");

        seedCodexRollout({
          id: "thread-short-twin",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 200).toISOString(),
          mtime: launchAt.getTime() + 200,
          records: [codexUserMessageRecord(prompt)],
        });
        seedCodexRollout({
          id: "thread-short-ours",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 900).toISOString(),
          mtime: launchAt.getTime() + 900,
          originator: nonce,
          records: [codexUserMessageRecord(prompt)],
        });
        await vi.advanceTimersByTimeAsync(500);

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(sessionId, "codex resume thread-short-ours");
        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          sessionId,
          expect.stringContaining("thread-short-twin"),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not adopt a subagent rollout that inherited this launch's nonce", async () => {
      // Codex subagents fork from the launched thread and inherit its
      // environment, so they carry the same originator. The thread ADE launched
      // is the root one.
      vi.useFakeTimers();
      try {
        const launchAt = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(launchAt);

        const { service, sessionService, loadPty } = createHarness();
        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
        });

        const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        const env = (ptyLib.spawn.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        const nonce = String(env?.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? "");

        // The subagent rollout lands first and is the only candidate in the
        // window: it still must not be adopted, nonce or no nonce.
        seedCodexRollout({
          id: "thread-subagent",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 400).toISOString(),
          mtime: launchAt.getTime() + 400,
          originator: nonce,
          parentThreadId: "thread-root",
        });
        await vi.advanceTimersByTimeAsync(500);

        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          sessionId,
          expect.stringContaining("thread-subagent"),
        );

        seedCodexRollout({
          id: "thread-root",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 900).toISOString(),
          mtime: launchAt.getTime() + 900,
          originator: nonce,
        });
        await vi.advanceTimersByTimeAsync(2_000);

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(sessionId, "codex resume thread-root");
      } finally {
        vi.useRealTimers();
      }
    });

    it("still adopts by window and exclusion when the launch delivered no text", async () => {
      // A bare interactive `codex` types nothing, so there is no ownership
      // signal to demand and capture keeps its pre-needle behavior.
      vi.useFakeTimers();
      try {
        const launchAt = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(launchAt);
        const { service, sessionService } = createHarness();

        sessionService.create({
          sessionId: "session-owner",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt: launchAt.toISOString(),
          transcriptPath: "/tmp/transcripts/session-owner.log",
          toolType: "codex",
          resumeCommand: "codex resume thread-already-owned",
        });
        seedCodexRollout({
          id: "thread-already-owned",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 300).toISOString(),
          mtime: launchAt.getTime() + 300,
        });
        seedCodexRollout({
          id: "thread-bare-launch",
          cwd: "/tmp/test-worktree",
          startedAt: new Date(launchAt.getTime() + 700).toISOString(),
          mtime: launchAt.getTime() + 700,
        });

        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
        });

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(sessionId, "codex resume thread-bare-launch");
        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          sessionId,
          expect.stringContaining("thread-already-owned"),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("marks a resumed session failed when it exits nonzero after actually running", async () => {
      vi.useFakeTimers();
      try {
        const { service, sessionService, mockPty } = createHarness();
        createDetachedResumableSession(sessionService, { sessionId: "session-resume-real-exit" });

        await service.create({
          sessionId: "session-resume-real-exit",
          laneId: "lane-1",
          title: "Claude CLI",
          cols: 80,
          rows: 24,
          toolType: "claude",
          startupCommand: "claude --resume claude-session-123",
        });

        await vi.advanceTimersByTimeAsync(60_000);
        mockPty._emitter.emit("exit", { exitCode: 2 });

        const session = sessionService.get("session-resume-real-exit");
        expect(session.status).toBe("failed");
        expect(session.exitCode).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("waits for agent CLI readiness before sending initialInput", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty } = createHarness();

        await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          startupCommand: "codex --no-alt-screen",
          initialInput: "print cwd",
        });

        expect(mockPty.write).not.toHaveBeenCalled();

        mockPty._emitter.emit("data", "OpenAI Codex\n");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(mockPty.write).not.toHaveBeenCalled();

        mockPty._emitter.emit("data", "\x1b[2J\x1b[Hmodel: loading\n› ");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(mockPty.write).not.toHaveBeenCalled();

        mockPty._emitter.emit("data", "\x1b[2J\x1b[Hmodel: gpt-5.4 medium\nStarting MCP servers (2/6): codex_apps, computer-use\n› ");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(mockPty.write).not.toHaveBeenCalled();

        mockPty._emitter.emit("data", "\x1b[2J\x1b[Hmodel: gpt-5.4 medium\nMCP startup incomplete (failed: linear)\n› ");
        await vi.advanceTimersByTimeAsync(599);
        expect(mockPty.write).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(mockPty.write).toHaveBeenCalledTimes(1);
        expect(mockPty.write).toHaveBeenNthCalledWith(1, "\x05");

        await vi.advanceTimersByTimeAsync(25);
        expect(mockPty.write).toHaveBeenCalledTimes(2);
        expect(mockPty.write).toHaveBeenNthCalledWith(2, "\x15");

        await vi.advanceTimersByTimeAsync(25);
        expect(mockPty.write).toHaveBeenCalledTimes(3);
        expect(mockPty.write).toHaveBeenLastCalledWith("\x1b[200~print cwd\x1b[201~");

        await vi.advanceTimersByTimeAsync(180);
        expect(mockPty.write).toHaveBeenCalledTimes(4);
        expect(mockPty.write).toHaveBeenLastCalledWith("\r");
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses agent CLI initialInput as the first-prompt title seed", async () => {
      vi.useFakeTimers();
      try {
        const aiIntegrationService = {
          getMode: vi.fn(() => "subscription"),
          summarizeTerminal: vi.fn(async () => ({ text: "Print cwd" })),
        };
        const { service, mockPty, sessionService } = createHarness({ aiIntegrationService });

        await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          startupCommand: "codex --no-alt-screen",
          initialInput: "print cwd",
        });

        const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
        expect(createdSessionId).toBeTruthy();

        mockPty._emitter.emit("data", "\x1b[2J\x1b[Hmodel: gpt-5.4 medium\nMCP startup incomplete (failed: linear)\n› ");
        await vi.advanceTimersByTimeAsync(600);
        // The early CLI title pass is deferred so it can read a slice of output
        // (seed + transcript); advance past that delay before asserting.
        await vi.advanceTimersByTimeAsync(EARLY_CLI_AI_TITLE_DELAY_MS + 100);
        await Promise.resolve();

        expect(sessionService.get(createdSessionId!)?.goal).toBe("print cwd");
        expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: expect.stringContaining("print cwd"),
            taskType: "session_title",
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves Codex initialInput after a readiness timeout without sending it into the update prompt", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, logger, sessionService } = createHarness();

        await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          startupCommand: "codex --no-alt-screen",
          initialInput: "please keep going",
          initialInputReadyTimeoutMs: 20_000,
        });

        mockPty._emitter.emit("data", [
          "Update available! 0.130.0 -> 0.134.0\n",
          "› Update now (runs npm install -g @openai/codex)\n",
          "  Skip\n",
        ].join(""));

        await vi.advanceTimersByTimeAsync(20_500);

        expect(mockPty.write).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.agent_cli_ready_wait_timeout",
          expect.objectContaining({ provider: "codex" }),
        );
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.initial_input_retrying_not_ready",
          expect.objectContaining({ provider: "codex", timeoutMs: 20_000 }),
        );
        expect(mockPty.kill).not.toHaveBeenCalled();
        expect(sessionService.end).not.toHaveBeenCalledWith(expect.objectContaining({
          status: "failed",
        }));
      } finally {
        vi.useRealTimers();
      }
    });

    it("delivers preserved Codex initialInput when the composer appears after a readiness timeout", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, logger } = createHarness();

        await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          startupCommand: "codex --no-alt-screen",
          initialInput: "ADE_INITIAL_PROMPT_RETRY_MARKER",
          initialInputReadyTimeoutMs: 20_000,
        });

        mockPty._emitter.emit("data", "Starting MCP servers (unityMCP)\n");
        await vi.advanceTimersByTimeAsync(20_100);
        expect(mockPty.write).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.initial_input_retrying_not_ready",
          expect.objectContaining({ provider: "codex" }),
        );

        mockPty._emitter.emit(
          "data",
          "\x1b[2J\x1b[HOpenAI Codex\nmodel: gpt-5.6-terra\nMCP startup incomplete (failed: unityMCP)\n› ",
        );
        await vi.advanceTimersByTimeAsync(600);
        await vi.advanceTimersByTimeAsync(25);
        await vi.advanceTimersByTimeAsync(25);

        expect(mockPty.write).toHaveBeenCalledWith(
          "\x1b[200~ADE_INITIAL_PROMPT_RETRY_MARKER\x1b[201~",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels preserved Codex initialInput when the user takes control before late readiness", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, logger } = createHarness();

        const created = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          startupCommand: "codex --no-alt-screen",
          initialInput: "ADE_STALE_INITIAL_PROMPT",
          initialInputReadyTimeoutMs: 20_000,
        });

        mockPty._emitter.emit("data", "Starting MCP servers (unityMCP)\n");
        await vi.advanceTimersByTimeAsync(20_100);
        service.write({ ptyId: created.ptyId, data: "user draft" });
        mockPty._emitter.emit(
          "data",
          "\x1b[2J\x1b[HOpenAI Codex\nmodel: gpt-5.6-terra\nMCP startup incomplete (failed: unityMCP)\n› user draft",
        );
        await vi.advanceTimersByTimeAsync(700);

        expect(mockPty.write).toHaveBeenCalledTimes(1);
        expect(mockPty.write).toHaveBeenCalledWith("user draft");
        expect(mockPty.write).not.toHaveBeenCalledWith(expect.stringContaining("ADE_STALE_INITIAL_PROMPT"));
        expect(logger.info).toHaveBeenCalledWith(
          "pty.initial_input_cancelled_user_takeover",
          expect.objectContaining({ provider: "codex" }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels Codex initialInput when the user takes control during the initial delay", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, logger } = createHarness();

        const created = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          startupCommand: "codex --no-alt-screen",
          initialInput: "ADE_DELAYED_STALE_PROMPT",
          initialInputDelayMs: 750,
        });

        service.write({ ptyId: created.ptyId, data: "user draft" });
        mockPty._emitter.emit(
          "data",
          "\x1b[2J\x1b[HOpenAI Codex\nmodel: gpt-5.6-terra\nMCP startup incomplete (failed: unityMCP)\n› user draft",
        );
        await vi.advanceTimersByTimeAsync(1_500);

        expect(mockPty.write).toHaveBeenCalledTimes(1);
        expect(mockPty.write).toHaveBeenCalledWith("user draft");
        expect(mockPty.write).not.toHaveBeenCalledWith(expect.stringContaining("ADE_DELAYED_STALE_PROMPT"));
        expect(logger.info).toHaveBeenCalledWith(
          "pty.initial_input_cancelled_user_takeover",
          expect.objectContaining({ provider: "codex" }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("accepts a stable Codex composer while unrelated PTY redraws continue after failed MCP startup", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty } = createHarness();

        await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          startupCommand: "codex --no-alt-screen",
          initialInput: "ADE_STABLE_COMPOSER_MARKER",
        });

        mockPty._emitter.emit(
          "data",
          "\x1b[2J\x1b[HOpenAI Codex\nmodel: gpt-5.6-terra\nMCP startup incomplete (failed: unityMCP)\n› ",
        );
        for (let elapsed = 0; elapsed < 700; elapsed += 100) {
          mockPty._emitter.emit("data", `\x1b]0;Codex startup ${elapsed}\x07`);
          await vi.advanceTimersByTimeAsync(100);
        }
        await vi.advanceTimersByTimeAsync(25);
        await vi.advanceTimersByTimeAsync(25);

        expect(mockPty.write).toHaveBeenCalledWith(
          "\x1b[200~ADE_STABLE_COMPOSER_MARKER\x1b[201~",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("moves node_modules bins behind user paths for Codex CLI launches", async () => {
      const previousPathEntries = Object.entries(process.env)
        .filter(([key]) => key.toLowerCase() === "path");
      for (const [key] of previousPathEntries) delete process.env[key];
      process.env.PATH = [
        "/repo/apps/desktop/node_modules/.bin",
        "/opt/homebrew/bin",
        "/usr/bin",
        "/tmp/project/node_modules/.bin",
      ].join(path.delimiter);
      try {
        const { service, loadPty } = createHarness();

        await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          startupCommand: "codex --no-alt-screen",
        });

        const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        const spawnArgs = ptyLib.spawn.mock.calls.at(-1);
        const opts = spawnArgs?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
        const pathEntries = opts?.env?.PATH?.split(path.delimiter) ?? [];
        const normalizedPathEntries = pathEntries.map((entry) => entry.replace(/\\/g, "/"));
        const yarnGlobalBin = path.join(os.homedir(), ".config", "yarn", "global", "node_modules", ".bin");
        const firstNodeModulesBin = normalizedPathEntries.findIndex((entry) =>
          entry.endsWith("/repo/apps/desktop/node_modules/.bin"),
        );
        expect(firstNodeModulesBin).toBeGreaterThanOrEqual(0);
        expect(pathEntries).toContain("/opt/homebrew/bin");
        expect(pathEntries).toContain("/usr/bin");
        expect(pathEntries.indexOf("/opt/homebrew/bin")).toBeLessThan(firstNodeModulesBin);
        expect(pathEntries.indexOf("/usr/bin")).toBeLessThan(firstNodeModulesBin);
        expect(normalizedPathEntries.slice(-2).map((entry) => entry.replace(/^[A-Za-z]:/, ""))).toEqual([
          "/repo/apps/desktop/node_modules/.bin",
          "/tmp/project/node_modules/.bin",
        ]);
        expect(pathEntries).toContain(path.join(os.homedir(), ".asdf", "shims"));
        expect(pathEntries.indexOf(yarnGlobalBin)).toBeGreaterThanOrEqual(0);
        expect(pathEntries.indexOf(yarnGlobalBin)).toBeLessThan(pathEntries.indexOf("/repo/apps/desktop/node_modules/.bin"));
      } finally {
        for (const key of Object.keys(process.env)) {
          if (key.toLowerCase() === "path") delete process.env[key];
        }
        for (const [key, value] of previousPathEntries) process.env[key] = value;
      }
    });

    it("does not send Cursor initialInput into the workspace trust prompt", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty } = createHarness();

        await service.create({
          laneId: "lane-1",
          title: "Cursor CLI",
          cols: 80,
          rows: 24,
          toolType: "cursor-cli",
          command: "/bin/bash",
          args: ["-lc", "cursor-agent --resume chat-1"],
          startupCommand: "cursor-agent --resume chat-1",
          initialInput: "print cwd",
        });

        mockPty._emitter.emit("data", [
          "Cursor Agent\n",
          "Workspace Trust Required\n",
          "Do you trust the content of this directory?\n",
          "[a] Trust this workspace\n",
        ].join(""));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(mockPty.write).not.toHaveBeenCalled();

        mockPty._emitter.emit("data", "Cursor Agent\nv2026.05.24\nUse /skills to give Cursor specialized knowledge for tasks.\n");
        await vi.advanceTimersByTimeAsync(600);
        expect(mockPty.write).toHaveBeenCalledTimes(1);
        expect(mockPty.write).toHaveBeenNthCalledWith(1, "\x05");

        await vi.advanceTimersByTimeAsync(25);
        expect(mockPty.write).toHaveBeenCalledTimes(2);
        expect(mockPty.write).toHaveBeenNthCalledWith(2, "\x15");

        await vi.advanceTimersByTimeAsync(25);
        expect(mockPty.write).toHaveBeenCalledTimes(3);
        expect(mockPty.write).toHaveBeenNthCalledWith(3, "print cwd");

        await vi.advanceTimersByTimeAsync(499);
        expect(mockPty.write).toHaveBeenCalledTimes(3);

        await vi.advanceTimersByTimeAsync(1);
        expect(mockPty.write).toHaveBeenCalledTimes(4);
        expect(mockPty.write).toHaveBeenLastCalledWith("\r");
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects awaited initialInput when the agent CLI never becomes ready", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, logger, sessionService } = createHarness();

        const pending = service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          command: "codex",
          args: ["--no-alt-screen"],
          startupCommand: "codex --no-alt-screen",
          initialInput: "please keep going",
          awaitInitialInput: true,
          initialInputReadyTimeoutMs: 20_000,
        }).then(
          () => null,
          (error: unknown) => error,
        );

        await Promise.resolve();
        mockPty._emitter.emit("data", [
          "Update available! 0.130.0 -> 0.134.0\n",
          "› Update now (runs npm install -g @openai/codex)\n",
          "  Skip\n",
        ].join(""));
        await vi.advanceTimersByTimeAsync(20_500);

        await expect(pending).resolves.toEqual(
          expect.objectContaining({
            message: expect.stringContaining("codex CLI did not become ready"),
          }),
        );
        expect(mockPty.write).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.initial_input_skipped_not_ready",
          expect.objectContaining({ provider: "codex" }),
        );
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.initial_input_await_failed_closing",
          expect.objectContaining({ toolType: "codex" }),
        );
        expect(mockPty.kill).toHaveBeenCalledWith("SIGTERM");
        expect(sessionService.end).toHaveBeenCalledWith(expect.objectContaining({
          exitCode: 1,
          status: "failed",
        }));
      } finally {
        vi.useRealTimers();
      }
    });

    it("waits for Droid readiness markers before sending initialInput", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty } = createHarness();

        await service.create({
          laneId: "lane-1",
          title: "Droid CLI",
          cols: 80,
          rows: 24,
          toolType: "droid",
          command: "droid",
          args: [],
          startupCommand: "droid",
          initialInput: "print cwd",
        });

        mockPty._emitter.emit("data", "Factory Droid\nBooting runtime...\n");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(mockPty.write).not.toHaveBeenCalled();

        mockPty._emitter.emit("data", "Message Droid\n");
        await vi.advanceTimersByTimeAsync(599);
        expect(mockPty.write).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(mockPty.write).toHaveBeenCalledTimes(1);
        expect(mockPty.write).toHaveBeenNthCalledWith(1, "\x05");
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips Cursor initialInput when the workspace trust prompt never reaches a composer", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, logger, sessionService } = createHarness();

        await service.create({
          laneId: "lane-1",
          title: "Cursor CLI",
          cols: 80,
          rows: 24,
          toolType: "cursor-cli",
          command: "/bin/bash",
          args: ["-lc", "cursor-agent --resume chat-1"],
          startupCommand: "cursor-agent --resume chat-1",
          initialInput: "print cwd",
        });

        mockPty._emitter.emit("data", [
          "Cursor Agent\n",
          "Workspace Trust Required\n",
          "Do you trust the content of this directory?\n",
          "[a] Trust this workspace\n",
        ].join(""));
        await vi.advanceTimersByTimeAsync(20_500);

        expect(mockPty.write).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.agent_cli_ready_wait_timeout",
          expect.objectContaining({ provider: "cursor" }),
        );
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.initial_input_skipped_not_ready",
          expect.objectContaining({ provider: "cursor" }),
        );
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.initial_input_launch_failed",
          expect.objectContaining({ toolType: "cursor-cli" }),
        );
        expect(mockPty.kill).not.toHaveBeenCalled();
        expect(sessionService.end).not.toHaveBeenCalledWith(expect.objectContaining({
          status: "failed",
        }));
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not treat a Cursor banner alone as an input-ready composer", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, logger } = createHarness();

        await service.create({
          laneId: "lane-1",
          title: "Cursor CLI",
          cols: 80,
          rows: 24,
          toolType: "cursor-cli",
          command: "/bin/bash",
          args: ["-lc", "cursor-agent --resume chat-1"],
          startupCommand: "cursor-agent --resume chat-1",
          initialInput: "print cwd",
        });

        mockPty._emitter.emit("data", "Cursor Agent\nv2026.05.24\n");
        await vi.advanceTimersByTimeAsync(20_500);

        expect(mockPty.write).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.agent_cli_ready_wait_timeout",
          expect.objectContaining({ provider: "cursor" }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not send OpenCode initialInput into an authentication prompt", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, logger } = createHarness();

        await service.create({
          laneId: "lane-1",
          title: "OpenCode CLI",
          cols: 80,
          rows: 24,
          toolType: "opencode",
          command: "opencode",
          args: ["--continue"],
          startupCommand: "opencode --continue",
          initialInput: "print cwd",
        });

        mockPty._emitter.emit("data", [
          "opencode\n",
          "Authentication required\n",
          "Please log in or configure an API key.\n",
        ].join(""));
        await vi.advanceTimersByTimeAsync(20_500);

        expect(mockPty.write).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.agent_cli_ready_wait_timeout",
          expect.objectContaining({ provider: "opencode" }),
        );
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.initial_input_skipped_not_ready",
          expect.objectContaining({ provider: "opencode" }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to typing startupCommand in a shell when direct command spawn fails", async () => {
      const { service, mockPty, loadPty } = createHarness();
      const spawn = vi.fn((command: string) => {
        if (command === "codex") throw new Error("ENOENT");
        return mockPty;
      });
      loadPty.mockImplementationOnce(() => ({ spawn: spawn as any }));

      await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        command: "codex",
        args: ["--no-alt-screen", "ADE session guidance"],
        startupCommand: "codex --no-alt-screen \"ADE session guidance\"",
      });

      expect(spawn).toHaveBeenCalledWith(
        "codex",
        ["--no-alt-screen", "ADE session guidance"],
        expect.any(Object),
      );
      expect(spawn).toHaveBeenCalledWith(
        expect.stringMatching(/(?:zsh|bash|sh|powershell|cmd)(?:\.exe)?$/),
        expect.any(Array),
        expect.any(Object),
      );
      expect(mockPty.write).toHaveBeenCalledWith("codex --no-alt-screen \"ADE session guidance\"\r");
    });

    it("falls back to a shell exec command when direct command spawn fails before a terminal attaches", async () => {
      setPlatform("darwin");
      const { service, mockPty, loadPty } = createHarness();
      const spawn = vi.fn((command: string) => {
        if (command === "./scripts/dogfood.sh") throw new Error("ENOENT");
        return mockPty;
      });
      loadPty.mockImplementationOnce(() => ({ spawn: spawn as any }));

      await service.create({
        laneId: "lane-1",
        title: "Run command",
        cols: 80,
        rows: 24,
        command: "./scripts/dogfood.sh",
        args: ["onboarding fixes", "quote's ok"],
      });

      expect(spawn).toHaveBeenCalledWith(
        "./scripts/dogfood.sh",
        ["onboarding fixes", "quote's ok"],
        expect.any(Object),
      );
      expect(spawn).toHaveBeenCalledWith(
        expect.stringMatching(/(?:zsh|bash|sh)$/),
        expect.any(Array),
        expect.any(Object),
      );
      expect(mockPty.write).toHaveBeenCalledWith("exec ./scripts/dogfood.sh 'onboarding fixes' 'quote'\\''s ok'\r");
    });

    it("wraps direct Windows command shims through cmd.exe", async () => {
      setPlatform("win32");
      const harness = createHarness();
      const ptyService = createPtyService({
        projectRoot: "/tmp/test-project",
        transcriptsDir: "/tmp/transcripts",
        laneService: harness.laneService as any,
        sessionService: harness.sessionService as any,
        logger: harness.logger as any,
        broadcastData: vi.fn(),
        broadcastExit: vi.fn(),
        onSessionEnded: vi.fn(),
        onSessionRuntimeSignal: vi.fn(),
        loadPty: harness.loadPty as any,
      });

      await ptyService.create({
        laneId: "lane-1",
        title: "Direct command",
        cols: 80,
        rows: 24,
        command: "npm.cmd",
        args: ["run", "dev"],
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      });

      const ptyLib = harness.loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      expect(ptyLib.spawn).toHaveBeenCalledWith(
        "C:\\Windows\\System32\\cmd.exe",
        '/d /s /c ""npm.cmd" "run" "dev""',
        expect.any(Object),
      );
    });

    it.each([
      ["powershell.exe", "powershell-command"],
      ["cmd.exe", "cmd-command"],
      [["C:", "Program Files", "Git", "bin", "bash.exe"].join(String.fromCharCode(92)), "git-bash-command"],
    ])("types the startup command for the selected Windows shell: %s", async (shell, expectedCommand) => {
      setPlatform("win32");
      process.env.SHELL = shell;
      const { service, mockPty, loadPty } = createHarness();

      await service.create({
        laneId: "lane-1",
        title: "App Control",
        cols: 80,
        rows: 24,
        toolType: "shell",
        startupCommand: "display-command",
        windowsStartupCommands: {
          powershell: "powershell-command",
          cmd: "cmd-command",
          "git-bash": "git-bash-command",
        },
        startupDelayMs: 0,
      });

      const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      expect(ptyLib.spawn.mock.calls[0]?.[0]).toBe(shell);
      expect(mockPty.write).toHaveBeenCalledWith(`${expectedCommand}\r`);
    });

    it("launches Cursor through the legacy Windows agent.cmd alias when needed", async () => {
      setPlatform("win32");
      const previousAppData = process.env.APPDATA;
      const previousComSpec = process.env.ComSpec;
      const appData = "C:\\Users\\ADE User\\AppData\\Roaming";
      const agentPath = path.join(appData, "npm", "agent.cmd");
      process.env.APPDATA = appData;
      process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
      mocks.fileStats.set(agentPath, { isDirectory: false, size: 1 });
      try {
        const harness = createHarness();
        await harness.service.create({
          laneId: "lane-1",
          title: "Cursor CLI",
          cols: 80,
          rows: 24,
          command: "cursor-agent",
          args: ["--resume", "chat with spaces & unicode-Ã©"],
          toolType: "cursor-cli",
        });

        const ptyLib = harness.loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        expect(ptyLib.spawn).toHaveBeenCalledWith(
          "C:\\Windows\\System32\\cmd.exe",
          expect.stringContaining(`"${agentPath}"`),
          expect.any(Object),
        );
        expect(ptyLib.spawn.mock.calls[0]?.[1]).toContain("chat with spaces & unicode-Ã©");
      } finally {
        if (previousAppData == null) delete process.env.APPDATA;
        else process.env.APPDATA = previousAppData;
        if (previousComSpec == null) delete process.env.ComSpec;
        else process.env.ComSpec = previousComSpec;
      }
    });

    // The bare word `claude` has no extension, so resolveCliSpawnInvocation used
    // to wrap every Windows launch in `cmd.exe /d /s /c "…"` — which expands
    // %VAR%, flattens the ~2KB multi-line --append-system-prompt blob to one
    // line, and dies past 8191 characters. The official installer's claude.exe
    // spawns directly and argv arrives byte-for-byte.
    it("launches Claude from the installed claude.exe instead of a cmd.exe wrapper", async () => {
      setPlatform("win32");
      const previousProfile = process.env.USERPROFILE;
      const previousComSpec = process.env.ComSpec;
      const home = "C:\\Users\\ADE User";
      const claudePath = path.join(home, ".local", "bin", "claude.exe");
      process.env.USERPROFILE = home;
      process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
      mocks.fileStats.set(claudePath, { isDirectory: false, size: 1 });
      try {
        const harness = createHarness();
        const guidance = "ADE guidance\nsecond line with %USERPROFILE% inside";
        await harness.service.create({
          laneId: "lane-1",
          title: "Claude CLI",
          cols: 80,
          rows: 24,
          command: "claude",
          args: ["--append-system-prompt", guidance],
          toolType: "claude",
        });

        const ptyLib = harness.loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
        const [spawnCommand, spawnArgs] = ptyLib.spawn.mock.calls[0] as [string, string | string[]];
        expect(spawnCommand).toBe(claudePath);
        // An array (not a verbatim command-line string) is the proof no shell
        // sits between ADE and Claude.
        expect(Array.isArray(spawnArgs)).toBe(true);
        expect(spawnArgs).toContain(guidance);
      } finally {
        if (previousProfile == null) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousProfile;
        if (previousComSpec == null) delete process.env.ComSpec;
        else process.env.ComSpec = previousComSpec;
      }
    });

    it("preserves an explicit Windows Cursor executable override", async () => {
      setPlatform("win32");
      const explicitPath = "D:\\Custom Tools\\Cursor\\cursor-agent.cmd";
      const harness = createHarness();

      await harness.service.create({
        laneId: "lane-1",
        title: "Custom Cursor CLI",
        cols: 80,
        rows: 24,
        command: explicitPath,
        args: ["--resume", "chat-123"],
        toolType: "cursor-cli",
      });

      const ptyLib = harness.loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      expect(ptyLib.spawn.mock.calls[0]?.[1]).toContain(`"${explicitPath}"`);
    });

    it("registers the session via sessionService.create", async () => {
      const { service, sessionService } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "My session",
        cols: 120,
        rows: 40,
      });
      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-1",
          title: "My session",
          tracked: true,
        }),
      );
    });

    it("uses a default title when runtime payloads omit one", async () => {
      const { service, sessionService } = createHarness();
      await service.create({
        laneId: "lane-1",
        cols: 120,
        rows: 40,
      } as any);
      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-1",
          title: "Terminal",
          tracked: true,
        }),
      );
    });

    it("rejects terminal launches when the lane worktree does not exist", async () => {
      mocks.existsSyncResults.set("/tmp/test-worktree", false);
      const { service, loadPty } = createHarness();
      await expect(service.create({
        laneId: "lane-1",
        title: "Missing worktree",
        cols: 80,
        rows: 24,
      })).rejects.toThrow(/worktree is unavailable/i);
      expect(loadPty).not.toHaveBeenCalled();
    });

    it("uses an explicit cwd when it stays inside the selected lane worktree", async () => {
      mocks.existsSyncResults.set("/tmp/test-worktree/subdir", true);
      const { service, loadPty } = createHarness();
      await service.create({
        laneId: "lane-1",
        cwd: "/tmp/test-worktree/subdir",
        title: "Subdir terminal",
        cols: 80,
        rows: 24,
      });
      const spawnCall = loadPty.mock.results[0].value.spawn;
      expect(spawnCall).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: "/tmp/test-worktree/subdir" }),
      );
    });

    it("rejects an explicit cwd outside the selected lane worktree", async () => {
      mocks.existsSyncResults.set("/tmp/outside", true);
      const { service, loadPty } = createHarness();
      await expect(service.create({
        laneId: "lane-1",
        cwd: "/tmp/outside",
        title: "Escaping terminal",
        cols: 80,
        rows: 24,
      })).rejects.toThrow(/escapes lane/i);
      expect(loadPty).not.toHaveBeenCalled();
    });

    it("allows an explicit absolute cwd outside the selected lane when opted in", async () => {
      mocks.existsSyncResults.set("/tmp/outside", true);
      const { service, loadPty } = createHarness();
      await service.create({
        laneId: "lane-1",
        cwd: "/tmp/outside",
        allowExternalCwd: true,
        title: "External cwd terminal",
        cols: 80,
        rows: 24,
      });
      const spawnCall = loadPty.mock.results[0].value.spawn;
      expect(spawnCall).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: "/tmp/outside" }),
      );
    });

    it("rejects a cwd whose realpath hops outside the lane worktree", async () => {
      const childPath = "/tmp/test-worktree/hop-child";
      mocks.existsSyncResults.set(childPath, true);
      mocks.realpathOverrides.set(childPath, "/private/tmp/hop-child");
      const { service, loadPty } = createHarness();
      await expect(service.create({
        laneId: "lane-1",
        cwd: childPath,
        title: "Realpath hop",
        cols: 80,
        rows: 24,
      })).rejects.toThrow(/escapes lane/i);
      expect(loadPty).not.toHaveBeenCalled();
    });

    it("preserves non-escape cwd errors instead of rewriting them as lane escapes", async () => {
      mocks.existsSyncResults.set("/tmp/test-worktree/missing", false);
      const { service, loadPty } = createHarness();
      await expect(service.create({
        laneId: "lane-1",
        cwd: "/tmp/test-worktree/missing",
        title: "Missing cwd",
        cols: 80,
        rows: 24,
      })).rejects.toThrow(/path does not exist/i);
      expect(loadPty).not.toHaveBeenCalled();
    });

    it("clamps very small dimensions to minimum values", async () => {
      const { service, loadPty } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "Small terminal",
        cols: 5,
        rows: 2,
      });
      const spawnCall = loadPty.mock.results[0].value.spawn;
      expect(spawnCall).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cols: 20, rows: 6 }),
      );
    });

    it("clamps very large dimensions to maximum values", async () => {
      const { service, loadPty } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "Large terminal",
        cols: 999,
        rows: 999,
      });
      const spawnCall = loadPty.mock.results[0].value.spawn;
      expect(spawnCall).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cols: 400, rows: 200 }),
      );
    });

    it("writes startup command to the PTY when provided", async () => {
      const { service, mockPty } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "With startup",
        cols: 80,
        rows: 24,
        startupCommand: "echo hello",
      });
      expect(mockPty.write).toHaveBeenCalledWith("echo hello\r");
    });

    it("delays startup command writes when requested", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty } = createHarness();
        await service.create({
          laneId: "lane-1",
          title: "With delayed startup",
          cols: 80,
          rows: 24,
          startupCommand: "echo delayed",
          startupDelayMs: 180,
        });
        expect(mockPty.write).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(179);
        expect(mockPty.write).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(mockPty.write).toHaveBeenCalledWith("echo delayed\r");
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears delayed startup command writes when disposed", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty } = createHarness();
        const created = await service.create({
          laneId: "lane-1",
          title: "Disposed delayed startup",
          cols: 80,
          rows: 24,
          startupCommand: "echo disposed",
          startupDelayMs: 180,
        });

        service.dispose({ ptyId: created.ptyId, sessionId: created.sessionId });
        await vi.advanceTimersByTimeAsync(180);

        expect(mockPty.write).not.toHaveBeenCalledWith("echo disposed\r");
      } finally {
        vi.useRealTimers();
      }
    });

    it("hydrates transcript reads from recent live output before the file stream flushes", async () => {
      const { service, mockPty, sessionService } = createHarness();
      const created = await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        command: "codex",
        args: ["--no-alt-screen", "ADE session guidance"],
      });
      sessionService.readTranscriptTail.mockResolvedValueOnce("");

      mockPty._emitter.emit("data", "\u001b[2J\u001b[HReady for input\n> ");

      await expect(service.readTranscriptTail({
        sessionId: created.sessionId,
        maxBytes: 160_000,
        raw: true,
      })).resolves.toBe("\u001b[2J\u001b[HReady for input\n> ");
      expect(sessionService.readTranscriptTail).toHaveBeenLastCalledWith(
        "/tmp/transcripts/uuid-2.log",
        160_000,
        expect.objectContaining({ raw: true }),
      );
    });

    it("deduplicates recent live output that has already reached the transcript file", async () => {
      const { service, mockPty, sessionService } = createHarness();
      const created = await service.create({
        laneId: "lane-1",
        title: "Claude CLI",
        cols: 80,
        rows: 24,
        toolType: "claude",
      });
      mockPty._emitter.emit("data", "Ready for input\n> ");
      sessionService.readTranscriptTail.mockResolvedValueOnce("Booting\nReady for input");

      await expect(service.readTranscriptTail({
        sessionId: created.sessionId,
        maxBytes: 160_000,
        raw: true,
      })).resolves.toBe("Booting\nReady for input\n> ");
    });

    it("deduplicates live output overlaps larger than the default scan window", async () => {
      const { service, mockPty, sessionService } = createHarness();
      const created = await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
      });
      const overlap = "x".repeat(13_000);
      mockPty._emitter.emit("data", `${overlap} live`);
      sessionService.readTranscriptTail.mockResolvedValueOnce(`disk\n${overlap}`);

      await expect(service.readTranscriptTail({
        sessionId: created.sessionId,
        maxBytes: 20_000,
        raw: true,
      })).resolves.toBe(`disk\n${overlap} live`);
    });

    it("returns the disk tail when the live entry has been disposed", async () => {
      const { service, mockPty, sessionService } = createHarness();
      const created = await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
      });
      // Dispose the live pty so `liveEntryBySessionId` returns null and the
      // merge path falls through to disk-only.
      mockPty._emitter.emit("exit", { exitCode: 0 });
      sessionService.readTranscriptTail.mockResolvedValueOnce("only on disk\n");

      await expect(service.readTranscriptTail({
        sessionId: created.sessionId,
        maxBytes: 20_000,
        raw: true,
      })).resolves.toBe("only on disk\n");
    });

    it("runs the merged tail through stripAnsi when raw is not set", async () => {
      const { service, sessionService } = createHarness();
      const created = await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
      });
      sessionService.readTranscriptTail.mockResolvedValueOnce("disk tail");
      // Reset before the call so we can detect the new invocation specifically.
      mocks.stripAnsi.mockClear();

      await service.readTranscriptTail({
        sessionId: created.sessionId,
        maxBytes: 20_000,
      });

      // Without raw: true, the service must pass the merged tail through
      // stripAnsi before returning. The fixture mocks stripAnsi to an identity
      // function, so we assert by invocation rather than by output content.
      expect(mocks.stripAnsi).toHaveBeenCalledWith(expect.stringContaining("disk tail"));
    });

    it("stores structured resume metadata for Claude launches", async () => {
      const { service, sessionService } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "Claude CLI",
        cols: 80,
        rows: 24,
        toolType: "claude",
        startupCommand: "claude --permission-mode default",
      });
      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          toolType: "claude",
          resumeMetadata: expect.objectContaining({
            provider: "claude",
            targetKind: "session",
            targetId: null,
            launch: expect.objectContaining({
              permissionMode: "default",
            }),
          }),
        }),
      );
    });

    it("stores structured resume metadata for Codex launches", async () => {
      const { service, sessionService } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        startupCommand: "codex --no-alt-screen --sandbox workspace-write --ask-for-approval untrusted",
      });
      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          toolType: "codex",
          resumeMetadata: expect.objectContaining({
            provider: "codex",
            targetKind: "thread",
            targetId: null,
            launch: expect.objectContaining({
              permissionMode: "edit",
              codexApprovalPolicy: "untrusted",
              codexSandbox: "workspace-write",
              codexConfigSource: "flags",
            }),
          }),
        }),
      );
    });

    it("reattaches a resumed tracked session instead of creating a duplicate terminal row", async () => {
      const { service, sessionService } = createHarness();
      sessionService.create({
        sessionId: "session-existing",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Codex CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-existing.log",
        toolType: "codex",
        resumeCommand: "codex --no-alt-screen resume thread-existing",
        resumeMetadata: {
          provider: "codex",
          targetKind: "thread",
          targetId: "thread-existing",
          launch: { permissionMode: "config-toml" },
        },
      });
      sessionService.end({
        sessionId: "session-existing",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });
      const createCallsBeforeResume = sessionService.create.mock.calls.length;

      const result = await service.create({
        sessionId: "session-existing",
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        startupCommand: "codex --no-alt-screen resume thread-existing",
      });

      expect(result.sessionId).toBe("session-existing");
      expect(sessionService.reattach).toHaveBeenCalledWith({
        sessionId: "session-existing",
        ptyId: expect.any(String),
        startedAt: expect.any(String),
      });
      expect(sessionService.create).toHaveBeenCalledTimes(createCallsBeforeResume);
    });

    it("restores spawn-lineage env from persisted resume metadata on resume", async () => {
      const { service, sessionService, loadPty } = createHarness();
      sessionService.create({
        sessionId: "session-spawned",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Codex CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-spawned.log",
        toolType: "codex",
        resumeCommand: "codex --no-alt-screen resume thread-spawned",
        resumeMetadata: {
          provider: "codex",
          targetKind: "thread",
          targetId: "thread-spawned",
          launch: { permissionMode: "config-toml" },
          orchestrationParentSessionId: "parent-session-1",
          spawnKind: "subagent",
        },
      });
      sessionService.end({
        sessionId: "session-spawned",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });

      await service.create({
        sessionId: "session-spawned",
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        startupCommand: "codex --no-alt-screen resume thread-spawned",
      });

      const ptyLib = loadPty.mock.results.at(-1)?.value as { spawn: ReturnType<typeof vi.fn> };
      const opts = ptyLib.spawn.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(opts?.env).toEqual(expect.objectContaining({
        ADE_PARENT_CHAT_SESSION_ID: "parent-session-1",
        ADE_SPAWN_KIND: "subagent",
      }));
      expect(opts?.env?.ADE_CHAT_SESSION_ID).toBe("session-spawned");
    });

    it("backfills a targetless Claude resume command before launching the resumed PTY", async () => {
      const pluginRoot = "/Applications/ADE.app/Contents/Resources/agent-skills";
      mocks.fileStats.set(path.join(pluginRoot, ".claude-plugin", "plugin.json"), { isDirectory: false });
      (mocks.extractResumeCommandFromOutput as any).mockReturnValueOnce("claude --resume claude-session-123");
      const { service, sessionService, mockPty } = createHarness({
        getAdeCliAgentEnv: (env) => ({
          ...env,
          ADE_AGENT_SKILLS_DIRS: pluginRoot,
          ADE_BUNDLED_AGENT_SKILLS_DIR: pluginRoot,
        }),
      });
      sessionService.create({
        sessionId: "session-claude-picker",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Claude CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-claude-picker.log",
        toolType: "claude",
        resumeCommand: "claude --permission-mode default --resume",
        resumeMetadata: {
          provider: "claude",
          targetKind: "session",
          targetId: null,
          launch: { permissionMode: "default" },
        },
      });
      sessionService.end({
        sessionId: "session-claude-picker",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });

      await service.create({
        sessionId: "session-claude-picker",
        laneId: "lane-1",
        title: "Claude CLI",
        cols: 80,
        rows: 24,
        toolType: "claude",
        startupCommand: "claude --permission-mode default --resume",
      });

      expect(sessionService.setResumeCommand).toHaveBeenCalledWith(
        "session-claude-picker",
        "claude --resume claude-session-123",
      );
      expect(mockPty.write).toHaveBeenCalledWith(
        `claude --plugin-dir "${pluginRoot}" --resume claude-session-123\r`,
      );
    });

    it("backfills a missing Codex storage target before launching the resumed PTY", async () => {
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);

        const homedir = os.homedir();
        const sessionsBase = path.join(homedir, ".codex", "sessions");
        const dirPath = path.join(sessionsBase, "2026", "04", "15");
        const filePath = path.join(dirPath, "rollout-2026-04-15T21-30-00-thread-resume.jsonl");
        const startedAt = "2026-04-15T21:30:00.000Z";
        const firstLine = JSON.stringify({
          timestamp: startedAt,
          type: "session_meta",
          payload: {
            id: "thread-resume",
            timestamp: startedAt,
            cwd: "/tmp/test-worktree",
          },
        });

        mocks.existsSyncResults.set(sessionsBase, true);
        mocks.existsSyncResults.set(dirPath, true);
        mocks.dirEntries.set(dirPath, [path.basename(filePath)]);
        mocks.fileContents.set(filePath, `${firstLine}\n`);
        mocks.fileStats.set(filePath, { size: firstLine.length, mtimeMs: fakeNow.getTime() - 30_000, isDirectory: false });

        const { service, sessionService, mockPty } = createHarness();
        sessionService.readTranscriptTail.mockResolvedValueOnce("OpenAI Codex\nmodel: gpt-5\n› ");
        sessionService.create({
          sessionId: "session-codex-picker",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt,
          transcriptPath: "/tmp/test-worktree/.ade/transcripts/session-codex-picker.log",
          toolType: "codex",
          resumeCommand: "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume '\u001b[>7u'",
          resumeMetadata: {
            provider: "codex",
            targetKind: "thread",
            targetId: "\u001b[>7u",
            launch: { permissionMode: "full-auto" },
          },
        });
        sessionService.end({
          sessionId: "session-codex-picker",
          endedAt: "2026-04-15T21:40:00.000Z",
          exitCode: 0,
          status: "completed",
        });

        await service.create({
          sessionId: "session-codex-picker",
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          startupCommand: "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume",
        });

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(
          "session-codex-picker",
          "codex resume thread-resume",
        );
        expect(mockPty.write).toHaveBeenCalledWith("codex resume thread-resume\r");
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves the strict resume path when a requested session id does not exist", async () => {
      const { service } = createHarness();

      await expect(service.create({
        sessionId: "session-missing",
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        startupCommand: "codex --no-alt-screen resume thread-existing",
      })).rejects.toThrow(/was not found/i);
    });

    it("creates a new tracked session when the caller explicitly pre-assigns a fresh session id", async () => {
      const { service, sessionService } = createHarness();

      const result = await service.create({
        sessionId: "session-process-1",
        allowNewSessionId: true,
        laneId: "lane-1",
        title: "Run process",
        cols: 80,
        rows: 24,
        toolType: "shell",
        command: "npm",
        args: ["run", "dev"],
      });

      expect(result.sessionId).toBe("session-process-1");
      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-process-1",
          title: "Run process",
          toolType: "shell",
        }),
      );
      expect(sessionService.reattach).not.toHaveBeenCalled();
    });

    it("reuses an already-live PTY when resume is requested twice for the same tracked session", async () => {
      const { service, sessionService, logger } = createHarness();
      sessionService.create({
        sessionId: "session-live",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Codex CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-live.log",
        toolType: "codex",
        resumeCommand: "codex --no-alt-screen resume thread-live",
        resumeMetadata: {
          provider: "codex",
          targetKind: "thread",
          targetId: "thread-live",
          launch: { permissionMode: "config-toml" },
        },
      });
      sessionService.end({
        sessionId: "session-live",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });

      const first = await service.create({
        sessionId: "session-live",
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        startupCommand: "codex --no-alt-screen resume thread-live",
      });
      sessionService.end({
        sessionId: "session-live",
        endedAt: "2026-04-09T12:31:00.000Z",
        exitCode: 0,
        status: "completed",
      });

      const createCallsBeforeSecondResume = sessionService.create.mock.calls.length;
      const second = await service.create({
        sessionId: "session-live",
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        startupCommand: "codex --no-alt-screen resume thread-live",
      });

      expect(second).toEqual(first);
      expect(sessionService.reattach).toHaveBeenCalledTimes(2);
      expect(sessionService.create).toHaveBeenCalledTimes(createCallsBeforeSecondResume);
      expect(logger.info).toHaveBeenCalledWith(
        "pty.resume_reused_live_attachment",
        expect.objectContaining({
          sessionId: "session-live",
          ptyId: first.ptyId,
          needsSessionResync: true,
        }),
      );
    });

    it("sendToSession writes to a live PTY without spawning another runtime", async () => {
      const { service, mockPty, loadPty } = createHarness();
      const created = await service.create({
        sessionId: "session-live-send",
        allowNewSessionId: true,
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        startupCommand: "codex",
      });
      (mockPty.write as unknown as { mockClear(): void }).mockClear();
      loadPty.mockClear();

      const result = await service.sendToSession({
        sessionId: created.sessionId,
        text: "keep going",
      });

      expect(result).toEqual(expect.objectContaining({
        sessionId: "session-live-send",
        ptyId: created.ptyId,
        resumed: false,
        reusedExistingRuntime: true,
      }));
      expect(mockPty.write).toHaveBeenNthCalledWith(1, "\x05");
      expect(mockPty.write).toHaveBeenNthCalledWith(2, "\x15");
      expect(mockPty.write).toHaveBeenNthCalledWith(3, "\x1b[200~keep going\x1b[201~");
      expect(mockPty.write).toHaveBeenNthCalledWith(4, "\r");
      expect(loadPty).not.toHaveBeenCalled();
    });

    it("accepts scheduled CLI turns only at a visible provider composer boundary", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty } = createHarness();
        const created = await service.create({
          sessionId: "session-scheduled-boundary",
          allowNewSessionId: true,
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          startupCommand: "codex",
        });

        expect(service.canAcceptScheduledTurn(created.sessionId)).toBe(false);
        mockPty._emitter.emit("data", "\x1b[2J\x1b[HOpenAI Codex\nmodel: gpt-5.4\n› ");
        await vi.advanceTimersByTimeAsync(599);
        expect(service.canAcceptScheduledTurn(created.sessionId)).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(service.canAcceptScheduledTurn(created.sessionId)).toBe(true);

        // Output silence alone must not make an in-progress model turn safe.
        mockPty._emitter.emit("data", "\x1b[2J\x1b[HWorking on the request…");
        await vi.advanceTimersByTimeAsync(12_500);
        expect(service.canAcceptScheduledTurn(created.sessionId)).toBe(false);

        mockPty._emitter.emit("data", "\x1b[2J\x1b[HOpenAI Codex\nmodel: gpt-5.4\n› ");
        await vi.advanceTimersByTimeAsync(600);
        expect(service.canAcceptScheduledTurn(created.sessionId)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps peer-owned tracked CLIs unavailable for scheduled delivery", async () => {
      const processRegistry = {
        pid: 12_345,
        startedAt: "2026-07-16T20:00:00.000Z",
        isPidLive: vi.fn((pid: number) => pid === 99_999),
        isProcessIdentityLive: vi.fn((pid: number, startedAt: string | null) => (
          pid === 99_999 && startedAt === "2026-07-16T20:01:00.000Z"
        )),
      };
      const { service, sessionService, loadPty } = createHarness({ processRegistry });
      sessionService.get.mockReturnValue({
        id: "peer-owned-cli",
        laneId: "lane-1",
        tracked: true,
        toolType: "codex",
        status: "running",
        ownerPid: 99_999,
        ownerProcessStartedAt: "2026-07-16T20:01:00.000Z",
      });

      expect(service.canAcceptScheduledTurn("peer-owned-cli")).toBe(false);
      await expect(service.sendToSession({
        sessionId: "peer-owned-cli",
        text: "check CI",
      })).rejects.toThrow("owned by another live ADE runtime");
      expect(loadPty).not.toHaveBeenCalled();
      expect(processRegistry.isProcessIdentityLive).toHaveBeenCalledWith(
        99_999,
        "2026-07-16T20:01:00.000Z",
      );
    });

    it("sendToSession uses line-submit for Droid CLI sessions", async () => {
      const { service, mockPty } = createHarness();
      const created = await service.create({
        sessionId: "session-droid-send",
        allowNewSessionId: true,
        laneId: "lane-1",
        title: "Droid CLI",
        cols: 80,
        rows: 24,
        toolType: "droid",
        startupCommand: "droid",
      });
      (mockPty.write as unknown as { mockClear(): void }).mockClear();

      const result = await service.sendToSession({
        sessionId: created.sessionId,
        text: "keep going",
      });

      expect(result).toEqual(expect.objectContaining({
        sessionId: "session-droid-send",
        ptyId: created.ptyId,
        resumed: false,
        reusedExistingRuntime: true,
      }));
      expect(mockPty.write).toHaveBeenNthCalledWith(1, "\x05");
      expect(mockPty.write).toHaveBeenNthCalledWith(2, "\x15");
      expect(mockPty.write).toHaveBeenNthCalledWith(3, "keep going");
      expect(mockPty.write).toHaveBeenNthCalledWith(4, "\r");
    });

    it.each([
      {
        provider: "claude",
        toolType: "claude",
        title: "Claude CLI",
        resumeCommand: "claude --resume",
        expectedName: "Claude",
      },
      {
        provider: "codex",
        toolType: "codex",
        title: "Codex CLI",
        resumeCommand: "codex --no-alt-screen --sandbox read-only --ask-for-approval on-request resume",
        expectedName: "Codex",
      },
      {
        provider: "droid",
        toolType: "droid",
        title: "Droid CLI",
        resumeCommand: "droid --resume",
        expectedName: "Droid",
      },
      {
        provider: "opencode",
        toolType: "opencode",
        title: "OpenCode CLI",
        resumeCommand: "opencode --continue",
        expectedName: "OpenCode",
      },
    ] as const)("sendToSession refuses targetless $expectedName resume sessions", async ({ provider, toolType, title, resumeCommand, expectedName }) => {
      const { service, sessionService, loadPty } = createHarness();
      sessionService.create({
        sessionId: `session-${provider}-targetless`,
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title,
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: `/tmp/transcripts/session-${provider}-targetless.log`,
        toolType,
        resumeCommand,
        resumeMetadata: {
          provider,
          targetKind: "session",
          targetId: null,
          launch: { permissionMode: "default" },
        },
      });
      sessionService.end({
        sessionId: `session-${provider}-targetless`,
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });
      sessionService.readTranscriptTail.mockResolvedValueOnce("normal transcript without updater text");

      const error = await service.sendToSession({
        sessionId: `session-${provider}-targetless`,
        text: "keep going",
      }).catch((cause: unknown) => cause);
      expect(isPtySendPreDeliveryError(error)).toBe(true);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(new RegExp(`${expectedName} exited before ADE could capture a concrete resume target`));
      expect(loadPty).not.toHaveBeenCalled();
    });

    it("sendToSession refuses Codex update-only sessions without relaunching", async () => {
      const { service, sessionService, loadPty } = createHarness();
      sessionService.create({
        sessionId: "session-codex-update-only",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Codex CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-codex-update-only.log",
        toolType: "codex",
        resumeCommand: "codex --no-alt-screen --sandbox read-only --ask-for-approval on-request resume",
        resumeMetadata: {
          provider: "codex",
          targetKind: "thread",
          targetId: null,
          launch: { permissionMode: "plan" },
        },
      });
      sessionService.end({
        sessionId: "session-codex-update-only",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });
      sessionService.readTranscriptTail.mockResolvedValue([
        "Update available! 0.130.0 -> 0.134.0\n",
        "Update ran successfully! Please restart Codex.\n",
      ].join(""));
      loadPty.mockClear();

      await expect(service.sendToSession({
        sessionId: "session-codex-update-only",
        text: "continue",
      })).rejects.toThrow(/before ADE could create a resumable thread/i);
      expect(loadPty).not.toHaveBeenCalled();
    });

    it("sendToSession backfills a Codex storage target before launching resume", async () => {
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);
        const startedAt = "2026-04-15T21:30:00.000Z";
        seedCodexRollout({
          id: "thread-storage",
          cwd: "/tmp/test-worktree",
          startedAt,
          mtime: fakeNow.getTime() - 30_000,
        });

        const { service, sessionService, loadPty } = createHarness();
        sessionService.readTranscriptTail.mockResolvedValue("OpenAI Codex\nmodel: gpt-5\n› ");
        sessionService.create({
          sessionId: "session-codex-storage-send",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt,
          transcriptPath: "/tmp/test-worktree/.ade/transcripts/session-codex-storage-send.log",
          toolType: "codex",
          resumeCommand: "codex --no-alt-screen resume",
        });
        sessionService.end({
          sessionId: "session-codex-storage-send",
          endedAt: "2026-04-15T21:45:00.000Z",
          exitCode: 0,
          status: "completed",
        });

        await service.sendToSession({
          sessionId: "session-codex-storage-send",
          text: "continue",
        });

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(
          "session-codex-storage-send",
          "codex resume thread-storage",
        );
        const spawn = (loadPty.mock.results[0]?.value as any).spawn;
        expect(spawn).toHaveBeenCalledWith(
          "/bin/bash",
          ["--noprofile", "--norc", "-lc", "codex --no-alt-screen resume thread-storage continue"],
          expect.any(Object),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("sendToSession resumes an ended tracked CLI session with the message in the launch command", async () => {
      const { service, sessionService, mockPty, loadPty } = createHarness();
      sessionService.create({
        sessionId: "session-ended-send",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Codex CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-ended-send.log",
        toolType: "codex",
        resumeCommand: "codex resume thread-ended",
        resumeMetadata: {
          provider: "codex",
          targetKind: "thread",
          targetId: "thread-ended",
          launch: { permissionMode: "plan" },
        },
      });
      sessionService.end({
        sessionId: "session-ended-send",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });
      sessionService.settleSession("session-ended-send", {
        settledAt: "2026-04-09T12:31:00.000Z",
      });

      const pending = service.sendToSession({
        sessionId: "session-ended-send",
        text: "fix failing tests",
        cols: 120,
        rows: 40,
        model: "gpt-5.4",
        reasoningEffort: "high",
        fastMode: true,
        permissionMode: "full-auto",
        codexApprovalPolicy: "on-request",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      });
      await Promise.resolve();
      const result = await pending;

      expect(result).toEqual(expect.objectContaining({
        sessionId: "session-ended-send",
        resumed: true,
        reusedExistingRuntime: false,
      }));
      expect(sessionService.get("session-ended-send")?.settledAt).toBeNull();
      expect(sessionService.clearTurnStartMarkers).toHaveBeenCalledWith("session-ended-send");
      expect(sessionService.reattach).toHaveBeenCalledWith({
        sessionId: "session-ended-send",
        ptyId: expect.any(String),
        startedAt: expect.any(String),
      });
      const spawn = (loadPty.mock.results[0]?.value as any).spawn;
      expect(spawn).toHaveBeenCalledWith(
        "/bin/bash",
        ["--noprofile", "--norc", "-lc", "codex --no-alt-screen --model gpt-5.4 -c \"model_reasoning_effort=\\\"high\\\"\" -c \"service_tier=\\\"fast\\\"\" -c features.fast_mode=true --sandbox danger-full-access --ask-for-approval on-request resume thread-ended \"fix failing tests\""],
        expect.any(Object),
      );
      expect(sessionService.get("session-ended-send")?.resumeMetadata?.launch).toMatchObject({
        model: "gpt-5.4",
        reasoningEffort: "high",
        fastMode: true,
        permissionMode: "full-auto",
        codexApprovalPolicy: "on-request",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      });
      expect(mockPty.write).not.toHaveBeenCalled();
    });

    it("sendToSession preserves stored launch model and reasoning when no overrides are provided", async () => {
      const { service, sessionService, loadPty } = createHarness();
      sessionService.create({
        sessionId: "session-ended-stored-launch",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Codex CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-ended-stored-launch.log",
        toolType: "codex",
        resumeCommand: "codex --no-alt-screen --model gpt-5.4 -c 'model_reasoning_effort=\"medium\"' --sandbox workspace-write --ask-for-approval untrusted resume thread-stored",
        resumeMetadata: {
          provider: "codex",
          targetKind: "thread",
          targetId: "thread-stored",
          launch: {
            permissionMode: "edit",
            model: "gpt-5.4",
            reasoningEffort: "medium",
          },
        },
      });
      sessionService.end({
        sessionId: "session-ended-stored-launch",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });

      const pending = service.sendToSession({
        sessionId: "session-ended-stored-launch",
        text: "continue",
      });
      await Promise.resolve();
      await pending;

      const spawn = (loadPty.mock.results[0]?.value as any).spawn;
      expect(spawn).toHaveBeenCalledWith(
        "/bin/bash",
        ["--noprofile", "--norc", "-lc", "codex --no-alt-screen --model gpt-5.4 -c \"model_reasoning_effort=\\\"medium\\\"\" --sandbox workspace-write --ask-for-approval untrusted resume thread-stored continue"],
        expect.any(Object),
      );
    });

    it("sendToSession persists a coarse Codex permission override across later continuations", async () => {
      const { service, sessionService, mockPty, loadPty } = createHarness();
      sessionService.create({
        sessionId: "session-ended-permission-override",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Codex CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-ended-permission-override.log",
        toolType: "codex",
        resumeCommand: "codex --no-alt-screen --sandbox danger-full-access --ask-for-approval never resume thread-permission-override",
        resumeMetadata: {
          provider: "codex",
          targetKind: "thread",
          targetId: "thread-permission-override",
          launch: {
            permissionMode: "full-auto",
            codexApprovalPolicy: "never",
            codexSandbox: "danger-full-access",
            codexConfigSource: "flags",
          },
        },
      });
      sessionService.end({
        sessionId: "session-ended-permission-override",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });

      await service.sendToSession({
        sessionId: "session-ended-permission-override",
        text: "first continuation",
        permissionMode: "plan",
      });

      expect(sessionService.get("session-ended-permission-override")?.resumeMetadata?.launch).toMatchObject({
        permissionMode: "plan",
        codexApprovalPolicy: null,
        codexSandbox: null,
        codexConfigSource: null,
      });
      const spawn = (loadPty.mock.results[0]?.value as any).spawn;
      expect(spawn).toHaveBeenLastCalledWith(
        "/bin/bash",
        ["--noprofile", "--norc", "-lc", "codex --no-alt-screen --sandbox read-only --ask-for-approval on-request resume thread-permission-override \"first continuation\""],
        expect.any(Object),
      );

      mockPty._emitter.emit("exit", { exitCode: 0 });

      await service.sendToSession({
        sessionId: "session-ended-permission-override",
        text: "later continuation",
      });

      const laterSpawn = (loadPty.mock.results[1]?.value as any).spawn;
      expect(laterSpawn).toHaveBeenCalledWith(
        "/bin/bash",
        ["--noprofile", "--norc", "-lc", "codex --no-alt-screen --sandbox read-only --ask-for-approval on-request resume thread-permission-override \"later continuation\""],
        expect.any(Object),
      );
    });

    it("sendToSession rebuilds legacy resumeCommand-only sessions with the prompt at launch", async () => {
      const { service, sessionService, mockPty, loadPty } = createHarness();
      sessionService.create({
        sessionId: "session-legacy-resume-command",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Codex CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-legacy-resume-command.log",
        toolType: "codex",
        resumeCommand: "codex --no-alt-screen --sandbox workspace-write --ask-for-approval untrusted resume thread-legacy",
        resumeMetadata: null,
      });
      sessionService.end({
        sessionId: "session-legacy-resume-command",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });

      await service.sendToSession({
        sessionId: "session-legacy-resume-command",
        text: "continue legacy thread",
      });

      const spawn = (loadPty.mock.results[0]?.value as any).spawn;
      expect(spawn).toHaveBeenCalledWith(
        "/bin/bash",
        ["--noprofile", "--norc", "-lc", "codex --no-alt-screen --sandbox workspace-write --ask-for-approval untrusted resume thread-legacy \"continue legacy thread\""],
        expect.any(Object),
      );
      expect(mockPty.write).not.toHaveBeenCalled();
    });

    it("resumeSession relaunches an ended tracked CLI session without writing a prompt", async () => {
      const { service, sessionService, mockPty, loadPty } = createHarness();
      sessionService.create({
        sessionId: "session-ended-resume-only",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Codex CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-ended-resume-only.log",
        toolType: "codex",
        resumeCommand: "codex resume thread-resume-only",
        resumeMetadata: {
          provider: "codex",
          targetKind: "thread",
          targetId: "thread-resume-only",
          launch: { permissionMode: "plan" },
        },
      });
      sessionService.end({
        sessionId: "session-ended-resume-only",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });

      const result = await service.resumeSession({
        sessionId: "session-ended-resume-only",
        cols: 120,
        rows: 40,
      });

      expect(result).toEqual(expect.objectContaining({
        sessionId: "session-ended-resume-only",
        resumed: true,
        reusedExistingRuntime: false,
      }));
      const spawn = (loadPty.mock.results[0]?.value as any).spawn;
      expect(spawn).toHaveBeenCalledWith(
        "/bin/bash",
        ["--noprofile", "--norc", "-lc", "codex --no-alt-screen --sandbox read-only --ask-for-approval on-request resume thread-resume-only"],
        expect.any(Object),
      );
      expect(mockPty.write).not.toHaveBeenCalled();
    });

    it("includes the asynchronously resolved Computer Use MCP config in Codex resume args", async () => {
      const { service, sessionService, loadPty } = createHarness();
      const command = "/Applications/Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient";
      mocks.resolveCodexComputerUseMcpConfig.mockResolvedValueOnce({
        command,
        args: ["mcp"],
        enabled: true,
      });
      sessionService.create({
        sessionId: "session-codex-computer-use",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Codex CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-codex-computer-use.log",
        toolType: "codex",
        resumeCommand: "codex resume thread-computer-use",
        resumeMetadata: {
          provider: "codex",
          targetKind: "thread",
          targetId: "thread-computer-use",
          launch: { permissionMode: "default" },
        },
      });
      sessionService.end({
        sessionId: "session-codex-computer-use",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });

      await service.resumeSession({
        sessionId: "session-codex-computer-use",
        cols: 120,
        rows: 40,
      });

      expect(mocks.resolveCodexComputerUseMcpConfig).toHaveBeenCalledTimes(1);
      const spawn = (loadPty.mock.results[0]?.value as any).spawn;
      const startupCommand = spawn.mock.calls[0]?.[1]?.[3] as string;
      expect(startupCommand).toContain("mcp_servers.computer_use.command");
      expect(startupCommand).toContain("mcp_servers.computer_use.args");
      expect(startupCommand).toContain("mcp_servers.computer_use.enabled=true");
      expect(startupCommand).toContain("SkyComputerUseClient");
    });

    it("sendToSession launches resumed Codex with the prompt argument when the composer is visible", async () => {
      vi.useFakeTimers();
      try {
        const { service, sessionService, mockPty, loadPty } = createHarness();
        sessionService.create({
          sessionId: "session-codex-visible-composer",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt: "2026-04-09T12:00:00.000Z",
          transcriptPath: "/tmp/transcripts/session-codex-visible-composer.log",
          toolType: "codex",
          resumeCommand: "codex resume thread-visible-composer",
          resumeMetadata: {
            provider: "codex",
            targetKind: "thread",
            targetId: "thread-visible-composer",
            launch: { permissionMode: "plan" },
          },
        });
        sessionService.end({
          sessionId: "session-codex-visible-composer",
          endedAt: "2026-04-09T12:30:00.000Z",
          exitCode: 0,
          status: "completed",
        });

        const pending = service.sendToSession({
          sessionId: "session-codex-visible-composer",
          text: "continue from the visible prompt",
        });
        await Promise.resolve();
        mockPty._emitter.emit("data", "› \ngpt-5.5 xhigh fast · ~/Projects/ADE\n");

        await pending;

        const spawn = (loadPty.mock.results[0]?.value as any).spawn;
        expect(spawn).toHaveBeenCalledWith(
          "/bin/bash",
          ["--noprofile", "--norc", "-lc", "codex --no-alt-screen --sandbox read-only --ask-for-approval on-request resume thread-visible-composer \"continue from the visible prompt\""],
          expect.any(Object),
        );
        expect(mockPty.write).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves percent signs when resuming a Windows CLI through cmd.exe", async () => {
      vi.useFakeTimers();
      try {
        setPlatform("win32");
        const { service, sessionService, mockPty, loadPty } = createHarness();
        sessionService.create({
          sessionId: "session-codex-windows-percent",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt: "2026-04-09T12:00:00.000Z",
          transcriptPath: "C:\\tmp\\transcripts\\session-codex-windows-percent.log",
          toolType: "codex",
          resumeCommand: "codex resume thread-windows-percent",
          resumeMetadata: {
            provider: "codex",
            targetKind: "thread",
            targetId: "thread-windows-percent",
            launch: { permissionMode: "plan" },
          },
        });
        sessionService.end({
          sessionId: "session-codex-windows-percent",
          endedAt: "2026-04-09T12:30:00.000Z",
          exitCode: 0,
          status: "completed",
        });

        const prompt = "Keep 100% literal and do not expand %PATH%.";
        const pending = service.sendToSession({
          sessionId: "session-codex-windows-percent",
          text: prompt,
        });
        await vi.advanceTimersByTimeAsync(0);
        mockPty._emitter.emit("data", "› \ngpt-5.5 xhigh fast · C:\\Projects\\ADE\n");
        await vi.advanceTimersByTimeAsync(2_000);
        await pending;

        const spawn = (loadPty.mock.results[0]?.value as any).spawn;
        const [command, commandLine] = spawn.mock.calls[0] as [string, string];
        expect(command).toMatch(/cmd(?:\.exe)?$/i);
        expect(commandLine).toContain("thread-windows-percent");
        expect(commandLine).not.toContain("100%");
        expect(commandLine).not.toContain("%PATH%");
        const writes = vi.mocked(mockPty.write).mock.calls.map(([value]) => String(value));
        expect(writes).toContainEqual(
          expect.stringContaining(prompt),
        );
        expect(writes).not.toContainEqual(
          expect.stringContaining("100%%"),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("sendToSession does not wait for provider-specific readiness before resuming with a prompt", async () => {
      vi.useFakeTimers();
      try {
        const { service, sessionService, mockPty, loadPty, logger } = createHarness();
        sessionService.create({
          sessionId: "session-codex-not-ready-preserve",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt: "2026-04-09T12:00:00.000Z",
          transcriptPath: "/tmp/transcripts/session-codex-not-ready-preserve.log",
          toolType: "codex",
          resumeCommand: "codex resume thread-not-ready-preserve",
          resumeMetadata: {
            provider: "codex",
            targetKind: "thread",
            targetId: "thread-not-ready-preserve",
            launch: { permissionMode: "plan" },
          },
        });
        sessionService.end({
          sessionId: "session-codex-not-ready-preserve",
          endedAt: "2026-04-09T12:30:00.000Z",
          exitCode: 0,
          status: "completed",
        });

        const pending = service.sendToSession({
          sessionId: "session-codex-not-ready-preserve",
          text: "this should not kill the resumed terminal",
        });
        await Promise.resolve();
        mockPty._emitter.emit("data", "Starting MCP servers (0/9)\n");

        await pending;

        const spawn = (loadPty.mock.results[0]?.value as any).spawn;
        expect(spawn).toHaveBeenCalledWith(
          "/bin/bash",
          ["--noprofile", "--norc", "-lc", "codex --no-alt-screen --sandbox read-only --ask-for-approval on-request resume thread-not-ready-preserve \"this should not kill the resumed terminal\""],
          expect.any(Object),
        );
        expect(mockPty.write).not.toHaveBeenCalled();
        expect(mockPty.kill).not.toHaveBeenCalled();
        expect(sessionService.end).not.toHaveBeenCalledWith(expect.objectContaining({
          sessionId: "session-codex-not-ready-preserve",
          status: "disposed",
        }));
        expect(logger.warn).not.toHaveBeenCalledWith(
          "pty.resume_send_input_failed_preserved",
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("sendToSession resumes Cursor and sends the prompt after the composer is ready", async () => {
      vi.useFakeTimers();
      try {
        const { service, sessionService, mockPty, loadPty } = createHarness();
        sessionService.create({
          sessionId: "session-cursor-resume",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Cursor CLI",
          startedAt: "2026-04-09T12:00:00.000Z",
          transcriptPath: "/tmp/transcripts/session-cursor-resume.log",
          toolType: "cursor-cli",
          resumeCommand: "cursor-agent --model auto --resume cursor-chat-1",
          resumeMetadata: {
            provider: "cursor",
            targetKind: "session",
            targetId: "cursor-chat-1",
            launch: { permissionMode: "default", model: "auto" },
          },
        });
        sessionService.end({
          sessionId: "session-cursor-resume",
          endedAt: "2026-04-09T12:30:00.000Z",
          exitCode: 0,
          status: "completed",
        });

        const pending = service.sendToSession({
          sessionId: "session-cursor-resume",
          text: "Print EXACT_CURSOR_RESUME_526 and stop",
          cols: 120,
          rows: 40,
        });
        await Promise.resolve();
        await vi.waitFor(() => {
          expect(loadPty).toHaveBeenCalled();
        });
        const spawn = (loadPty.mock.results[0]?.value as any).spawn;
        expect(spawn).toHaveBeenCalledWith(
          "/bin/bash",
          ["--noprofile", "--norc", "-lc", "cursor-agent --model auto --resume cursor-chat-1"],
          expect.any(Object),
        );
        mockPty._emitter.emit("data", "Cursor Agent\nv2026.05.24\n→ Add a follow-up\n");

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockPty.write).toHaveBeenNthCalledWith(1, "\x05");
        await vi.advanceTimersByTimeAsync(25);
        expect(mockPty.write).toHaveBeenNthCalledWith(2, "\x15");
        await vi.advanceTimersByTimeAsync(25);
        expect(mockPty.write).toHaveBeenNthCalledWith(3, "Print EXACT_CURSOR_RESUME_526 and stop");
        await vi.advanceTimersByTimeAsync(500);

        const result = await pending;

        expect(result).toEqual(expect.objectContaining({
          sessionId: "session-cursor-resume",
          resumed: true,
          reusedExistingRuntime: false,
        }));
        expect(mockPty.write).toHaveBeenLastCalledWith("\r");
      } finally {
        vi.useRealTimers();
      }
    });

    it("sendToSession does not inject a resumed Cursor prompt before the composer is ready", async () => {
      vi.useFakeTimers();
      try {
        const { service, sessionService, mockPty, loadPty, logger } = createHarness();
        sessionService.create({
          sessionId: "session-cursor-trust",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Cursor CLI",
          startedAt: "2026-04-09T12:00:00.000Z",
          transcriptPath: "/tmp/transcripts/session-cursor-trust.log",
          toolType: "cursor-cli",
          resumeCommand: "cursor-agent --model auto --resume cursor-chat-trust",
          resumeMetadata: {
            provider: "cursor",
            targetKind: "session",
            targetId: "cursor-chat-trust",
            launch: { permissionMode: "default", model: "auto" },
          },
        });
        sessionService.end({
          sessionId: "session-cursor-trust",
          endedAt: "2026-04-09T12:30:00.000Z",
          exitCode: 0,
          status: "completed",
        });

        const pending = service.sendToSession({
          sessionId: "session-cursor-trust",
          text: "Print EXACT_CURSOR_TRUST_TIMEOUT and stop",
          cols: 120,
          rows: 40,
        }).then(
          (result) => ({ result, error: null as Error | null }),
          (error: Error) => ({ result: null, error }),
        );
        await Promise.resolve();
        mockPty._emitter.emit("data", [
          "Cursor Agent\n",
          "Workspace Trust Required\n",
          "Do you trust the content of this directory?\n",
          "[a] Trust this workspace\n",
        ].join(""));

        await vi.advanceTimersByTimeAsync(20_500);
        await expect(pending).resolves.toEqual(expect.objectContaining({
          result: null,
          error: expect.objectContaining({
            message: expect.stringContaining("could not receive the message"),
          }),
        }));
        const spawn = (loadPty.mock.results[0]?.value as any).spawn;
        expect(spawn).toHaveBeenCalledWith(
          "/bin/bash",
          ["--noprofile", "--norc", "-lc", "cursor-agent --model auto --resume cursor-chat-trust"],
          expect.any(Object),
        );
        expect(mockPty.write).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.agent_cli_ready_wait_timeout",
          expect.objectContaining({ provider: "cursor" }),
        );
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.resume_send_input_failed_preserved",
          expect.objectContaining({ provider: "cursor" }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("sendToSession can continue Cursor without a captured chat id and never adds --trust", async () => {
      vi.useFakeTimers();
      try {
        const { service, sessionService, mockPty, loadPty } = createHarness();
        sessionService.create({
          sessionId: "session-cursor-continue",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Cursor CLI",
          startedAt: "2026-04-09T12:00:00.000Z",
          transcriptPath: "/tmp/transcripts/session-cursor-continue.log",
          toolType: "cursor-cli",
          resumeCommand: "cursor-agent --force --trust --model composer-2.5-fast --continue",
          resumeMetadata: {
            provider: "cursor",
            targetKind: "session",
            targetId: null,
            launch: { permissionMode: "full-auto", model: "composer-2.5-fast" },
          },
        });
        sessionService.end({
          sessionId: "session-cursor-continue",
          endedAt: "2026-04-09T12:30:00.000Z",
          exitCode: 1,
          status: "failed",
        });

        const pending = service.sendToSession({
          sessionId: "session-cursor-continue",
          text: "Print EXACT_CURSOR_CONTINUE and stop",
          cols: 120,
          rows: 40,
        });
        await Promise.resolve();
        await vi.waitFor(() => {
          expect(loadPty).toHaveBeenCalled();
        });
        const spawn = (loadPty.mock.results[0]?.value as any).spawn;
        expect(spawn).toHaveBeenCalledWith(
          "/bin/bash",
          ["--noprofile", "--norc", "-lc", "cursor-agent --force --model composer-2.5-fast --continue"],
          expect.any(Object),
        );
        await Promise.resolve();
        mockPty._emitter.emit("data", "Cursor Agent\nv2026.05.24\nUse /skills to give Cursor specialized knowledge for tasks.\n");
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1000);
        expect(mockPty.write).toHaveBeenNthCalledWith(1, "\x05");
        await vi.advanceTimersByTimeAsync(25);
        expect(mockPty.write).toHaveBeenNthCalledWith(2, "\x15");
        await vi.advanceTimersByTimeAsync(25);
        expect(mockPty.write).toHaveBeenNthCalledWith(3, "Print EXACT_CURSOR_CONTINUE and stop");
        await vi.advanceTimersByTimeAsync(500);
        await expect(pending).resolves.toEqual(expect.objectContaining({
          sessionId: "session-cursor-continue",
          resumed: true,
          reusedExistingRuntime: false,
        }));
        expect(mockPty.write).toHaveBeenLastCalledWith("\r");
      } finally {
        vi.useRealTimers();
      }
    });

    it("resumeSession can continue Cursor without a captured chat id and never adds --trust", async () => {
      const { service, sessionService, loadPty } = createHarness();
      sessionService.create({
        sessionId: "session-cursor-resume-continue",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Cursor CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-cursor-resume-continue.log",
        toolType: "cursor-cli",
        resumeCommand: "cursor-agent --force --trust --model composer-2.5-fast --continue",
        resumeMetadata: {
          provider: "cursor",
          targetKind: "session",
          targetId: null,
          launch: { permissionMode: "full-auto", model: "composer-2.5-fast" },
        },
      });
      sessionService.end({
        sessionId: "session-cursor-resume-continue",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 1,
        status: "failed",
      });

      await expect(service.resumeSession({
        sessionId: "session-cursor-resume-continue",
        cols: 120,
        rows: 40,
      })).resolves.toEqual(expect.objectContaining({
        sessionId: "session-cursor-resume-continue",
        resumed: true,
        reusedExistingRuntime: false,
      }));

      const spawn = (loadPty.mock.results[0]?.value as any).spawn;
      expect(spawn).toHaveBeenCalledWith(
        "/bin/bash",
        ["--noprofile", "--norc", "-lc", "cursor-agent --force --model composer-2.5-fast --continue"],
        expect.any(Object),
      );
    });

    // The Windows Droid resume runs `powershell.exe -Command <line>`, whose
    // command line reaches a droid.cmd shim truncated at the first newline. The
    // launch builder now withholds the prompt (surfacing it as `initialInput`),
    // so the resume path must notice and still write it over the PTY.
    it("resumes Droid on Windows with the prompt written over the PTY, not the command line", async () => {
      vi.useFakeTimers();
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        const { service, sessionService, mockPty, loadPty } = createHarness();
        sessionService.create({
          sessionId: "session-droid-windows",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Droid CLI",
          startedAt: "2026-07-30T12:00:00.000Z",
          transcriptPath: "C:\\tmp\\transcripts\\session-droid-windows.log",
          toolType: "droid",
          resumeCommand: "droid --resume droid-session-1",
          resumeMetadata: {
            provider: "droid",
            targetKind: "session",
            targetId: "droid-session-1",
            launch: { permissionMode: "edit", model: "droid/claude-sonnet-5" },
          },
        });
        sessionService.end({
          sessionId: "session-droid-windows",
          endedAt: "2026-07-30T12:30:00.000Z",
          exitCode: 0,
          status: "completed",
        });

        const prompt = "Continue in %TEMP%\nsecond line";
        const pending = service.sendToSession({
          sessionId: "session-droid-windows",
          text: prompt,
        });
        await vi.advanceTimersByTimeAsync(0);
        mockPty._emitter.emit("data", "Droid\nWhat do you want to build?\n");
        await vi.advanceTimersByTimeAsync(2_000);

        await expect(pending).resolves.toEqual(expect.objectContaining({
          sessionId: "session-droid-windows",
          resumed: true,
          reusedExistingRuntime: false,
        }));

        const spawn = (loadPty.mock.results[0]?.value as any).spawn;
        const [spawnCommand, spawnArgs] = spawn.mock.calls[0] as [string, string | string[]];
        expect(spawnCommand).toBe("powershell.exe");
        expect(String(spawnArgs)).toContain("droid-session-1");
        expect(String(spawnArgs)).not.toContain("Continue in");
        expect(String(spawnArgs)).not.toContain("%TEMP%");
        const writes = vi.mocked(mockPty.write).mock.calls.map(([value]) => String(value));
        expect(writes).toContainEqual(expect.stringContaining(prompt));
        // Exactly once. The launch builder surfaces the withheld prompt as
        // `initialInput`, which on this path is a signal ("the command line
        // does not carry it") and not a delivery request — the resume path does
        // its own ready-gated `writeSubmittedText`. `getOrCreateResumeFlight`
        // therefore does not forward the field to `create()`. Verified with
        // teeth: adding that one forwarding line makes this assertion fail with
        // two writes of the same text.
        const promptWrites = writes.filter((value) => value.includes("second line"));
        expect(promptWrites).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    });

    it("resumes OpenCode on Windows through direct argv and inherited env", async () => {
      vi.useFakeTimers();
      const originalPlatform = process.platform;
      const previousReplay = process.env.ADE_OPENCODE_REPLAY_RESUME;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      process.env.ADE_OPENCODE_REPLAY_RESUME = "0";
      try {
        const { service, sessionService, mockPty, loadPty } = createHarness();
        sessionService.create({
          sessionId: "session-opencode-windows",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "OpenCode CLI",
          startedAt: "2026-07-30T12:00:00.000Z",
          transcriptPath: "C:\\tmp\\transcripts\\session-opencode-windows.log",
          toolType: "opencode",
          resumeCommand: "opencode --session ses_windows",
          resumeMetadata: {
            provider: "opencode",
            targetKind: "session",
            targetId: "ses_windows",
            launch: {
              permissionMode: "plan",
              model: "opencode/openai/gpt-5.4",
            },
          },
        });
        sessionService.end({
          sessionId: "session-opencode-windows",
          endedAt: "2026-07-30T12:30:00.000Z",
          exitCode: 0,
          status: "completed",
        });

        const prompt = "Continue in C:\\Program Files\\ADE's $lane %TEMP% & café";
        const pending = service.sendToSession({
          sessionId: "session-opencode-windows",
          text: prompt,
        });
        await vi.advanceTimersByTimeAsync(0);
        mockPty._emitter.emit("data", "OpenCode\nWhat do you want to do?\n");
        await vi.advanceTimersByTimeAsync(2_000);

        await expect(pending).resolves.toEqual(expect.objectContaining({
          sessionId: "session-opencode-windows",
          resumed: true,
          reusedExistingRuntime: false,
        }));

        const spawn = (loadPty.mock.results[0]?.value as any).spawn;
        const [spawnCommand, spawnArgs, spawnOptions] = spawn.mock.calls[0] as [
          string,
          string | string[],
          { env: Record<string, string> },
        ];
        expect(spawnCommand.toLowerCase()).toContain("cmd");
        expect(spawnArgs).toContain("opencode");
        expect(spawnArgs).toContain("--session");
        expect(spawnArgs).toContain("ses_windows");
        expect(spawnArgs).not.toContain(prompt);
        expect(spawnArgs).not.toContain("%TEMP%");
        expect(spawnOptions.env.OPENCODE_CONFIG_CONTENT).toContain("\"question\":\"allow\"");
        expect(mockPty.write).not.toHaveBeenCalledWith(expect.stringContaining("OPENCODE_CONFIG_CONTENT="));
        const writes = vi.mocked(mockPty.write).mock.calls.map(([value]) => String(value));
        expect(writes).toContainEqual(expect.stringContaining(prompt));
        expect(writes).not.toContainEqual(expect.stringContaining("%%TEMP%%"));
      } finally {
        vi.useRealTimers();
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        if (previousReplay === undefined) {
          delete process.env.ADE_OPENCODE_REPLAY_RESUME;
        } else {
          process.env.ADE_OPENCODE_REPLAY_RESUME = previousReplay;
        }
      }
    });

    it("sendToSession uses OpenCode replay resume when the installed CLI supports it", async () => {
      const previous = process.env.ADE_OPENCODE_REPLAY_RESUME;
      process.env.ADE_OPENCODE_REPLAY_RESUME = "1";
      try {
        const { service, sessionService, mockPty, loadPty } = createHarness();
        sessionService.create({
          sessionId: "session-opencode-replay",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "OpenCode CLI",
          startedAt: "2026-04-09T12:00:00.000Z",
          transcriptPath: "/tmp/transcripts/session-opencode-replay.log",
          toolType: "opencode",
          resumeCommand: "opencode --session ses_abc",
          resumeMetadata: {
            provider: "opencode",
            targetKind: "session",
            targetId: "ses_abc",
            launch: { permissionMode: "plan", fastMode: true },
          },
        });
        sessionService.end({
          sessionId: "session-opencode-replay",
          endedAt: "2026-04-09T12:30:00.000Z",
          exitCode: 0,
          status: "completed",
        });

        const result = await service.sendToSession({
          sessionId: "session-opencode-replay",
          text: "continue from the freeze frame",
          model: "opencode/lmstudio/openai%2Fgpt-oss-20b",
          permissionMode: "plan",
        });

        expect(result).toEqual(expect.objectContaining({
          sessionId: "session-opencode-replay",
          resumed: true,
          reusedExistingRuntime: false,
        }));
        const spawn = (loadPty.mock.results[0]?.value as any).spawn;
        const spawnArgs = spawn.mock.calls.map((call: any[]) => call[1]).flat();
        expect(spawnArgs).toContain(buildCanonicalOpenCodeReplayResumeCommand({
          permissionMode: "plan",
          model: "opencode/lmstudio/openai%2Fgpt-oss-20b",
          fastMode: true,
          resumeTarget: "ses_abc",
          prompt: "continue from the freeze frame",
          replayLimit: 40,
        }));
        expect(mockPty.write).not.toHaveBeenCalledWith("continue from the freeze frame\r");
      } finally {
        if (previous === undefined) {
          delete process.env.ADE_OPENCODE_REPLAY_RESUME;
        } else {
          process.env.ADE_OPENCODE_REPLAY_RESUME = previous;
        }
      }
    });

    it("sendToSession single-flights concurrent resumes for the same session", async () => {
      const { service, sessionService, mockPty, loadPty } = createHarness();
      sessionService.create({
        sessionId: "session-concurrent-send",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Codex CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-concurrent-send.log",
        toolType: "codex",
        resumeCommand: "codex resume thread-concurrent",
        resumeMetadata: {
          provider: "codex",
          targetKind: "thread",
          targetId: "thread-concurrent",
          launch: { permissionMode: "default" },
        },
      });
      sessionService.end({
        sessionId: "session-concurrent-send",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });

      const pending = Promise.all([
        service.sendToSession({ sessionId: "session-concurrent-send", text: "first" }),
        service.sendToSession({ sessionId: "session-concurrent-send", text: "second" }),
      ]);
      for (let i = 0; i < 10 && loadPty.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      await Promise.resolve();
      mockPty._emitter.emit("data", "OpenAI Codex\n› ");
      const [first, second] = await pending;

      expect(first.ptyId).toBe(second.ptyId);
      expect(loadPty).toHaveBeenCalledTimes(1);
      const spawn = (loadPty.mock.results[0]?.value as any).spawn;
      expect(spawn).toHaveBeenCalledWith(
        "/bin/bash",
        ["--noprofile", "--norc", "-lc", "codex --no-alt-screen --sandbox workspace-write --ask-for-approval on-request resume thread-concurrent first"],
        expect.any(Object),
      );
      const writes = (mockPty.write as any).mock.calls.map((call: string[]) => call[0]);
      const secondText = writes.indexOf("\x1b[200~second\x1b[201~");
      const secondSubmit = writes.indexOf("\r", secondText + 1);
      expect(writes).not.toContain("\x1b[200~first\x1b[201~");
      expect(secondText).toBeGreaterThanOrEqual(0);
      expect(secondSubmit).toBeGreaterThan(secondText);
    });

    it("sendToSession rejects ended shell sessions", async () => {
      const { service, sessionService } = createHarness();
      sessionService.create({
        sessionId: "session-shell-ended",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Shell",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-shell-ended.log",
        toolType: "shell",
        resumeCommand: null,
        resumeMetadata: null,
      });
      sessionService.end({
        sessionId: "session-shell-ended",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });

      await expect(service.sendToSession({
        sessionId: "session-shell-ended",
        text: "hello",
      })).rejects.toThrow(/not an agent CLI session/i);
    });

    it("rejects reattaching a session into the wrong lane", async () => {
      const { service, sessionService } = createHarness();
      sessionService.create({
        sessionId: "session-other-lane",
        laneId: "lane-other",
        ptyId: null,
        tracked: true,
        title: "Codex CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-other-lane.log",
        toolType: "codex",
        resumeCommand: "codex --no-alt-screen resume thread-existing",
        resumeMetadata: {
          provider: "codex",
          targetKind: "thread",
          targetId: "thread-existing",
          launch: { permissionMode: "config-toml" },
        },
      });

      await expect(service.create({
        sessionId: "session-other-lane",
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        startupCommand: "codex --no-alt-screen resume thread-existing",
      })).rejects.toThrow(/belongs to lane/i);
    });

    it("preserves the previous session outcome when a reattached resume spawn fails", async () => {
      const { service, sessionService, loadPty } = createHarness();
      loadPty.mockReturnValue({
        spawn: vi.fn(() => {
          throw new Error("spawn failed");
        }),
      });
      sessionService.create({
        sessionId: "session-existing",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Codex CLI",
        startedAt: "2026-04-09T12:00:00.000Z",
        transcriptPath: "/tmp/transcripts/session-existing.log",
        toolType: "codex",
        resumeCommand: "codex --no-alt-screen resume thread-existing",
        resumeMetadata: {
          provider: "codex",
          targetKind: "thread",
          targetId: "thread-existing",
          launch: { permissionMode: "config-toml" },
        },
      });
      sessionService.end({
        sessionId: "session-existing",
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });

      await expect(service.create({
        sessionId: "session-existing",
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
        startupCommand: "codex --no-alt-screen resume thread-existing",
      })).rejects.toThrow(/spawn failed/i);

      expect(sessionService.reattach).not.toHaveBeenCalled();
      expect(sessionService.end).toHaveBeenCalledTimes(1);
      expect(sessionService.get("session-existing")).toEqual(expect.objectContaining({
        status: "completed",
        exitCode: 0,
        endedAt: "2026-04-09T12:30:00.000Z",
      }));
    });

    it("normalizes toolType to a known value", async () => {
      const { service, sessionService } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "Claude session",
        cols: 80,
        rows: 24,
        toolType: "claude",
      });
      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({ toolType: "claude" }),
      );
    });

    it("preserves droid-chat as a known toolType", async () => {
      const { service, sessionService } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "Droid chat",
        cols: 80,
        rows: 24,
        toolType: "droid-chat",
      });
      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({ toolType: "droid-chat" }),
      );
    });

    it("normalizes unknown toolType to 'other'", async () => {
      const { service, sessionService } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "Unknown tool",
        cols: 80,
        rows: 24,
        toolType: "something-unknown" as any,
      });
      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({ toolType: "other" }),
      );
    });

    it("normalizes null/empty toolType to null", async () => {
      const { service, sessionService } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "No tool",
        cols: 80,
        rows: 24,
        toolType: null,
      });
      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({ toolType: null }),
      );
    });

    it.each([
      ["claude", "Claude Code"],
      ["codex", "Codex session"],
      ["cursor-cli", "Cursor Agent CLI"],
      ["droid", "Factory Droid CLI"],
      ["opencode", "OpenCode CLI"],
    ] as const)("generates %s titles from the first submitted PTY write using the bound cwd", async (toolType, title) => {
      vi.useFakeTimers();
      try {
        mocks.existsSyncResults.set("/tmp/test-worktree/subdir", true);
        const aiIntegrationService = {
          getMode: vi.fn(() => "subscription"),
          summarizeTerminal: vi.fn(async () => ({ text: "Bound title" })),
        };
        const { service, mockPty, laneService, sessionService } = createHarness({ aiIntegrationService });
        const { ptyId } = await service.create({
          laneId: "lane-1",
          cwd: "/tmp/test-worktree/subdir",
          title,
          cols: 80,
          rows: 24,
          toolType,
        });
        // Mark the metadata file as non-existent so readPersistedChatManuallyNamed returns false
        const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
        if (createdSessionId) {
          mocks.existsSyncResults.set(`/tmp/chat-sessions/${createdSessionId}.json`, false);
        }

        laneService.getLaneBaseAndBranch.mockReturnValue({
          worktreePath: "/tmp/other-worktree",
          baseRef: "origin/main",
          branchRef: "feature/moved",
        });

        mockPty._emitter.emit("data", "generated enough output for a better title");
        await vi.advanceTimersByTimeAsync(PTY_AI_TITLE_DEBOUNCE_MS);
        expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalled();

        service.write({ ptyId, data: "Fix the flaky login tests\r" });
        // Early CLI title is deferred so it can read a slice of session output.
        await vi.advanceTimersByTimeAsync(EARLY_CLI_AI_TITLE_DELAY_MS + 100);
        await Promise.resolve();

        expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledWith(
          expect.objectContaining({
            cwd: "/tmp/test-worktree/subdir",
            prompt: expect.stringContaining("Fix the flaky login tests"),
            timeoutMs: PTY_AI_TITLE_TIMEOUT_MS,
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("stores the first CLI prompt as the session goal immediately", async () => {
      const { service, sessionService } = createHarness();
      const { ptyId } = await service.create({
        laneId: "lane-1",
        title: "Codex",
        cols: 80,
        rows: 24,
        toolType: "codex",
      });

      const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
      expect(typeof createdSessionId).toBe("string");

      service.write({ ptyId, data: "Fix the flaky login tests\r" });

      expect(sessionService.updateMeta).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: createdSessionId,
          goal: "Fix the flaky login tests",
        }),
      );
      expect(sessionService.get(createdSessionId)?.goal).toBe("Fix the flaky login tests");
    });

    it("uses the wrapped ADE user task instead of launch guidance for CLI fallback titles", async () => {
      const { service, sessionService } = createHarness();
      const { ptyId } = await service.create({
        laneId: "lane-1",
        title: "Codex",
        cols: 80,
        rows: 24,
        toolType: "codex",
      });

      const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
      expect(typeof createdSessionId).toBe("string");

      service.write({
        ptyId,
        data: [
          "ADE session guidance. Treat this as operating guidance for the CLI session.",
          "Start working on that user prompt immediately.",
          "",
          "User prompt:",
          "You are working in ADE lane:",
          "/repo/.ade/worktrees/context-iphone-17-simulator",
          "",
          "Edits and mutating commands must stay inside that worktree.",
          "",
          "The user is debugging the ADE iOS Work chat scroll/layout bugs.",
        ].join("\n") + "\r",
      });

      expect(sessionService.get(createdSessionId)?.title).toBe(
        "The user is debugging the ADE iOS Work chat scroll/layout bugs",
      );
      expect(sessionService.get(createdSessionId)?.goal).toBe(
        "The user is debugging the ADE iOS Work chat scroll/layout bugs.",
      );
    });

    it("ignores provider slash commands when choosing the first CLI title seed", async () => {
      const { service, sessionService } = createHarness();
      const { ptyId } = await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
      });

      const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
      expect(typeof createdSessionId).toBe("string");

      service.write({ ptyId, data: "/model\r" });

      expect(sessionService.get(createdSessionId)?.title).toBe("Codex CLI");
      expect(sessionService.get(createdSessionId)?.goal ?? null).toBeNull();

      service.write({ ptyId, data: "Fix the flaky login tests\r" });

      expect(sessionService.get(createdSessionId)?.title).toBe("Fix the flaky login tests");
      expect(sessionService.get(createdSessionId)?.goal).toBe("Fix the flaky login tests");
    });

    it("drops accidental leading slash markers from natural-language Claude titles", async () => {
      const { service, sessionService } = createHarness();
      const { ptyId } = await service.create({
        laneId: "lane-1",
        title: "Claude Code",
        cols: 80,
        rows: 24,
        toolType: "claude",
      });

      const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
      expect(typeof createdSessionId).toBe("string");

      service.write({ ptyId, data: "/this is a test\r" });

      expect(sessionService.get(createdSessionId)?.title).toBe("This is a test");
      expect(sessionService.get(createdSessionId)?.goal).toBe("/this is a test");
    });

    it("adopts Claude Code runtime ai-title from local session storage", async () => {
      vi.useFakeTimers();
      try {
        const claudeSessionId = "123e4567-e89b-12d3-a456-426614174000";
        const claudeFilePath = path.join(
          os.homedir(),
          ".claude",
          "projects",
          "-tmp-test-worktree",
          `${claudeSessionId}.jsonl`,
        );
        mocks.fileContents.set(claudeFilePath, "");

        const { service, sessionService } = createHarness();
        const { ptyId } = await service.create({
          laneId: "lane-1",
          title: "Claude Code",
          cols: 80,
          rows: 24,
          toolType: "claude",
          startupCommand: `claude --session-id ${claudeSessionId} --append-system-prompt guidance`,
        });

        const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
        expect(createdSessionId).toBeTruthy();

        service.write({ ptyId, data: "/this is a test\r" });
        expect(sessionService.get(createdSessionId)?.title).toBe("This is a test");

        const runtimeTitle = JSON.stringify({
          type: "ai-title",
          sessionId: claudeSessionId,
          aiTitle: "Test session setup",
        });
        mocks.fileContents.set(claudeFilePath, `${runtimeTitle}\n`);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(sessionService.get(createdSessionId)?.title).toBe("Test session setup");
        expect(sessionService.updateMeta).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: createdSessionId,
            title: "Test session setup",
            manuallyNamed: false,
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("adopts Claude runtime window titles emitted by the live PTY", async () => {
      const { service, mockPty, sessionService } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "Start with context skill then i wanna redesign the ade",
        cols: 80,
        rows: 24,
        toolType: "claude",
      });

      const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
      expect(typeof createdSessionId).toBe("string");

      mockPty._emitter.emit(
        "data",
        "\x1b]0;\u2802 Redesign ADE mobile app with unified project hub\x07",
      );

      expect(sessionService.get(createdSessionId)?.title).toBe(
        "Redesign ADE mobile app with unified project hub",
      );
      expect(sessionService.updateMeta).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: createdSessionId,
          title: "Redesign ADE mobile app with unified project hub",
          manuallyNamed: false,
        }),
      );
    });

    it("does not let provider window titles replace ADE AI title generation", async () => {
      const aiIntegrationService = {
        getMode: vi.fn(() => "subscription"),
        summarizeTerminal: vi.fn(async () => ({ text: "ADE generated title" })),
      };
      const { service, mockPty, sessionService } = createHarness({ aiIntegrationService });
      await service.create({
        laneId: "lane-1",
        title: "Start with context skill then i wanna redesign the ade",
        cols: 80,
        rows: 24,
        toolType: "claude",
      });

      const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
      expect(typeof createdSessionId).toBe("string");

      mockPty._emitter.emit(
        "data",
        "\x1b]0;\u2802 Redesign ADE mobile app with unified project hub\x07",
      );

      expect(sessionService.get(createdSessionId)?.title).toBe(
        "Start with context skill then i wanna redesign the ade",
      );
      expect(sessionService.updateMeta).not.toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: createdSessionId,
          title: "Redesign ADE mobile app with unified project hub",
        }),
      );
    });

    it("sets a deterministic title immediately, then upgrades it via a deferred AI pass for Claude CLI sessions", async () => {
      vi.useFakeTimers();
      try {
        const aiIntegrationService = {
          getMode: vi.fn(() => "subscription"),
          summarizeTerminal: vi.fn(async () => ({ text: "ADE generated title" })),
        };
        const { service, sessionService } = createHarness({ aiIntegrationService });
        const { ptyId } = await service.create({
          laneId: "lane-1",
          title: "Claude Code",
          cols: 80,
          rows: 24,
          toolType: "claude",
        });

        const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
        expect(createdSessionId).toBeTruthy();

        service.write({ ptyId, data: "Fix the flaky login tests\r" });
        await Promise.resolve();

        // Instant deterministic title; AI pass is deferred so it can read output.
        expect(sessionService.get(createdSessionId)?.title).toBe("Fix the flaky login tests");
        expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(EARLY_CLI_AI_TITLE_DELAY_MS + 100);
        await Promise.resolve();

        expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: expect.stringContaining("Fix the flaky login tests"),
            taskType: "session_title",
          }),
        );
        expect(sessionService.get(createdSessionId)?.title).toBe("ADE generated title");
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats legacy slash-command CLI titles as placeholders", async () => {
      const { service, sessionService } = createHarness();
      const { ptyId } = await service.create({
        laneId: "lane-1",
        title: "/model",
        cols: 80,
        rows: 24,
        toolType: "codex",
      });

      const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
      expect(createdSessionId).toBeTruthy();

      service.write({ ptyId, data: "Fix the flaky login tests\r" });

      expect(sessionService.get(createdSessionId)?.title).toBe("Fix the flaky login tests");
      expect(sessionService.get(createdSessionId)?.goal).toBe("Fix the flaky login tests");
    });

    it("sets a compact fallback title from the first CLI prompt while AI naming is pending", async () => {
      const { service, sessionService } = createHarness();
      const { ptyId } = await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
      });

      const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
      expect(createdSessionId).toBeTruthy();

      service.write({
        ptyId,
        data: "vv take a look at this screenshot, it shows a session card for a codex cli started in ade\r",
      });

      expect(sessionService.get(createdSessionId)?.title).toBe("Take a look at this screenshot");
      expect(sessionService.get(createdSessionId)?.goal).toBe(
        "vv take a look at this screenshot, it shows a session card for a codex cli started in ade",
      );
    });

    it("does not replace a manually renamed CLI session with the fallback title", async () => {
      const aiIntegrationService = {
        getMode: vi.fn(() => "subscription"),
        summarizeTerminal: vi.fn(async () => ({ text: "AI title" })),
      };
      const { service, sessionService } = createHarness({ aiIntegrationService });
      const { ptyId } = await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
      });

      const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
      expect(createdSessionId).toBeTruthy();
      sessionService.updateMeta({ sessionId: createdSessionId, title: "Manual title", manuallyNamed: true });

      service.write({ ptyId, data: "Fix the flaky login tests\r" });

      expect(sessionService.get(createdSessionId)?.title).toBe("Manual title");
      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalled();
    });

    it("rejects low-signal AI titles for raw CLI sessions", async () => {
      const aiIntegrationService = {
        getMode: vi.fn(() => "subscription"),
        summarizeTerminal: vi.fn(async () => ({ text: "/model" })),
      };
      const { service, sessionService } = createHarness({ aiIntegrationService });
      const { ptyId } = await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
      });

      const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
      expect(createdSessionId).toBeTruthy();

      service.write({ ptyId, data: "Fix the flaky login tests\r" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(sessionService.get(createdSessionId)?.title).toBe("Fix the flaky login tests");
    });

    it("backfills a missing tracked CLI resume target from the flushed transcript tail on exit", async () => {
      mocks.extractResumeCommandFromOutput.mockReturnValue("codex resume thread-backfilled" as any);
      const { service, mockPty, sessionService } = createHarness();
      const created = await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex-orchestrated",
        startupCommand: "codex --no-alt-screen",
      });
      const transcriptPath = sessionService.create.mock.calls[0]?.[0]?.transcriptPath;

      mockPty._emitter.emit("exit", { exitCode: 0 });
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(sessionService.readTranscriptTail).toHaveBeenCalledWith(transcriptPath, 220_000);
      expect(sessionService.setResumeCommand).toHaveBeenCalledWith(created.sessionId, "codex resume thread-backfilled");
    });

    it("backfills a missing Codex resume target from storage when session_meta exceeds 1 KB", async () => {
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);
        mocks.extractResumeCommandFromOutput.mockReturnValue(null);

        const homedir = os.homedir();
        const sessionsBase = path.join(homedir, ".codex", "sessions");
        const dirPath = path.join(sessionsBase, "2026", "04", "15");
        const filePath = path.join(dirPath, "rollout-2026-04-15T22-00-01-thread-storage.jsonl");
        const startedAt = "2026-04-15T22:00:01.000Z";
        const oversizedFirstLine = JSON.stringify({
          timestamp: startedAt,
          type: "session_meta",
          payload: {
            id: "thread-storage",
            timestamp: startedAt,
            cwd: "/tmp/test-worktree",
            base_instructions: {
              text: "x".repeat(5000),
            },
          },
        });

        mocks.existsSyncResults.set(sessionsBase, true);
        mocks.existsSyncResults.set(dirPath, true);
        mocks.dirEntries.set(dirPath, [path.basename(filePath)]);
        mocks.fileContents.set(filePath, `${oversizedFirstLine}\n{"timestamp":"2026-04-15T21:31:00.000Z","type":"event_msg","payload":{"type":"task_started"}}\n`);
        mocks.fileStats.set(filePath, { size: oversizedFirstLine.length + 100, mtimeMs: fakeNow.getTime() - 30_000, isDirectory: false });

        const { service, mockPty, sessionService } = createHarness();
        sessionService.readTranscriptTail.mockResolvedValueOnce("OpenAI Codex\nmodel: gpt-5\n› ");
        const created = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          startupCommand: "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox",
        });
        const createArgs = sessionService.create.mock.calls.at(-1)?.[0];
        expect(createArgs?.startedAt).toBeTruthy();

        mockPty._emitter.emit("exit", { exitCode: 0 });
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(created.sessionId, "codex resume thread-storage");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not overwrite a manually renamed CLI session title", async () => {
      vi.useFakeTimers();
      try {
        const aiIntegrationService = {
          getMode: vi.fn(() => "subscription"),
          summarizeTerminal: vi.fn(async () => ({ text: "AI title" })),
        };
        const { service, sessionService } = createHarness({ aiIntegrationService });
        const { ptyId } = await service.create({
          laneId: "lane-1",
          title: "Codex",
          cols: 80,
          rows: 24,
          toolType: "codex",
        });

        const createdSessionId = (sessionService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.sessionId;
        expect(createdSessionId).toBeTruthy();
        sessionService.updateMeta({ sessionId: createdSessionId, title: "My renamed session", manuallyNamed: true });

        service.write({ ptyId, data: "Fix the flaky login tests\r" });
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();

        expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalled();
        expect(sessionService.get(createdSessionId)?.title).toBe("My renamed session");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("write", () => {
    it("forwards data to the underlying PTY", async () => {
      const { service, mockPty } = createHarness();
      const { ptyId } = await service.create({ laneId: "lane-1", title: "w", cols: 80, rows: 24 });
      service.write({ ptyId, data: "ls\r" });
      expect(mockPty.write).toHaveBeenCalledWith("ls\r");
    });

    it("silently ignores writes to unknown pty ids", () => {
      const { service } = createHarness();
      expect(() => service.write({ ptyId: "non-existent", data: "test" })).not.toThrow();
    });
  });

  describe("resize", () => {
    it("resizes the PTY with clamped dimensions", async () => {
      const { service, mockPty } = createHarness();
      const { ptyId } = await service.create({ laneId: "lane-1", title: "r", cols: 80, rows: 24 });
      service.resize({ ptyId, cols: 10, rows: 3 });
      expect(mockPty.resize).toHaveBeenCalledWith(20, 6);
    });

    it("forwards Windows ConPTY resize dimensions without shell translation", async () => {
      setPlatform("win32");
      const { service, mockPty } = createHarness();
      const { ptyId } = await service.create({ laneId: "lane-1", title: "ConPTY resize", cols: 80, rows: 24 });

      service.resize({ ptyId, cols: 132, rows: 43 });

      expect(mockPty.resize).toHaveBeenCalledOnce();
      expect(mockPty.resize).toHaveBeenCalledWith(132, 43);
    });

    it("silently ignores resize on unknown pty ids", () => {
      const { service } = createHarness();
      expect(() => service.resize({ ptyId: "non-existent", cols: 80, rows: 24 })).not.toThrow();
    });
  });

  describe("getRuntimeState", () => {
    it("returns the tracked runtime state for active sessions", async () => {
      const { service } = createHarness();
      const { sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });
      const state = service.getRuntimeState(sessionId, "running");
      expect(state).toBe("running");
    });

    it("emits an idle runtime signal when a live CLI session stops outputting", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, onSessionRuntimeSignal } = createHarness();
        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Claude CLI",
          cols: 80,
          rows: 24,
          toolType: "claude",
        });

        mockPty._emitter.emit("data", "working...\n");
        onSessionRuntimeSignal.mockClear();

        await vi.advanceTimersByTimeAsync(12_499);
        expect(onSessionRuntimeSignal).not.toHaveBeenCalledWith(
          expect.objectContaining({ sessionId, runtimeState: "idle" }),
        );

        await vi.advanceTimersByTimeAsync(1);

        expect(service.getRuntimeState(sessionId, "running")).toBe("idle");
        expect(onSessionRuntimeSignal).toHaveBeenCalledWith(
          expect.objectContaining({
            laneId: "lane-1",
            sessionId,
            runtimeState: "idle",
          }),
        );

        onSessionRuntimeSignal.mockClear();
        mockPty._emitter.emit("data", "more work\n");

        expect(service.getRuntimeState(sessionId, "running")).toBe("running");
        expect(onSessionRuntimeSignal).toHaveBeenCalledWith(
          expect.objectContaining({
            laneId: "lane-1",
            sessionId,
            runtimeState: "running",
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("derives state from fallback status for unknown sessions", () => {
      const { service } = createHarness();
      expect(service.getRuntimeState("unknown-session", "completed")).toBe("exited");
      expect(service.getRuntimeState("unknown-session", "failed")).toBe("exited");
      expect(service.getRuntimeState("unknown-session", "running")).toBe("running");
      expect(service.getRuntimeState("unknown-session", "disposed")).toBe("killed");
      expect(service.getRuntimeState("unknown-session", "detached")).toBe("exited");
    });
  });

  describe("enrichSessions", () => {
    it("adds runtimeState to session summary rows", async () => {
      const { service } = createHarness();
      const { sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });
      const rows = [{ id: sessionId, status: "running" as const, extra: "data" }];
      const enriched = service.enrichSessions(rows as any);
      expect(enriched[0]).toMatchObject({ id: sessionId, runtimeState: "running", extra: "data" });
    });

    it("overlays live PTY attachment when a persisted row drifted to ended", async () => {
      const { service, sessionService } = createHarness();
      const { ptyId, sessionId } = await service.create({
        laneId: "lane-1",
        title: "Codex CLI",
        cols: 80,
        rows: 24,
        toolType: "codex",
      });
      sessionService.end({
        sessionId,
        endedAt: "2026-04-09T12:30:00.000Z",
        exitCode: 0,
        status: "completed",
      });

      const stale = sessionService.get(sessionId);
      expect(stale).toMatchObject({ status: "completed", ptyId: null });

      const enriched = service.enrichSessions([stale] as any);
      expect(enriched[0]).toMatchObject({
        id: sessionId,
        ptyId,
        status: "running",
        endedAt: null,
        exitCode: null,
        runtimeState: "running",
      });
    });

    it("falls back to status-derived state for unknown sessions", () => {
      const { service } = createHarness();
      const rows = [{ id: "unknown", status: "completed" as const }];
      const enriched = service.enrichSessions(rows as any);
      expect(enriched[0].runtimeState).toBe("exited");
    });

    it("presents stale running PTY rows without a live local PTY as ended", () => {
      const { service } = createHarness();
      const enriched = service.enrichSessions([{
        id: "stale-session",
        status: "running" as const,
        ptyId: "stale-pty",
        toolType: "codex" as const,
        chatSessionId: null,
      }] as any);

      expect(enriched[0]).toMatchObject({
        id: "stale-session",
        status: "detached",
        ptyId: null,
        runtimeState: "exited",
      });
    });

    it("keeps persisted agent chat rows resumable but idle when there is no PTY", () => {
      const { service } = createHarness();
      const enriched = service.enrichSessions([{
        id: "chat-session",
        status: "running" as const,
        ptyId: null,
        toolType: "codex-chat" as const,
        chatSessionId: "chat-session",
      }] as any);

      expect(enriched[0]).toMatchObject({
        id: "chat-session",
        status: "running",
        runtimeState: "idle",
      });
    });

    it("presents live peer-owned PTYs as detached from this runtime", () => {
      const processRegistry = {
        pid: 12_345,
        startedAt: "2026-03-17T00:00:00.000Z",
        isPidLive: vi.fn((pid: number) => pid === 99_999),
        isProcessIdentityLive: vi.fn((pid: number, startedAt: string | null) => (
          pid === 99_999 && startedAt === "2026-03-17T00:01:00.000Z"
        )),
      };
      const { service } = createHarness({ processRegistry });

      const enriched = service.enrichSessions([{
        id: "peer-session",
        status: "running" as const,
        ptyId: "peer-pty",
        ownerPid: 99_999,
        ownerProcessStartedAt: "2026-03-17T00:01:00.000Z",
        chatSessionId: null,
      }] as any);

      expect(enriched[0]).toMatchObject({
        id: "peer-session",
        status: "detached",
        ptyId: null,
        runtimeState: "exited",
      });
      expect(processRegistry.isProcessIdentityLive).toHaveBeenCalledWith(99_999, "2026-03-17T00:01:00.000Z");
    });
  });

  describe("dispose", () => {
    it("kills the PTY and ends the session", async () => {
      const { service, mockPty, sessionService, broadcastExit } = createHarness();
      const { ptyId, sessionId } = await service.create({ laneId: "lane-1", title: "d", cols: 80, rows: 24 });
      service.dispose({ ptyId });
      await Promise.resolve();
      expect(mockPty.kill).toHaveBeenCalled();
      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId, status: "disposed" }),
      );
      expect(broadcastExit).toHaveBeenCalledWith(
        expect.objectContaining({ ptyId, sessionId, exitCode: null }),
      );
    });

    it("does not kill a live PTY when the supplied session id belongs to another session", async () => {
      const { service, mockPty, sessionService, broadcastExit } = createHarness();
      const first = await service.create({ laneId: "lane-1", title: "first", cols: 80, rows: 24 });
      const second = await service.create({ laneId: "lane-1", title: "second", cols: 80, rows: 24 });

      const result = service.dispose({ ptyId: second.ptyId, sessionId: first.sessionId });

      expect(result).toEqual({ disposed: false, reason: "session-mismatch" });
      expect(mockPty.kill).not.toHaveBeenCalled();
      expect(sessionService.end).not.toHaveBeenCalled();
      expect(broadcastExit).not.toHaveBeenCalled();
    });

    it("handles disposing an already-disposed PTY gracefully", async () => {
      const { service } = createHarness();
      const { ptyId } = await service.create({ laneId: "lane-1", title: "d", cols: 80, rows: 24 });
      service.dispose({ ptyId });
      // Second dispose should not throw
      expect(() => service.dispose({ ptyId })).not.toThrow();
    });

    it("does not create per-session ADE tool config artifacts for tool sessions", async () => {
      const { service } = createHarness();
      const { ptyId } = await service.create({
        laneId: "lane-1",
        title: "Claude session",
        cols: 80,
        rows: 24,
        toolType: "claude",
        startupCommand: "claude",
      });

      service.dispose({ ptyId });

      expect(mocks.writeFileSync).not.toHaveBeenCalledWith(
        expect.stringContaining("agent-configs"),
        expect.anything(),
        expect.anything(),
      );
    });

    it("handles orphaned sessions (PTY not in map but session exists)", async () => {
      const { service, sessionService, broadcastExit, logger } = createHarness();
      sessionService.get.mockReturnValue({
        sessionId: "orphan-session",
        laneId: "lane-1",
        tracked: true,
        lastOutputPreview: "last output",
      });
      service.dispose({ ptyId: "missing-pty", sessionId: "orphan-session" });
      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "orphan-session", status: "disposed" }),
      );
      expect(broadcastExit).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "orphan-session", exitCode: null }),
      );
      expect(logger.warn).toHaveBeenCalledWith("pty.dispose_orphaned", expect.any(Object));
    });

    it("skips orphan dispose when a live peer owns the session", async () => {
      const processRegistry = {
        pid: 12_345,
        startedAt: "2026-03-17T00:00:00.000Z",
        isPidLive: vi.fn((pid: number) => pid === 99_999),
        isProcessIdentityLive: vi.fn((pid: number, startedAt: string | null) => (
          pid === 99_999 && startedAt === "2026-03-17T00:01:00.000Z"
        )),
      };
      const { service, sessionService, broadcastExit, logger } = createHarness({ processRegistry });
      sessionService.get.mockReturnValue({
        id: "peer-session",
        sessionId: "peer-session",
        laneId: "lane-1",
        tracked: true,
        ownerPid: 99_999,
        ownerProcessStartedAt: "2026-03-17T00:01:00.000Z",
        lastOutputPreview: "still running elsewhere",
      });

      service.dispose({ ptyId: "missing-pty", sessionId: "peer-session" });

      expect(sessionService.end).not.toHaveBeenCalled();
      expect(broadcastExit).not.toHaveBeenCalled();
      expect(processRegistry.isProcessIdentityLive).toHaveBeenCalledWith(99_999, "2026-03-17T00:01:00.000Z");
      expect(logger.warn).toHaveBeenCalledWith(
        "pty.dispose_skipped_owned_by_peer",
        expect.objectContaining({
          sessionId: "peer-session",
          ownerPid: 99_999,
          currentPid: 12_345,
        }),
      );
    });

    it("orphan dispose still ends sessions owned by us or dead peers", async () => {
      const processRegistry = {
        pid: 12_345,
        startedAt: "2026-03-17T00:00:00.000Z",
        isPidLive: vi.fn(() => false),
        isProcessIdentityLive: vi.fn(() => false),
      };
      const { service, sessionService } = createHarness({ processRegistry });
      sessionService.get.mockReturnValueOnce({
        id: "owned-session",
        sessionId: "owned-session",
        laneId: "lane-1",
        tracked: true,
        ownerPid: 12_345,
        lastOutputPreview: null,
      });
      service.dispose({ ptyId: "missing-pty", sessionId: "owned-session" });

      sessionService.get.mockReturnValueOnce({
        id: "dead-peer-session",
        sessionId: "dead-peer-session",
        laneId: "lane-1",
        tracked: true,
        ownerPid: 99_999,
        lastOutputPreview: null,
      });
      service.dispose({ ptyId: "missing-pty", sessionId: "dead-peer-session" });

      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "owned-session", status: "disposed" }),
      );
      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "dead-peer-session", status: "disposed" }),
      );
    });

    it("writes owner_pid when creating a tracked PTY session", async () => {
      const { service, sessionService } = createHarness({
        processRegistry: {
          pid: 12_345,
          startedAt: "2026-03-17T00:00:00.000Z",
          isPidLive: vi.fn(),
          isProcessIdentityLive: vi.fn(),
        },
      });

      await service.create({
        laneId: "lane-1",
        title: "Claude session",
        cols: 80,
        rows: 24,
        toolType: "claude",
        startupCommand: "claude",
      });

      expect(sessionService.create).toHaveBeenCalledWith(expect.objectContaining({
        ownerPid: 12_345,
        ownerProcessStartedAt: "2026-03-17T00:00:00.000Z",
      }));
    });

    it("repairs a live PTY session row that another runtime marked detached", async () => {
      const { service, mockPty, sessionService, logger } = createHarness({
        processRegistry: {
          pid: 12_345,
          startedAt: "2026-03-17T00:00:00.000Z",
          isPidLive: vi.fn(),
          isProcessIdentityLive: vi.fn(() => false),
        },
      });

      const { ptyId, sessionId } = await service.create({
        laneId: "lane-1",
        title: "Claude session",
        cols: 80,
        rows: 24,
        toolType: "claude",
        startupCommand: "claude",
      });
      const session = sessionService.get(sessionId);
      Object.assign(session, {
        status: "detached",
        ptyId: null,
        endedAt: "2026-03-17T00:01:00.000Z",
      });

      mockPty._emitter.emit("data", "still running\n");

      expect(sessionService.reattach).toHaveBeenCalledWith({
        sessionId,
        ptyId,
        startedAt: expect.any(String),
        ownerPid: 12_345,
        ownerProcessStartedAt: "2026-03-17T00:00:00.000Z",
      });
      expect(session).toEqual(expect.objectContaining({
        status: "running",
        ptyId,
        endedAt: null,
      }));
      expect(logger.warn).toHaveBeenCalledWith(
        "pty.live_session_row_resynced",
        expect.objectContaining({
          sessionId,
          ptyId,
          previousStatus: "detached",
          previousPtyId: null,
          toolType: "claude",
        }),
      );
    });

    it("uses the bound cwd for AI summaries after exit even if the lane mapping changes later", async () => {
      mocks.existsSyncResults.set("/tmp/test-worktree/subdir", true);
      const aiIntegrationService = {
        getMode: vi.fn(() => "subscription"),
        summarizeTerminal: vi.fn(async () => ({ text: "Bound summary" })),
      };
      const { service, mockPty, laneService } = createHarness({ aiIntegrationService });
      await service.create({
        laneId: "lane-1",
        cwd: "/tmp/test-worktree/subdir",
        title: "Summary session",
        cols: 80,
        rows: 24,
      });

      laneService.getLaneBaseAndBranch.mockReturnValue({
        worktreePath: "/tmp/other-worktree",
        baseRef: "origin/main",
        branchRef: "feature/moved",
      });

      mockPty._emitter.emit("exit", { exitCode: 0 });
      await vi.waitFor(() => {
        expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalled();
      });

      expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/tmp/test-worktree/subdir" }),
      );
    });

    it("silently ignores dispose for completely unknown pty/session", () => {
      const { service } = createHarness();
      expect(() => service.dispose({ ptyId: "non-existent" })).not.toThrow();
    });
  });

  describe("disposeAll", () => {
    it("disposes all active PTYs", async () => {
      const { service, broadcastExit } = createHarness();
      await service.create({ laneId: "lane-1", title: "a", cols: 80, rows: 24 });
      await service.create({ laneId: "lane-1", title: "b", cols: 80, rows: 24 });
      service.disposeAll();
      expect(broadcastExit).toHaveBeenCalledTimes(2);
    });
  });

  describe("PTY data handling", () => {
    it.each([
      "claude",
      "codex",
      "cursor-cli",
      "droid",
      "opencode",
      "claude-orchestrated",
      "codex-orchestrated",
      "opencode-orchestrated",
    ] as const)("preserves %s settlement through final PTY output until the next user input", async (toolType) => {
      const { service, mockPty, sessionService } = createHarness();
      const { ptyId, sessionId } = await service.create({
        laneId: "lane-1",
        title: `${toolType} CLI`,
        cols: 80,
        rows: 24,
        toolType,
      });
      sessionService.settleSession(sessionId, {
        settledAt: "2026-07-23T12:00:00.000Z",
      });

      mockPty._emitter.emit("data", "final answer\n");

      expect(sessionService.get(sessionId)?.settledAt).toBe("2026-07-23T12:00:00.000Z");
      expect(sessionService.touchSessionActivity).toHaveBeenLastCalledWith(
        sessionId,
        expect.any(String),
        { clearSettled: false },
      );
      expect(sessionService.setLastOutputPreview).toHaveBeenLastCalledWith(
        sessionId,
        "preview",
        { clearSettled: false },
      );

      service.write({ ptyId, data: "continue\r" });

      expect(sessionService.get(sessionId)?.settledAt).toBeNull();
      expect(sessionService.clearTurnStartMarkers).toHaveBeenCalledWith(sessionId);
    });

    it("keeps ordinary shell output as the signal that a settled session is active again", async () => {
      const { service, mockPty, sessionService } = createHarness();
      const { sessionId } = await service.create({
        laneId: "lane-1",
        title: "Shell",
        cols: 80,
        rows: 24,
        toolType: "shell",
      });
      sessionService.settleSession(sessionId, {
        settledAt: "2026-07-23T12:00:00.000Z",
      });

      mockPty._emitter.emit("data", "background job produced output\n");

      expect(sessionService.get(sessionId)?.settledAt).toBeNull();
      expect(sessionService.touchSessionActivity).toHaveBeenLastCalledWith(
        sessionId,
        expect.any(String),
        { clearSettled: true },
      );
      expect(sessionService.setLastOutputPreview).toHaveBeenLastCalledWith(
        sessionId,
        "preview",
        { clearSettled: true },
      );
      expect(sessionService.clearTurnStartMarkers).not.toHaveBeenCalled();
    });

    it("broadcasts data events when the PTY emits data", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, broadcastData } = createHarness();
        const { ptyId, sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });
        mockPty._emitter.emit("data", "hello world");
        expect(broadcastData).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(50);
        expect(broadcastData).toHaveBeenCalledWith({
          ptyId,
          sessionId,
          projectRoot: "/tmp/test-project",
          data: "hello world",
          offset: Buffer.byteLength("hello world", "utf8"),
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("coalesces rapid PTY data chunks and flushes before exit", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, broadcastData, broadcastExit } = createHarness();
        const { ptyId, sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });
        mockPty._emitter.emit("data", "hello ");
        mockPty._emitter.emit("data", "world");
        mockPty._emitter.emit("exit", { exitCode: 0 });

        expect(broadcastData).toHaveBeenCalledWith({
          ptyId,
          sessionId,
          projectRoot: "/tmp/test-project",
          data: "hello world",
          offset: Buffer.byteLength("hello world", "utf8"),
        });
        expect(broadcastExit).toHaveBeenCalledWith({
          ptyId,
          sessionId,
          projectRoot: "/tmp/test-project",
          exitCode: 0,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("closes entry and broadcasts exit when PTY exits", async () => {
      const { service, mockPty, broadcastExit, sessionService } = createHarness();
      const { ptyId, sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });
      mockPty._emitter.emit("exit", { exitCode: 0 });
      expect(broadcastExit).toHaveBeenCalledWith({
        ptyId,
        sessionId,
        projectRoot: "/tmp/test-project",
        exitCode: 0,
      });
      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId, exitCode: 0, status: "completed" }),
      );
    });

    it("ignores stale dispose after a PTY already exited", async () => {
      const { service, mockPty, broadcastExit, sessionService } = createHarness();
      const { ptyId, sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });
      mockPty._emitter.emit("exit", { exitCode: 0 });
      const endCalls = sessionService.end.mock.calls.length;
      const exitCalls = broadcastExit.mock.calls.length;

      service.dispose({ ptyId, sessionId });

      expect(sessionService.end).toHaveBeenCalledTimes(endCalls);
      expect(broadcastExit).toHaveBeenCalledTimes(exitCalls);
    });

    it("marks session as failed when exit code is non-zero", async () => {
      const { service, mockPty, sessionService } = createHarness();
      const { sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });
      mockPty._emitter.emit("exit", { exitCode: 1 });
      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId, exitCode: 1, status: "failed" }),
      );
    });

    it("marks signal-terminated sessions as disposed instead of failed", async () => {
      const { service, mockPty, sessionService } = createHarness();
      const { sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });
      mockPty._emitter.emit("exit", { exitCode: 143 });
      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId, exitCode: 143, status: "disposed" }),
      );
    });

    it("marks session as completed when exit code is null", async () => {
      const { service, mockPty, sessionService } = createHarness();
      const { sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });
      mockPty._emitter.emit("exit", { exitCode: undefined });
      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId, exitCode: null, status: "completed" }),
      );
    });

    it("does not auto-close user-launched Claude sessions when they become waiting-input", async () => {
      vi.useFakeTimers();
      try {
        mocks.runtimeStateFromOsc133Chunk.mockReturnValue("waiting-input");
        const { service, mockPty } = createHarness();
        await service.create({ laneId: "lane-1", title: "Claude", cols: 80, rows: 24, toolType: "claude" });

        await vi.advanceTimersByTimeAsync(PTY_AI_TITLE_DEBOUNCE_MS);
        mockPty._emitter.emit("data", "\u001b]133;A\u0007");
        await vi.advanceTimersByTimeAsync(2000);

        expect(mockPty.kill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not auto-close orchestrated worker sessions when they become waiting-input", async () => {
      vi.useFakeTimers();
      try {
        mocks.runtimeStateFromOsc133Chunk.mockReturnValue("waiting-input");
        const { service, mockPty, logger } = createHarness();
        await service.create({
          laneId: "lane-1",
          title: "Claude worker",
          cols: 80,
          rows: 24,
          toolType: "claude-orchestrated",
        });

        await vi.advanceTimersByTimeAsync(PTY_AI_TITLE_DEBOUNCE_MS);
        mockPty._emitter.emit("data", "\u001b]133;A\u0007");
        await vi.advanceTimersByTimeAsync(1499);
        expect(mockPty.kill).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(mockPty.kill).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalledWith(
          "pty.tool_exit_auto_close",
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops scanning output for a late-printed resume command after 60 seconds and ignores matches in stale buffers", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
        mocks.defaultResumeCommandForTool.mockReturnValue("claude --resume" as any);
        const { service, mockPty, sessionService } = createHarness();
        const { sessionId } = await service.create({
          laneId: "lane-1",
          title: "Claude CLI",
          cols: 80,
          rows: 24,
          toolType: "claude",
        });

        mockPty._emitter.emit("data", "boot output\n");
        expect(mocks.extractResumeCommandFromOutput).toHaveBeenCalled();
        mocks.extractResumeCommandFromOutput.mockClear();
        (sessionService.setResumeCommand as ReturnType<typeof vi.fn>).mockClear();

        vi.setSystemTime(new Date("2026-04-29T00:01:00.500Z"));
        mocks.extractResumeCommandFromOutput.mockReturnValue("claude --resume claude-late-session" as any);
        mockPty._emitter.emit("data", "claude --resume claude-late-session\n");

        expect(mocks.extractResumeCommandFromOutput).not.toHaveBeenCalled();
        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          sessionId,
          "claude --resume claude-late-session",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("PTY data offsets (mobile byte-offset streaming)", () => {
    const flushTranscriptWork = async () => {
      for (let index = 0; index < 200; index += 1) await Promise.resolve();
    };

    it("preserves a surrogate pair split across PTY callbacks", async () => {
      vi.useFakeTimers();
      try {
        const transcriptPath = "/tmp/transcripts/surrogate-split.log";
        const { service, mockPty, broadcastData } = createHarness();
        const { ptyId, sessionId } = await service.create({
          laneId: "lane-1",
          title: "t",
          cols: 80,
          rows: 24,
          sessionId: "surrogate-split",
        });

        mockPty._emitter.emit("data", "\uD83D");
        await vi.advanceTimersByTimeAsync(50);
        expect(broadcastData).not.toHaveBeenCalled();
        expect(mocks.fileContents.get(transcriptPath) ?? "").toBe("");

        mockPty._emitter.emit("data", "\uDE00!");
        await vi.advanceTimersByTimeAsync(50);
        expect(broadcastData).toHaveBeenLastCalledWith({
          ptyId,
          sessionId,
          projectRoot: "/tmp/test-project",
          data: "😀!",
          offset: 5,
        });
        expect(mocks.fileContents.get(transcriptPath)).toBe("😀!");
        expect(mocks.fileStats.get(transcriptPath)?.size).toBe(5);
        await expect(service.readTranscriptSnapshot({ sessionId, maxBytes: 64 })).resolves.toEqual({
          data: "😀!",
          startOffset: 0,
          endOffset: 5,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["exit", "dispose"] as const)(
      "flushes one replacement character before PTY %s",
      async (teardown) => {
        const transcriptPath = `/tmp/transcripts/surrogate-${teardown}.log`;
        const { service, mockPty, broadcastData, broadcastExit } = createHarness();
        const { ptyId, sessionId } = await service.create({
          laneId: "lane-1",
          title: "t",
          cols: 80,
          rows: 24,
          sessionId: `surrogate-${teardown}`,
        });

        mockPty._emitter.emit("data", "A\uD83D");
        if (teardown === "exit") {
          mockPty._emitter.emit("exit", { exitCode: 0 });
        } else {
          service.dispose({ ptyId, sessionId });
        }

        expect(broadcastData).toHaveBeenCalledTimes(1);
        expect(broadcastData).toHaveBeenCalledWith({
          ptyId,
          sessionId,
          projectRoot: "/tmp/test-project",
          data: "A�",
          offset: 4,
        });
        expect(broadcastData.mock.invocationCallOrder[0]).toBeLessThan(
          broadcastExit.mock.invocationCallOrder[0]!,
        );
        expect(mocks.fileContents.get(transcriptPath)).toBe("A�");
        expect(mocks.fileStats.get(transcriptPath)?.size).toBe(4);
      },
    );

    it("canonicalizes unpaired surrogates before persistence and broadcast", async () => {
      vi.useFakeTimers();
      try {
        const transcriptPath = "/tmp/transcripts/surrogate-invalid.log";
        const { service, mockPty, broadcastData } = createHarness();
        const { ptyId, sessionId } = await service.create({
          laneId: "lane-1",
          title: "t",
          cols: 80,
          rows: 24,
          sessionId: "surrogate-invalid",
        });

        mockPty._emitter.emit("data", "\uDE00\uD83Dx");
        await vi.advanceTimersByTimeAsync(50);

        expect(broadcastData).toHaveBeenCalledWith({
          ptyId,
          sessionId,
          projectRoot: "/tmp/test-project",
          data: "��x",
          offset: 7,
        });
        expect(mocks.fileContents.get(transcriptPath)).toBe("��x");
        expect(mocks.fileStats.get(transcriptPath)?.size).toBe(7);
      } finally {
        vi.useRealTimers();
      }
    });

    it("attaches the transcript end offset across batched flushes", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, broadcastData } = createHarness();
        const { ptyId, sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });
        mockPty._emitter.emit("data", "hello ");
        mockPty._emitter.emit("data", "wörld");
        await vi.advanceTimersByTimeAsync(50);
        expect(broadcastData).toHaveBeenLastCalledWith({
          ptyId,
          sessionId,
          projectRoot: "/tmp/test-project",
          data: "hello wörld",
          offset: Buffer.byteLength("hello wörld", "utf8"),
        });

        mockPty._emitter.emit("data", "again");
        await vi.advanceTimersByTimeAsync(50);
        expect(broadcastData).toHaveBeenLastCalledWith(expect.objectContaining({
          data: "again",
          offset: Buffer.byteLength("hello wörld", "utf8") + Buffer.byteLength("again", "utf8"),
        }));
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns an exact live snapshot through the logical end while disk is behind", async () => {
      const transcriptPath = "/tmp/transcripts/live-snapshot.log";
      mocks.fileContents.set(transcriptPath, "disk");
      mocks.fileStats.set(transcriptPath, { size: 4 });
      const { service, mockPty } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "t",
        cols: 80,
        rows: 24,
        sessionId: "live-snapshot",
      });
      mockPty._emitter.emit("data", "AéB");
      // Model a buffered WriteStream: the in-memory logical offset is current,
      // while stat/read still expose only the pre-output file.
      mocks.fileContents.set(transcriptPath, "disk");
      mocks.fileStats.set(transcriptPath, { size: 4 });

      await expect(service.readTranscriptSnapshot({
        sessionId: "live-snapshot",
        maxBytes: 3,
      })).resolves.toEqual({
        data: "éB",
        startOffset: 5,
        endOffset: 8,
      });
    });

    it("combines a retained transcript with new live output after recreating the PTY", async () => {
      const transcriptPath = "/tmp/transcripts/recreated-live-snapshot.log";
      mocks.fileContents.set(transcriptPath, "retained screen\n");
      mocks.fileStats.set(transcriptPath, { size: Buffer.byteLength("retained screen\n") });
      const { service, mockPty } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "t",
        cols: 80,
        rows: 24,
        sessionId: "recreated-live-snapshot",
      });
      mockPty._emitter.emit("data", "new prompt");
      // Keep the new output in the WriteStream buffer so the snapshot must
      // compose the old disk tail with the exact in-memory continuation.
      mocks.fileContents.set(transcriptPath, "retained screen\n");
      mocks.fileStats.set(transcriptPath, { size: Buffer.byteLength("retained screen\n") });

      await expect(service.readTranscriptSnapshot({
        sessionId: "recreated-live-snapshot",
        maxBytes: 64,
      })).resolves.toEqual({
        data: "retained screen\nnew prompt",
        startOffset: 0,
        endOffset: Buffer.byteLength("retained screen\nnew prompt"),
      });
    });

    it("returns only the contiguous live suffix when the disk gap predates the bounded tail", async () => {
      const transcriptPath = "/tmp/transcripts/live-snapshot-gap.log";
      mocks.fileContents.set(transcriptPath, "disk");
      mocks.fileStats.set(transcriptPath, { size: 4 });
      const { service, mockPty } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "t",
        cols: 80,
        rows: 24,
        sessionId: "live-snapshot-gap",
      });
      const output = "x".repeat(2_000_005);
      mockPty._emitter.emit("data", output);
      // The recent-output buffer keeps only 2,000,000 characters. Model disk
      // still ending before that retained suffix, leaving an unreadable gap.
      mocks.fileContents.set(transcriptPath, "disk");
      mocks.fileStats.set(transcriptPath, { size: 4 });

      const snapshot = await service.readTranscriptSnapshot({
        sessionId: "live-snapshot-gap",
        maxBytes: 2_000_010,
      });
      expect(snapshot).not.toBeNull();
      expect(snapshot!.data).toHaveLength(2_000_000);
      expect(snapshot!.data).toBe("x".repeat(2_000_000));
      expect(snapshot!.startOffset).toBe(9);
      expect(snapshot!.endOffset).toBe(2_000_009);
    });

    it("keeps logical offsets advancing while the retained transcript rolls over", async () => {
      vi.useFakeTimers();
      try {
        const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
        mocks.fileStats.set("/tmp/transcripts/cap-session.log", { size: MAX_TRANSCRIPT_BYTES - 5 });
        const { service, mockPty, broadcastData } = createHarness();
        await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24, sessionId: "cap-session" });
        mockPty._emitter.emit("data", "0123456789");
        await vi.advanceTimersByTimeAsync(50);
        expect(broadcastData).toHaveBeenLastCalledWith(expect.objectContaining({
          data: "0123456789",
          offset: MAX_TRANSCRIPT_BYTES + 5,
        }));

        await flushTranscriptWork();
        mockPty._emitter.emit("data", "later");
        await vi.advanceTimersByTimeAsync(50);
        expect(broadcastData).toHaveBeenLastCalledWith(expect.objectContaining({
          data: "later",
          offset: MAX_TRANSCRIPT_BYTES + 10,
        }));
        expect(mockPty.pause).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("persists queued rollover bytes when the PTY exits during compaction", async () => {
      const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
      const transcriptPath = "/tmp/transcripts/rollover-exit.log";
      mocks.fileStats.set(transcriptPath, { size: MAX_TRANSCRIPT_BYTES });
      const { service, mockPty } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "t",
        cols: 80,
        rows: 24,
        sessionId: "rollover-exit",
      });

      mockPty._emitter.emit("data", "final");
      mockPty._emitter.emit("exit", { exitCode: 0 });
      await flushTranscriptWork();

      const window = service.getTranscriptWindow("rollover-exit")!;
      expect(window.endOffset).toBe(MAX_TRANSCRIPT_BYTES + 5);
      await expect(service.readTranscriptRange({
        sessionId: "rollover-exit",
        startOffset: MAX_TRANSCRIPT_BYTES,
        endOffset: MAX_TRANSCRIPT_BYTES + 5,
      })).resolves.toEqual({
        data: "final",
        startOffset: MAX_TRANSCRIPT_BYTES,
        endOffset: MAX_TRANSCRIPT_BYTES + 5,
      });
    });

    it("persists queued rollover bytes when the session is disposed during compaction", async () => {
      const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
      const transcriptPath = "/tmp/transcripts/rollover-dispose.log";
      mocks.fileStats.set(transcriptPath, { size: MAX_TRANSCRIPT_BYTES });
      const { service, mockPty } = createHarness();
      const created = await service.create({
        laneId: "lane-1",
        title: "t",
        cols: 80,
        rows: 24,
        sessionId: "rollover-dispose",
      });

      mockPty._emitter.emit("data", "saved");
      service.dispose({ ptyId: created.ptyId, sessionId: created.sessionId });
      await flushTranscriptWork();

      const window = service.getTranscriptWindow("rollover-dispose")!;
      expect(window.endOffset).toBe(MAX_TRANSCRIPT_BYTES + 5);
      await expect(service.readTranscriptRange({
        sessionId: "rollover-dispose",
        startOffset: MAX_TRANSCRIPT_BYTES,
        endOffset: MAX_TRANSCRIPT_BYTES + 5,
      })).resolves.toEqual({
        data: "saved",
        startOffset: MAX_TRANSCRIPT_BYTES,
        endOffset: MAX_TRANSCRIPT_BYTES + 5,
      });
    });

    it("retains a bounded tail and maps it to logical snapshot offsets", async () => {
      vi.useFakeTimers();
      try {
        const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
        const transcriptPath = "/tmp/transcripts/rollover-tail.log";
        const initial = "a".repeat(MAX_TRANSCRIPT_BYTES - 4);
        mocks.fileContents.set(transcriptPath, initial);
        mocks.fileStats.set(transcriptPath, { size: Buffer.byteLength(initial) });
        const { service, mockPty } = createHarness();
        await service.create({
          laneId: "lane-1",
          title: "t",
          cols: 80,
          rows: 24,
          sessionId: "rollover-tail",
        });

        mockPty._emitter.emit("data", "éTAIL");
        await flushTranscriptWork();

        const window = service.getTranscriptWindow("rollover-tail");
        expect(window).not.toBeNull();
        expect(window!.startOffset).toBeGreaterThan(0);
        expect(window!.retainedBytes).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
        expect(window!.endOffset).toBe(
          Buffer.byteLength(initial, "utf8") + Buffer.byteLength("éTAIL", "utf8"),
        );
        const retained = await service.readTranscriptRange({
          sessionId: "rollover-tail",
          startOffset: 0,
          endOffset: window!.endOffset,
        });
        expect(retained?.startOffset).toBe(window!.startOffset);
        expect(retained?.endOffset).toBe(window!.endOffset);
        expect(retained?.data.endsWith("éTAIL")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rolls the retained tail forward past a split UTF-8 code point", async () => {
      const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
      const ROLLOVER_TARGET_BYTES = MAX_TRANSCRIPT_BYTES / 2;
      const transcriptPath = "/tmp/transcripts/rollover-utf8.log";
      // Put the second byte of é exactly where the 8 MiB tail read begins.
      const initialBuffer = Buffer.concat([
        Buffer.alloc(ROLLOVER_TARGET_BYTES - 1, 0x61),
        Buffer.from("é", "utf8"),
        Buffer.alloc(MAX_TRANSCRIPT_BYTES - ROLLOVER_TARGET_BYTES - 1, 0x62),
      ]);
      mocks.fileContents.set(transcriptPath, initialBuffer.toString("utf8"));
      mocks.fileStats.set(transcriptPath, { size: initialBuffer.length });
      const { service, mockPty } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "t",
        cols: 80,
        rows: 24,
        sessionId: "rollover-utf8",
      });

      mockPty._emitter.emit("data", "!");
      await flushTranscriptWork();

      const window = service.getTranscriptWindow("rollover-utf8")!;
      const retained = await service.readTranscriptRange({
        sessionId: "rollover-utf8",
        startOffset: window.startOffset,
        endOffset: window.endOffset,
      });
      expect(retained?.data.startsWith("b")).toBe(true);
      expect(retained?.data.endsWith("!")).toBe(true);
      expect(retained?.data).not.toContain("�");
      expect(Buffer.byteLength(retained?.data ?? "", "utf8")).toBe(window.retainedBytes);
    });

    it("recovers the logical offset from rollover metadata when a session restarts", async () => {
      vi.useFakeTimers();
      try {
        const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
        const transcriptPath = "/tmp/transcripts/restart-rollover.log";
        const initial = "x".repeat(MAX_TRANSCRIPT_BYTES);
        mocks.fileContents.set(transcriptPath, initial);
        mocks.fileStats.set(transcriptPath, { size: Buffer.byteLength(initial) });
        const { service, mockPty, broadcastData } = createHarness();
        const first = await service.create({
          laneId: "lane-1",
          title: "t",
          cols: 80,
          rows: 24,
          sessionId: "restart-rollover",
        });
        mockPty._emitter.emit("data", "first");
        await flushTranscriptWork();
        const beforeRestart = service.getTranscriptWindow(first.sessionId);
        expect(beforeRestart?.endOffset).toBe(MAX_TRANSCRIPT_BYTES + 5);

        mockPty._emitter.emit("exit", { exitCode: 0 });
        await flushTranscriptWork();
        await service.create({
          laneId: "lane-1",
          title: "t",
          cols: 80,
          rows: 24,
          sessionId: "restart-rollover",
        });
        mockPty._emitter.emit("data", "next");
        await vi.advanceTimersByTimeAsync(50);

        expect(broadcastData).toHaveBeenLastCalledWith(expect.objectContaining({
          data: "next",
          offset: MAX_TRANSCRIPT_BYTES + 9,
        }));
      } finally {
        vi.useRealTimers();
      }
    });

    it("repairs and clears an interrupted rollover journal before accepting new output", async () => {
      const transcriptPath = "/tmp/transcripts/journal-recovery.log";
      const statePath = `${transcriptPath}.rollover.json`;
      const journalPath = `${transcriptPath}.rollover.pending.json`;
      const backupPath = `${transcriptPath}.rollover.previous`;
      mocks.fileContents.set(transcriptPath, "TAIL");
      mocks.fileStats.set(transcriptPath, { size: 4 });
      mocks.fileContents.set(backupPath, "0123456789");
      mocks.fileStats.set(backupPath, { size: 10 });
      mocks.fileContents.set(statePath, JSON.stringify({
        version: 1,
        baseOffset: 0,
        retainedBytes: 10,
      }));
      mocks.fileContents.set(journalPath, JSON.stringify({
        version: 1,
        previousBaseOffset: 0,
        previousRetainedBytes: 10,
        nextBaseOffset: 6,
        nextRetainedBytes: 4,
      }));
      const { service } = createHarness();

      await service.create({
        laneId: "lane-1",
        title: "t",
        cols: 80,
        rows: 24,
        sessionId: "journal-recovery",
      });

      expect(service.getTranscriptWindow("journal-recovery")).toEqual({
        startOffset: 6,
        endOffset: 10,
        retainedBytes: 4,
      });
      expect(mocks.fileContents.has(journalPath)).toBe(false);
      expect(mocks.fileContents.has(backupPath)).toBe(false);
      expect(JSON.parse(mocks.fileContents.get(statePath) ?? "{}")).toMatchObject({
        version: 1,
        baseOffset: 6,
        retainedBytes: 4,
      });
    });

    it("restores the previous transcript when restart lands between the two file renames", async () => {
      const transcriptPath = "/tmp/transcripts/journal-mid-rename.log";
      const statePath = `${transcriptPath}.rollover.json`;
      const journalPath = `${transcriptPath}.rollover.pending.json`;
      const backupPath = `${transcriptPath}.rollover.previous`;
      mocks.existsSyncResults.set(transcriptPath, false);
      mocks.existsSyncResults.set(backupPath, true);
      mocks.fileContents.set(backupPath, "0123456789");
      mocks.fileStats.set(backupPath, { size: 10 });
      mocks.fileContents.set(statePath, JSON.stringify({ version: 1, baseOffset: 0, retainedBytes: 10 }));
      mocks.fileContents.set(journalPath, JSON.stringify({
        version: 1,
        previousBaseOffset: 0,
        previousRetainedBytes: 10,
        nextBaseOffset: 6,
        nextRetainedBytes: 4,
      }));
      const { service } = createHarness();

      await service.create({
        laneId: "lane-1",
        title: "t",
        cols: 80,
        rows: 24,
        sessionId: "journal-mid-rename",
      });

      expect(service.getTranscriptWindow("journal-mid-rename")).toEqual({
        startOffset: 0,
        endOffset: 10,
        retainedBytes: 10,
      });
      expect(mocks.fileContents.get(transcriptPath)).toBe("0123456789");
      expect(mocks.fileContents.has(backupPath)).toBe(false);
      expect(mocks.fileContents.has(journalPath)).toBe(false);
    });

    it("removes rollover sidecars and interrupted atomic-write temps on transcript deletion", () => {
      const transcriptPath = "/tmp/transcripts/delete-me.log";
      mocks.dirEntries.set("/tmp/transcripts", [
        "delete-me.log.123.uuid.tmp",
        "delete-me.log.rollover.json.123.uuid.tmp",
        "delete-me.log.rollover.pending.json.123.uuid.tmp",
        "another-session.log.123.uuid.tmp",
      ]);
      const { service } = createHarness();

      service.removeTranscriptRolloverArtifacts(transcriptPath);

      expect(mocks.unlinkSync).toHaveBeenCalledWith(`${transcriptPath}.rollover.json`);
      expect(mocks.unlinkSync).toHaveBeenCalledWith(`${transcriptPath}.rollover.pending.json`);
      expect(mocks.unlinkSync).toHaveBeenCalledWith(`${transcriptPath}.rollover.previous`);
      expect(mocks.unlinkSync).toHaveBeenCalledWith("/tmp/transcripts/delete-me.log.123.uuid.tmp");
      expect(mocks.unlinkSync).toHaveBeenCalledWith("/tmp/transcripts/delete-me.log.rollover.json.123.uuid.tmp");
      expect(mocks.unlinkSync).toHaveBeenCalledWith("/tmp/transcripts/delete-me.log.rollover.pending.json.123.uuid.tmp");
      expect(mocks.unlinkSync).not.toHaveBeenCalledWith("/tmp/transcripts/another-session.log.123.uuid.tmp");
    });

    it("emits null offsets for untracked sessions", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, broadcastData } = createHarness();
        await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24, tracked: false });
        mockPty._emitter.emit("data", "untracked output");
        await vi.advanceTimersByTimeAsync(50);
        expect(broadcastData).toHaveBeenLastCalledWith(expect.objectContaining({
          data: "untracked output",
          offset: null,
        }));
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("readTranscriptRange", () => {
    async function createSessionWithTranscript(content: string, sessionId = "range-session") {
      const harness = createHarness();
      await harness.service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24, sessionId });
      const transcriptPath = `/tmp/transcripts/${sessionId}.log`;
      mocks.fileContents.set(transcriptPath, content);
      mocks.fileStats.set(transcriptPath, { size: Buffer.byteLength(content, "utf8") });
      return harness;
    }

    it("reads an exact byte range from the start of the transcript", async () => {
      const content = "line1\nline2\nline3\n";
      const { service } = await createSessionWithTranscript(content);
      const range = await service.readTranscriptRange({
        sessionId: "range-session",
        startOffset: 0,
        endOffset: Buffer.byteLength(content, "utf8"),
      });
      expect(range).toEqual({ data: content, startOffset: 0, endOffset: 18 });
    });

    it("scans a non-zero page start forward past the next newline", async () => {
      const { service } = await createSessionWithTranscript("abcdef\nghijkl\n");
      const range = await service.readTranscriptRange({
        sessionId: "range-session",
        startOffset: 2,
        endOffset: 14,
        alignStartToSafeBoundary: true,
      });
      expect(range).toEqual({ data: "ghijkl\n", startOffset: 7, endOffset: 14 });
    });

    it("treats an ESC byte as a safe page start", async () => {
      const { service } = await createSessionWithTranscript("abc\u001b[31mred");
      const range = await service.readTranscriptRange({
        sessionId: "range-session",
        startOffset: 1,
        endOffset: 11,
        alignStartToSafeBoundary: true,
      });
      expect(range).toEqual({ data: "\u001b[31mred", startOffset: 3, endOffset: 11 });
    });

    it("never starts a page on a UTF-8 continuation byte, even without boundary alignment", async () => {
      // "héllo" = 68 C3 A9 6C 6C 6F; offset 2 lands on the é continuation byte.
      const { service } = await createSessionWithTranscript("héllo");
      const range = await service.readTranscriptRange({
        sessionId: "range-session",
        startOffset: 2,
        endOffset: 6,
      });
      expect(range).toEqual({ data: "llo", startOffset: 3, endOffset: 6 });
    });

    it("never ends a page in the middle of a UTF-8 code point", async () => {
      // "AéB" = 41 C3 A9 42; offset 2 stops after the first byte of é.
      const { service } = await createSessionWithTranscript("AéB");
      const range = await service.readTranscriptRange({
        sessionId: "range-session",
        startOffset: 0,
        endOffset: 2,
      });
      expect(range).toEqual({ data: "A", startOffset: 0, endOffset: 1 });
    });

    it("clamps the requested range to the flushed file size", async () => {
      const { service } = await createSessionWithTranscript("line1\nline2\nline3\n");
      const range = await service.readTranscriptRange({
        sessionId: "range-session",
        startOffset: 12,
        endOffset: 999_999,
      });
      expect(range).toEqual({ data: "line3\n", startOffset: 12, endOffset: 18 });

      const pastEof = await service.readTranscriptRange({
        sessionId: "range-session",
        startOffset: 50,
        endOffset: 999_999,
      });
      expect(pastEof).toEqual({ data: "", startOffset: 18, endOffset: 18 });
    });

    it("returns an empty result for a zero-length range and null for unknown sessions", async () => {
      const { service } = await createSessionWithTranscript("line1\n");
      expect(await service.readTranscriptRange({
        sessionId: "range-session",
        startOffset: 5,
        endOffset: 5,
      })).toEqual({ data: "", startOffset: 5, endOffset: 5 });
      expect(await service.readTranscriptRange({
        sessionId: "missing-session",
        startOffset: 0,
        endOffset: 10,
      })).toBeNull();
    });
  });

  describe("mobile resize ownership", () => {
    it("restores the desktop renderer size after a mobile resize", async () => {
      const { service, mockPty } = createHarness();
      const { ptyId, sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });

      service.resize({ ptyId, cols: 100, rows: 40 });
      expect(service.resizeBySessionId(sessionId, 60, 20, { source: "mobile" })).toBe(true);
      expect(mockPty.resize).toHaveBeenLastCalledWith(60, 20);

      expect(service.restoreDesktopSizeBySessionId(sessionId)).toBe(true);
      expect(mockPty.resize).toHaveBeenLastCalledWith(100, 40);
      // Already back at the desktop size: nothing to restore.
      expect(service.restoreDesktopSizeBySessionId(sessionId)).toBe(false);
    });

    it("records sizes from resizeBySessionId unless the source is mobile", async () => {
      const { service, mockPty } = createHarness();
      const { sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });

      expect(service.resizeBySessionId(sessionId, 90, 30)).toBe(true);
      expect(service.resizeBySessionId(sessionId, 61, 21, { source: "mobile" })).toBe(true);
      expect(service.restoreDesktopSizeBySessionId(sessionId)).toBe(true);
      expect(mockPty.resize).toHaveBeenLastCalledWith(90, 30);
    });

    it("restores to the create-time size when mobile resizes before desktop", async () => {
      const { service, mockPty } = createHarness();
      const { sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });

      expect(service.resizeBySessionId(sessionId, 61, 21, { source: "mobile" })).toBe(true);
      expect(mockPty.resize).toHaveBeenLastCalledWith(61, 21);

      expect(service.restoreDesktopSizeBySessionId(sessionId)).toBe(true);
      expect(mockPty.resize).toHaveBeenLastCalledWith(80, 24);
    });
  });

  describe("ensureResumeTargets", () => {
    it("resolves the backfill cwd from the lane worktree, not the transcript path", async () => {
      // Transcripts live under the project root even for lane sessions, so a
      // transcript-derived cwd searched the wrong directory and never matched
      // the rollout Codex wrote in the lane worktree.
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);
        const startedAt = "2026-04-15T21:30:00.000Z";
        seedCodexRollout({
          id: "thread-lane",
          cwd: "/tmp/test-worktree",
          startedAt,
          mtime: fakeNow.getTime() - 30_000,
        });

        const { service, sessionService, laneService } = createHarness();
        sessionService.readTranscriptTail.mockResolvedValueOnce("OpenAI Codex\nmodel: gpt-5\n› ");
        sessionService.create({
          sessionId: "session-lane-cwd",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt,
          // Project-root transcript, deliberately NOT under the lane worktree.
          transcriptPath: "/tmp/test-project/.ade/transcripts/session-lane-cwd.log",
          toolType: "codex",
        });

        await service.ensureResumeTargets(["session-lane-cwd"]);
        await vi.advanceTimersByTimeAsync(0);

        expect(laneService.getLaneBaseAndBranch).toHaveBeenCalledWith("lane-1");
        expect(sessionService.setResumeCommand).toHaveBeenCalledWith("session-lane-cwd", "codex resume thread-lane");
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to the transcript-derived cwd when the lane lookup fails", async () => {
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);
        const startedAt = "2026-04-15T21:30:00.000Z";
        seedCodexRollout({
          id: "thread-fallback",
          cwd: "/tmp/deleted-lane",
          startedAt,
          mtime: fakeNow.getTime() - 30_000,
        });

        const { service, sessionService, laneService } = createHarness();
        laneService.getLaneBaseAndBranch.mockImplementation(() => {
          throw new Error("lane 'lane-1' no longer exists");
        });
        sessionService.readTranscriptTail.mockResolvedValueOnce("OpenAI Codex\nmodel: gpt-5\n› ");
        sessionService.create({
          sessionId: "session-fallback-cwd",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt,
          transcriptPath: "/tmp/deleted-lane/.ade/transcripts/session-fallback-cwd.log",
          toolType: "codex",
        });

        await service.ensureResumeTargets(["session-fallback-cwd"]);
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(
          "session-fallback-cwd",
          "codex resume thread-fallback",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("backfills Codex storage resume targets during session-list hydration", async () => {
      // The session-list path is how older sessions (whose transcripts no
      // longer contain an explicit resume command) get their resume target
      // backfilled. The same storage fallback also runs from continuation
      // launch so Codex does not fall through to the picker.
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);
        const startedAt = "2026-04-15T21:30:00.000Z";
        seedCodexRollout({
          id: "thread-abc",
          cwd: "/tmp/test-worktree",
          startedAt,
          mtime: fakeNow.getTime() - 30_000,
        });

        const { service, sessionService } = createHarness();
        sessionService.readTranscriptTail.mockResolvedValueOnce("OpenAI Codex\nmodel: gpt-5\n› ");
        sessionService.create({
          sessionId: "session-1",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt,
          transcriptPath: "/tmp/test-worktree/.ade/transcripts/session-1.log",
          toolType: "codex",
        });

        await service.ensureResumeTargets(["session-1"]);
        // allow any microtasks to settle
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith("session-1", "codex resume thread-abc");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not backfill a Codex resume target from storage for update-only transcripts", async () => {
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);
        const startedAt = "2026-04-15T21:30:00.000Z";
        seedCodexRollout({
          id: "thread-live",
          cwd: "/tmp/test-worktree",
          startedAt,
          mtime: fakeNow.getTime() - 30_000,
        });

        const { service, sessionService, logger } = createHarness();
        sessionService.readTranscriptTail.mockResolvedValueOnce([
          "Update available! 0.130.0 -> 0.134.0\n",
          "Updating Codex via npm install -g @openai/codex...\n",
          "Update ran successfully! Please restart Codex.\n",
        ].join(""));
        sessionService.create({
          sessionId: "session-update-only",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt,
          transcriptPath: "/tmp/test-worktree/.ade/transcripts/session-update-only.log",
          toolType: "codex",
        });

        await service.ensureResumeTargets(["session-update-only"]);
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          "session-update-only",
          expect.stringContaining("thread-live"),
        );
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.resume_target_backfill_skipped_codex_update",
          expect.objectContaining({
            sessionId: "session-update-only",
            toolType: "codex",
            reason: "session-list",
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the Codex update transcript guard scoped to Codex backfills", async () => {
      (mocks.extractResumeCommandFromOutput as any).mockReturnValueOnce("claude --resume 11111111-1111-1111-1111-111111111111");

      const { service, sessionService, logger } = createHarness();
      sessionService.readTranscriptTail.mockResolvedValueOnce([
        "Update available! 0.130.0 -> 0.134.0\n",
        "Updating Codex via npm install -g @openai/codex...\n",
        "Update ran successfully! Please restart Codex.\n",
      ].join(""));
      sessionService.create({
        sessionId: "session-claude-with-codex-words",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Claude CLI",
        startedAt: "2026-04-15T21:30:00.000Z",
        transcriptPath: "/tmp/test-worktree/.ade/transcripts/session-claude-with-codex-words.log",
        toolType: "claude",
      });

      await service.ensureResumeTargets(["session-claude-with-codex-words"]);

      expect(mocks.extractResumeCommandFromOutput).toHaveBeenCalledWith(
        expect.stringContaining("Update available"),
        "claude",
      );
      expect(sessionService.setResumeCommand).toHaveBeenCalledWith(
        "session-claude-with-codex-words",
        "claude --resume 11111111-1111-1111-1111-111111111111",
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        "pty.resume_target_backfill_skipped_codex_update",
        expect.anything(),
      );
    });

    it("scores Claude storage backfills by ADE session start time instead of newest same-cwd file", async () => {
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);

        const matchedId = "11111111-1111-1111-1111-111111111111";
        const newerDifferentId = "22222222-2222-2222-2222-222222222222";
        const claudeProjectDir = path.join(os.homedir(), ".claude", "projects", "-tmp-test-worktree");
        const matchedPath = path.join(claudeProjectDir, `${matchedId}.jsonl`);
        const newerDifferentPath = path.join(claudeProjectDir, `${newerDifferentId}.jsonl`);
        const matchedFirstLine = JSON.stringify({
          timestamp: "2026-04-15T21:30:00.000Z",
          type: "user",
          sessionId: matchedId,
          cwd: "/tmp/test-worktree",
        });
        const newerDifferentFirstLine = JSON.stringify({
          timestamp: "2026-04-15T22:00:00.000Z",
          type: "user",
          sessionId: newerDifferentId,
          cwd: "/tmp/test-worktree",
        });

        mocks.existsSyncResults.set(claudeProjectDir, true);
        mocks.dirEntries.set(claudeProjectDir, [
          path.basename(matchedPath),
          path.basename(newerDifferentPath),
        ]);
        mocks.fileContents.set(matchedPath, `${matchedFirstLine}\n`);
        mocks.fileContents.set(newerDifferentPath, `${newerDifferentFirstLine}\n`);
        mocks.fileStats.set(matchedPath, { size: matchedFirstLine.length, mtimeMs: fakeNow.getTime() - 4 * 60_000, isDirectory: false });
        mocks.fileStats.set(newerDifferentPath, { size: newerDifferentFirstLine.length, mtimeMs: fakeNow.getTime() - 30_000, isDirectory: false });

        const { service, sessionService } = createHarness();
        sessionService.readTranscriptTail.mockResolvedValueOnce("Claude Code\n❯ ");
        sessionService.create({
          sessionId: "session-claude-storage",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Claude CLI",
          startedAt: "2026-04-15T21:30:00.000Z",
          transcriptPath: "/tmp/test-worktree/.ade/transcripts/session-claude-storage.log",
          toolType: "claude",
        });

        await service.ensureResumeTargets(["session-claude-storage"]);
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(
          "session-claude-storage",
          `claude --resume ${matchedId}`,
        );
        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          "session-claude-storage",
          `claude --resume ${newerDifferentId}`,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not backfill Claude storage sessions outside the ADE PTY lifetime", async () => {
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);

        const otherId = "33333333-3333-3333-3333-333333333333";
        const claudeProjectDir = path.join(os.homedir(), ".claude", "projects", "-tmp-test-worktree");
        const otherPath = path.join(claudeProjectDir, `${otherId}.jsonl`);
        const otherFirstLine = JSON.stringify({
          timestamp: "2026-04-15T21:31:00.000Z",
          type: "user",
          sessionId: otherId,
          cwd: "/tmp/test-worktree",
        });

        mocks.existsSyncResults.set(claudeProjectDir, true);
        mocks.dirEntries.set(claudeProjectDir, [path.basename(otherPath)]);
        mocks.fileContents.set(otherPath, `${otherFirstLine}\n`);
        mocks.fileStats.set(otherPath, { size: otherFirstLine.length, mtimeMs: fakeNow.getTime() - 30_000, isDirectory: false });

        const { service, sessionService } = createHarness();
        sessionService.readTranscriptTail.mockResolvedValueOnce("Claude Code\n❯ ");
        sessionService.create({
          sessionId: "session-claude-targetless",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Claude CLI",
          startedAt: "2026-04-15T21:30:00.000Z",
          transcriptPath: "/tmp/test-worktree/.ade/transcripts/session-claude-targetless.log",
          toolType: "claude",
        });
        sessionService.end({
          sessionId: "session-claude-targetless",
          endedAt: "2026-04-15T21:30:02.000Z",
          exitCode: 1,
          status: "failed",
        });

        await service.ensureResumeTargets(["session-claude-targetless"]);
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          "session-claude-targetless",
          `claude --resume ${otherId}`,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not guess between ambiguous Claude storage sessions in the same launch window", async () => {
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);

        const firstId = "44444444-4444-4444-4444-444444444444";
        const secondId = "55555555-5555-5555-5555-555555555555";
        const claudeProjectDir = path.join(os.homedir(), ".claude", "projects", "-tmp-test-worktree");
        const firstPath = path.join(claudeProjectDir, `${firstId}.jsonl`);
        const secondPath = path.join(claudeProjectDir, `${secondId}.jsonl`);
        const firstLine = JSON.stringify({
          timestamp: "2026-04-15T21:30:00.500Z",
          type: "user",
          sessionId: firstId,
          cwd: "/tmp/test-worktree",
        });
        const secondLine = JSON.stringify({
          timestamp: "2026-04-15T21:30:01.000Z",
          type: "user",
          sessionId: secondId,
          cwd: "/tmp/test-worktree",
        });

        mocks.existsSyncResults.set(claudeProjectDir, true);
        mocks.dirEntries.set(claudeProjectDir, [path.basename(firstPath), path.basename(secondPath)]);
        mocks.fileContents.set(firstPath, `${firstLine}\n`);
        mocks.fileContents.set(secondPath, `${secondLine}\n`);
        mocks.fileStats.set(firstPath, { size: firstLine.length, mtimeMs: fakeNow.getTime() - 60_000, isDirectory: false });
        mocks.fileStats.set(secondPath, { size: secondLine.length, mtimeMs: fakeNow.getTime() - 30_000, isDirectory: false });

        const { service, sessionService } = createHarness();
        sessionService.readTranscriptTail.mockResolvedValueOnce("Claude Code\n❯ ");
        sessionService.create({
          sessionId: "session-claude-ambiguous",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Claude CLI",
          startedAt: "2026-04-15T21:30:00.000Z",
          transcriptPath: "/tmp/test-worktree/.ade/transcripts/session-claude-ambiguous.log",
          toolType: "claude",
        });
        sessionService.end({
          sessionId: "session-claude-ambiguous",
          endedAt: "2026-04-15T21:30:02.000Z",
          exitCode: 1,
          status: "failed",
        });

        await service.ensureResumeTargets(["session-claude-ambiguous"]);
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          "session-claude-ambiguous",
          expect.stringMatching(/^claude --resume /),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("cools down repeated missing resume target backfills during session-list hydration", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-04-15T22:00:00.000Z"));

        const { service, sessionService, logger } = createHarness();
        sessionService.create({
          sessionId: "session-missing",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt: "2026-04-15T21:30:00.000Z",
          transcriptPath: "/tmp/test-worktree/.ade/transcripts/session-missing.log",
          toolType: "codex",
        });

        await service.ensureResumeTargets(["session-missing"]);
        await service.ensureResumeTargets(["session-missing"]);

        expect(sessionService.readTranscriptTail).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.resume_target_missing",
          expect.objectContaining({ sessionId: "session-missing", reason: "session-list" }),
        );

        await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
        await service.ensureResumeTargets(["session-missing"]);
        expect(sessionService.readTranscriptTail).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await service.ensureResumeTargets(["session-missing"]);
        expect(sessionService.readTranscriptTail).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses ADE's bundled OpenCode runtime when backfilling OpenCode resume targets", async () => {
      const startedAt = "2026-04-15T21:30:00.000Z";
      const bundledOpenCode = "/Applications/ADE.app/Contents/Resources/app.asar.unpacked/node_modules/opencode-darwin-arm64/bin/opencode";
      mocks.resolveOpenCodeBinaryPath.mockReturnValue(bundledOpenCode);
      mocks.spawnSync.mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify([
          {
            id: "ses_abc",
            directory: "/tmp/test-worktree",
            created: Date.parse(startedAt),
            updated: Date.parse(startedAt) + 1000,
          },
        ]),
        stderr: "",
      });

      const { service, sessionService } = createHarness();
      sessionService.readTranscriptTail.mockResolvedValueOnce("opencode\n");
      sessionService.create({
        sessionId: "session-opencode",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "OpenCode CLI",
        startedAt,
        transcriptPath: "/tmp/test-worktree/.ade/transcripts/session-opencode.log",
        toolType: "opencode",
      });

      await service.ensureResumeTargets(["session-opencode"]);

      expect(mocks.spawnSync).toHaveBeenCalledWith(
        bundledOpenCode,
        ["session", "list", "--format", "json", "--max-count", "80"],
        expect.objectContaining({
          cwd: "/tmp/test-worktree",
          encoding: "utf8",
        }),
      );
      expect(sessionService.setResumeCommand).toHaveBeenCalledWith("session-opencode", "opencode --session ses_abc");
    });

    it("does not backfill OpenCode from session list without OpenCode transcript evidence", async () => {
      const startedAt = "2026-04-15T21:30:00.000Z";
      mocks.spawnSync.mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify([
          {
            id: "ses_false_match",
            directory: "/tmp/test-worktree",
            created: Date.parse(startedAt),
            updated: Date.parse(startedAt) + 1000,
          },
        ]),
        stderr: "",
      });

      const { service, sessionService } = createHarness();
      sessionService.readTranscriptTail.mockResolvedValueOnce("simulated early exit for opencode\n");
      sessionService.create({
        sessionId: "session-opencode-false-match",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "OpenCode CLI",
        startedAt,
        transcriptPath: "/tmp/test-worktree/.ade/transcripts/session-opencode-false-match.log",
        toolType: "opencode",
      });

      await service.ensureResumeTargets(["session-opencode-false-match"]);

      expect(mocks.spawnSync).not.toHaveBeenCalled();
      expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
        "session-opencode-false-match",
        "opencode --session ses_false_match",
      );
    });

    it("does not backfill Droid storage without Droid transcript evidence", async () => {
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);
        const startedAt = "2026-04-15T21:30:00.000Z";
        const droidSessionsDir = path.join(os.homedir(), ".factory", "sessions");
        const projectDir = path.join(droidSessionsDir, "-tmp-test-worktree");
        const filePath = path.join(projectDir, "droid-session.jsonl");
        const firstLine = JSON.stringify({
          type: "session_start",
          id: "droid_false_match",
          cwd: "/tmp/test-worktree",
        });
        mocks.dirEntries.set(projectDir, [path.basename(filePath)]);
        mocks.fileContents.set(filePath, `${firstLine}\n`);
        mocks.fileStats.set(filePath, { size: firstLine.length, mtimeMs: Date.parse(startedAt), isDirectory: false });

        const { service, sessionService } = createHarness();
        sessionService.readTranscriptTail.mockResolvedValueOnce("simulated early exit for droid\n");
        sessionService.create({
          sessionId: "session-droid-false-match",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Droid CLI",
          startedAt,
          transcriptPath: "/tmp/test-worktree/.ade/transcripts/session-droid-false-match.log",
          toolType: "droid",
        });

        await service.ensureResumeTargets(["session-droid-false-match"]);
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(
          "session-droid-false-match",
          "droid --resume droid_false_match",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("captures Claude runtime titles for sessions that already have a resume target", async () => {
      vi.useFakeTimers();
      try {
        const claudeSessionId = "5647da1e-10de-4089-bce2-00b9c2552bfc";
        const filePath = path.join(
          os.homedir(),
          ".claude",
          "projects",
          "-tmp-test-worktree",
          `${claudeSessionId}.jsonl`,
        );
        mocks.fileContents.set(filePath, `${JSON.stringify({
          type: "ai-title",
          sessionId: claudeSessionId,
          aiTitle: "Patched exit works",
        })}\n`);

        const { service, sessionService } = createHarness();
        sessionService.create({
          sessionId: "session-claude-existing",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Say exactly: patched exit works",
          startedAt: "2026-04-15T21:30:00.000Z",
          transcriptPath: "/tmp/test-worktree/.ade/transcripts/session-claude-existing.log",
          toolType: "claude",
          resumeMetadata: {
            provider: "claude",
            targetKind: "session",
            targetId: claudeSessionId,
            launch: { permissionMode: "default" },
          },
        });

        await service.ensureResumeTargets(["session-claude-existing"]);
        await vi.advanceTimersByTimeAsync(0);

        expect(sessionService.updateMeta).toHaveBeenCalledWith(expect.objectContaining({
          sessionId: "session-claude-existing",
          title: "Patched exit works",
          manuallyNamed: false,
        }));
      } finally {
        vi.useRealTimers();
      }
    });

    it("captures a fresh Codex storage target for a new launch without choosing older same-cwd sessions", async () => {
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);

        const homedir = os.homedir();
        const sessionsBase = path.join(homedir, ".codex", "sessions");
        const dirPath = path.join(sessionsBase, "2026", "04", "15");
        const stalePath = path.join(dirPath, "rollout-2026-04-15T21-30-00-thread-stale.jsonl");
        const freshPath = path.join(dirPath, "rollout-2026-04-15T22-00-01-thread-fresh.jsonl");
        const staleFirstLine = JSON.stringify({
          timestamp: "2026-04-15T21:30:00.000Z",
          type: "session_meta",
          payload: {
            id: "thread-stale",
            timestamp: "2026-04-15T21:30:00.000Z",
            cwd: "/tmp/test-worktree",
          },
        });
        const freshFirstLine = JSON.stringify({
          timestamp: "2026-04-15T22:00:01.000Z",
          type: "session_meta",
          payload: {
            id: "thread-fresh",
            timestamp: "2026-04-15T22:00:01.000Z",
            cwd: "/tmp/test-worktree",
          },
        });

        mocks.existsSyncResults.set(sessionsBase, true);
        mocks.existsSyncResults.set(dirPath, true);
        mocks.dirEntries.set(dirPath, [path.basename(stalePath), path.basename(freshPath)]);
        mocks.fileContents.set(stalePath, `${staleFirstLine}\n`);
        const freshContent = [
          freshFirstLine,
          JSON.stringify({ timestamp: "2026-04-15T22:00:01.200Z", type: "response_item", payload: { type: "message", role: "developer", content: "x".repeat(70_000) } }),
          JSON.stringify({ timestamp: "2026-04-15T22:00:01.500Z", type: "event_msg", payload: { type: "user_message", message: "ADE session guidance" } }),
          JSON.stringify({ timestamp: "2026-04-15T22:00:03.000Z", type: "event_msg", payload: { type: "thread_name_updated", thread_id: "thread-fresh", thread_name: "Runtime title from Codex" } }),
        ].join("\n") + "\n";
        mocks.fileContents.set(freshPath, freshContent);
        mocks.fileStats.set(stalePath, { size: staleFirstLine.length, mtimeMs: fakeNow.getTime() - 30 * 60_000, isDirectory: false });
        mocks.fileStats.set(freshPath, { size: freshContent.length, mtimeMs: fakeNow.getTime() + 1_000, isDirectory: false });

        const { service, sessionService } = createHarness();
        const created = await service.create({
          laneId: "lane-1",
          title: "Codex CLI",
          cols: 80,
          rows: 24,
          toolType: "codex",
          startupCommand: "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox",
        });

        await vi.advanceTimersByTimeAsync(1_500);

        expect(sessionService.setResumeCommand).toHaveBeenCalledWith(created.sessionId, "codex resume thread-fresh");
        expect(sessionService.setResumeCommand).not.toHaveBeenCalledWith(created.sessionId, "codex resume thread-stale");
        expect(sessionService.updateMeta).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: created.sessionId,
            title: "Runtime title from Codex",
            manuallyNamed: false,
          }),
        );
        expect(sessionService.get(created.sessionId)?.title).toBe("Runtime title from Codex");
      } finally {
        vi.useRealTimers();
      }
    });

    it("dedupes duplicate/empty/whitespace sessionIds", async () => {
      const { service, sessionService } = createHarness();
      // No session is seeded, so tryBackfillResumeTarget returns early after calling get();
      // we just want to confirm only ONE call per unique id reaches sessionService.get.
      const getSpy = sessionService.get as ReturnType<typeof vi.fn>;
      getSpy.mockClear();

      await service.ensureResumeTargets(["session-1", "  session-1 ", "", "  ", "session-1"]);

      const uniqueCallsForSession1 = getSpy.mock.calls.filter(([id]) => id === "session-1").length;
      expect(uniqueCallsForSession1).toBe(1);
    });

    it("swallows per-session errors and logs a warning", async () => {
      const { service, sessionService, logger } = createHarness();
      const getSpy = sessionService.get as ReturnType<typeof vi.fn>;
      // First invocation for session-a throws; second invocation for session-b returns null cleanly
      getSpy.mockImplementationOnce(() => {
        throw new Error("boom");
      });

      await expect(service.ensureResumeTargets(["session-a", "session-b"])).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        "pty.resume_target_backfill_failed",
        expect.objectContaining({ sessionId: "session-a", err: expect.stringContaining("boom") }),
      );
      // session-b should still have been attempted
      expect(getSpy.mock.calls.some(([id]) => id === "session-b")).toBe(true);
    });
  });

  describe("spawn failure handling", () => {
    it("cleans up and rethrows when all shell candidates fail", async () => {
      const { service, sessionService, broadcastExit, logger, loadPty } = createHarness();
      loadPty.mockReturnValue({
        spawn: vi.fn(() => { throw new Error("spawn failed"); }),
      });

      await expect(service.create({
        laneId: "lane-1",
        title: "fail",
        cols: 80,
        rows: 24,
      })).rejects.toThrow("spawn failed");

      expect(logger.error).toHaveBeenCalledWith("pty.spawn_failed", expect.any(Object));
      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
      expect(broadcastExit).toHaveBeenCalledWith(
        expect.objectContaining({ exitCode: null }),
      );
    });
  });

  describe("chat terminal contract", () => {
    /**
     * Augment the harness's session service with the methods listTerminals/activeForChat rely on.
     * Returned `service` is a fresh ptyService bound to the augmented sessionService, so we can
     * exercise the chat-linked terminal surface end-to-end.
     */
    function createChatHarness() {
      const harness = createHarness();
      const sessionStore = new Map<string, any>();

      const sessionService = {
        ...harness.sessionService,
        create: vi.fn((args: any) => {
          sessionStore.set(args.sessionId, {
            ...args,
            id: args.sessionId,
            status: "running",
            laneId: args.laneId,
            laneName: "Test lane",
            ptyId: args.ptyId ?? null,
            title: args.title,
            transcriptPath: args.transcriptPath,
            startedAt: args.startedAt,
            endedAt: null,
            exitCode: null,
            chatSessionId: args.chatSessionId ?? null,
          });
        }),
        end: vi.fn((args: any) => {
          const s = sessionStore.get(args.sessionId);
          if (s) {
            s.status = args.status;
            s.exitCode = args.exitCode;
            s.endedAt = args.endedAt;
            s.ptyId = null;
          }
        }),
        get: vi.fn((id: string) => sessionStore.get(id) ?? null),
        list: vi.fn((args: { laneId?: string; limit?: number } = {}) => {
          const all = Array.from(sessionStore.values()) as any[];
          return all
            .filter((s) => (args.laneId ? s.laneId === args.laneId : true))
            .slice(0, args.limit ?? all.length);
        }),
        setChatSessionId: vi.fn((sessionId: string, chatSessionId: string | null) => {
          const s = sessionStore.get(sessionId);
          if (s) s.chatSessionId = chatSessionId;
        }),
        readTranscriptTail: vi.fn(async (
          _path: string,
          _max: number,
          _opts?: { raw?: boolean },
        ) => "transcript-bytes"),
      };

      const service = createPtyService({
        projectRoot: "/tmp/test-project",
        transcriptsDir: "/tmp/transcripts",
        laneService: harness.laneService as any,
        sessionService: sessionService as any,
        logger: harness.logger as any,
        broadcastData: harness.broadcastData,
        broadcastExit: harness.broadcastExit,
        onSessionEnded: harness.onSessionEnded,
        onSessionRuntimeSignal: harness.onSessionRuntimeSignal,
        loadPty: harness.loadPty as any,
      });

      return { ...harness, sessionService, sessionStore, service };
    }

    it("propagates chatSessionId through sessionService.create on a fresh terminal", async () => {
      const { service, sessionService } = createChatHarness();

      const created = await service.create({
        laneId: "lane-1",
        title: "Chat-linked terminal",
        cols: 80,
        rows: 24,
        chatSessionId: "chat-42",
      });

      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: created.sessionId,
          chatSessionId: "chat-42",
        }),
      );
      const active = service.activeForChat({ chatSessionId: "chat-42" });
      expect(active).not.toBeNull();
      expect(active!.terminalId).toBe(created.sessionId);
      expect(active!.chatSessionId).toBe("chat-42");
      expect(active!.active).toBe(true);
    });

    it("listTerminals filters to the requested chat session and orders active first", async () => {
      const { service } = createChatHarness();

      const a = await service.create({ laneId: "lane-1", title: "A", cols: 80, rows: 24, chatSessionId: "chat-1" });
      const b = await service.create({ laneId: "lane-1", title: "B", cols: 80, rows: 24, chatSessionId: "chat-1" });
      const c = await service.create({ laneId: "lane-1", title: "C", cols: 80, rows: 24, chatSessionId: "chat-other" });

      const list = service.listTerminals({ chatSessionId: "chat-1" });
      const ids = list.map((s) => s.terminalId);
      expect(ids).toContain(a.sessionId);
      expect(ids).toContain(b.sessionId);
      expect(ids).not.toContain(c.sessionId);
      // The most recently created terminal is the active one for the chat and must sort first.
      expect(list[0]?.terminalId).toBe(b.sessionId);
      expect(list[0]?.active).toBe(true);
    });

    it("listTerminals excludes persisted agent chat transcript rows", async () => {
      const { service, sessionService } = createChatHarness();

      const terminal = await service.create({
        laneId: "lane-1",
        title: "Claude Code",
        cols: 80,
        rows: 24,
        toolType: "claude",
      });
      sessionService.create({
        sessionId: "chat-row",
        laneId: "lane-1",
        ptyId: null,
        tracked: true,
        title: "Claude Chat",
        startedAt: new Date().toISOString(),
        transcriptPath: "/tmp/chat-row.jsonl",
        toolType: "claude-chat",
      });

      const ids = service.listTerminals({ laneId: "lane-1" }).map((session) => session.terminalId);

      expect(ids).toContain(terminal.sessionId);
      expect(ids).not.toContain("chat-row");
      await expect(service.previewTerminal({ terminalId: "chat-row" })).rejects.toThrow("not a terminal");
    });

    it("readTerminal returns transcript bytes from `since` and reports nextSince", async () => {
      const { service, sessionService } = createChatHarness();
      const created = await service.create({
        laneId: "lane-1",
        title: "Reader",
        cols: 80,
        rows: 24,
        chatSessionId: "chat-7",
      });
      sessionService.readTranscriptTail.mockResolvedValueOnce("0123456789");

      const read = await service.readTerminal({ chatSessionId: "chat-7", since: 4, maxBytes: 1024 });
      expect(read.terminalId).toBe(created.sessionId);
      expect(read.data).toBe("456789");
      expect(read.nextSince).toBe(4 + "456789".length);
    });

    it("readTerminal accepts a live PTY handle as an alias for the terminal session id", async () => {
      const { service, sessionService } = createChatHarness();
      const created = await service.create({
        laneId: "lane-1",
        title: "Reader",
        cols: 80,
        rows: 24,
        chatSessionId: "chat-7",
      });
      sessionService.readTranscriptTail.mockResolvedValueOnce("pty transcript");

      const read = await service.readTerminal({ ptyId: created.ptyId, maxBytes: 1024 });

      expect(read.terminalId).toBe(created.sessionId);
      expect(read.data).toBe("pty transcript");
      expect(sessionService.get).toHaveBeenCalledWith(created.sessionId);

      sessionService.readTranscriptTail.mockResolvedValueOnce("terminal flag pty transcript");
      const terminalFlagRead = await service.readTerminal({ terminalId: created.ptyId, maxBytes: 1024 });

      expect(terminalFlagRead.terminalId).toBe(created.sessionId);
      expect(terminalFlagRead.data).toBe("terminal flag pty transcript");
    });

    it("readTerminal merges recent live output before the transcript stream flushes", async () => {
      const { service, mockPty, sessionService } = createChatHarness();
      const created = await service.create({
        laneId: "lane-1",
        title: "Reader",
        cols: 80,
        rows: 24,
        chatSessionId: "chat-7",
      });
      sessionService.readTranscriptTail.mockResolvedValueOnce("disk\n");

      mockPty._emitter.emit("data", "live output");

      const read = await service.readTerminal({ terminalId: created.sessionId, since: 5, maxBytes: 1024 });
      expect(read.terminalId).toBe(created.sessionId);
      expect(read.data).toBe("live output");
      expect(read.nextSince).toBe("disk\nlive output".length);
    });

    it("readTerminal defaults to a bounded transcript tail", async () => {
      const { service, sessionService } = createChatHarness();
      await service.create({
        laneId: "lane-1",
        title: "Reader",
        cols: 80,
        rows: 24,
        chatSessionId: "chat-7",
      });

      await service.readTerminal({ chatSessionId: "chat-7" });
      expect(sessionService.readTranscriptTail).toHaveBeenCalledWith(
        expect.stringContaining("/tmp/transcripts/"),
        220_000,
        { raw: true },
      );
    });

    it("previewTerminal returns a transcript fallback without resuming the terminal", async () => {
      const { service, sessionService } = createChatHarness();
      const created = await service.create({
        laneId: "lane-1",
        title: "Preview",
        cols: 80,
        rows: 24,
        chatSessionId: "chat-preview",
      });
      sessionService.readTranscriptTail.mockResolvedValueOnce("raw transcript");

      const preview = await service.previewTerminal({ terminalId: created.sessionId, maxBytes: 4096 });

      expect(preview.terminalId).toBe(created.sessionId);
      expect(preview.source).toBe("transcript");
      expect(preview.transcript).toBe("raw transcript");
      expect(preview.snapshot).toBeNull();
      expect(sessionService.readTranscriptTail).toHaveBeenCalledWith(
        expect.stringContaining("/tmp/transcripts/"),
        4096,
        { raw: true, alignToLineBoundary: true },
      );
    });

    it("writeTerminal routes data via the active chat terminal and the underlying PTY", async () => {
      const { service, mockPty } = createChatHarness();
      await service.create({
        laneId: "lane-1",
        title: "Writer",
        cols: 80,
        rows: 24,
        chatSessionId: "chat-write",
      });

      const result = await service.writeTerminal({ chatSessionId: "chat-write", data: "y\n" });
      expect(result).toEqual({ ok: true });
      expect(mockPty.write).toHaveBeenCalledWith("y\n");
    });

    it("writeTerminal marks user input so immediate output uses the interactive batch window", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
        const { service, mockPty, broadcastData } = createChatHarness();
        await service.create({
          laneId: "lane-1",
          title: "Writer",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-write",
        });

        await service.writeTerminal({ chatSessionId: "chat-write", data: "y\n" });
        mockPty._emitter.emit("data", "prompt");

        await vi.advanceTimersByTimeAsync(7);
        expect(broadcastData).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(broadcastData).toHaveBeenCalledWith(expect.objectContaining({ data: "prompt" }));
      } finally {
        vi.useRealTimers();
      }
    });

    it("resizeTerminal resizes the active chat terminal", async () => {
      const { service, mockPty } = createChatHarness();
      await service.create({
        laneId: "lane-1",
        title: "Resize",
        cols: 80,
        rows: 24,
        chatSessionId: "chat-resize",
      });

      const result = service.resizeTerminal({ chatSessionId: "chat-resize", cols: 120, rows: 30 });

      expect(result).toEqual({ ok: true, cols: 120, rows: 30 });
      expect(mockPty.resize).toHaveBeenCalledWith(120, 30);
    });

    it("signalTerminal sends ^C for SIGINT and forwards SIGTERM to pty.kill", async () => {
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true as const);
      const { service, mockPty } = createChatHarness();
      await service.create({
        laneId: "lane-1",
        title: "Signal",
        cols: 80,
        rows: 24,
        chatSessionId: "chat-signal",
      });

      service.signalTerminal({ chatSessionId: "chat-signal", signal: "SIGINT" });
      expect(mockPty.write).toHaveBeenCalledWith("\x03");

      mocks.spawnSync.mockClear();
      service.signalTerminal({ chatSessionId: "chat-signal", signal: "SIGTERM" });
      await Promise.resolve();
      expect(mockPty.kill).toHaveBeenCalledWith("SIGTERM");
      expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
      expect(mocks.spawnSync).not.toHaveBeenCalled();
      kill.mockRestore();
    });

    it("uses node-pty's kill fallback without POSIX process-group signals on Windows", async () => {
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true as const);
      setPlatform("win32");
      try {
        const { service, mockPty } = createChatHarness();
        await service.create({
          laneId: "lane-1",
          title: "Signal",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-signal-windows",
        });

        service.signalTerminal({ chatSessionId: "chat-signal-windows", signal: "SIGTERM" });
        expect(mockPty.kill).toHaveBeenCalledWith("SIGTERM");
        expect(kill).not.toHaveBeenCalledWith(-12345, "SIGTERM");
      } finally {
        setPlatform(originalPlatform);
        kill.mockRestore();
      }
    });

    it("force-kills a stubborn Windows PTY tree without blocking the main process", async () => {
      vi.useFakeTimers();
      setPlatform("win32");
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true as const);
      try {
        const { service, mockPty } = createChatHarness();
        await service.create({
          laneId: "lane-1",
          title: "Signal",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-signal-windows-stubborn",
        });

        service.signalTerminal({
          chatSessionId: "chat-signal-windows-stubborn",
          signal: "SIGTERM",
        });
        expect(mockPty.kill).toHaveBeenCalledWith("SIGTERM");
        expect(mocks.execFile).toHaveBeenCalledWith(
          "taskkill.exe",
          ["/PID", "12345", "/T"],
          expect.objectContaining({ windowsHide: true }),
          expect.any(Function),
        );

        await vi.advanceTimersByTimeAsync(1_500);
        expect(mocks.execFile).toHaveBeenCalledWith(
          "taskkill.exe",
          ["/PID", "12345", "/T", "/F"],
          expect.objectContaining({ windowsHide: true }),
          expect.any(Function),
        );
        expect(mocks.spawnSync).not.toHaveBeenCalled();
      } finally {
        setPlatform(originalPlatform);
        kill.mockRestore();
        vi.useRealTimers();
      }
    });

    it("still force-kills Windows descendants after the ConPTY leader exits", async () => {
      vi.useFakeTimers();
      setPlatform("win32");
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("ESRCH");
      });
      try {
        const { service } = createChatHarness();
        await service.create({
          laneId: "lane-1",
          title: "Signal",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-signal-windows-orphan",
        });

        service.signalTerminal({ chatSessionId: "chat-signal-windows-orphan", signal: "SIGTERM" });
        await vi.advanceTimersByTimeAsync(1_500);

        expect(mocks.execFile).toHaveBeenCalledWith(
          "taskkill.exe",
          ["/PID", "12345", "/T", "/F"],
          expect.objectContaining({ windowsHide: true }),
          expect.any(Function),
        );
      } finally {
        setPlatform(originalPlatform);
        kill.mockRestore();
        vi.useRealTimers();
      }
    });

    it("uses taskkill tree semantics for an immediate Windows SIGKILL", async () => {
      setPlatform("win32");
      try {
        const { service, mockPty } = createChatHarness();
        await service.create({
          laneId: "lane-1",
          title: "Signal",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-signal-windows-kill",
        });

        service.signalTerminal({ chatSessionId: "chat-signal-windows-kill", signal: "SIGKILL" });

        expect(mockPty.kill).toHaveBeenCalledWith("SIGKILL");
        expect(mocks.execFile).toHaveBeenCalledWith(
          "taskkill.exe",
          ["/PID", "12345", "/T", "/F"],
          expect.objectContaining({ windowsHide: true }),
          expect.any(Function),
        );
      } finally {
        setPlatform(originalPlatform);
      }
    });

    it("force-kills a live PTY process group after its leader exits", async () => {
      vi.useFakeTimers();
      mocks.execFile.mockImplementation((...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback === "function") {
          (callback as (...callbackArgs: unknown[]) => void)(
            null,
            "12345 1 12345 12345\n",
            "",
          );
        }
        return { kill: vi.fn() };
      });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true as const);
      try {
        const { service } = createChatHarness();
        await service.create({
          laneId: "lane-1",
          title: "Signal",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-signal-group",
        });

        service.signalTerminal({ chatSessionId: "chat-signal-group", signal: "SIGTERM" });
        await vi.advanceTimersByTimeAsync(1_500);

        expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
      } finally {
        kill.mockRestore();
        vi.useRealTimers();
      }
    });

    it("kills a foreground job group after the PTY shell group exits", async () => {
      vi.useFakeTimers();
      let scanCount = 0;
      mocks.execFile.mockImplementation((...args: unknown[]) => {
        scanCount += 1;
        const callback = args.at(-1);
        if (typeof callback === "function") {
          (callback as (...callbackArgs: unknown[]) => void)(
            null,
            scanCount === 1
              ? [
                  "12345 1 12345 23456",
                  "23456 12345 23456 23456",
                  "34567 23456 34567 -1",
                ].join("\n")
              : [
                  "23456 1 23456 23456",
                  "34567 23456 34567 -1",
                ].join("\n"),
            "",
          );
        }
        return { kill: vi.fn() };
      });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true as const);
      try {
        const { service } = createChatHarness();
        await service.create({
          laneId: "lane-1",
          title: "Signal",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-signal-foreground-group",
        });

        service.signalTerminal({
          chatSessionId: "chat-signal-foreground-group",
          signal: "SIGTERM",
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(kill).toHaveBeenCalledWith(-23456, "SIGTERM");
        expect(kill).toHaveBeenCalledWith(-34567, "SIGTERM");

        await vi.advanceTimersByTimeAsync(1_500);
        expect(kill).toHaveBeenCalledWith(-23456, "SIGKILL");
        expect(kill).toHaveBeenCalledWith(23456, "SIGKILL");
        expect(kill).toHaveBeenCalledWith(-34567, "SIGKILL");
        expect(kill).toHaveBeenCalledWith(34567, "SIGKILL");
        expect(mocks.execFile).toHaveBeenCalledWith(
          "ps",
          ["-axo", "pid=,ppid=,pgid=,tpgid="],
          expect.any(Object),
          expect.any(Function),
        );
      } finally {
        kill.mockRestore();
        vi.useRealTimers();
      }
    });

    it("signals the PTY within a bounded delay when the process scan stalls", async () => {
      vi.useFakeTimers();
      mocks.execFile.mockImplementation(() => ({ kill: vi.fn() }));
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true as const);
      try {
        const { service, mockPty } = createChatHarness();
        await service.create({
          laneId: "lane-1",
          title: "Signal",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-signal-scan-stall",
        });

        service.signalTerminal({ chatSessionId: "chat-signal-scan-stall", signal: "SIGTERM" });
        await vi.advanceTimersByTimeAsync(99);
        expect(mockPty.kill).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
        expect(mockPty.kill).toHaveBeenCalledWith("SIGTERM");
      } finally {
        kill.mockRestore();
        vi.useRealTimers();
      }
    });

    it("force-kills known PTY groups when the reap scan fails under load", async () => {
      vi.useFakeTimers();
      let scanCount = 0;
      mocks.execFile.mockImplementation((...args: unknown[]) => {
        scanCount += 1;
        const callback = args.at(-1);
        if (typeof callback === "function") {
          if (scanCount === 1) {
            (callback as (...callbackArgs: unknown[]) => void)(
              null,
              [
                "12345 1 12345 23456",
                "23456 12345 23456 23456",
              ].join("\n"),
              "",
            );
          } else {
            (callback as (...callbackArgs: unknown[]) => void)(
              new Error("process scan timed out"),
              "",
              "",
            );
          }
        }
        return { kill: vi.fn() };
      });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true as const);
      try {
        const { service } = createChatHarness();
        await service.create({
          laneId: "lane-1",
          title: "Signal",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-signal-reap-scan-failure",
        });

        service.signalTerminal({
          chatSessionId: "chat-signal-reap-scan-failure",
          signal: "SIGTERM",
        });
        await vi.advanceTimersByTimeAsync(0);
        kill.mockClear();

        await vi.advanceTimersByTimeAsync(1_500);
        expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
        expect(kill).toHaveBeenCalledWith(12345, "SIGKILL");
        expect(kill).toHaveBeenCalledWith(-23456, "SIGKILL");
        expect(kill).toHaveBeenCalledWith(23456, "SIGKILL");
      } finally {
        kill.mockRestore();
        vi.useRealTimers();
      }
    });

    it("fails loudly when chat terminal calls cannot resolve a target", async () => {
      const { service } = createChatHarness();

      await expect(service.readTerminal({ chatSessionId: "no-such-chat" })).rejects.toThrow(
        /terminal\.read requires/,
      );
      await expect(service.writeTerminal({ chatSessionId: "no-such-chat", data: "x" })).rejects.toThrow(
        /terminal\.write requires/,
      );
      expect(() => service.signalTerminal({ chatSessionId: "no-such-chat", signal: "SIGINT" })).toThrow(
        /No running terminal/,
      );
      expect(service.activeForChat({ chatSessionId: "no-such-chat" })).toBeNull();
      expect(service.activeForChat({})).toBeNull();
      expect(service.activeForChat(null)).toBeNull();
    });

    describe("reattachChatCli", () => {
      it("returns the existing live PTY when one is already bound", async () => {
        const { service } = createChatHarness();
        // Use the same sessionId for chat session and terminal session, mirroring chat-CLI tracking
        const created = await service.create({
          sessionId: "chat-existing",
          allowNewSessionId: true,
          laneId: "lane-1",
          title: "Claude Chat",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-existing",
          tracked: true,
          toolType: "claude-chat",
          startupCommand: "claude --resume target",
        });

        const result = await service.reattachChatCli({ chatSessionId: "chat-existing" });

        expect(result.relaunched).toBe(false);
        expect(result.terminalId).toBe(created.sessionId);
        expect(result.ptyId).toBe(created.ptyId);
      });

      it("prefers chat CLI over a newer App Control shell with the same chatSessionId", async () => {
        const { service } = createChatHarness();
        const chatCli = await service.create({
          sessionId: "chat-app-control",
          allowNewSessionId: true,
          laneId: "lane-1",
          title: "Claude Chat",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-app-control",
          tracked: true,
          toolType: "claude-chat",
          startupCommand: "claude --resume target",
        });
        const appControlShell = await service.create({
          laneId: "lane-1",
          title: "App Control",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-app-control",
          tracked: true,
          toolType: "shell",
          startupCommand: "npm run dev",
        });

        const active = service.activeForChat({ chatSessionId: "chat-app-control" });
        expect(active?.terminalId).toBe(chatCli.sessionId);
        expect(active?.terminalId).not.toBe(appControlShell.sessionId);

        const reattached = await service.reattachChatCli({ chatSessionId: "chat-app-control" });
        expect(reattached.relaunched).toBe(false);
        expect(reattached.terminalId).toBe(chatCli.sessionId);
        expect(reattached.ptyId).toBe(chatCli.ptyId);
      });

      it("routes terminal operations to the App Control shell without making it the active chat CLI", async () => {
        const { service, loadPty, sessionService } = createChatHarness();
        const chatPty = createMockPty();
        const appControlPty = createMockPty();
        const spawn = vi.fn()
          .mockReturnValueOnce(chatPty)
          .mockReturnValueOnce(appControlPty);
        loadPty.mockReturnValue({ spawn });

        const chatCli = await service.create({
          sessionId: "chat-app-control-routing",
          allowNewSessionId: true,
          laneId: "lane-1",
          title: "Claude Chat",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-app-control-routing",
          tracked: true,
          toolType: "claude-chat",
          startupCommand: "claude --resume target",
        });
        const appControlShell = await service.create({
          laneId: "lane-1",
          title: "App Control",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-app-control-routing",
          tracked: true,
          toolType: "shell",
          startupCommand: "npm run dev",
        });
        (chatPty.write as ReturnType<typeof vi.fn>).mockClear();
        (appControlPty.write as ReturnType<typeof vi.fn>).mockClear();
        sessionService.readTranscriptTail.mockResolvedValueOnce("app control output");

        const read = await service.readTerminal({ chatSessionId: "chat-app-control-routing" });
        await service.writeTerminal({ chatSessionId: "chat-app-control-routing", data: "q\n" });
        service.signalTerminal({ chatSessionId: "chat-app-control-routing", signal: "SIGINT" });

        expect(read.terminalId).toBe(appControlShell.sessionId);
        expect(appControlPty.write).toHaveBeenNthCalledWith(1, "q\n");
        expect(appControlPty.write).toHaveBeenNthCalledWith(2, "\x03");
        expect(chatPty.write).not.toHaveBeenCalled();
        expect(service.activeForChat({ chatSessionId: "chat-app-control-routing" })?.terminalId).toBe(chatCli.sessionId);
      });

      it("relaunches a new PTY for a disposed chat-CLI session", async () => {
        const { service, loadPty, sessionStore } = createChatHarness();
        const created = await service.create({
          sessionId: "chat-relaunch",
          allowNewSessionId: true,
          laneId: "lane-1",
          title: "Claude Chat",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-relaunch",
          tracked: true,
          toolType: "claude-chat",
          startupCommand: "claude --resume target",
        });

        // Persist a resume command on the session record so reattach can build a startup command.
        const record = sessionStore.get("chat-relaunch");
        if (record) {
          record.resumeCommand = "claude --resume target";
        }

        // Dispose the live PTY entry to simulate a dead session after ADE crash/restart.
        service.dispose({ ptyId: created.ptyId, sessionId: created.sessionId });

        // Wire a fresh mock PTY for the relaunch.
        const freshMockPty = createMockPty();
        const freshSpawn = vi.fn(() => freshMockPty);
        loadPty.mockImplementationOnce(() => ({ spawn: freshSpawn as any }));

        const result = await service.reattachChatCli({ chatSessionId: "chat-relaunch" });

        expect(result.relaunched).toBe(true);
        expect(result.terminalId).toBe(created.sessionId);
        expect(result.ptyId).not.toBe(created.ptyId);
        expect(freshSpawn).toHaveBeenCalled();
      });

      it("reattaches legacy OpenCode chats on Windows without typing POSIX env syntax", async () => {
        const { service, loadPty, sessionStore } = createChatHarness();
        const created = await service.create({
          sessionId: "chat-opencode-windows-legacy",
          allowNewSessionId: true,
          laneId: "lane-1",
          title: "OpenCode Chat",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-opencode-windows-legacy",
          tracked: true,
          toolType: "opencode-chat",
          startupCommand: "opencode --session ses_legacy",
        });
        const record = sessionStore.get("chat-opencode-windows-legacy");
        if (record) {
          record.resumeCommand = "OPENCODE_CONFIG_CONTENT='{\"permission\":\"allow\"}' opencode --session ses_legacy";
          record.resumeMetadata = null;
        }
        service.dispose({ ptyId: created.ptyId, sessionId: created.sessionId });

        const originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        try {
          const freshMockPty = createMockPty();
          const freshSpawn = vi.fn(() => freshMockPty);
          loadPty.mockImplementationOnce(() => ({ spawn: freshSpawn as any }));

          await expect(service.reattachChatCli({
            chatSessionId: "chat-opencode-windows-legacy",
          })).resolves.toEqual(expect.objectContaining({
            terminalId: "chat-opencode-windows-legacy",
            relaunched: true,
          }));

          const [spawnCommand, spawnArgs, spawnOptions] = freshSpawn.mock.calls[0] as unknown as [
            string,
            string | string[],
            { env: Record<string, string> },
          ];
          expect(spawnCommand.toLowerCase()).toContain("cmd");
          expect(spawnArgs).toContain("opencode");
          expect(spawnArgs).toContain("ses_legacy");
          expect(spawnOptions.env.OPENCODE_CONFIG_CONTENT).toContain("\"permission\":\"allow\"");
          expect(freshMockPty.write).not.toHaveBeenCalledWith(
            expect.stringContaining("OPENCODE_CONFIG_CONTENT="),
          );
        } finally {
          Object.defineProperty(process, "platform", {
            value: originalPlatform,
            configurable: true,
          });
        }
      });

      it("throws when the chat-CLI session record is missing", async () => {
        const { service } = createChatHarness();
        await expect(service.reattachChatCli({ chatSessionId: "missing" })).rejects.toThrow(
          /was not found/,
        );
      });

      it("throws when the session is not a persisted chat tool type", async () => {
        const { service } = createChatHarness();
        await service.create({
          sessionId: "plain-shell",
          allowNewSessionId: true,
          laneId: "lane-1",
          title: "Shell",
          cols: 80,
          rows: 24,
          tracked: true,
          toolType: "shell",
        });
        // The activeTerminalByChatSession bypass key is the chatSessionId, which is null for shell sessions,
        // so reattachChatCli falls through to the session-lookup branch directly even with a live PTY.

        await expect(service.reattachChatCli({ chatSessionId: "plain-shell" })).rejects.toThrow(
          /not a chat CLI session/,
        );
      });

      it("throws when the chat-CLI session is untracked", async () => {
        const { service, sessionStore } = createChatHarness();
        const created = await service.create({
          sessionId: "untracked-chat",
          allowNewSessionId: true,
          laneId: "lane-1",
          title: "Claude",
          cols: 80,
          rows: 24,
          chatSessionId: "untracked-chat",
          toolType: "claude-chat",
          tracked: false,
        });
        // Force tracked = false on the stored record (the chat harness defaults to tracked: true).
        const record = sessionStore.get("untracked-chat");
        if (record) {
          record.tracked = false;
        }
        // Dispose the live PTY so reattachChatCli must take the lookup-and-relaunch path.
        service.dispose({ ptyId: created.ptyId, sessionId: created.sessionId });

        await expect(service.reattachChatCli({ chatSessionId: "untracked-chat" })).rejects.toThrow(
          /not tracked/,
        );
      });

      it("throws when the chat-CLI session has no resume command or metadata", async () => {
        const { service, sessionStore } = createChatHarness();
        const created = await service.create({
          sessionId: "no-resume",
          allowNewSessionId: true,
          laneId: "lane-1",
          title: "Claude",
          cols: 80,
          rows: 24,
          chatSessionId: "no-resume",
          tracked: true,
          toolType: "claude-chat",
        });

        // Wipe out the resume hints so reattach has nothing to launch with.
        const record = sessionStore.get("no-resume");
        if (record) {
          record.resumeCommand = null;
          record.resumeMetadata = null;
        }

        service.dispose({ ptyId: created.ptyId, sessionId: created.sessionId });

        await expect(service.reattachChatCli({ chatSessionId: "no-resume" })).rejects.toThrow(
          /no resume command available/,
        );
      });

      it("throws when called with an empty chatSessionId", async () => {
        const { service } = createChatHarness();
        await expect(service.reattachChatCli({ chatSessionId: "" })).rejects.toThrow(
          /requires chatSessionId/,
        );
      });

      it("dedupes concurrent reattach calls for the same chatSessionId to a single relaunch", async () => {
        const { service, loadPty, sessionStore } = createChatHarness();
        const created = await service.create({
          sessionId: "chat-dedup",
          allowNewSessionId: true,
          laneId: "lane-1",
          title: "Claude Chat",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-dedup",
          tracked: true,
          toolType: "claude-chat",
          startupCommand: "claude --resume target",
        });
        const record = sessionStore.get("chat-dedup");
        if (record) record.resumeCommand = "claude --resume target";
        service.dispose({ ptyId: created.ptyId, sessionId: created.sessionId });

        // Only one fresh spawn should happen even if multiple callers race.
        const freshMockPty = createMockPty();
        const freshSpawn = vi.fn(() => freshMockPty);
        loadPty.mockImplementation(() => ({ spawn: freshSpawn as any }));

        const [a, b, c] = await Promise.all([
          service.reattachChatCli({ chatSessionId: "chat-dedup" }),
          service.reattachChatCli({ chatSessionId: "chat-dedup" }),
          service.reattachChatCli({ chatSessionId: "chat-dedup" }),
        ]);

        // All three resolve to the same new PTY; only one spawn happened.
        expect(a.ptyId).toBe(b.ptyId);
        expect(b.ptyId).toBe(c.ptyId);
        expect(freshSpawn).toHaveBeenCalledTimes(1);
      });
    });

    describe("writeTerminal auto-reattach", () => {
      it("auto-reattaches a dead chat-CLI session when writing by chatSessionId", async () => {
        const { service, loadPty, sessionStore } = createChatHarness();
        const created = await service.create({
          sessionId: "chat-auto",
          allowNewSessionId: true,
          laneId: "lane-1",
          title: "Claude Chat",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-auto",
          tracked: true,
          toolType: "claude-chat",
          startupCommand: "claude --resume target",
        });

        // Seed a resume command so the auto-reattach can launch.
        const record = sessionStore.get("chat-auto");
        if (record) {
          record.resumeCommand = "claude --resume target";
        }

        // Simulate the PTY being dead (ADE crashed or quit).
        service.dispose({ ptyId: created.ptyId, sessionId: created.sessionId });

        // Wire a fresh PTY for the relaunch and capture its write calls.
        const freshMockPty = createMockPty();
        const freshSpawn = vi.fn(() => freshMockPty);
        loadPty.mockImplementationOnce(() => ({ spawn: freshSpawn as any }));

        const result = await service.writeTerminal({ chatSessionId: "chat-auto", data: "hello\n" });

        expect(result).toEqual({ ok: true });
        expect(freshSpawn).toHaveBeenCalled();
        expect(freshMockPty.write).toHaveBeenCalledWith("hello\n");
      });

      it("still throws when called with a stale explicit ptyId", async () => {
        const { service } = createChatHarness();
        const created = await service.create({
          sessionId: "chat-stale-pty",
          allowNewSessionId: true,
          laneId: "lane-1",
          title: "Claude Chat",
          cols: 80,
          rows: 24,
          chatSessionId: "chat-stale-pty",
          tracked: true,
          toolType: "claude-chat",
        });

        service.dispose({ ptyId: created.ptyId, sessionId: created.sessionId });

        await expect(
          service.writeTerminal({ ptyId: created.ptyId, data: "x" }),
        ).rejects.toThrow(/Terminal PTY '.*' is not running/);
      });
    });
  });
});
