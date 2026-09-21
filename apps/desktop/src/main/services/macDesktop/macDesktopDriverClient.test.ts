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

/** A child process handle enough for the client: spawn/close, pipes, kill. */
function createChild(pid: number) {
  const emitter = new EventEmitter();
  const child = {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    kill: vi.fn(() => {
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
