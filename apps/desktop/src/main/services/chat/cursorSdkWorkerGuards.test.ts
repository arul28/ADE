import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createCursorSdkWorkerExit,
  cursorSdkOwnerPidArg,
  cursorSdkOwnerStillOwns,
  ignoreCursorSdkWorkerPipeErrors,
  readCursorSdkOwnerPid,
  sendToCursorSdkParent,
} from "./cursorSdkWorkerGuards";

/**
 * Mirrors Node's `process.send`: with the channel closed, the error goes to
 * the callback when there is one, and to a process `'error'` event otherwise.
 */
class FakeIpcProcess extends EventEmitter {
  connected = true;
  channelOpen = true;
  sent: unknown[] = [];

  send = (
    message: unknown,
    _handle?: undefined,
    _options?: undefined,
    callback?: (error: Error | null) => void,
  ): boolean => {
    if (!this.channelOpen) {
      const error = Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" });
      if (callback) queueMicrotask(() => callback(error));
      else queueMicrotask(() => this.emit("error", error));
      return false;
    }
    this.sent.push(message);
    if (callback) queueMicrotask(() => callback(null));
    return true;
  };
}

describe("sendToCursorSdkParent", () => {
  it("drops the message without a send when the parent is gone", () => {
    const proc = new FakeIpcProcess();
    proc.connected = false;
    const send = vi.spyOn(proc, "send");

    expect(sendToCursorSdkParent(proc, { type: "log" })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("routes a send that fails mid-flight to its callback, never to an 'error' event", async () => {
    const proc = new FakeIpcProcess();
    // `connected` still reads true, but the channel is already closing.
    proc.channelOpen = false;
    const errors: unknown[] = [];
    proc.on("error", (error) => errors.push(error));
    const send = vi.spyOn(proc, "send");

    expect(sendToCursorSdkParent(proc, { type: "log" })).toBe(false);
    const callback = send.mock.calls[0]?.[3];
    expect(typeof callback).toBe("function");
    // Let the queued failure report land.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(errors).toEqual([]);
  });

  it("returns false instead of throwing when send throws", () => {
    const proc = {
      connected: true,
      send: () => {
        throw new Error("write EPIPE");
      },
    };
    expect(sendToCursorSdkParent(proc, { type: "log" })).toBe(false);
  });

  it("delivers the message while connected", () => {
    const proc = new FakeIpcProcess();
    expect(sendToCursorSdkParent(proc, { type: "log" })).toBe(true);
    expect(proc.sent).toEqual([{ type: "log" }]);
  });
});

describe("ignoreCursorSdkWorkerPipeErrors", () => {
  it("swallows EPIPE on stdio and errors on the process", () => {
    const proc = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    ignoreCursorSdkWorkerPipeErrors(proc, [stdout, stderr, null]);

    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    // An EventEmitter with no 'error' listener throws; each of these would be
    // an uncaught exception in the worker.
    expect(() => stderr.emit("error", epipe)).not.toThrow();
    expect(() => stdout.emit("error", epipe)).not.toThrow();
    expect(() => proc.emit("error", new Error("Channel closed"))).not.toThrow();
  });
});

describe("createCursorSdkWorkerExit", () => {
  it("exits at the deadline when dispose never settles", () => {
    const timers: Array<{ callback: () => void; ms: number; unref: ReturnType<typeof vi.fn> }> = [];
    const exit = vi.fn();
    const exitWorker = createCursorSdkWorkerExit({
      dispose: () => new Promise<void>(() => {}),
      exit,
      deadlineMs: 2_000,
      setTimer: (callback, ms) => {
        const timer = { callback, ms, unref: vi.fn() };
        timers.push(timer);
        return timer;
      },
    });

    exitWorker(1);

    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(2_000);
    expect(timers[0]?.unref).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    timers[0]!.callback();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits once dispose settles, and only the first trigger counts", async () => {
    const timers: Array<() => void> = [];
    const dispose = vi.fn(async () => {});
    const exited = new Promise<number>((resolve) => {
      const exitWorker = createCursorSdkWorkerExit({
        dispose,
        exit: resolve,
        setTimer: (callback) => {
          timers.push(callback);
          return {};
        },
      });
      exitWorker(0);
      exitWorker(1);
    });

    expect(await exited).toBe(0);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
  });

  it("still exits when dispose rejects", async () => {
    const exited = new Promise<number>((resolve) => {
      createCursorSdkWorkerExit({
        dispose: async () => {
          throw new Error("agent close failed");
        },
        exit: resolve,
        setTimer: () => ({}),
      })(0);
    });
    expect(await exited).toBe(0);
  });
});

describe("Cursor SDK owner pid", () => {
  it("round-trips through argv and a process command line", () => {
    expect(readCursorSdkOwnerPid(["/usr/bin/node", "/x/cursorSdkWorker.cjs", cursorSdkOwnerPidArg(4321)])).toBe(4321);
    expect(readCursorSdkOwnerPid("\"C:\\ADE\\ADE.exe\" \"C:\\ADE\\cursorSdkWorker.cjs\" --ade-owner-pid=77")).toBe(77);
  });

  it("rejects a missing or malformed owner pid", () => {
    expect(readCursorSdkOwnerPid(["node", "cursorSdkWorker.cjs"])).toBeNull();
    expect(readCursorSdkOwnerPid("--ade-owner-pid=12abc")).toBeNull();
    expect(readCursorSdkOwnerPid("--ade-owner-pid=0")).toBeNull();
    expect(readCursorSdkOwnerPid("--ade-owner-pid=")).toBeNull();
  });
});

describe("cursorSdkOwnerStillOwns", () => {
  const isAlive = (pid: number) => pid === 10;

  it("reports the owner gone once the IPC channel is closed", () => {
    expect(cursorSdkOwnerStillOwns({
      ownerPid: 10,
      proc: { connected: false, ppid: 10 },
      platform: "darwin",
      isAlive,
    })).toBe(false);
  });

  it("reports the owner gone on POSIX once the worker is reparented, even if the pid is reused", () => {
    expect(cursorSdkOwnerStillOwns({
      ownerPid: 10,
      proc: { connected: true, ppid: 1 },
      platform: "linux",
      isAlive,
    })).toBe(false);
  });

  it("ignores the ppid on Windows and probes the owner pid", () => {
    expect(cursorSdkOwnerStillOwns({
      ownerPid: 10,
      proc: { connected: true, ppid: 99 },
      platform: "win32",
      isAlive,
    })).toBe(true);
    expect(cursorSdkOwnerStillOwns({
      ownerPid: 11,
      proc: { connected: true, ppid: 11 },
      platform: "win32",
      isAlive,
    })).toBe(false);
  });
});
