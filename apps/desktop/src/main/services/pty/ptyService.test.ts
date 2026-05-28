import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import type { IPty } from "node-pty";
import type * as TerminalSessionSignals from "../../utils/terminalSessionSignals";

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
    createWriteStream: vi.fn(() => {
      const listeners = {
        finish: new Set<() => void>(),
        error: new Set<() => void>(),
      };
      const stream: any = {
        writableFinished: false,
        destroyed: false,
        write: vi.fn(),
        once: vi.fn((event: "finish" | "error", cb: () => void) => {
          listeners[event]?.add(cb);
          return stream;
        }),
        removeListener: vi.fn((event: "finish" | "error", cb: () => void) => {
          listeners[event]?.delete(cb);
          return stream;
        }),
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
    runGit: vi.fn(async () => ({ exitCode: 0, stdout: "abc123\n", stderr: "" })),
    stripAnsi: vi.fn((t: string) => t),
    summarizeTerminalSession: vi.fn(() => "test summary"),
    derivePreviewFromChunk: vi.fn(() => ({ nextLine: "", preview: "preview" })),
    defaultResumeCommandForTool: vi.fn(() => null),
    extractResumeCommandFromOutput: vi.fn(() => null),
    parseTrackedCliLaunchConfig: vi.fn(() => null),
    runtimeStateFromOsc133Chunk: vi.fn(() => "running"),
    resolveOpenCodeBinaryPath: vi.fn<[], string | null>(() => null),
    execFileSync: vi.fn(() => ""),
    spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
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
}));

vi.mock("node:crypto", () => ({
  randomUUID: mocks.randomUUID,
}));

vi.mock("node:child_process", () => ({
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

import {
  createPtyService,
  ensureNodePtySpawnHelperExecutable,
  PTY_AI_TITLE_DEBOUNCE_MS,
  PTY_AI_TITLE_TIMEOUT_MS,
} from "./ptyService";

const originalPlatform = process.platform;

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
    setSummary: vi.fn(),
    setLastOutputPreview: vi.fn(),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ptyService", () => {
  afterEach(() => {
    setPlatform(originalPlatform);
  });

  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" });
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

    it("starts plain shell sessions without user startup files", async () => {
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
          ["-f"],
          expect.objectContaining({
            env: expect.objectContaining({
              ZDOTDIR: "/var/empty",
            }),
          }),
        );
      } finally {
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

    it("does not send Codex initialInput into the update prompt", async () => {
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
          "pty.initial_input_skipped_not_ready",
          expect.objectContaining({ provider: "codex" }),
        );
        expect(logger.warn).toHaveBeenCalledWith(
          "pty.initial_input_launch_failed",
          expect.objectContaining({ toolType: "codex" }),
        );
        expect(sessionService.end).toHaveBeenCalledWith(expect.objectContaining({
          exitCode: 1,
          status: "failed",
        }));
      } finally {
        vi.useRealTimers();
      }
    });

    it("moves node_modules bins behind user paths for Codex CLI launches", async () => {
      const previousPath = process.env.PATH;
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
        expect(opts?.env?.PATH?.split(path.delimiter)).toEqual([
          "/opt/homebrew/bin",
          "/usr/bin",
          "/repo/apps/desktop/node_modules/.bin",
          "/tmp/project/node_modules/.bin",
        ]);
      } finally {
        if (previousPath == null) delete process.env.PATH;
        else process.env.PATH = previousPath;
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
        const { service, mockPty, logger } = createHarness();

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
        expect(sessionService.end).toHaveBeenCalledWith(expect.objectContaining({
          exitCode: 1,
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

    it("backfills a targetless Claude resume command before launching the resumed PTY", async () => {
      (mocks.extractResumeCommandFromOutput as any).mockReturnValueOnce("claude --resume claude-session-123");
      const { service, sessionService, mockPty } = createHarness();
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
      expect(mockPty.write).toHaveBeenCalledWith("claude --resume claude-session-123\r");
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
        toolType: "run-shell",
        command: "npm",
        args: ["run", "dev"],
      });

      expect(result.sessionId).toBe("session-process-1");
      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-process-1",
          title: "Run process",
          toolType: "run-shell",
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
        provider: "cursor",
        toolType: "cursor-cli",
        title: "Cursor CLI",
        resumeCommand: "cursor-agent --model auto --continue",
        expectedName: "Cursor",
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

      await expect(service.sendToSession({
        sessionId: `session-${provider}-targetless`,
        text: "keep going",
      })).rejects.toThrow(new RegExp(`${expectedName} exited before ADE could capture a concrete resume target`));
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
      sessionService.readTranscriptTail.mockResolvedValueOnce([
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

    it("sendToSession resumes an ended tracked CLI session and writes the message", async () => {
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

      const pending = service.sendToSession({
        sessionId: "session-ended-send",
        text: "fix failing tests",
        cols: 120,
        rows: 40,
        model: "gpt-5.4",
        reasoningEffort: "high",
        permissionMode: "plan",
      });
      await Promise.resolve();
      mockPty._emitter.emit("data", "OpenAI Codex\n› ");
      const result = await pending;

      expect(result).toEqual(expect.objectContaining({
        sessionId: "session-ended-send",
        resumed: true,
        reusedExistingRuntime: false,
      }));
      expect(sessionService.reattach).toHaveBeenCalledWith({
        sessionId: "session-ended-send",
        ptyId: expect.any(String),
        startedAt: expect.any(String),
      });
      const spawn = (loadPty.mock.results[0]?.value as any).spawn;
      expect(spawn).toHaveBeenCalledWith(
        "/bin/bash",
        ["--noprofile", "--norc", "-lc", "codex --no-alt-screen --model gpt-5.4 -c 'model_reasoning_effort=\"high\"' --sandbox read-only --ask-for-approval on-request resume thread-ended"],
        expect.any(Object),
      );
      expect(mockPty.write).toHaveBeenCalledWith("\x1b[200~fix failing tests\x1b[201~");
      expect(mockPty.write).toHaveBeenCalledWith("\r");
    });

    it("sendToSession preserves stored launch model and reasoning when no overrides are provided", async () => {
      const { service, sessionService, mockPty, loadPty } = createHarness();
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
      mockPty._emitter.emit("data", "OpenAI Codex\n› ");
      await pending;

      const spawn = (loadPty.mock.results[0]?.value as any).spawn;
      expect(spawn).toHaveBeenCalledWith(
        "/bin/bash",
        ["--noprofile", "--norc", "-lc", "codex --no-alt-screen --model gpt-5.4 -c 'model_reasoning_effort=\"medium\"' --sandbox workspace-write --ask-for-approval untrusted resume thread-stored"],
        expect.any(Object),
      );
    });

    it("sendToSession treats Cursor's resumed follow-up composer as ready", async () => {
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
        mockPty._emitter.emit("data", "Cursor Agent\nv2026.05.24\n→ Add a follow-up\n");

        await vi.advanceTimersByTimeAsync(599);
        expect(mockPty.write).toHaveBeenCalledTimes(0);
        const spawn = (loadPty.mock.results[0]?.value as any).spawn;
        expect(spawn).toHaveBeenCalledWith(
          "/bin/bash",
          ["--noprofile", "--norc", "-lc", "cursor-agent --model auto --resume cursor-chat-1"],
          expect.any(Object),
        );

        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(550);
        const result = await pending;

        expect(result).toEqual(expect.objectContaining({
          sessionId: "session-cursor-resume",
          resumed: true,
          reusedExistingRuntime: false,
        }));
        expect(mockPty.write).toHaveBeenNthCalledWith(1, "\x05");
        expect(mockPty.write).toHaveBeenNthCalledWith(2, "\x15");
        expect(mockPty.write).toHaveBeenNthCalledWith(3, "Print EXACT_CURSOR_RESUME_526 and stop");
        expect(mockPty.write).toHaveBeenNthCalledWith(4, "\r");
      } finally {
        vi.useRealTimers();
      }
    });

    it("sendToSession does not type into a resumed Cursor workspace trust prompt", async () => {
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
          () => null,
          (err: unknown) => err,
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
          message: expect.stringMatching(/could not receive the message/),
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
      } finally {
        vi.useRealTimers();
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
            launch: { permissionMode: "plan" },
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
        expect(spawnArgs.some((line: string) =>
          line.includes("opencode run --interactive --agent plan --model lmstudio/openai/gpt-oss-20b --session ses_abc --replay --replay-limit 40 --")
          && line.includes("continue from the freeze frame")
          && line.includes("\"question\":\"allow\"")
        )).toBe(true);
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
      await Promise.resolve();
      mockPty._emitter.emit("data", "OpenAI Codex\n› ");
      const [first, second] = await pending;

      expect(first.ptyId).toBe(second.ptyId);
      expect(loadPty).toHaveBeenCalledTimes(1);
      const writes = (mockPty.write as any).mock.calls.map((call: string[]) => call[0]);
      const firstText = writes.indexOf("\x1b[200~first\x1b[201~");
      const firstSubmit = writes.indexOf("\r", writes.indexOf("codex resume thread-concurrent\r") + 1);
      const secondText = writes.indexOf("\x1b[200~second\x1b[201~");
      const secondSubmit = writes.indexOf("\r", firstSubmit + 1);
      expect(firstText).toBeGreaterThanOrEqual(0);
      expect(firstSubmit).toBeGreaterThan(firstText);
      expect(secondText).toBeGreaterThan(firstSubmit);
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
        await vi.advanceTimersByTimeAsync(0);
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
      expect(createdSessionId).toBeTruthy();

      service.write({ ptyId, data: "Fix the flaky login tests\r" });

      expect(sessionService.updateMeta).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: createdSessionId,
          goal: "Fix the flaky login tests",
        }),
      );
      expect(sessionService.get(createdSessionId)?.goal).toBe("Fix the flaky login tests");
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
      expect(createdSessionId).toBeTruthy();

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
      expect(createdSessionId).toBeTruthy();

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

    it("does not call ADE AI title generation for Claude CLI sessions", async () => {
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

      expect(sessionService.get(createdSessionId)?.title).toBe("Fix the flaky login tests");
      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalled();
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

    it("does not end persisted agent chat rows just because there is no PTY", () => {
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
        runtimeState: "running",
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
      expect(mockPty.kill).toHaveBeenCalled();
      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId, status: "disposed" }),
      );
      expect(broadcastExit).toHaveBeenCalledWith(
        expect.objectContaining({ ptyId, sessionId, exitCode: null }),
      );
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
    it("broadcasts data events when the PTY emits data", async () => {
      vi.useFakeTimers();
      try {
        const { service, mockPty, broadcastData } = createHarness();
        const { ptyId, sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });
        mockPty._emitter.emit("data", "hello world");
        expect(broadcastData).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(16);
        expect(broadcastData).toHaveBeenCalledWith({
          ptyId,
          sessionId,
          projectRoot: "/tmp/test-project",
          data: "hello world",
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

    it("still auto-closes orchestrated worker sessions after the wrapped CLI exits", async () => {
      vi.useFakeTimers();
      try {
        mocks.runtimeStateFromOsc133Chunk.mockReturnValue("waiting-input");
        const { service, mockPty, logger } = createHarness();
        const { sessionId } = await service.create({
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
        expect(mockPty.kill).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith(
          "pty.tool_exit_auto_close",
          expect.objectContaining({ sessionId, toolType: "claude-orchestrated" }),
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

  describe("ensureResumeTargets", () => {
    it("backfills Codex storage resume targets during session-list hydration", async () => {
      // The session-list path is how older sessions (whose transcripts no
      // longer contain an explicit resume command) get their resume target
      // backfilled. The same storage fallback also runs from continuation
      // launch so Codex does not fall through to the picker.
      vi.useFakeTimers();
      try {
        const fakeNow = new Date("2026-04-15T22:00:00.000Z");
        vi.setSystemTime(fakeNow);

        const homedir = os.homedir();
        const sessionsBase = path.join(homedir, ".codex", "sessions");
        const dirPath = path.join(sessionsBase, "2026", "04", "15");
        const filePath = path.join(dirPath, "rollout-2026-04-15T21-30-00-thread-abc.jsonl");
        const startedAt = "2026-04-15T21:30:00.000Z";
        const firstLine = JSON.stringify({
          timestamp: startedAt,
          type: "session_meta",
          payload: {
            id: "thread-abc",
            timestamp: startedAt,
            cwd: "/tmp/worktree",
          },
        });

        mocks.existsSyncResults.set(sessionsBase, true);
        mocks.existsSyncResults.set(dirPath, true);
        mocks.dirEntries.set(dirPath, [path.basename(filePath)]);
        mocks.fileContents.set(filePath, `${firstLine}\n`);
        mocks.fileStats.set(filePath, { size: firstLine.length, mtimeMs: fakeNow.getTime() - 30_000, isDirectory: false });

        const { service, sessionService } = createHarness();
        sessionService.readTranscriptTail.mockResolvedValueOnce("OpenAI Codex\nmodel: gpt-5\n› ");
        sessionService.create({
          sessionId: "session-1",
          laneId: "lane-1",
          ptyId: null,
          tracked: true,
          title: "Codex CLI",
          startedAt,
          transcriptPath: "/tmp/worktree/.ade/transcripts/session-1.log",
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

        const homedir = os.homedir();
        const sessionsBase = path.join(homedir, ".codex", "sessions");
        const dirPath = path.join(sessionsBase, "2026", "04", "15");
        const filePath = path.join(dirPath, "rollout-2026-04-15T21-30-00-thread-live.jsonl");
        const startedAt = "2026-04-15T21:30:00.000Z";
        const firstLine = JSON.stringify({
          timestamp: startedAt,
          type: "session_meta",
          payload: {
            id: "thread-live",
            timestamp: startedAt,
            cwd: "/tmp/worktree",
          },
        });

        mocks.existsSyncResults.set(sessionsBase, true);
        mocks.existsSyncResults.set(dirPath, true);
        mocks.dirEntries.set(dirPath, [path.basename(filePath)]);
        mocks.fileContents.set(filePath, `${firstLine}\n`);
        mocks.fileStats.set(filePath, { size: firstLine.length, mtimeMs: fakeNow.getTime() - 30_000, isDirectory: false });

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
          transcriptPath: "/tmp/worktree/.ade/transcripts/session-update-only.log",
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
        transcriptPath: "/tmp/worktree/.ade/transcripts/session-claude-with-codex-words.log",
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
        const claudeProjectDir = path.join(os.homedir(), ".claude", "projects", "-tmp-worktree");
        const matchedPath = path.join(claudeProjectDir, `${matchedId}.jsonl`);
        const newerDifferentPath = path.join(claudeProjectDir, `${newerDifferentId}.jsonl`);
        const matchedFirstLine = JSON.stringify({
          timestamp: "2026-04-15T21:30:00.000Z",
          type: "user",
          sessionId: matchedId,
          cwd: "/tmp/worktree",
        });
        const newerDifferentFirstLine = JSON.stringify({
          timestamp: "2026-04-15T22:00:00.000Z",
          type: "user",
          sessionId: newerDifferentId,
          cwd: "/tmp/worktree",
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
          transcriptPath: "/tmp/worktree/.ade/transcripts/session-claude-storage.log",
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
        const claudeProjectDir = path.join(os.homedir(), ".claude", "projects", "-tmp-worktree");
        const otherPath = path.join(claudeProjectDir, `${otherId}.jsonl`);
        const otherFirstLine = JSON.stringify({
          timestamp: "2026-04-15T21:31:00.000Z",
          type: "user",
          sessionId: otherId,
          cwd: "/tmp/worktree",
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
          transcriptPath: "/tmp/worktree/.ade/transcripts/session-claude-targetless.log",
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
        const claudeProjectDir = path.join(os.homedir(), ".claude", "projects", "-tmp-worktree");
        const firstPath = path.join(claudeProjectDir, `${firstId}.jsonl`);
        const secondPath = path.join(claudeProjectDir, `${secondId}.jsonl`);
        const firstLine = JSON.stringify({
          timestamp: "2026-04-15T21:30:00.500Z",
          type: "user",
          sessionId: firstId,
          cwd: "/tmp/worktree",
        });
        const secondLine = JSON.stringify({
          timestamp: "2026-04-15T21:30:01.000Z",
          type: "user",
          sessionId: secondId,
          cwd: "/tmp/worktree",
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
          transcriptPath: "/tmp/worktree/.ade/transcripts/session-claude-ambiguous.log",
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
          transcriptPath: "/tmp/worktree/.ade/transcripts/session-missing.log",
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
            directory: "/tmp/worktree",
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
        transcriptPath: "/tmp/worktree/.ade/transcripts/session-opencode.log",
        toolType: "opencode",
      });

      await service.ensureResumeTargets(["session-opencode"]);

      expect(mocks.spawnSync).toHaveBeenCalledWith(
        bundledOpenCode,
        ["session", "list", "--format", "json", "--max-count", "80"],
        expect.objectContaining({
          cwd: "/tmp/worktree",
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
            directory: "/tmp/worktree",
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
        transcriptPath: "/tmp/worktree/.ade/transcripts/session-opencode-false-match.log",
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
        const projectDir = path.join(droidSessionsDir, "-tmp-worktree");
        const filePath = path.join(projectDir, "droid-session.jsonl");
        const firstLine = JSON.stringify({
          type: "session_start",
          id: "droid_false_match",
          cwd: "/tmp/worktree",
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
          transcriptPath: "/tmp/worktree/.ade/transcripts/session-droid-false-match.log",
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
          "-tmp-worktree",
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
          transcriptPath: "/tmp/worktree/.ade/transcripts/session-claude-existing.log",
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

      service.signalTerminal({ chatSessionId: "chat-signal", signal: "SIGTERM" });
      expect(mockPty.kill).toHaveBeenCalledWith("SIGTERM");
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
