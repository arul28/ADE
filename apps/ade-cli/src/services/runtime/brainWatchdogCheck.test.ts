import { describe, expect, it, vi } from "vitest";

/**
 * Records every `execFileSync` call while still running the real one, so the
 * identity probe's options can be asserted without faking `ps` output.
 */
const execFileSyncCalls = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => {
      execFileSyncCalls(...args);
      return (actual.execFileSync as (...callArgs: unknown[]) => unknown)(...args);
    },
  };
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BRAIN_HEARTBEAT_FILE,
  BRAIN_HEARTBEAT_STALE_MS,
  writeBrainHeartbeat,
} from "./brainHeartbeat";
import {
  defaultBrainProcessIdentity,
  resolveBrainHeartbeatStaleMs,
  runBrainWatchdogCheck,
} from "./brainWatchdogCheck";
import {
  BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE,
  readBrainLoopWatchdogLastWedge,
  recoverBrainLoopWatchdogBreadcrumb,
} from "./brainLoopWatchdog";

function tempRuntimeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-watchdog-"));
}

const NOW = 10_000_000;

/** The live pid really is the process that wrote the beat. */
const MATCHING_IDENTITY = (): { startedAtMs: number } => ({ startedAtMs: 1 });

describe("resolveBrainHeartbeatStaleMs", () => {
  it("falls back to the default for missing or nonsense values", () => {
    expect(resolveBrainHeartbeatStaleMs({})).toBe(BRAIN_HEARTBEAT_STALE_MS);
    expect(resolveBrainHeartbeatStaleMs({ ADE_BRAIN_HEARTBEAT_STALE_MS: "nope" }))
      .toBe(BRAIN_HEARTBEAT_STALE_MS);
  });

  it("refuses a threshold short enough to fire on an ordinary gap", () => {
    expect(resolveBrainHeartbeatStaleMs({ ADE_BRAIN_HEARTBEAT_STALE_MS: "500" })).toBe(30_000);
  });
});

describe("defaultBrainProcessIdentity", () => {
  // Read-only, and the only pid guaranteed to exist: this one. Without this the
  // whole identity gate is covered by injected fakes and a `ps` output change
  // would silently turn every wedge kill into a no-op.
  (process.platform === "win32" ? it.skip : it)("reads a live pid's start time", () => {
    const identity = defaultBrainProcessIdentity(process.pid);
    expect(identity).not.toBeNull();
    const uptimeMs = process.uptime() * 1_000;
    expect(Math.abs(Date.now() - uptimeMs - (identity?.startedAtMs ?? 0))).toBeLessThan(5_000);
  });

  // `ps -o lstart=` renders in the process locale. On a de_DE or fr_FR host the
  // unpinned probe returned null forever, so the wedge kill never fired there.
  (process.platform === "win32" ? it.skip : it)("asks ps in a fixed locale", () => {
    execFileSyncCalls.mockClear();
    defaultBrainProcessIdentity(process.pid);
    const options = execFileSyncCalls.mock.calls.at(-1)?.[2] as
      | { env?: NodeJS.ProcessEnv }
      | undefined;
    expect(options?.env?.LC_ALL).toBe("C");
    expect(options?.env?.LANG).toBe("C");
  });

  it("returns no identity for a pid that does not exist, and never on win32", () => {
    // 0x7FFFFFFF is above every platform's pid_max, so it cannot be assigned.
    expect(defaultBrainProcessIdentity(2_147_483_647)).toBeNull();
    expect(defaultBrainProcessIdentity(process.pid, "win32")).toBeNull();
  });
});

describe("runBrainWatchdogCheck", () => {
  it("does nothing when there is no heartbeat to judge", () => {
    const kill = vi.fn();
    const result = runBrainWatchdogCheck({
      runtimeDir: tempRuntimeDir(),
      now: () => NOW,
      kill,
      pidAlive: () => true,
    });
    expect(result.action).toBe("absent");
    expect(kill).not.toHaveBeenCalled();
  });

  it("leaves a healthy brain alone", () => {
    const runtimeDir = tempRuntimeDir();
    writeBrainHeartbeat(runtimeDir, { pid: 4242, ts: NOW - 5_000, seq: 3, startedAt: NOW - 60_000 });
    const kill = vi.fn();
    const result = runBrainWatchdogCheck({
      runtimeDir,
      now: () => NOW,
      selfPid: 1,
      kill,
      pidAlive: () => true,
    });
    expect(result.action).toBe("healthy");
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not kill a stale heartbeat whose writer already exited", () => {
    const runtimeDir = tempRuntimeDir();
    writeBrainHeartbeat(runtimeDir, { pid: 4242, ts: NOW - 600_000, seq: 3, startedAt: 1 });
    const kill = vi.fn();
    const result = runBrainWatchdogCheck({
      runtimeDir,
      now: () => NOW,
      selfPid: 1,
      kill,
      pidAlive: () => false,
    });
    expect(result.action).toBe("already_exited");
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills a wedged brain and leaves a breadcrumb the next start promotes", () => {
    const runtimeDir = tempRuntimeDir();
    writeBrainHeartbeat(runtimeDir, { pid: 4242, ts: NOW - 600_000, seq: 3, startedAt: 1 });
    const kill = vi.fn();
    const result = runBrainWatchdogCheck({
      runtimeDir,
      now: () => NOW,
      selfPid: 1,
      kill,
      pidAlive: () => true,
      processIdentity: MATCHING_IDENTITY,
    });

    expect(result.action).toBe("killed");
    expect(result.pid).toBe(4242);
    expect(kill).toHaveBeenCalledWith(4242);
    expect(fs.existsSync(path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE))).toBe(true);

    // The existing lastWedge plumbing must be able to consume it unchanged.
    recoverBrainLoopWatchdogBreadcrumb({ runtimeDir, warn: () => {} });
    const lastWedge = readBrainLoopWatchdogLastWedge(runtimeDir);
    expect(lastWedge?.lastCommand).toBe("external-watchdog");
    expect(lastWedge?.blockedMs).toBe(600_000);
  });

  it("reports a kill it could not perform instead of claiming success", () => {
    const runtimeDir = tempRuntimeDir();
    writeBrainHeartbeat(runtimeDir, { pid: 4242, ts: NOW - 600_000, seq: 3, startedAt: 1 });
    const result = runBrainWatchdogCheck({
      runtimeDir,
      now: () => NOW,
      selfPid: 1,
      pidAlive: () => true,
      processIdentity: MATCHING_IDENTITY,
      kill: () => {
        throw new Error("EPERM");
      },
    });
    expect(result.action).toBe("kill_failed");
    expect(result.message).toContain("EPERM");
  });

  // The 2026-08-05 shape: the brain crashed, the heartbeat file outlived it, and
  // the OS handed that pid number to something else. Killing on pid alone made
  // the watchdog SIGKILL an innocent process once a minute, forever.
  it("never kills a recycled pid, and clears the heartbeat that named it", () => {
    const runtimeDir = tempRuntimeDir();
    writeBrainHeartbeat(runtimeDir, { pid: 4242, ts: NOW - 600_000, seq: 3, startedAt: NOW - 660_000 });
    const kill = vi.fn();
    const result = runBrainWatchdogCheck({
      runtimeDir,
      now: () => NOW,
      selfPid: 1,
      kill,
      pidAlive: () => true,
      // Same pid, but it started long after the brain wrote its first beat.
      processIdentity: () => ({ startedAtMs: NOW - 30_000 }),
    });

    expect(result.action).toBe("already_exited");
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(runtimeDir, BRAIN_HEARTBEAT_FILE))).toBe(false);
    // No breadcrumb either: nothing wedged, so nothing to report as a wedge.
    expect(fs.existsSync(path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE))).toBe(false);
  });

  // A failed probe (no `ps`, a timeout, a fork failure) is not evidence. Deleting
  // the heartbeat here would erase a live brain's wedge, and the next check would
  // find nothing to judge -- the wedge would never be stopped.
  it("never kills a pid it cannot identify, and keeps the heartbeat", () => {
    const runtimeDir = tempRuntimeDir();
    writeBrainHeartbeat(runtimeDir, { pid: 4242, ts: NOW - 600_000, seq: 3, startedAt: 1 });
    const kill = vi.fn();
    const result = runBrainWatchdogCheck({
      runtimeDir,
      now: () => NOW,
      selfPid: 1,
      kill,
      pidAlive: () => true,
      processIdentity: () => null,
    });

    expect(result.action).toBe("already_exited");
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(runtimeDir, BRAIN_HEARTBEAT_FILE))).toBe(true);
    expect(result.message).toContain("no way to tell");
  });

  it("leaves the wedge kill to the supervisor on Windows", () => {
    const runtimeDir = tempRuntimeDir();
    writeBrainHeartbeat(runtimeDir, { pid: 4242, ts: NOW - 600_000, seq: 3, startedAt: 1 });
    const kill = vi.fn();
    const processIdentity = vi.fn(MATCHING_IDENTITY);
    const result = runBrainWatchdogCheck({
      runtimeDir,
      now: () => NOW,
      selfPid: 1,
      kill,
      pidAlive: () => true,
      platform: "win32",
      processIdentity,
    });

    expect(result.action).toBe("already_exited");
    expect(kill).not.toHaveBeenCalled();
    expect(processIdentity).not.toHaveBeenCalled();
    // The supervisor still reads that file to find its own wedged child.
    expect(fs.existsSync(path.join(runtimeDir, BRAIN_HEARTBEAT_FILE))).toBe(true);
  });

  it("never kills the process running the check", () => {
    const runtimeDir = tempRuntimeDir();
    writeBrainHeartbeat(runtimeDir, { pid: 4242, ts: NOW - 600_000, seq: 3, startedAt: 1 });
    const kill = vi.fn();
    const result = runBrainWatchdogCheck({
      runtimeDir,
      now: () => NOW,
      selfPid: 4242,
      kill,
      pidAlive: () => true,
    });
    expect(result.action).toBe("self");
    expect(kill).not.toHaveBeenCalled();
  });
});
