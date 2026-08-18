import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeSubprocessReaper, parseEtimeSeconds } from "./claudeSubprocessReaper";

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

/**
 * `etime` is the only start-time column macOS and Linux `ps` format the same
 * way, and it now gates a destructive group kill: misreading it as "younger
 * than the record" refuses a real orphan, misreading it the other way accepts a
 * recycled pid.
 */
describe("parseEtimeSeconds", () => {
  it.each([
    ["05:23", 323],
    ["1:05:23", 3_923],
    ["10-12:10:58", 907_858],
    ["00:00", 0],
    ["119:59:59", 431_999],
    [" 03:07 ", 187],
  ])("parses %s", (raw, expected) => {
    expect(parseEtimeSeconds(raw as string)).toBe(expected);
  });

  it.each(["", "garbage", "12", "1:2:3:4", "-05:23"])("refuses %s", (raw) => {
    expect(parseEtimeSeconds(raw)).toBeNull();
  });
});

// These cover the POSIX signal path, which is why each reaper is pinned to
// "darwin": on Windows there are no signals, and the reaper kills the whole
// process tree with taskkill instead.
describe("createClaudeSubprocessReaper", () => {
  it("registers and unregisters Claude subprocesses on exit", () => {
    const logger = createLogger();
    const reaper = createClaudeSubprocessReaper({ logger, platform: "darwin" });
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
      platform: "darwin",
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
      // POSIX only: the child has to lead its own process group or the reaper
      // can never reach its MCP servers.
      detached: true,
    }));
    expect(reaper.liveRecords()).toEqual([
      expect.objectContaining({
        pid: 5678,
        sessionId: "chat-2",
        laneId: "lane-2",
      }),
    ]);
  });

  it("signals the whole process group for a child ADE spawned detached", () => {
    // A Claude SDK process owns 2-4 MCP servers, each with children. Signalling
    // the single pid leaves all of them running and holding their memory, and a
    // later SIGKILL of the leader orphans them permanently. This is the POSIX
    // half of the tree kill Windows already gets from `taskkill /T /F`.
    vi.useFakeTimers();
    const logger = createLogger();
    const child = createProcess(7001);
    const processKill = vi.fn(() => true);
    const reaper = createClaudeSubprocessReaper({
      logger,
      platform: "darwin",
      killGraceMs: 25,
      processKill,
      spawnProcess: (() => child) as any,
      registryPath: null,
    });

    reaper.spawnClaudeCodeProcess({
      command: "/bin/claude",
      args: [],
      cwd: "/tmp/lane",
      env: {},
      signal: new AbortController().signal,
    }, { sessionId: "chat-group", sdkSessionId: null, laneId: "lane-1", cwd: "/tmp/lane" });

    reaper.reapForSession("chat-group", "ended_session");
    expect(processKill).toHaveBeenCalledWith(-7001, "SIGTERM");
    // The group signal succeeded, so the leader is not signalled a second time.
    expect(child.killedWith).toEqual([]);

    vi.advanceTimersByTime(25);
    expect(processKill).toHaveBeenCalledWith(-7001, "SIGKILL");
  });

  it("falls back to the child and then the bare pid when the group signal fails", () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const child = createProcess(7002);
    const processKill = vi.fn((pid: number) => {
      if (pid < 0) throw new Error("ESRCH");
      return true;
    });
    const reaper = createClaudeSubprocessReaper({
      logger,
      platform: "darwin",
      killGraceMs: 25,
      processKill,
      spawnProcess: (() => child) as any,
      registryPath: null,
    });
    reaper.spawnClaudeCodeProcess({
      command: "/bin/claude",
      args: [],
      cwd: "/tmp/lane",
      env: {},
      signal: new AbortController().signal,
    }, { sessionId: "chat-fallback", sdkSessionId: null, laneId: "lane-1", cwd: "/tmp/lane" });

    reaper.reapForSession("chat-fallback", "ended_session");
    expect(child.killedWith).toEqual(["SIGTERM"]);
  });

  it("signals the group for a stale registry record that ps reports as a group leader", () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-reaper-pgid-"));
    const registryPath = path.join(dir, "registry.json");
    fs.writeFileSync(registryPath, JSON.stringify([
      {
        pid: 4321,
        ownerPid: 999_002,
        sessionId: "chat-orphan-group",
        laneId: "lane-orphan",
        cwd: "/tmp/lane",
        command: "claude",
        args: [],
        createdAt: new Date().toISOString(),
      },
    ]));
    const alive = new Set([4321]);
    const processKill = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) {
        if (!alive.has(pid)) throw new Error("missing");
        return true;
      }
      return true;
    });

    createClaudeSubprocessReaper({
      logger,
      platform: "darwin",
      killGraceMs: 25,
      registryPath,
      processKill,
      // No live handle exists for a stale record, so `ps` is the only way to
      // learn both that the pid is still ours and that it leads a group.
      readProcessInfo: () => ({ pgid: 4321, elapsedSeconds: 120, command: "/bin/claude --model sonnet" }),
    });

    expect(processKill).toHaveBeenCalledWith(-4321, "SIGTERM");
  });

  it("refuses a stale registry pid that ps says is somebody else's process", () => {
    const logger = createLogger();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-reaper-reuse-"));
    const registryPath = path.join(dir, "registry.json");
    fs.writeFileSync(registryPath, JSON.stringify([
      {
        pid: 4322,
        ownerPid: 999_003,
        sessionId: "chat-reused",
        laneId: "lane-orphan",
        cwd: "/tmp/lane",
        command: "claude",
        args: [],
        createdAt: new Date().toISOString(),
      },
    ]));
    const alive = new Set([4322]);
    const processKill = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      // The owning ADE process is gone; only the orphaned pid answers.
      if (signal === 0 && !alive.has(pid)) throw new Error("missing");
      return true;
    });

    createClaudeSubprocessReaper({
      logger,
      platform: "darwin",
      registryPath,
      processKill,
      readProcessInfo: () => ({ pgid: 4322, elapsedSeconds: 120, command: "/usr/bin/postgres -D /var/db" }),
    });

    expect(processKill).not.toHaveBeenCalledWith(4322, "SIGTERM");
    expect(processKill).not.toHaveBeenCalledWith(-4322, "SIGTERM");
    expect(logger.warn).toHaveBeenCalledWith(
      "agent_chat.claude_subprocess_pid_reused",
      expect.objectContaining({ pid: 4322 }),
    );
  });

  it("never signals its own pid, even when the record matches perfectly", () => {
    // `reapStaleRegistry` skips records whose OWNER is us, never records whose
    // subject pid is. After a crash-and-fast-restart the OS can hand our own new
    // pid to a seconds-old record — and we spawn detached, so we would look like
    // a matching group leader and force-kill our own process group.
    const logger = createLogger();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-reaper-self-"));
    const registryPath = path.join(dir, "registry.json");
    fs.writeFileSync(registryPath, JSON.stringify([
      {
        pid: process.pid,
        ownerPid: 999_006,
        sessionId: "chat-self",
        laneId: "lane-orphan",
        cwd: "/tmp/lane",
        command: "claude",
        args: [],
        createdAt: new Date().toISOString(),
      },
    ]));
    const processKill = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && pid === 999_006) throw new Error("missing");
      return true;
    });

    createClaudeSubprocessReaper({
      logger,
      platform: "darwin",
      registryPath,
      processKill,
      readProcessInfo: () => ({ pgid: process.pid, elapsedSeconds: 5, command: "/bin/claude" }),
    });

    expect(processKill).not.toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(processKill).not.toHaveBeenCalledWith(-process.pid, "SIGTERM");
  });

  it("refuses a stale registry pid whose only match is an interpreter name", () => {
    // The SDK spawns `node <cli.js>` whenever the Claude CLI is not directly
    // spawnable, so the recorded command is often the interpreter. Accepting on
    // `node` means every node process on the machine looks like us.
    const logger = createLogger();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-reaper-generic-"));
    const registryPath = path.join(dir, "registry.json");
    fs.writeFileSync(registryPath, JSON.stringify([
      {
        pid: 4325,
        ownerPid: 999_007,
        sessionId: "chat-generic",
        laneId: "lane-orphan",
        cwd: "/tmp/lane",
        command: "/usr/local/bin/node",
        args: ["--enable-source-maps"],
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    ]));
    const alive = new Set([4325]);
    const processKill = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && !alive.has(pid)) throw new Error("missing");
      return true;
    });

    createClaudeSubprocessReaper({
      logger,
      platform: "darwin",
      registryPath,
      processKill,
      readProcessInfo: () => ({ pgid: 4325, elapsedSeconds: 7_200, command: "/usr/local/bin/node /srv/unrelated/server.js" }),
    });

    expect(processKill).not.toHaveBeenCalledWith(4325, "SIGTERM");
    expect(processKill).not.toHaveBeenCalledWith(-4325, "SIGTERM");
    expect(logger.warn).toHaveBeenCalledWith(
      "agent_chat.claude_subprocess_pid_reused",
      expect.objectContaining({ pid: 4325 }),
    );
  });

  it("refuses to signal its own pid on Windows too", () => {
    // The guard sits before the platform split on purpose: `taskkill /T /F` on
    // our own pid takes down ADE's whole tree, which is worse than the POSIX
    // group kill it also prevents.
    const logger = createLogger();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-reaper-self-win-"));
    const registryPath = path.join(dir, "registry.json");
    fs.writeFileSync(registryPath, JSON.stringify([
      {
        pid: process.pid,
        ownerPid: 999_008,
        sessionId: "chat-self-win",
        laneId: "lane-orphan",
        cwd: "C:\\lane",
        command: "claude.exe",
        args: [],
        createdAt: new Date().toISOString(),
      },
    ]));
    const processKill = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && pid === 999_008) throw new Error("missing");
      return true;
    });

    createClaudeSubprocessReaper({
      logger,
      platform: "win32",
      registryPath,
      processKill,
    });

    expect(logger.warn).not.toHaveBeenCalledWith(
      "agent_chat.claude_subprocess_terminate",
      expect.objectContaining({ pid: process.pid }),
    );
    expect(JSON.parse(fs.readFileSync(registryPath, "utf8"))).toEqual([]);
  });

  it("refuses a stale registry pid that started AFTER the record was written", () => {
    // The command line can match by coincidence — the user's own `claude` CLI
    // is the likeliest collider on an ADE machine — so identity also has to
    // account for time. A pid younger than its record was handed out after we
    // wrote the record down and cannot be the process it describes.
    const logger = createLogger();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-reaper-age-"));
    const registryPath = path.join(dir, "registry.json");
    fs.writeFileSync(registryPath, JSON.stringify([
      {
        pid: 4323,
        ownerPid: 999_004,
        sessionId: "chat-recycled",
        laneId: "lane-orphan",
        cwd: "/tmp/lane",
        command: "claude",
        args: [],
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    ]));
    const alive = new Set([4323]);
    const processKill = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && !alive.has(pid)) throw new Error("missing");
      return true;
    });

    createClaudeSubprocessReaper({
      logger,
      platform: "darwin",
      registryPath,
      processKill,
      // Looks exactly like us by argv, but has only been alive 30 seconds
      // against an hour-old record.
      readProcessInfo: () => ({ pgid: 4323, elapsedSeconds: 30, command: "/bin/claude --model sonnet" }),
    });

    expect(processKill).not.toHaveBeenCalledWith(4323, "SIGTERM");
    expect(processKill).not.toHaveBeenCalledWith(-4323, "SIGTERM");
    expect(logger.warn).toHaveBeenCalledWith(
      "agent_chat.claude_subprocess_pid_reused",
      expect.objectContaining({ pid: 4323 }),
    );
  });

  it("re-checks identity before escalating a stale registry pid to SIGKILL", () => {
    // The pid can be recycled inside the grace window — which is the exact
    // hazard the identity check exists for — so reusing the decision made
    // `killGraceMs` ago would aim a forced GROUP kill at the new owner.
    vi.useFakeTimers();
    const logger = createLogger();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-reaper-escalate-"));
    const registryPath = path.join(dir, "registry.json");
    fs.writeFileSync(registryPath, JSON.stringify([
      {
        pid: 4324,
        ownerPid: 999_005,
        sessionId: "chat-escalate",
        laneId: "lane-orphan",
        cwd: "/tmp/lane",
        command: "claude",
        args: [],
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    ]));
    const alive = new Set([4324]);
    const processKill = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && !alive.has(pid)) throw new Error("missing");
      return true;
    });
    let probes = 0;
    createClaudeSubprocessReaper({
      logger,
      platform: "darwin",
      killGraceMs: 25,
      registryPath,
      processKill,
      readProcessInfo: () => {
        probes += 1;
        return probes === 1
          ? { pgid: 4324, elapsedSeconds: 4_000, command: "/bin/claude --model sonnet" }
          // Recycled during the grace window: same pid, brand new process.
          : { pgid: 4324, elapsedSeconds: 1, command: "/usr/bin/postgres -D /var/db" };
      },
    });

    expect(processKill).toHaveBeenCalledWith(-4324, "SIGTERM");
    vi.advanceTimersByTime(25);
    expect(processKill).not.toHaveBeenCalledWith(-4324, "SIGKILL");
    expect(processKill).not.toHaveBeenCalledWith(4324, "SIGKILL");
  });

  it("does not detach on Windows, and kills the tree with taskkill on both signals", () => {
    // `detached` on Windows means "own console window", which is both wrong and
    // unnecessary: `taskkill /T /F` walks the tree by parent link. The
    // escalation has to walk it too — a bare SIGKILL on the leader is what
    // turns a surviving tree into a permanently orphaned one.
    vi.useFakeTimers();
    const logger = createLogger();
    const child = createProcess(7100);
    const spawnProcess = vi.fn(() => child);
    const reaper = createClaudeSubprocessReaper({
      logger,
      platform: "win32",
      killGraceMs: 25,
      spawnProcess: spawnProcess as any,
      registryPath: null,
    });

    reaper.spawnClaudeCodeProcess({
      command: "C:\\Program Files\\claude\\claude.exe",
      args: [],
      cwd: "C:\\lane",
      env: {},
      signal: new AbortController().signal,
    }, { sessionId: "chat-win", sdkSessionId: null, laneId: "lane-1", cwd: "C:\\lane" });

    expect(spawnProcess).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      detached: false,
      windowsHide: true,
    }));

    reaper.reapForSession("chat-win", "ended_session");
    // Both the tree kill and the direct child signal run — taskkill's exit code
    // is not evidence the tree died, in either direction.
    expect(child.killedWith).toEqual(["SIGTERM"]);
    vi.advanceTimersByTime(25);
    expect(child.killedWith).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("terminates live subprocesses and escalates to SIGKILL after the grace period", () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const child = createProcess(2468);
    const reaper = createClaudeSubprocessReaper({
      logger,
      platform: "darwin",
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
      platform: "darwin",
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
    const reaper = createClaudeSubprocessReaper({ logger, platform: "darwin", killGraceMs: 25 });
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
      platform: "darwin",
      killGraceMs: 25,
      registryPath,
      processKill,
      // Not a group leader (a record written before ADE spawned detached), so
      // the reaper falls back to signalling the bare pid.
      readProcessInfo: () => ({ pgid: 999_001, elapsedSeconds: 120, command: "/bin/claude" }),
    });

    expect(processKill).toHaveBeenCalledWith(999_001, 0);
    expect(processKill).toHaveBeenCalledWith(3456, "SIGTERM");

    vi.advanceTimersByTime(25);

    expect(processKill).toHaveBeenCalledWith(3456, "SIGKILL");
    expect(JSON.parse(fs.readFileSync(registryPath, "utf8"))).toEqual([]);
  });
});
