import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeSubprocessReaper } from "./claudeSubprocessReaper";

function createLogger() {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
  };
}

function createProcess(pid: number) {
  const emitter = new EventEmitter();
  const killedWith: string[] = [];
  const child = {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    kill: vi.fn((signal: NodeJS.Signals) => {
      killedWith.push(signal);
      if (signal === "SIGKILL") {
        child.killed = true;
      }
      return true;
    }),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    emitExit: () => {
      child.exitCode = 0;
      emitter.emit("exit", 0, null);
    },
    emitError: () => {
      emitter.emit("error", new Error("spawn failed"));
    },
    killedWith,
  };
  return child;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createClaudeSubprocessReaper", () => {
  it("registers and unregisters Claude subprocesses on exit", () => {
    const logger = createLogger();
    const reaper = createClaudeSubprocessReaper({ logger });
    const child = createProcess(1234);

    reaper.register(child, {
      sessionId: "chat-1",
      sdkSessionId: "sdk-1",
      laneId: "lane-1",
      cwd: "/tmp/lane",
    }, "claude", ["--output-format", "stream-json"]);

    expect(reaper.liveRecords()).toEqual([
      expect.objectContaining({
        pid: 1234,
        sessionId: "chat-1",
        sdkSessionId: "sdk-1",
        laneId: "lane-1",
        cwd: "/tmp/lane",
        command: "claude",
      }),
    ]);

    child.emitExit();

    expect(reaper.liveRecords()).toEqual([]);
    expect(logger.debug).toHaveBeenCalledWith("agent_chat.claude_subprocess_unregistered", expect.objectContaining({
      pid: 1234,
      reason: "exit",
    }));
  });

  it("spawns through the hook and records process metadata", () => {
    const logger = createLogger();
    const child = createProcess(5678);
    const spawnProcess = vi.fn(() => child);
    const reaper = createClaudeSubprocessReaper({
      logger,
      spawnProcess: spawnProcess as any,
    });

    const spawned = reaper.spawnClaudeCodeProcess({
      command: "/bin/claude",
      args: ["--model", "sonnet"],
      cwd: "/tmp/lane",
      env: { FOO: "bar" },
      signal: new AbortController().signal,
    }, {
      sessionId: "chat-2",
      sdkSessionId: null,
      laneId: "lane-2",
      cwd: "/tmp/lane",
    });

    expect(spawned).toBe(child);
    expect(spawnProcess).toHaveBeenCalledWith("/bin/claude", ["--model", "sonnet"], expect.objectContaining({
      cwd: "/tmp/lane",
      env: { FOO: "bar" },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }));
    expect(reaper.liveRecords()).toEqual([
      expect.objectContaining({
        pid: 5678,
        sessionId: "chat-2",
        laneId: "lane-2",
      }),
    ]);
  });

  it("terminates live subprocesses and escalates to SIGKILL after the grace period", () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const child = createProcess(2468);
    const reaper = createClaudeSubprocessReaper({
      logger,
      killGraceMs: 25,
    });
    reaper.register(child, {
      sessionId: "chat-3",
      laneId: "lane-3",
      cwd: "/tmp/lane",
    }, "claude", []);

    reaper.reapAll("shutdown");

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.killedWith).toEqual(["SIGTERM"]);

    vi.advanceTimersByTime(25);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.killedWith).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("reapForSession terminates only the matching session's live subprocesses", () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const matchingChild = createProcess(2469);
    const otherChild = createProcess(2470);
    const reaper = createClaudeSubprocessReaper({
      logger,
      killGraceMs: 25,
    });
    reaper.register(matchingChild, {
      sessionId: "chat-matching",
      laneId: "lane-1",
      cwd: "/tmp/lane-1",
    }, "claude", []);
    reaper.register(otherChild, {
      sessionId: "chat-other",
      laneId: "lane-2",
      cwd: "/tmp/lane-2",
    }, "claude", []);

    reaper.reapForSession("chat-matching", "ended_session");

    expect(matchingChild.killedWith).toEqual(["SIGTERM"]);
    expect(otherChild.killedWith).toEqual([]);
    expect(reaper.liveRecords().map((record) => record.sessionId)).toEqual([
      "chat-matching",
      "chat-other",
    ]);

    vi.advanceTimersByTime(25);

    expect(matchingChild.killedWith).toEqual(["SIGTERM", "SIGKILL"]);
    expect(otherChild.killedWith).toEqual([]);
  });

  it("escalates to SIGKILL for a hung child even though killed=true after SIGTERM", () => {
    // Node sets child.killed as soon as ANY signal is delivered — it does NOT
    // mean the process exited. A hung child must still get the escalation.
    vi.useFakeTimers();
    const logger = createLogger();
    const child = createProcess(9911);
    child.kill = vi.fn((signal: NodeJS.Signals) => {
      child.killedWith.push(signal);
      child.killed = true; // Node-faithful: true after the first delivered signal.
      return true;
    });
    const reaper = createClaudeSubprocessReaper({ logger, killGraceMs: 25 });
    reaper.register(child, {
      sessionId: "chat-hung",
      laneId: "lane-1",
      cwd: "/tmp/lane-1",
    }, "claude", []);

    reaper.reapForSession("chat-hung", "ended_session");
    expect(child.killedWith).toEqual(["SIGTERM"]);

    vi.advanceTimersByTime(25);
    expect(child.killedWith).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("reaps subprocesses left behind by a crashed ADE owner", () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-reaper-"));
    const registryPath = path.join(dir, "registry.json");
    fs.writeFileSync(registryPath, JSON.stringify([
      {
        pid: 3456,
        ownerPid: 999_001,
        sessionId: "chat-orphan",
        sdkSessionId: "sdk-orphan",
        laneId: "lane-orphan",
        cwd: "/tmp/lane",
        command: "claude",
        args: [],
        createdAt: new Date().toISOString(),
      },
    ]));
    const alive = new Set([3456]);
    const processKill = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) {
        if (!alive.has(pid)) throw new Error("missing");
        return true;
      }
      if (signal === "SIGKILL") alive.delete(pid);
      return true;
    });

    createClaudeSubprocessReaper({
      logger,
      killGraceMs: 25,
      registryPath,
      processKill,
    });

    expect(processKill).toHaveBeenCalledWith(999_001, 0);
    expect(processKill).toHaveBeenCalledWith(3456, "SIGTERM");

    vi.advanceTimersByTime(25);

    expect(processKill).toHaveBeenCalledWith(3456, "SIGKILL");
    expect(JSON.parse(fs.readFileSync(registryPath, "utf8"))).toEqual([]);
  });
});
