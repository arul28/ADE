import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import type { IPty } from "node-pty";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const existsSyncResults = new Map<string, boolean>();
  const realpathOverrides = new Map<string, string>();
  const dirEntries = new Map<string, string[]>();
  const fileContents = new Map<string, string>();
  const fileStats = new Map<string, { size?: number; mtimeMs?: number; isDirectory?: boolean }>();
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
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
    randomUUID: vi.fn(() => "uuid-" + Math.random().toString(36).slice(2, 10)),
    runGit: vi.fn(async () => ({ exitCode: 0, stdout: "abc123\n", stderr: "" })),
    stripAnsi: vi.fn((t: string) => t),
    summarizeTerminalSession: vi.fn(() => "test summary"),
    derivePreviewFromChunk: vi.fn(() => ({ nextLine: "", preview: "preview" })),
    defaultResumeCommandForTool: vi.fn(() => null),
    extractResumeCommandFromOutput: vi.fn(() => null),
    parseTrackedCliLaunchConfig: vi.fn(() => null),
    runtimeStateFromOsc133Chunk: vi.fn(() => "running"),
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
    createWriteStream: mocks.createWriteStream,
    unlinkSync: mocks.unlinkSync,
    writeFileSync: mocks.writeFileSync,
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
  createWriteStream: mocks.createWriteStream,
  unlinkSync: mocks.unlinkSync,
  writeFileSync: mocks.writeFileSync,
}));

vi.mock("node:crypto", () => ({
  randomUUID: mocks.randomUUID,
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
  const actual = await vi.importActual<typeof import("../../utils/terminalSessionSignals")>(
    "../../utils/terminalSessionSignals",
  );
  return {
    ...actual,
    defaultResumeCommandForTool: mocks.defaultResumeCommandForTool,
    extractResumeCommandFromOutput: mocks.extractResumeCommandFromOutput,
    runtimeStateFromOsc133Chunk: mocks.runtimeStateFromOsc133Chunk,
  };
});

import { createPtyService, PTY_AI_TITLE_DEBOUNCE_MS, PTY_AI_TITLE_TIMEOUT_MS } from "./ptyService";

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
        env: { CUSTOM_FLAG: "1" },
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
          }),
        }),
      );
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
        '/d /s /c "npm.cmd" "run" "dev"',
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

    it("generates Claude CLI titles from the first submitted PTY write (user prompt) using the bound cwd", async () => {
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
          title: "Claude session",
          cols: 80,
          rows: 24,
          toolType: "claude",
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
        const filePath = path.join(dirPath, "rollout-2026-04-15T21-30-00-thread-storage.jsonl");
        const startedAt = "2026-04-15T21:30:00.000Z";
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

    it("derives state from fallback status for unknown sessions", () => {
      const { service } = createHarness();
      expect(service.getRuntimeState("unknown-session", "completed")).toBe("exited");
      expect(service.getRuntimeState("unknown-session", "failed")).toBe("exited");
      expect(service.getRuntimeState("unknown-session", "running")).toBe("running");
      expect(service.getRuntimeState("unknown-session", "disposed")).toBe("killed");
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

    it("falls back to status-derived state for unknown sessions", () => {
      const { service } = createHarness();
      const rows = [{ id: "unknown", status: "completed" as const }];
      const enriched = service.enrichSessions(rows as any);
      expect(enriched[0].runtimeState).toBe("exited");
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
      const { service, mockPty, broadcastData } = createHarness();
      const { ptyId, sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });
      mockPty._emitter.emit("data", "hello world");
      expect(broadcastData).toHaveBeenCalledWith({
        ptyId,
        sessionId,
        projectRoot: "/tmp/test-project",
        data: "hello world",
      });
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
  });

  describe("ensureResumeTargets", () => {
    it("calls sessionService.setResumeCommand for each session whose Codex JSONL matches", async () => {
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
});
