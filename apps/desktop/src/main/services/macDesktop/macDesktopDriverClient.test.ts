import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMacDesktopDriverClient,
  isMacDesktopDriverStillRunning,
} from "./macDesktopDriverClient";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * A child process handle enough for the client: spawn/close, pipes, kill.
 *
 * `ignoresTerm` is a helper whose main thread is stuck: SIGTERM is queued
 * behind it and never handled, and only SIGKILL ends it.
 */
function createChild(pid: number, options: { ignoresTerm?: boolean } = {}) {
  const emitter = new EventEmitter();
  const child = {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    kill: vi.fn((signal?: string) => {
      if (options.ignoresTerm && signal !== "SIGKILL") return true;
      if (child.killed) return true;
      child.killed = true;
      child.exitCode = 0;
      // The client waits for `close`, exactly as a real process would.
      process.nextTick(() => emitter.emit("close", 0, null));
      return true;
    }),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    emitSpawn: () => emitter.emit("spawn"),
    exit: (code = 0) => { child.exitCode = code; emitter.emit("close", code, null); },
  };
  // After the synchronous `start()` has attached its listeners.
  process.nextTick(() => child.emitSpawn());
  return child;
}

describe("macDesktopDriverClient restart", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restart() kills the child, starts a new one, resolves ready", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-driver-client-"));
    tempDirs.push(dir);
    const binary = path.join(dir, "ade-desktop-driver");
    fs.writeFileSync(binary, "");

    const first = createChild(101);
    let nextPid = 202;
    const spawnProcess = vi.fn(() => {
      // Built at spawn time so the child's async `spawn` event cannot fire
      // before the client has attached its listener.
      const pid = nextPid;
      nextPid += 1;
      return createChild(pid);
    });
    spawnProcess.mockReturnValueOnce(first);

    const client = createMacDesktopDriverClient({
      logger,
      platform: "darwin",
      resolveExecutablePath: () => binary,
      spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
    });

    await client.ensureStarted();
    expect(client.isRunning()).toBe(true);
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    await client.restart();

    // The old helper was actually killed, a replacement was spawned, and the
    // promise did not resolve until the new one was ready.
    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(client.isRunning()).toBe(true);

    client.dispose();
  });
});

describe("macDesktopDriverClient when the helper stops answering", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function binaryPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-driver-client-"));
    tempDirs.push(dir);
    const binary = path.join(dir, "ade-desktop-driver");
    fs.writeFileSync(binary, "");
    return binary;
  }

  function recordingLogger() {
    const lines: Array<{ level: string; event: string; meta?: Record<string, unknown> }> = [];
    const at = (level: string) => (event: string, meta?: Record<string, unknown>) => {
      lines.push({ level, event, ...(meta ? { meta } : {}) });
    };
    return { lines, logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } };
  }

  it("kills a helper that ignores SIGTERM before starting its replacement", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const binary = binaryPath();
    const stuck = createChild(101, { ignoresTerm: true });
    let nextPid = 202;
    const spawnProcess = vi.fn(() => {
      const pid = nextPid;
      nextPid += 1;
      return createChild(pid);
    });
    spawnProcess.mockReturnValueOnce(stuck);
    const { lines, logger: recorded } = recordingLogger();
    const client = createMacDesktopDriverClient({
      logger: recorded,
      platform: "darwin",
      resolveExecutablePath: () => binary,
      spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
    });
    await client.ensureStarted();

    const restarted = client.restart();
    await vi.advanceTimersByTimeAsync(1_900);
    expect(stuck.kill).toHaveBeenCalledWith("SIGTERM");
    expect(stuck.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    await restarted;
    expect(stuck.kill).toHaveBeenCalledWith("SIGKILL");
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(client.isRunning()).toBe(true);
    expect(lines.some((line) => line.event === "mac_desktop.driver_restart_kill" && line.level === "warn")).toBe(true);
    client.dispose();
  });

  it.each(["restart", "dispose"] as const)("%s asks a Windows host to quit and cancels force termination when it exits", async (operation) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = createChild(401);
    let replacement: ReturnType<typeof createChild> | undefined;
    const spawnProcess = vi.fn(() => {
      replacement = createChild(402);
      return replacement;
    }).mockReturnValueOnce(child);
    const client = createMacDesktopDriverClient({
      logger, platform: "win32", supportedPlatforms: ["win32"], gracefulQuit: true,
      resolveExecutablePath: binaryPath,
      spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
    });
    await client.ensureStarted();
    const shutdown = operation === "restart" ? client.restart() : Promise.resolve(client.dispose());
    expect(child.stdin.read()?.toString()).toBe('{"type":"quit"}\n');
    expect(child.kill).not.toHaveBeenCalled();
    child.exit();
    if (operation === "restart") {
      await shutdown;
      expect(client.isRunning()).toBe(true);
      expect(spawnProcess).toHaveBeenCalledTimes(2);
      client.dispose();
      replacement!.exit();
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("hands a retired Windows driver's queued requests to a fresh one, with no backoff and no crash loop", async () => {
    // Exit 75 is the Windows host retiring itself on purpose (a wedged UI
    // thread, an operation past its deadline). What it had queued never ran, so
    // the same request goes to a driver started at once; five in a row is not a
    // crash loop, because none of them crashed.
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    const children: Array<ReturnType<typeof createChild>> = [];
    const spawnProcess = vi.fn(() => {
      const next = createChild(500 + children.length);
      children.push(next);
      return next;
    });
    const lost: string[] = [];
    const client = createMacDesktopDriverClient({
      logger, platform: "win32", supportedPlatforms: ["win32"],
      resolveExecutablePath: binaryPath,
      spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
      onDriverLost: (reason) => lost.push(reason),
    });
    await client.ensureStarted();

    for (let round = 0; round < 5; round += 1) {
      const retiring = children.at(-1)!;
      const reply = client.request("window.focus", { laneId: "lane-1", windowId: round });
      await settle();
      const sent = retiring.stdin.read()?.toString() ?? "";
      expect(JSON.parse(sent)).toMatchObject({ op: "window.focus", windowId: round });

      retiring.exit(75);
      await settle();
      const fresh = children.at(-1)!;
      expect(fresh, `round ${round}`).not.toBe(retiring);
      // The very request, not a new one: its id is what the reply answers.
      expect(fresh.stdin.read()?.toString()).toBe(sent);
      fresh.stdout.write(`${JSON.stringify({ id: JSON.parse(sent).id, ok: true, result: { windowId: round } })}\n`);
      await expect(reply).resolves.toEqual({ windowId: round });
    }

    expect(spawnProcess).toHaveBeenCalledTimes(6);
    expect(client.getHealth().state).toBe("running");
    // The service decides whether a retirement took a screen with it.
    expect(lost).toEqual(["retired", "retired", "retired", "retired", "retired"]);
    client.dispose();
  });

  /**
   * A helper that dies on sight, over and over.
   *
   * The budget has to span the 30 s window stability is measured against: a
   * budget that ran out inside it could not tell a burst of transient failures
   * (an update replacing the binary, a window-server hiccup) from a helper that
   * will never come up. Past the budget, the retries slow down while a request
   * is recent enough to want the driver; once nothing has asked for it, they
   * stop until the next request.
   */
  const crashLoopClient = (spawnProcess: ReturnType<typeof vi.fn>, recorded: ReturnType<typeof recordingLogger>) => {
    const client = createMacDesktopDriverClient({
      logger: recorded.logger,
      platform: "darwin",
      resolveExecutablePath: binaryPath,
      spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
    });
    return client;
  };

  /** Advances fake time until `expected` spawns have happened, or `withinMs` has passed. */
  const spawnWithin = async (spawnProcess: { mock: { calls: unknown[] } }, expected: number, withinMs: number): Promise<boolean> => {
    for (let elapsed = 0; elapsed < withinMs; elapsed += 250) {
      await vi.advanceTimersByTimeAsync(250);
      if (spawnProcess.mock.calls.length >= expected) return true;
    }
    return false;
  };

  it("keeps retrying a crash-looping helper while it is wanted, and only slows down", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const children: Array<ReturnType<typeof createChild>> = [];
    const spawnedAt: number[] = [];
    const spawnProcess = vi.fn(() => {
      const next = createChild(600 + children.length);
      children.push(next);
      spawnedAt.push(Date.now());
      return next;
    });
    const recorded = recordingLogger();
    const client = crashLoopClient(spawnProcess, recorded);
    await client.ensureStarted();

    // The fast budget: seven restarts, each within ten seconds.
    for (let round = 0; round < 7; round += 1) {
      children.at(-1)!.exit(1);
      expect(await spawnWithin(spawnProcess, round + 2, 20_000)).toBe(true);
    }
    // Past it, each retry waits minutes rather than ten seconds, and the
    // driver is still wanted: the request that started this is minutes old.
    for (let round = 0; round < 2; round += 1) {
      children.at(-1)!.exit(1);
      expect(await spawnWithin(spawnProcess, 9 + round, 130_000)).toBe(true);
    }
    expect(spawnedAt.at(-1)! - spawnedAt.at(-2)!).toBeGreaterThanOrEqual(60_000);
    expect(recorded.lines.filter((line) => line.event === "mac_desktop.driver_crash_loop")).toHaveLength(1);
    expect(recorded.lines.some((line) => line.event === "mac_desktop.driver_restart_parked")).toBe(false);
    client.dispose();
  });

  it("parks a crash-looping helper once nothing has asked for it, and the next request spawns at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const children: Array<ReturnType<typeof createChild>> = [];
    const spawnProcess = vi.fn(() => {
      const next = createChild(600 + children.length);
      children.push(next);
      return next;
    });
    const recorded = recordingLogger();
    const client = crashLoopClient(spawnProcess, recorded);
    await client.ensureStarted();

    // Keep it dying until a death lands with no request in the window before
    // it: then no restart is armed, and no spawn follows the death.
    let parked = false;
    for (let round = 0; round < 30 && !parked; round += 1) {
      children.at(-1)!.exit(1);
      parked = !(await spawnWithin(spawnProcess, round + 2, 130_000));
    }
    expect(parked).toBe(true);
    const spawnsWhenParked = spawnProcess.mock.calls.length;
    expect(recorded.lines.some((line) => line.event === "mac_desktop.driver_restart_parked")).toBe(true);

    // Ten minutes with nothing asking for it: no helper is spawned.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(spawnProcess).toHaveBeenCalledTimes(spawnsWhenParked);

    // The next real request spawns at once, without waiting for any timer.
    await client.ensureStarted();
    expect(spawnProcess).toHaveBeenCalledTimes(spawnsWhenParked + 1);
    expect(client.isRunning()).toBe(true);
    client.dispose();
  });

  it("tells the driver's give-up answer apart from a refusal and from a dead driver", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = createChild(303);
    const client = createMacDesktopDriverClient({
      logger,
      platform: "darwin",
      resolveExecutablePath: binaryPath,
      spawnProcess: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    await client.ensureStarted();
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

    const answer = async (error: Record<string, unknown>): Promise<unknown> => {
      const request = client.request("observe", { laneId: "lane-1" });
      await settle();
      const id = JSON.parse(child.stdin.read()!.toString()).id;
      child.stdout.write(`${JSON.stringify({ id, ok: false, error })}\n`);
      return await request.catch((failure: unknown) => failure);
    };

    // The watchdog answering for a handler that is still running: alive, and
    // the work may yet land.
    expect(isMacDesktopDriverStillRunning(await answer({
      code: "internal_error",
      message: "observe did not complete within 15s. "
        + "The driver gave up waiting and answered on its behalf; the operation may still be running.",
    }))).toBe(true);
    // The same code with a real internal failure behind it is not a give-up.
    expect(isMacDesktopDriverStillRunning(await answer({
      code: "internal_error",
      message: "The element map could not be written.",
    }))).toBe(false);
    // Nor is a refusal.
    expect(isMacDesktopDriverStillRunning(await answer({
      code: "no_display",
      message: "Lane lane-1 has no display. Start one before observing it.",
    }))).toBe(false);

    // And a driver that is simply gone is the other failure, not this one.
    // The rejection is handled where it is made, not after the exit lands.
    const gone = client.request("observe", { laneId: "lane-1" }).catch((failure: unknown) => failure);
    await settle();
    child.exit(1);
    await settle();
    expect(isMacDesktopDriverStillRunning(await gone)).toBe(false);
    client.dispose();
  });

  it("logs each stderr line, and a request the helper never answered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const binary = binaryPath();
    const child = createChild(303);
    const { lines, logger: recorded } = recordingLogger();
    const client = createMacDesktopDriverClient({
      logger: recorded,
      platform: "darwin",
      resolveExecutablePath: () => binary,
      requestTimeoutMs: 1_000,
      spawnProcess: (() => child) as unknown as typeof import("node:child_process").spawn,
    });
    await client.ensureStarted();

    child.stderr.write("[ade-desktop-driver] TextEdit did not answer accessibility\n[ade-desktop-driver] watch");
    child.stderr.write("dog answering observe 7 after 15s with no reply\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.filter((line) => line.event === "mac_desktop.driver_stderr")).toEqual([
      { level: "info", event: "mac_desktop.driver_stderr", meta: { message: "[ade-desktop-driver] TextEdit did not answer accessibility" } },
      { level: "info", event: "mac_desktop.driver_stderr", meta: { message: "[ade-desktop-driver] watchdog answering observe 7 after 15s with no reply" } },
    ]);

    const request = client.request("observe", { laneId: "lane-1" });
    const rejected = expect(request).rejects.toThrow(/did not answer observe in 1000ms/);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(lines).toContainEqual({
      level: "warn",
      event: "mac_desktop.driver_request_timeout",
      meta: { op: "observe", timeoutMs: 1_000, pendingRequests: 0, pid: 303 },
    });
    client.dispose();
  });
});
