import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireToolLock, isToolLockContention } from "./lock";

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

let root = "";

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-tool-lock-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", realPlatform);
  await fsp.rm(root, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function lockRecord(overrides: Partial<{ pid: number; host: string }> = {}): string {
  return JSON.stringify({
    pid: overrides.pid ?? process.pid,
    host: overrides.host ?? os.hostname(),
    startedAt: new Date().toISOString(),
  });
}

describe("isToolLockContention", () => {
  it("treats EEXIST as contention on every platform", () => {
    expect(isToolLockContention(errno("EEXIST"))).toBe(true);
  });

  it("treats the Windows delete-pending codes as contention only on win32", () => {
    setPlatform("win32");
    expect(isToolLockContention(errno("EPERM"))).toBe(true);
    expect(isToolLockContention(errno("EACCES"))).toBe(true);
    expect(isToolLockContention(errno("EBUSY"))).toBe(true);

    setPlatform("linux");
    expect(isToolLockContention(errno("EPERM"))).toBe(false);
    expect(isToolLockContention(errno("EACCES"))).toBe(false);
    expect(isToolLockContention(errno("EBUSY"))).toBe(false);
  });

  it("never treats an unrelated failure as contention", () => {
    setPlatform("win32");
    expect(isToolLockContention(errno("ENOSPC"))).toBe(false);
    expect(isToolLockContention(new Error("boom"))).toBe(false);
    expect(isToolLockContention(null)).toBe(false);
  });
});

describe("acquireToolLock", () => {
  it("keeps waiting when Windows reports a delete-pending lock as EPERM/EACCES/EBUSY", async () => {
    // The regression: `open(path, "wx")` against a lock another process is
    // mid-unlink of fails with EPERM/EACCES/EBUSY on Windows, not EEXIST.
    // Rethrowing those turned a benign race into a hard install failure.
    setPlatform("win32");
    const lockPath = path.join(root, "locks", "codex.lock");
    // A live, non-stale holder's record, so the stale-takeover branch does not
    // short-circuit the wait this asserts on.
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    await fsp.writeFile(lockPath, lockRecord());

    const codes = ["EPERM", "EACCES", "EBUSY"];
    let attempts = 0;
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      attempts += 1;
      const code = codes[attempts - 1];
      if (code) throw errno(code);
      // The "holder" finally finished: its name is gone and we win the create.
      await fsp.rm(lockPath, { force: true });
      return realOpen(...args);
    });

    const sleep = vi.fn(async () => undefined);
    const acquisition = await acquireToolLock({ lockPath, sleep, pollIntervalMs: 1 });

    expect(acquisition.kind).toBe("acquired");
    expect(attempts).toBe(codes.length + 1);
    expect(sleep).toHaveBeenCalledTimes(codes.length);
  });

  it("still rethrows a genuine filesystem failure as a typed ToolError", async () => {
    const lockPath = path.join(root, "locks", "codex.lock");
    vi.spyOn(fsp, "open").mockRejectedValue(errno("ENOSPC"));

    await expect(
      acquireToolLock({ lockPath, sleep: async () => undefined }),
    ).rejects.toMatchObject({ name: "ToolError", kind: "filesystem" });
  });

  it("release() leaves a lock alone once another process has reclaimed it", async () => {
    // Our lock went stale, a second process took it over and wrote its own
    // record. A late unconditional rm here would release *their* lock and let
    // two installs race the same cache directory.
    const lockPath = path.join(root, "locks", "codex.lock");
    const acquisition = await acquireToolLock({ lockPath, sleep: async () => undefined });
    if (acquisition.kind !== "acquired") throw new Error("expected to acquire the lock");

    const stolen = lockRecord({ pid: process.pid + 1_000, host: "some-other-host" });
    await fsp.writeFile(lockPath, stolen);

    await acquisition.release();

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(stolen);
  });

  it("polls instead of spinning when a stale lock cannot be removed", async () => {
    // A lock that reads as permanently stale but cannot be unlinked (an
    // unremovable file, a denied directory, a Windows handle still open on it)
    // used to retry the takeover with no sleep between attempts, spinning a core
    // in syscalls for the whole 15-minute deadline.
    const lockPath = path.join(root, "locks", "codex.lock");
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    // This host, a pid far above any pid_max: the stale check sees a dead
    // holder without depending on wall-clock mtime, which the fake clock below
    // would otherwise make meaningless.
    await fsp.writeFile(lockPath, lockRecord({ pid: 4_000_000 }));

    let clock = 0;
    let removeAttempts = 0;
    vi.spyOn(fsp, "rm").mockImplementation(async () => {
      removeAttempts += 1;
      // Advance a little so a regression terminates on the deadline instead of
      // hanging the suite; it just does so having never slept.
      clock += 1;
      throw errno("EPERM");
    });
    const sleep = vi.fn(async () => {
      clock += 250;
    });

    await expect(
      acquireToolLock({ lockPath, sleep, pollIntervalMs: 250, timeoutMs: 1_000, now: () => clock }),
    ).rejects.toMatchObject({ name: "ToolError", kind: "lock-timeout" });

    expect(sleep).toHaveBeenCalled();
    expect(removeAttempts).toBeLessThan(10);
  });

  it("stops the heartbeat once another process has reclaimed the lock", async () => {
    // The mirror of the release() guard: a stalled holder whose heartbeat kept
    // running would keep refreshing the new owner's mtime, so that owner's lock
    // could never age out if it died.
    vi.useFakeTimers();
    try {
      const lockPath = path.join(root, "locks", "codex.lock");
      const acquisition = await acquireToolLock({
        lockPath,
        sleep: async () => undefined,
        staleMs: 4_000,
      });
      if (acquisition.kind !== "acquired") throw new Error("expected to acquire the lock");

      const utimes = vi.spyOn(fs, "utimesSync");
      vi.advanceTimersByTime(1_000);
      expect(utimes).toHaveBeenCalledTimes(1);

      fs.writeFileSync(lockPath, lockRecord({ pid: process.pid + 1_000, host: "some-other-host" }));
      vi.advanceTimersByTime(10_000);

      expect(utimes).toHaveBeenCalledTimes(1);
      await acquisition.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("release() removes the lock it actually wrote", async () => {
    const lockPath = path.join(root, "locks", "codex.lock");
    const acquisition = await acquireToolLock({ lockPath, sleep: async () => undefined });
    if (acquisition.kind !== "acquired") throw new Error("expected to acquire the lock");

    await acquisition.release();

    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
