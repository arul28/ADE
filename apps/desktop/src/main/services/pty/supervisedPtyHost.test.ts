import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { IWindowsPtyForkOptions } from "node-pty";
import { createSupervisedPtyLoader, type HostedPty } from "./supervisedPtyHost";

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  fork: mocks.fork,
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}));

type FakeChild = EventEmitter & {
  connected: boolean;
  killed: boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  sent: unknown[];
  emitMessage: (message: unknown) => void;
};

function createFakeChild({ emitExitOnKill = true }: { emitExitOnKill?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.connected = true;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.sent = [];
  child.send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
    child.sent.push(message);
    callback?.(null);
    return true;
  });
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.connected = false;
    if (emitExitOnKill) {
      child.emit("exit", 0, signal ?? null);
    }
    return true;
  });
  child.emitMessage = (message: unknown) => child.emit("message", message);
  return child;
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function spawnOptions(): IWindowsPtyForkOptions {
  return {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: "/tmp",
    env: {},
  };
}

describe("createSupervisedPtyLoader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks leaves queued mockReturnValueOnce implementations behind.
    // A shared host means some tests intentionally use fewer forks than before.
    mocks.fork.mockReset();
    vi.unstubAllEnvs();
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "", error: undefined });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("queues PTY operations until the host confirms spawn", async () => {
    const child = createFakeChild();
    mocks.fork.mockReturnValueOnce(child);
    const loader = createSupervisedPtyLoader({ logger: createLogger() as any });
    const pty = loader().spawn("/bin/zsh", ["-f"], spawnOptions()) as HostedPty;

    pty.write("echo queued\r");
    expect(child.sent).toHaveLength(1);

    const spawnRequest = child.sent[0] as { requestId: string; ptyId: string };
    child.emitMessage({
      type: "spawned",
      requestId: spawnRequest.requestId,
      ptyId: spawnRequest.ptyId,
      pid: 123,
      process: "/bin/zsh",
      cols: 80,
      rows: 24,
    });
    await pty.__adePtyHostReady;

    expect(child.sent).toEqual([
      expect.objectContaining({ type: "spawn" }),
      expect.objectContaining({ type: "write", data: "echo queued\r" }),
    ]);
  });

  it("can launch the worker through an internal ADE command instead of node fork", () => {
    const child = createFakeChild();
    mocks.spawn.mockReturnValueOnce(child);
    vi.stubEnv("ADE_PTY_HOST_WORKER_COMMAND", "/Users/example/.ade/bin/ade");
    vi.stubEnv("ADE_PTY_HOST_WORKER_NODE", "");
    const loader = createSupervisedPtyLoader({ logger: createLogger() as any });

    loader().spawn("/bin/zsh", [], spawnOptions());

    expect(mocks.spawn).toHaveBeenCalledWith(
      "/Users/example/.ade/bin/ade",
      ["__ade-pty-host-worker"],
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: expect.objectContaining({
          ADE_PTY_HOST: "1",
        }),
      }),
    );
    expect(mocks.fork).not.toHaveBeenCalled();
    expect(child.sent[0]).toEqual(expect.objectContaining({
      type: "spawn",
      command: "/bin/zsh",
    }));
  });

  it("converts host process exit into PTY exits and restarts on the next spawn", async () => {
    const child1 = createFakeChild();
    const child2 = createFakeChild();
    mocks.fork.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const logger = createLogger();
    const loader = createSupervisedPtyLoader({ logger: logger as any });
    const pty = loader().spawn("/bin/zsh", [], spawnOptions()) as HostedPty;
    const exits: Array<{ exitCode: number; signal?: number }> = [];
    pty.onExit((event) => exits.push(event));

    const spawnRequest = child1.sent[0] as { requestId: string; ptyId: string };
    child1.emitMessage({
      type: "spawned",
      requestId: spawnRequest.requestId,
      ptyId: spawnRequest.ptyId,
      pid: 123,
      process: "/bin/zsh",
      cols: 80,
      rows: 24,
    });
    await pty.__adePtyHostReady;

    child1.connected = false;
    child1.emit("exit", 1, null);

    expect(exits).toEqual([{ exitCode: 1, signal: undefined }]);
    expect(logger.warn).toHaveBeenCalledWith("pty.host_exited", expect.objectContaining({
      code: 1,
      activePtys: 1,
    }));

    loader().spawn("/bin/bash", [], spawnOptions());
    expect(mocks.fork).toHaveBeenCalledTimes(2);
    expect(child2.sent[0]).toEqual(expect.objectContaining({
      type: "spawn",
      command: "/bin/bash",
    }));
  });

  it("isolates a host exit to its eight PTYs while the next host stays alive", async () => {
    const child1 = createFakeChild();
    const child2 = createFakeChild();
    mocks.fork.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const loader = createSupervisedPtyLoader({ logger: createLogger() as any });
    const ptys = Array.from({ length: 9 }, (_, index) =>
      loader().spawn(index === 8 ? "/bin/csh" : "/bin/zsh", [], spawnOptions()) as HostedPty);
    const exits = ptys.map(() => [] as Array<{ exitCode: number; signal?: number }>);
    ptys.forEach((pty, index) => pty.onExit((event) => exits[index]!.push(event)));
    const firstHostSpawns = child1.sent.filter((message) => (message as { type?: string }).type === "spawn") as Array<{
      requestId: string;
      ptyId: string;
    }>;
    const secondHostSpawn = child2.sent.find((message) => (message as { type?: string }).type === "spawn") as {
      requestId: string;
      ptyId: string;
    };

    for (const [index, spawnRequest] of firstHostSpawns.entries()) {
      child1.emitMessage({
        type: "spawned",
        requestId: spawnRequest.requestId,
        ptyId: spawnRequest.ptyId,
        pid: 123 + index,
        process: "/bin/zsh",
        cols: 80,
        rows: 24,
      });
    }
    child2.emitMessage({
      type: "spawned",
      requestId: secondHostSpawn.requestId,
      ptyId: secondHostSpawn.ptyId,
      pid: 456,
      process: "/bin/csh",
      cols: 80,
      rows: 24,
    });
    await Promise.all(ptys.map((pty) => pty.__adePtyHostReady));

    expect(mocks.fork).toHaveBeenCalledTimes(2);
    expect(firstHostSpawns).toHaveLength(8);
    expect(secondHostSpawn.ptyId).toBe(ptys[8]!.__adePtyHostId);

    child1.connected = false;
    child1.emit("exit", 1, null);
    ptys[8]!.write("still alive\r");

    expect(exits.slice(0, 8)).toEqual(Array.from({ length: 8 }, () => [{ exitCode: 1, signal: undefined }]));
    expect(exits[8]).toEqual([]);
    expect(child2.sent).toContainEqual(expect.objectContaining({
      type: "write",
      data: "still alive\r",
    }));
  });

  it("turns an async IPC send failure into an exit for only that PTY on a shared host", async () => {
    const child = createFakeChild();
    mocks.fork.mockReturnValueOnce(child);
    const loader = createSupervisedPtyLoader({ logger: createLogger() as any });
    const first = loader().spawn("/bin/zsh", [], spawnOptions()) as HostedPty;
    const second = loader().spawn("/bin/bash", [], spawnOptions()) as HostedPty;
    const firstExits: Array<{ exitCode: number; signal?: number }> = [];
    const secondExits: Array<{ exitCode: number; signal?: number }> = [];
    first.onExit((event) => firstExits.push(event));
    second.onExit((event) => secondExits.push(event));

    const spawnRequests = child.sent as Array<{ type?: string; requestId?: string; ptyId?: string }>;
    const firstSpawn = spawnRequests.find((message) => message.type === "spawn")!;
    const secondSpawn = spawnRequests.filter((message) => message.type === "spawn")[1]!;
    child.emitMessage({
      type: "spawned",
      requestId: firstSpawn.requestId,
      ptyId: firstSpawn.ptyId,
      pid: 123,
      process: "/bin/zsh",
      cols: 80,
      rows: 24,
    });
    child.emitMessage({
      type: "spawned",
      requestId: secondSpawn.requestId,
      ptyId: secondSpawn.ptyId,
      pid: 456,
      process: "/bin/bash",
      cols: 80,
      rows: 24,
    });
    await Promise.all([first.__adePtyHostReady, second.__adePtyHostReady]);

    child.send.mockImplementation((message: unknown, callback?: (error: Error | null) => void) => {
      child.sent.push(message);
      const ptyId = (message as { ptyId?: string }).ptyId;
      callback?.(ptyId === first.__adePtyHostId ? new Error("EPIPE") : null);
      return true;
    });
    first.write("lost\r");
    second.write("kept\r");

    expect(firstExits).toEqual([{ exitCode: 1, signal: undefined }]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(secondExits).toEqual([]);
    expect(child.sent).toContainEqual(expect.objectContaining({
      type: "write",
      ptyId: second.__adePtyHostId,
      data: "kept\r",
    }));
    expect(mocks.fork).toHaveBeenCalledTimes(1);
  });

  it("acknowledges PTY output in batches even when a data listener throws", async () => {
    const child = createFakeChild();
    mocks.fork.mockReturnValueOnce(child);
    const loader = createSupervisedPtyLoader({ logger: createLogger() as any });
    const pty = loader().spawn("/bin/zsh", [], spawnOptions()) as HostedPty;
    const spawnRequest = child.sent[0] as { requestId: string; ptyId: string };
    child.emitMessage({
      type: "spawned",
      requestId: spawnRequest.requestId,
      ptyId: spawnRequest.ptyId,
      pid: 123,
      process: "/bin/zsh",
      cols: 80,
      rows: 24,
    });
    await pty.__adePtyHostReady;
    const received: string[] = [];
    pty.onData((data) => {
      received.push(data);
      if (data.startsWith("throw:")) throw new Error("terminal data listener failed");
    });

    child.emitMessage({ type: "data", ptyId: pty.__adePtyHostId, data: "a".repeat(16 * 1024) });
    expect(child.sent.filter((message) => (message as { type?: string }).type === "ack")).toEqual([]);

    child.emitMessage({ type: "data", ptyId: pty.__adePtyHostId, data: "b".repeat(16 * 1024) });
    const acknowledgements = () => child.sent.filter((message) => (message as { type?: string }).type === "ack");
    expect(acknowledgements()).toEqual([expect.objectContaining({
      type: "ack",
      ptyId: pty.__adePtyHostId,
      chars: 32 * 1024,
    })]);

    child.emitMessage({ type: "data", ptyId: pty.__adePtyHostId, data: `throw:${"c".repeat(32 * 1024 - 6)}` });

    expect(received).toHaveLength(3);
    expect(acknowledgements()).toHaveLength(2);
    expect(acknowledgements()[1]).toEqual(expect.objectContaining({
      type: "ack",
      ptyId: pty.__adePtyHostId,
      chars: 32 * 1024,
    }));
    expect(received[2]).toMatch(/^throw:/);
  });

  it("stops an idle host after its PTY exits normally", async () => {
    const child = createFakeChild();
    mocks.fork.mockReturnValueOnce(child);
    const loader = createSupervisedPtyLoader({ logger: createLogger() as any });
    const pty = loader().spawn("/bin/zsh", [], spawnOptions()) as HostedPty;
    const spawnRequest = child.sent[0] as { requestId: string; ptyId: string };
    child.emitMessage({
      type: "spawned",
      requestId: spawnRequest.requestId,
      ptyId: spawnRequest.ptyId,
      pid: 123,
      process: "/bin/zsh",
      cols: 80,
      rows: 24,
    });
    await pty.__adePtyHostReady;

    child.emitMessage({
      type: "exit",
      ptyId: spawnRequest.ptyId,
      exitCode: 0,
      signal: null,
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("kills the recorded ConPTY tree when a Windows host worker crashes", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const child = createFakeChild({ emitExitOnKill: false });
      mocks.fork.mockReturnValueOnce(child);
      const loader = createSupervisedPtyLoader({ logger: createLogger() as any });
      const pty = loader().spawn("powershell.exe", [], spawnOptions()) as HostedPty;
      const spawnRequest = child.sent[0] as { requestId: string; ptyId: string };
      child.emitMessage({
        type: "spawned",
        requestId: spawnRequest.requestId,
        ptyId: spawnRequest.ptyId,
        pid: 789,
        process: "powershell.exe",
        cols: 80,
        rows: 24,
      });
      await pty.__adePtyHostReady;

      child.emit("exit", 1, null);

      expect(mocks.spawnSync).toHaveBeenCalledWith(
        "taskkill.exe",
        ["/PID", "789", "/T", "/F"],
        { windowsHide: true },
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("disposes a stuck PTY through its shared host without stopping its sibling", async () => {
    vi.useFakeTimers();
    const child = createFakeChild({ emitExitOnKill: false });
    mocks.fork.mockReturnValueOnce(child);
    const loader = createSupervisedPtyLoader({ logger: createLogger() as any });
    const stuck = loader().spawn("/bin/zsh", [], spawnOptions()) as HostedPty;
    const sibling = loader().spawn("/bin/bash", [], spawnOptions()) as HostedPty;
    const stuckExits: Array<{ exitCode: number; signal?: number }> = [];
    const siblingExits: Array<{ exitCode: number; signal?: number }> = [];
    stuck.onExit((event) => stuckExits.push(event));
    sibling.onExit((event) => siblingExits.push(event));
    for (const [index, spawnRequest] of (child.sent as Array<{ type?: string; requestId?: string; ptyId?: string }>)
      .filter((message) => message.type === "spawn" && message.requestId && message.ptyId)
      .entries()) {
      child.emitMessage({
        type: "spawned",
        requestId: spawnRequest.requestId,
        ptyId: spawnRequest.ptyId,
        pid: 123 + index,
        process: index === 0 ? "/bin/zsh" : "/bin/bash",
        cols: 80,
        rows: 24,
      });
    }
    await Promise.all([stuck.__adePtyHostReady, sibling.__adePtyHostReady]);

    stuck.kill("SIGTERM");
    expect(child.sent).toContainEqual(expect.objectContaining({
      type: "kill",
      ptyId: stuck.__adePtyHostId,
      signal: "SIGTERM",
    }));
    expect(stuckExits).toEqual([]);
    expect(siblingExits).toEqual([]);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(child.sent).toContainEqual(expect.objectContaining({
      type: "dispose",
      ptyId: stuck.__adePtyHostId,
      signal: "SIGKILL",
    }));
    expect(child.kill).not.toHaveBeenCalled();
    expect(stuckExits).toEqual([{ exitCode: 1, signal: undefined }]);
    expect(siblingExits).toEqual([]);

    sibling.write("still running\r");
    expect(child.sent).toContainEqual(expect.objectContaining({
      type: "write",
      ptyId: sibling.__adePtyHostId,
      data: "still running\r",
    }));
  });

  it("rejects an in-flight spawn when the supervised backend is disposed", async () => {
    const child = createFakeChild({ emitExitOnKill: false });
    mocks.fork.mockReturnValueOnce(child);
    const loader = createSupervisedPtyLoader({ logger: createLogger() as any });
    const pty = loader().spawn("/bin/zsh", [], spawnOptions()) as HostedPty;

    const ready = pty.__adePtyHostReady.catch((error: unknown) => error);
    loader.dispose();

    await expect(ready).resolves.toEqual(expect.objectContaining({
      message: expect.stringContaining("disposed before terminal spawn completed"),
    }));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("times out an in-flight spawn when the worker never answers", async () => {
    vi.useFakeTimers();
    const child = createFakeChild({ emitExitOnKill: false });
    mocks.fork.mockReturnValueOnce(child);
    const logger = createLogger();
    const loader = createSupervisedPtyLoader({ logger: logger as any });
    const pty = loader().spawn("/bin/zsh", [], spawnOptions()) as HostedPty;
    const ready = pty.__adePtyHostReady.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(ready).resolves.toEqual(expect.objectContaining({
      message: expect.stringContaining("spawn timed out"),
    }));
    expect(child.sent).toContainEqual(expect.objectContaining({
      type: "dispose",
      ptyId: (child.sent[0] as { ptyId: string }).ptyId,
      signal: "SIGKILL",
    }));
    expect(child.kill).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("pty.host_spawn_timeout", expect.objectContaining({
      ptyId: expect.any(String),
    }));

    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("gives no new PTY to a shared host that missed a spawn deadline", async () => {
    vi.useFakeTimers();
    const stuckHost = createFakeChild({ emitExitOnKill: false });
    const freshHost = createFakeChild();
    mocks.fork.mockReturnValueOnce(stuckHost).mockReturnValueOnce(freshHost);
    const loader = createSupervisedPtyLoader({ logger: createLogger() as any });
    const sibling = loader().spawn("/bin/zsh", [], spawnOptions()) as HostedPty;
    const siblingSpawn = stuckHost.sent[0] as { requestId: string; ptyId: string };
    stuckHost.emitMessage({
      type: "spawned",
      requestId: siblingSpawn.requestId,
      ptyId: siblingSpawn.ptyId,
      pid: 123,
      process: "/bin/zsh",
      cols: 80,
      rows: 24,
    });
    await sibling.__adePtyHostReady;
    const late = loader().spawn("/bin/bash", [], spawnOptions()) as HostedPty;
    const lateReady = late.__adePtyHostReady.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(lateReady).resolves.toEqual(expect.objectContaining({
      message: expect.stringContaining("spawn timed out"),
    }));

    const next = loader().spawn("/bin/sh", [], spawnOptions()) as HostedPty;
    expect(mocks.fork).toHaveBeenCalledTimes(2);
    expect(freshHost.sent[0]).toEqual(expect.objectContaining({ type: "spawn", ptyId: next.__adePtyHostId }));
    expect(stuckHost.sent.filter((message) => (message as { type?: string }).type === "spawn")).toHaveLength(2);
    expect(stuckHost.kill).not.toHaveBeenCalled();
  });
});
