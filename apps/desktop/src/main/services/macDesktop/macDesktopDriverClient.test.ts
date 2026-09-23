import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMacDesktopDriverClient } from "./macDesktopDriverClient";

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
