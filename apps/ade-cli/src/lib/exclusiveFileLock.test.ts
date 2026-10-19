import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExclusiveFileLockTimeoutError, withExclusiveFileLock } from "./exclusiveFileLock";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempLockPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-exclusive-lock-"));
  tempDirs.push(dir);
  return path.join(dir, "service-install.lock");
}

describe("withExclusiveFileLock", () => {
  it("runs one holder at a time and reaps a lock left by a dead owner", async () => {
    const lockPath = tempLockPath();
    // A pid that has already exited: the lock a killed installer leaves behind.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    fs.writeFileSync(lockPath, JSON.stringify({ id: "left-behind", pid: deadPid }));
    const options = { waitMs: 5_000, label: "test lock" };
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withExclusiveFileLock(lockPath, async () => {
      events.push("first:start");
      await held;
      events.push("first:end");
    }, options);
    const second = withExclusiveFileLock(lockPath, async () => {
      events.push("second");
    }, options);
    release();
    await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second"]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("gives up with its named timeout error, and never runs the task, when the holder outlasts the wait", async () => {
    const lockPath = tempLockPath();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withExclusiveFileLock(lockPath, () => held, { waitMs: 5_000, label: "test lock" });
    let ran = false;

    await expect(withExclusiveFileLock(lockPath, async () => {
      ran = true;
    }, { waitMs: 150, label: "test lock" })).rejects.toThrow(ExclusiveFileLockTimeoutError);
    expect(ran).toBe(false);

    release();
    await holder;
  });
});
