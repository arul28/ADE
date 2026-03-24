import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IPty } from "node-pty";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const existsSyncResults = new Map<string, boolean>();
  return {
    existsSyncResults,
    mkdirSync: vi.fn(),
    existsSync: vi.fn((p: string) => existsSyncResults.get(p) ?? true),
    statSync: vi.fn(() => ({ size: 0 })),
    createWriteStream: vi.fn(() => ({
      write: vi.fn(),
      end: vi.fn(),
    })),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
    randomUUID: vi.fn(() => "uuid-" + Math.random().toString(36).slice(2, 10)),
    runGit: vi.fn(async () => ({ exitCode: 0, stdout: "abc123\n", stderr: "" })),
    resolveAdeLayout: vi.fn((root: string) => ({
      mcpConfigsDir: `${root}/.ade/mcp-configs`,
    })),
    buildCodexMcpConfigFlags: vi.fn(() => []),
    resolveAdeMcpServerLaunch: vi.fn(() => ({
      command: "npx",
      cmdArgs: ["tsx", "index.ts"],
      env: {},
    })),
    resolveUnifiedRuntimeRoot: vi.fn(() => "/tmp/ade-runtime"),
    shellEscapeArg: vi.fn((v: string) => `'${v}'`),
    stripAnsi: vi.fn((t: string) => t),
    summarizeTerminalSession: vi.fn(() => "test summary"),
    derivePreviewFromChunk: vi.fn(() => ({ nextLine: "", preview: "preview" })),
    defaultResumeCommandForTool: vi.fn(() => null),
    extractResumeCommandFromOutput: vi.fn(() => null),
    runtimeStateFromOsc133Chunk: vi.fn(() => "running"),
  };
});

vi.mock("node:fs", () => ({
  default: {
    existsSync: mocks.existsSync,
    mkdirSync: mocks.mkdirSync,
    statSync: mocks.statSync,
    createWriteStream: mocks.createWriteStream,
    unlinkSync: mocks.unlinkSync,
    writeFileSync: mocks.writeFileSync,
  },
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  statSync: mocks.statSync,
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

vi.mock("../../../shared/adeLayout", () => ({
  resolveAdeLayout: mocks.resolveAdeLayout,
}));

vi.mock("../orchestrator/unifiedOrchestratorAdapter", () => ({
  buildCodexMcpConfigFlags: mocks.buildCodexMcpConfigFlags,
  resolveAdeMcpServerLaunch: mocks.resolveAdeMcpServerLaunch,
  resolveUnifiedRuntimeRoot: mocks.resolveUnifiedRuntimeRoot,
}));

vi.mock("../orchestrator/baseOrchestratorAdapter", () => ({
  shellEscapeArg: mocks.shellEscapeArg,
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

vi.mock("../../utils/terminalSessionSignals", () => ({
  defaultResumeCommandForTool: mocks.defaultResumeCommandForTool,
  extractResumeCommandFromOutput: mocks.extractResumeCommandFromOutput,
  runtimeStateFromOsc133Chunk: mocks.runtimeStateFromOsc133Chunk,
}));

import { createPtyService } from "./ptyService";

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

function createHarness() {
  const mockPty = createMockPty();
  const broadcastData = vi.fn();
  const broadcastExit = vi.fn();
  const onSessionEnded = vi.fn();
  const onSessionRuntimeSignal = vi.fn();

  const sessionStore = new Map<string, any>();
  const sessionService = {
    create: vi.fn((args: any) => { sessionStore.set(args.sessionId, { ...args, status: "running" }); }),
    end: vi.fn((args: any) => {
      const s = sessionStore.get(args.sessionId);
      if (s) { s.status = args.status; s.exitCode = args.exitCode; }
    }),
    get: vi.fn((id: string) => sessionStore.get(id) ?? null),
    setSummary: vi.fn(),
    setLastOutputPreview: vi.fn(),
    setResumeCommand: vi.fn(),
    setHeadShaStart: vi.fn(),
    setHeadShaEnd: vi.fn(),
    updateMeta: vi.fn(),
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSyncResults.clear();
    mocks.existsSyncResults.set("/tmp/test-worktree", true);
    let counter = 0;
    mocks.randomUUID.mockImplementation(() => `uuid-${++counter}`);
    mocks.runtimeStateFromOsc133Chunk.mockReturnValue("running");
    mocks.defaultResumeCommandForTool.mockReturnValue(null);
    mocks.extractResumeCommandFromOutput.mockReturnValue(null);
    mocks.derivePreviewFromChunk.mockReturnValue({ nextLine: "", preview: "preview" });
  });

  describe("create", () => {
    it("creates a PTY and returns ptyId and sessionId", async () => {
      const { service } = createHarness();
      const result = await service.create({
        laneId: "lane-1",
        title: "Test terminal",
        cols: 80,
        rows: 24,
      });
      expect(result.ptyId).toBe("uuid-1");
      expect(result.sessionId).toBe("uuid-2");
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

    it("uses projectRoot as fallback cwd when worktree does not exist", async () => {
      mocks.existsSyncResults.set("/tmp/test-worktree", false);
      const { service, logger, loadPty } = createHarness();
      await service.create({
        laneId: "lane-1",
        title: "Fallback cwd",
        cols: 80,
        rows: 24,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "pty.cwd_missing_fallback",
        expect.objectContaining({ fallbackCwd: "/tmp/test-project" }),
      );
      const spawnCall = loadPty.mock.results[0].value.spawn;
      expect(spawnCall).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: "/tmp/test-project" }),
      );
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
      expect(broadcastData).toHaveBeenCalledWith({ ptyId, sessionId, data: "hello world" });
    });

    it("closes entry and broadcasts exit when PTY exits", async () => {
      const { service, mockPty, broadcastExit, sessionService } = createHarness();
      const { ptyId, sessionId } = await service.create({ laneId: "lane-1", title: "t", cols: 80, rows: 24 });
      mockPty._emitter.emit("exit", { exitCode: 0 });
      expect(broadcastExit).toHaveBeenCalledWith({ ptyId, sessionId, exitCode: 0 });
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
