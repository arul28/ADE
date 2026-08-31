import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultProcessStartedAt,
  parseElapsedTime,
  readRuntimePidfile,
  reclaimStaleRuntime,
  removeRuntimePidfile,
  runtimePidfilePath,
  writeRuntimePidfile,
} from "../src/runtimePidfile.js";

/**
 * These exist because of a real leak: a validator run SIGKILLed its host four
 * times and accumulated four orphaned runtimes, each holding a temp ADE home.
 * The engine's parent-death watchdog is the primary fix; this file is the
 * client-side half — recording who owns a home, and reclaiming it safely.
 *
 * "Safely" is the whole difficulty. A recorded pid may have been recycled onto
 * an unrelated process, and killing the user's editor because a pidfile went
 * stale is far worse than leaking a runtime. Most of these tests are about the
 * cases where reclaim must decline to act.
 */

const homes: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-pidfile-"));
  homes.push(home);
  return home;
}

/**
 * Corroborated start time for a synthetic pid: "this process started a moment
 * ago", which is what a genuine runtime looks like. Tests that reach the kill
 * path must supply this, because the real probe cannot vouch for a fake pid and
 * reclaim declines to signal anything it cannot verify.
 */
const recentStart = async (): Promise<Date> => new Date();

const noSleep = async (): Promise<void> => {};

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runtime pidfile", () => {
  it("round-trips a record", async () => {
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: 7,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await readRuntimePidfile(home)).toEqual({
      version: 1,
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: 7,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("returns null for an absent or corrupt file rather than throwing", async () => {
    const home = makeHome();
    expect(await readRuntimePidfile(home)).toBeNull();
    // A crash mid-write is exactly when this file matters most, so a truncated
    // one must read as "nothing to reclaim", never as a parse error that takes
    // down createAdeChat.
    fs.writeFileSync(runtimePidfilePath(home), '{"version":1,"pid":');
    expect(await readRuntimePidfile(home)).toBeNull();
  });

  it("rejects a non-positive recorded pid", async () => {
    const home = makeHome();
    // This value flows into process.kill, where on POSIX a non-positive pid
    // addresses a process GROUP rather than a process. It must never survive
    // the read.
    for (const pid of [0, -1, -4242]) {
      fs.writeFileSync(
        runtimePidfilePath(home),
        JSON.stringify({ version: 1, pid, socketPath: "/tmp/x.sock" }),
      );
      expect(await readRuntimePidfile(home), `pid ${pid}`).toBeNull();
    }
  });

  it("removes cleanly and tolerates a missing file", async () => {
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 1,
      socketPath: "/tmp/x.sock",
      parentPid: 2,
      startedAt: "",
    });
    await removeRuntimePidfile(home);
    expect(fs.existsSync(runtimePidfilePath(home))).toBe(false);
    await expect(removeRuntimePidfile(home)).resolves.toBeUndefined();
  });
});

describe("reclaimStaleRuntime", () => {
  it("does nothing when there is no pidfile", async () => {
    const kill = vi.fn();
    const outcome = await reclaimStaleRuntime({
      home: makeHome(),
      socketPath: "/tmp/x.sock",
      kill,
      sleep: noSleep,
    });
    expect(outcome).toMatchObject({ action: "none" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("reuses a runtime that still answers on the endpoint", async () => {
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: 7,
      startedAt: "",
    });
    const kill = vi.fn();
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      isAlive: () => true,
      kill,
      probeEndpoint: async () => true,
      sleep: noSleep,
    });
    // A runtime that answers is a working runtime. Killing it would cost a cold
    // boot and leave the home briefly ownerless for no benefit.
    expect(outcome).toEqual({ action: "reused", pid: 4242 });
    expect(kill).not.toHaveBeenCalled();
  });

  it("terminates a live process whose endpoint is dead", async () => {
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: 7,
      startedAt: "",
    });
    let alive = true;
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") alive = false;
    });
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      isAlive: () => alive,
      kill,
      probeEndpoint: async () => false,
      sleep: noSleep,
      processStartedAt: recentStart,
    });
    // Process up + endpoint dead is the orphan signature.
    expect(outcome).toEqual({ action: "killed", pid: 4242 });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    // Graceful first: SIGKILL only if SIGTERM is ignored.
    expect(kill).not.toHaveBeenCalledWith(4242, "SIGKILL");
    expect(fs.existsSync(runtimePidfilePath(home))).toBe(false);
  });

  it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: 7,
      startedAt: "",
    });
    const kill = vi.fn();
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      isAlive: () => true,
      kill,
      probeEndpoint: async () => false,
      terminateGraceMs: 0,
      sleep: noSleep,
      processStartedAt: recentStart,
    });
    expect(outcome).toEqual({ action: "killed", pid: 4242 });
    expect(kill).toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("leaves a process alone when the pidfile names a different endpoint", async () => {
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/other.sock",
      parentPid: 7,
      startedAt: "",
    });
    const kill = vi.fn();
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      isAlive: () => true,
      kill,
      probeEndpoint: async () => false,
      sleep: noSleep,
      processStartedAt: recentStart,
    });
    // THE pid-reuse guard. A recycled pid belonging to the user's editor fails
    // this check, and the endpoint mismatch is the only cheap evidence we have
    // that the recorded process is not the one we think it is.
    expect(outcome).toMatchObject({ action: "left", pid: 4242 });
    expect(kill).not.toHaveBeenCalled();
  });

  it("never kills a process it cannot signal", async () => {
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: 7,
      startedAt: "",
    });
    const kill = vi.fn(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      isAlive: () => true,
      kill,
      probeEndpoint: async () => false,
      sleep: noSleep,
      processStartedAt: recentStart,
    });
    // EPERM means the process belongs to another user, so it is definitively
    // not our runtime. Escalating to SIGKILL here would be an attempt to kill a
    // stranger's process.
    expect(outcome).toMatchObject({ action: "left", pid: 4242 });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("refuses to act on a pidfile naming this very process", async () => {
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: process.pid,
      socketPath: "/tmp/x.sock",
      parentPid: 7,
      startedAt: "",
    });
    const kill = vi.fn();
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      kill,
      probeEndpoint: async () => false,
      sleep: noSleep,
      processStartedAt: recentStart,
    });
    expect(outcome).toMatchObject({ action: "left", pid: process.pid });
    expect(kill).not.toHaveBeenCalled();
  });

  it("clears a pidfile whose process is already gone", async () => {
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: 7,
      startedAt: "",
    });
    const kill = vi.fn();
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      isAlive: () => false,
      kill,
      sleep: noSleep,
    });
    expect(outcome).toMatchObject({ action: "none" });
    expect(kill).not.toHaveBeenCalled();
    // Stale record removed, so the next start does not re-probe a dead pid.
    expect(fs.existsSync(runtimePidfilePath(home))).toBe(false);
  });

  it("never kills a recycled pid that predates the pidfile", async () => {
    // THE case this corroboration exists for. Host is SIGKILLed so the pidfile
    // survives; the orphan is reaped; days later the OS hands that pid to the
    // user's editor. Endpoint matches (it is our own home), the process is
    // alive, nothing answers the socket — every other check passes.
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: 7,
      startedAt: new Date("2026-08-30T12:00:00.000Z").toISOString(),
    });
    const kill = vi.fn();
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      isAlive: () => true,
      kill,
      probeEndpoint: async () => false,
      sleep: noSleep,
      // Started a day BEFORE the pidfile was written: cannot be our runtime.
      processStartedAt: async () => new Date("2026-08-29T12:00:00.000Z"),
    });
    expect(outcome).toMatchObject({ action: "left" });
    expect((outcome as { reason: string }).reason).toMatch(/recycled/);
    expect(kill).not.toHaveBeenCalled();
    // The misleading record is cleared so it cannot re-accuse the same pid.
    expect(fs.existsSync(runtimePidfilePath(home))).toBe(false);
  });

  it("declines to kill when the start time cannot be read at all", async () => {
    // Unverifiable is not the same as safe. A leaked runtime is recoverable;
    // killing the wrong process is not.
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: 7,
      startedAt: new Date().toISOString(),
    });
    const kill = vi.fn();
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      isAlive: () => true,
      kill,
      probeEndpoint: async () => false,
      sleep: noSleep,
      processStartedAt: async () => null,
    });
    expect(outcome).toMatchObject({ action: "left" });
    expect(kill).not.toHaveBeenCalled();
    // Left in place: the pid is unverified, not disproven.
    expect(fs.existsSync(runtimePidfilePath(home))).toBe(true);
  });

  it("still kills a runtime that started just before its pidfile was written", async () => {
    // The genuine case must not be caught by the recycling guard: the runtime
    // starts, connects, and only then is the pidfile written, so a small
    // negative skew is normal.
    const home = makeHome();
    const startedAt = new Date();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: 7,
      startedAt: startedAt.toISOString(),
    });
    const kill = vi.fn();
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      isAlive: () => true,
      kill,
      probeEndpoint: async () => false,
      terminateGraceMs: 0,
      sleep: noSleep,
      processStartedAt: async () => new Date(startedAt.getTime() - 2_000),
    });
    expect(outcome).toMatchObject({ action: "killed" });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it("treats a Windows pipe endpoint case-insensitively", async () => {
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "\\\\.\\pipe\\ade-sdk-ABC",
      parentPid: 7,
      startedAt: "",
    });
    const kill = vi.fn((_pid: number, _signal: NodeJS.Signals) => {});
    let alive = true;
    const outcome = await reclaimStaleRuntime({
      home,
      // Same pipe, different spelling. Treating these as two endpoints would
      // make reclaim silently decline on Windows and the leak would persist
      // there only.
      socketPath: "//./pipe/ade-sdk-abc",
      isAlive: () => {
        const was = alive;
        alive = false;
        return was;
      },
      kill,
      probeEndpoint: async () => false,
      sleep: noSleep,
      processStartedAt: recentStart,
    });
    expect(outcome).toMatchObject({ action: "killed" });
  });
});

/**
 * The recycling guard is only as good as this probe: if it silently returned a
 * wrong time, reclaim would either kill innocent processes or never reclaim
 * anything. These run against the real OS rather than a stub.
 */
describe("process start probe", () => {
  it("parses every ps etime shape", () => {
    expect(parseElapsedTime("12:34")).toBe(754_000);
    expect(parseElapsedTime("01:02:03")).toBe(3_723_000);
    expect(parseElapsedTime("2-03:04:05")).toBe(183_845_000);
    expect(parseElapsedTime("nonsense")).toBeNull();
    expect(parseElapsedTime("")).toBeNull();
  });

  it("reads this very process's start time from the OS", async () => {
    const self = await defaultProcessStartedAt(process.pid);
    expect(self).toBeInstanceOf(Date);
    const ageMs = Date.now() - self!.getTime();
    // In the past, and not absurdly so — a bad parse shows up as either.
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(60 * 60 * 1000);
  });

  it("returns null for a pid that does not exist, so reclaim declines to kill", async () => {
    expect(await defaultProcessStartedAt(999_999)).toBeNull();
  });
});

describe("reclaim: owner liveness (A5)", () => {
  it("does not adopt a live runtime whose owner is already dead", async () => {
    // The runtime's watchdog polls its recorded parent and exits seconds after
    // that parent dies. Adopting it hands the caller a connection that drops
    // moments later with no explanation, so a doomed runtime is reclaimed
    // rather than reused even though it is answering right now.
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: 7777,
      startedAt: new Date().toISOString(),
    });
    const kill = vi.fn();
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      isAlive: (pid) => pid === 4242,
      kill,
      probeEndpoint: async () => true,
      terminateGraceMs: 0,
      sleep: noSleep,
      processStartedAt: recentStart,
    });
    expect(outcome).toMatchObject({ action: "killed", pid: 4242 });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it("adopts a live runtime whose owner is still alive", async () => {
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: 7777,
      startedAt: new Date().toISOString(),
    });
    const kill = vi.fn();
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      isAlive: () => true,
      kill,
      probeEndpoint: async () => true,
      sleep: noSleep,
      processStartedAt: recentStart,
    });
    expect(outcome).toEqual({ action: "reused", pid: 4242 });
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not treat a missing parent pid as alive", async () => {
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: 0,
      startedAt: new Date().toISOString(),
    });
    const kill = vi.fn();
    const probed: number[] = [];
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      isAlive: (pid) => {
        probed.push(pid);
        return pid === 4242 || pid === 0;
      },
      kill,
      probeEndpoint: async () => true,
      terminateGraceMs: 0,
      sleep: noSleep,
      processStartedAt: recentStart,
    });
    expect(probed).not.toContain(0);
    expect(outcome).toMatchObject({ action: "killed", pid: 4242 });
  });

  it("adopts a runtime this very process owns", async () => {
    const home = makeHome();
    await writeRuntimePidfile(home, {
      pid: 4242,
      socketPath: "/tmp/x.sock",
      parentPid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const outcome = await reclaimStaleRuntime({
      home,
      socketPath: "/tmp/x.sock",
      isAlive: (pid) => pid === 4242,
      kill: vi.fn(),
      probeEndpoint: async () => true,
      sleep: noSleep,
      processStartedAt: recentStart,
    });
    expect(outcome).toEqual({ action: "reused", pid: 4242 });
  });
});
