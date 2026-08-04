import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withSocketSpawnLock } from "./socketSpawnLock";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-spawn-lock-"));
  tempDirs.push(dir);
  return path.join(dir, "ade.sock");
}

describe("withSocketSpawnLock", () => {
  it("serialises concurrent spawn claims for the same socket", async () => {
    const socketPath = tempSocketPath();
    let concurrent = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 8 }, () => withSocketSpawnLock(socketPath, async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
    })));
    expect(peak).toBe(1);
    expect(fs.existsSync(`${socketPath}.spawn.lock`)).toBe(false);
  });

  it("surfaces a permission failure as itself, not as lock contention", async () => {
    // The contention branch used to widen to EPERM/EACCES on Windows, on the
    // theory that a delete-pending name surfaces as one of those. Measured
    // false: libuv opens with FILE_SHARE_DELETE, so unlink-while-open succeeds
    // and the next `open(..., "wx")` succeeds too -- a 10-process contention run
    // produced ONLY EEXIST. The cost of the widened branch was real: a genuine
    // ACL denial on the lock directory was retried for the full 10s deadline
    // and then reported as "Timed out waiting for ADE socket spawn lock",
    // hiding the one error the user could act on.
    const socketPath = tempSocketPath();
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const realOpenSync = fs.openSync;
    (fs as { openSync: typeof fs.openSync }).openSync = (() => {
      throw denied;
    }) as typeof fs.openSync;
    try {
      const started = Date.now();
      await expect(withSocketSpawnLock(socketPath, async () => "unreachable"))
        .rejects.toThrow(/permission denied/);
      // It must fail immediately, not after burning the 10s contention deadline.
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      (fs as { openSync: typeof fs.openSync }).openSync = realOpenSync;
    }
  });
});
