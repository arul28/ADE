import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// adb is the process boundary: the dump and the follow reader are fakes.
const adb = vi.hoisted(() => ({
  runAdb: vi.fn(),
  spawnAdb: vi.fn(),
}));
vi.mock("./adb", () => adb);

import { createAndroidCrashWatch } from "./androidCrashWatch";

type FakeReader = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };

function fakeReader(): FakeReader {
  const child = new EventEmitter() as FakeReader;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", null);
  return child;
}

const ADB = { serial: "emulator-5560", adbPath: "/sdk/platform-tools/adb" };
/** One event-loop turn: the watch's dump answer and its spawn run in it. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function javaCrash(time: string, pid: number, pkg: string): string {
  return [
    `${time}  ${pid}  ${pid} E AndroidRuntime: FATAL EXCEPTION: main`,
    `${time}  ${pid}  ${pid} E AndroidRuntime: Process: ${pkg}, PID: ${pid}`,
    `${time}  ${pid}  ${pid} E AndroidRuntime: java.lang.IllegalStateException: boom`,
    "",
  ].join("\n");
}

afterEach(() => {
  adb.runAdb.mockReset();
  adb.spawnAdb.mockReset();
});

describe("createAndroidCrashWatch", () => {
  it("pins only the lane's app's crashes from after the watch started", async () => {
    const reader = fakeReader();
    adb.runAdb.mockResolvedValue({ stdout: Buffer.from(javaCrash("100.000", 41, "com.example.app")) });
    adb.spawnAdb.mockReturnValue(reader);
    const onCrash = vi.fn();
    const watch = createAndroidCrashWatch({
      lanePackages: () => ["com.example.app"],
      onCrash,
      signal: new AbortController().signal,
    });

    watch.ensure("lane-1", ADB);
    await settle();
    expect(adb.spawnAdb).toHaveBeenCalledTimes(1);
    // The follow reader replays the old crash, then another app's, then the lane's own.
    reader.stdout.write(javaCrash("100.000", 41, "com.example.app"));
    reader.stdout.write(javaCrash("150.000", 52, "com.other.app"));
    reader.stdout.write(javaCrash("200.000", 63, "com.example.app"));
    await settle();
    reader.emit("close", 0);

    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash).toHaveBeenCalledWith("lane-1", expect.objectContaining({
      packageName: "com.example.app",
      pid: 63,
      kind: "java",
      summary: "java.lang.IllegalStateException: boom",
    }));
    expect(watch.latest("lane-1")?.time).toBe("200.000");
    watch.stop("lane-1");
    expect(watch.latest("lane-1")).toBeNull();
  });

  it("starts no reader after dispose, and waits longer after each quick exit", async () => {
    let clock = 1_000_000;
    let answerDump: (value: { stdout: Buffer }) => void = () => {};
    adb.runAdb.mockImplementation(() => new Promise((resolve) => { answerDump = resolve; }));
    adb.spawnAdb.mockImplementation(() => fakeReader());
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const watch = createAndroidCrashWatch({
      lanePackages: () => [],
      onCrash: vi.fn(),
      logger: logger as never,
      signal: new AbortController().signal,
      now: () => clock,
    });

    // Disposed while the dump is still out: its answer starts no logcat, and nor does a later read.
    watch.ensure("lane-1", ADB);
    watch.dispose();
    answerDump({ stdout: Buffer.alloc(0) });
    await settle();
    watch.ensure("lane-2", ADB);
    await settle();
    expect(adb.spawnAdb).not.toHaveBeenCalled();
    expect(adb.runAdb).toHaveBeenCalledTimes(1);

    // A fresh watch whose logcat dies at once: the next start waits 20 s, not 10 s.
    adb.runAdb.mockResolvedValue({ stdout: Buffer.alloc(0) });
    const fresh = createAndroidCrashWatch({
      lanePackages: () => [],
      onCrash: vi.fn(),
      logger: logger as never,
      signal: new AbortController().signal,
      now: () => clock,
    });
    fresh.ensure("lane-1", ADB);
    await settle();
    const first = adb.spawnAdb.mock.results[0]!.value as FakeReader;
    clock += 1_000;
    first.emit("close", 1);
    expect(logger.warn).toHaveBeenCalledWith("android.crash_watch_ended", expect.objectContaining({ quick: true, retryInMs: 20_000 }));
    clock += 11_000;
    fresh.ensure("lane-1", ADB);
    await settle();
    expect(adb.spawnAdb).toHaveBeenCalledTimes(1);
    clock += 10_000;
    fresh.ensure("lane-1", ADB);
    await settle();
    expect(adb.spawnAdb).toHaveBeenCalledTimes(2);
    fresh.dispose();
  });
});
