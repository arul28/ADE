import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  processIsAlive,
  readEmbeddedParentPid,
  startParentDeathWatchdog,
  validateParentPid,
} from "./parentDeathWatchdog";

/**
 * The leak this guards: an embedded runtime spawned by an external host is a
 * plain child process, and on POSIX an orphan is reparented to init rather than
 * killed. A host that dies without unwinding (SIGKILL, crashed renderer) leaves
 * the runtime holding an ADE home and a listening socket forever. A validator
 * run accumulated four of them.
 */
describe("parentDeathWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shuts down once the parent is observed gone", () => {
    let alive = true;
    const onParentGone = vi.fn();
    startParentDeathWatchdog({
      parentPid: 4242,
      intervalMs: 1_000,
      isAlive: () => alive,
      onParentGone,
    });

    vi.advanceTimersByTime(3_000);
    expect(onParentGone).not.toHaveBeenCalled();

    alive = false;
    vi.advanceTimersByTime(1_000);
    expect(onParentGone).toHaveBeenCalledTimes(1);
  });

  it("fires shutdown exactly once even as polling continues", () => {
    const onParentGone = vi.fn();
    startParentDeathWatchdog({
      parentPid: 4242,
      intervalMs: 1_000,
      isAlive: () => false,
      onParentGone,
    });

    // onParentGone starts a graceful shutdown. A second tick landing during
    // teardown would run that path twice, which is how a clean shutdown turns
    // into a double-close of the socket and db.
    vi.advanceTimersByTime(10_000);
    expect(onParentGone).toHaveBeenCalledTimes(1);
  });

  it("stops polling after the returned stop function runs", () => {
    const isAlive = vi.fn(() => true);
    const onParentGone = vi.fn();
    const stop = startParentDeathWatchdog({
      parentPid: 4242,
      intervalMs: 1_000,
      isAlive,
      onParentGone,
    });

    vi.advanceTimersByTime(2_000);
    const pollsBeforeStop = isAlive.mock.calls.length;
    expect(pollsBeforeStop).toBeGreaterThan(0);

    stop();
    stop(); // idempotent
    vi.advanceTimersByTime(10_000);
    expect(isAlive).toHaveBeenCalledTimes(pollsBeforeStop);
    expect(onParentGone).not.toHaveBeenCalled();
  });

  it("refuses a non-positive pid instead of probing it", () => {
    // The load-bearing case. On POSIX `process.kill(0, sig)` signals the
    // caller's ENTIRE process group and a negative pid signals that group by
    // id. With signal 0 that is only a probe, but a watchdog that can address a
    // process group is a loaded gun pointed at the developer's own shell.
    for (const pid of [0, -1, -4242]) {
      const onParentGone = vi.fn();
      const onInvalidParent = vi.fn();
      const isAlive = vi.fn(() => false);
      startParentDeathWatchdog({ parentPid: pid, isAlive, onParentGone, onInvalidParent });
      vi.advanceTimersByTime(60_000);
      expect(isAlive, `pid ${pid} must never be probed`).not.toHaveBeenCalled();
      expect(onParentGone).not.toHaveBeenCalled();
      expect(onInvalidParent).toHaveBeenCalledWith(expect.stringContaining("positive"));
    }
  });

  it("refuses its own pid, which could never be observed dead", () => {
    const onInvalidParent = vi.fn();
    const isAlive = vi.fn(() => false);
    startParentDeathWatchdog({
      parentPid: process.pid,
      isAlive,
      onParentGone: vi.fn(),
      onInvalidParent,
    });
    vi.advanceTimersByTime(60_000);
    // Accepting it would silently disable the watchdog: this process is alive
    // by definition, so the leak would come back with no signal that it had.
    expect(isAlive).not.toHaveBeenCalled();
    expect(onInvalidParent).toHaveBeenCalledWith(expect.stringContaining("this process"));
  });

  it("keeps the runtime running when the pid is unusable", () => {
    const onParentGone = vi.fn();
    startParentDeathWatchdog({
      parentPid: Number.NaN,
      isAlive: () => false,
      onParentGone,
      onInvalidParent: vi.fn(),
    });
    vi.advanceTimersByTime(60_000);
    // A malformed pid is the spawner's bug. Exiting over it would turn a
    // resource leak into an outage for a host that is perfectly healthy.
    expect(onParentGone).not.toHaveBeenCalled();
  });

  it("never polls faster than the floor, however small the interval", () => {
    const isAlive = vi.fn(() => true);
    startParentDeathWatchdog({
      parentPid: 4242,
      intervalMs: 1,
      isAlive,
      onParentGone: vi.fn(),
    });
    // A caller passing 0 or 1 must not turn the watchdog into a busy loop
    // burning a core for the runtime's whole lifetime.
    vi.advanceTimersByTime(1_000);
    expect(isAlive.mock.calls.length).toBeLessThanOrEqual(4);
  });

  describe("validateParentPid", () => {
    it("accepts a plausible foreign pid", () => {
      expect(validateParentPid(4242, 99)).toEqual({ ok: true });
    });

    it("rejects fractional pids", () => {
      expect(validateParentPid(12.5, 99)).toMatchObject({ ok: false });
    });
  });

  describe("readEmbeddedParentPid", () => {
    it("parses a plain decimal pid", () => {
      expect(readEmbeddedParentPid("4242")).toBe(4242);
      expect(readEmbeddedParentPid(" 4242 ")).toBe(4242);
    });

    it("returns null for absent input", () => {
      expect(readEmbeddedParentPid(undefined)).toBeNull();
      expect(readEmbeddedParentPid(null)).toBeNull();
      expect(readEmbeddedParentPid("")).toBeNull();
      expect(readEmbeddedParentPid("   ")).toBeNull();
    });

    it("rejects anything Number() would silently coerce", () => {
      // Number("0x10") is 16 and Number("1e3") is 1000 — a spawner typo would
      // resolve to some unrelated live process, and the watchdog would then be
      // watching a pid that has nothing to do with its owner.
      for (const value of ["0x10", "1e3", "12abc", "-5", "+5", "12.0", "Infinity"]) {
        expect(readEmbeddedParentPid(value), `${value} must not parse`).toBeNull();
      }
    });
  });

  describe("processIsAlive", () => {
    it("reports this process as alive", () => {
      vi.useRealTimers();
      expect(processIsAlive(process.pid)).toBe(true);
    });

    it("reports a definitely-dead pid as gone", () => {
      vi.useRealTimers();
      // ESRCH is the only signal that means "gone".
      const probe = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      });
      expect(processIsAlive(4242)).toBe(false);
      probe.mockRestore();
    });

    it("treats EPERM as alive, not dead", () => {
      vi.useRealTimers();
      // A process owned by another user exists — we just may not signal it.
      // Reading EPERM as "gone" would shut the runtime down while its owner is
      // still running, which is a worse failure than the leak.
      const probe = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      });
      expect(processIsAlive(4242)).toBe(true);
      probe.mockRestore();
    });
  });
});
