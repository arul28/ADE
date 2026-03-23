import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPtyService } from "./ptyService";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createSessionServiceMock() {
  return {
    create: vi.fn(),
    end: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    setHeadShaStart: vi.fn(),
    setHeadShaEnd: vi.fn(),
    setLastOutputPreview: vi.fn(),
    setSummary: vi.fn(),
    setResumeCommand: vi.fn(),
    updateMeta: vi.fn(),
    readTranscriptTail: vi.fn().mockResolvedValue(""),
  };
}

function createLaneServiceMock(worktreePath: string) {
  return {
    getLaneBaseAndBranch: vi.fn().mockReturnValue({ worktreePath }),
  };
}

function createServiceFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pty-"));
  const worktreePath = path.join(projectRoot, "worktree");
  const transcriptsDir = path.join(projectRoot, "transcripts");
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const logger = createLogger();
  const sessionService = createSessionServiceMock();
  const laneService = createLaneServiceMock(worktreePath);
  const broadcastData = vi.fn();
  const broadcastExit = vi.fn();

  const service = createPtyService({
    projectRoot,
    transcriptsDir,
    laneService: laneService as any,
    sessionService: sessionService as any,
    logger,
    broadcastData,
    broadcastExit,
    loadPty: () => {
      throw new Error("loadPty should be overridden in each test");
    },
  });

  return {
    projectRoot,
    worktreePath,
    transcriptsDir,
    logger,
    sessionService,
    laneService,
    broadcastData,
    broadcastExit,
    service,
  };
}

function createFakePty() {
  return {
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubEnv("SHELL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createPtyService", () => {
  it("ends the session when node-pty fails to load", async () => {
    const fixture = createServiceFixture();
    const service = createPtyService({
      projectRoot: fixture.projectRoot,
      transcriptsDir: fixture.transcriptsDir,
      laneService: fixture.laneService as any,
      sessionService: fixture.sessionService as any,
      logger: fixture.logger,
      broadcastData: fixture.broadcastData,
      broadcastExit: fixture.broadcastExit,
      loadPty: () => {
        throw new Error("node-pty missing");
      },
    });

    await expect(service.create({
      laneId: "lane-1",
      cols: 80,
      rows: 24,
      title: "Shell",
      tracked: false,
    })).rejects.toThrow("node-pty missing");

    expect(fixture.sessionService.create).toHaveBeenCalledTimes(1);
    expect(fixture.sessionService.end).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      exitCode: null,
    }));
    expect(fixture.broadcastExit).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: null,
    }));
    expect(fixture.logger.error).toHaveBeenCalledWith(
      "pty.spawn_failed",
      expect.objectContaining({
        err: expect.stringContaining("node-pty missing"),
      }),
    );
  });

  it("retries shell candidates and fails cleanly when every spawn attempt throws", async () => {
    const fixture = createServiceFixture();
    const spawn = vi.fn((shell: string) => {
      throw new Error(`spawn failed for ${shell}`);
    });
    const service = createPtyService({
      projectRoot: fixture.projectRoot,
      transcriptsDir: fixture.transcriptsDir,
      laneService: fixture.laneService as any,
      sessionService: fixture.sessionService as any,
      logger: fixture.logger,
      broadcastData: fixture.broadcastData,
      broadcastExit: fixture.broadcastExit,
      loadPty: () => ({ spawn } as any),
    });

    await expect(service.create({
      laneId: "lane-1",
      cols: 80,
      rows: 24,
      title: "Shell",
      tracked: false,
    })).rejects.toThrow("spawn failed for /bin/sh");

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn.mock.calls.map(([shell]) => shell)).toEqual([
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
    ]);
    expect(fixture.logger.warn).toHaveBeenNthCalledWith(
      1,
      "pty.spawn_retry",
      expect.objectContaining({ shell: "/bin/zsh" }),
    );
    expect(fixture.logger.warn).toHaveBeenNthCalledWith(
      2,
      "pty.spawn_retry",
      expect.objectContaining({ shell: "/bin/bash" }),
    );
    expect(fixture.logger.warn).toHaveBeenNthCalledWith(
      3,
      "pty.spawn_retry",
      expect.objectContaining({ shell: "/bin/sh" }),
    );
    expect(fixture.logger.error).toHaveBeenCalledWith(
      "pty.spawn_failed",
      expect.objectContaining({
        err: expect.stringContaining("spawn failed for /bin/sh"),
      }),
    );
    expect(fixture.sessionService.end).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      exitCode: null,
    }));
    expect(fixture.broadcastExit).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: null,
    }));
  });

  it("logs startup command write failures without tearing down the session", async () => {
    const fixture = createServiceFixture();
    const fakePty = createFakePty();
    fakePty.write.mockImplementation(() => {
      throw new Error("startup write failed");
    });
    const spawn = vi.fn().mockReturnValue(fakePty);
    const service = createPtyService({
      projectRoot: fixture.projectRoot,
      transcriptsDir: fixture.transcriptsDir,
      laneService: fixture.laneService as any,
      sessionService: fixture.sessionService as any,
      logger: fixture.logger,
      broadcastData: fixture.broadcastData,
      broadcastExit: fixture.broadcastExit,
      loadPty: () => ({ spawn } as any),
    });

    const result = await service.create({
      laneId: "lane-1",
      cols: 80,
      rows: 24,
      title: "Shell",
      tracked: false,
      startupCommand: "echo hello",
    });

    expect(result).toEqual(expect.objectContaining({
      ptyId: expect.any(String),
      sessionId: expect.any(String),
    }));
    expect(fakePty.write).toHaveBeenCalledWith("echo hello\r");
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      "pty.startup_command_failed",
      expect.objectContaining({
        err: expect.stringContaining("startup write failed"),
      }),
    );
    expect(fixture.sessionService.end).not.toHaveBeenCalled();
    expect(fixture.broadcastExit).not.toHaveBeenCalled();
  });
});
