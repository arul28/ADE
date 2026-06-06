import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { IWindowsPtyForkOptions } from "node-pty";
import { createSupervisedPtyLoader, type HostedPty } from "./supervisedPtyHost";

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  fork: mocks.fork,
  spawn: mocks.spawn,
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
    vi.unstubAllEnvs();
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

  it("isolates PTY host exits to the affected terminal", async () => {
    const child1 = createFakeChild();
    const child2 = createFakeChild();
    mocks.fork.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const loader = createSupervisedPtyLoader({ logger: createLogger() as any });
    const first = loader().spawn("/bin/zsh", [], spawnOptions()) as HostedPty;
    const second = loader().spawn("/bin/bash", [], spawnOptions()) as HostedPty;
    const firstExits: Array<{ exitCode: number; signal?: number }> = [];
    const secondExits: Array<{ exitCode: number; signal?: number }> = [];
    first.onExit((event) => firstExits.push(event));
    second.onExit((event) => secondExits.push(event));

    const firstSpawn = child1.sent[0] as { requestId: string; ptyId: string };
    const secondSpawn = child2.sent[0] as { requestId: string; ptyId: string };
    child1.emitMessage({
      type: "spawned",
      requestId: firstSpawn.requestId,
      ptyId: firstSpawn.ptyId,
      pid: 123,
      process: "/bin/zsh",
      cols: 80,
      rows: 24,
    });
    child2.emitMessage({
      type: "spawned",
      requestId: secondSpawn.requestId,
      ptyId: secondSpawn.ptyId,
      pid: 456,
      process: "/bin/bash",
      cols: 80,
      rows: 24,
    });
    await Promise.all([first.__adePtyHostReady, second.__adePtyHostReady]);

    child1.connected = false;
    child1.emit("exit", 1, null);
    second.write("still alive\r");

    expect(firstExits).toEqual([{ exitCode: 1, signal: undefined }]);
    expect(secondExits).toEqual([]);
    expect(child2.sent).toContainEqual(expect.objectContaining({
      type: "write",
      data: "still alive\r",
    }));
  });

  it("turns async IPC send failures into exits for only the affected terminal", async () => {
    const child1 = createFakeChild();
    const child2 = createFakeChild();
    mocks.fork.mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const loader = createSupervisedPtyLoader({ logger: createLogger() as any });
    const first = loader().spawn("/bin/zsh", [], spawnOptions()) as HostedPty;
    const second = loader().spawn("/bin/bash", [], spawnOptions()) as HostedPty;
    const firstExits: Array<{ exitCode: number; signal?: number }> = [];
    const secondExits: Array<{ exitCode: number; signal?: number }> = [];
    first.onExit((event) => firstExits.push(event));
    second.onExit((event) => secondExits.push(event));

    const firstSpawn = child1.sent[0] as { requestId: string; ptyId: string };
    const secondSpawn = child2.sent[0] as { requestId: string; ptyId: string };
    child1.emitMessage({
      type: "spawned",
      requestId: firstSpawn.requestId,
      ptyId: firstSpawn.ptyId,
      pid: 123,
      process: "/bin/zsh",
      cols: 80,
      rows: 24,
    });
    child2.emitMessage({
      type: "spawned",
      requestId: secondSpawn.requestId,
      ptyId: secondSpawn.ptyId,
      pid: 456,
      process: "/bin/bash",
      cols: 80,
      rows: 24,
    });
    await Promise.all([first.__adePtyHostReady, second.__adePtyHostReady]);

    child1.send.mockImplementation((message: unknown, callback?: (error: Error | null) => void) => {
      child1.sent.push(message);
      callback?.(new Error("EPIPE"));
      return true;
    });
    first.write("lost\r");
    second.write("kept\r");

    expect(firstExits).toEqual([{ exitCode: 1, signal: undefined }]);
    expect(child1.kill).toHaveBeenCalledWith("SIGTERM");
    expect(secondExits).toEqual([]);
    expect(child2.sent).toContainEqual(expect.objectContaining({
      type: "write",
      data: "kept\r",
    }));
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

  it("force-cleans a killed host if the worker never reports PTY exit", async () => {
    vi.useFakeTimers();
    const child = createFakeChild({ emitExitOnKill: false });
    mocks.fork.mockReturnValueOnce(child);
    const loader = createSupervisedPtyLoader({ logger: createLogger() as any });
    const pty = loader().spawn("/bin/zsh", [], spawnOptions()) as HostedPty;
    const exits: Array<{ exitCode: number; signal?: number }> = [];
    pty.onExit((event) => exits.push(event));
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

    pty.kill("SIGTERM");
    expect(child.sent).toContainEqual(expect.objectContaining({
      type: "kill",
      signal: "SIGTERM",
    }));
    expect(exits).toEqual([]);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(exits).toEqual([{ exitCode: 1, signal: undefined }]);
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
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(logger.warn).toHaveBeenCalledWith("pty.host_spawn_timeout", expect.objectContaining({
      ptyId: expect.any(String),
    }));
  });
});
