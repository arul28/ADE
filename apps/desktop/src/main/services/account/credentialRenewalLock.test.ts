import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withCredentialRenewalLock } from "./credentialRenewalLock";

const dirs: string[] = [];

function lockDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-renewal-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("withCredentialRenewalLock", () => {
  it("keeps a renewal that runs longer than the stale age from being taken over", async () => {
    vi.useFakeTimers({ now: Date.now() });
    const dir = lockDir();
    const order: string[] = [];
    let finishFirst!: () => void;

    const first = withCredentialRenewalLock(dir, "renew.lock", async () => {
      order.push("first started");
      await new Promise<void>((resolve) => { finishFirst = resolve; });
      order.push("first finished");
    }, { staleMs: 300 });
    await vi.advanceTimersByTimeAsync(0);
    const second = withCredentialRenewalLock(dir, "renew.lock", async () => {
      order.push("second ran");
    }, { staleMs: 300, timeoutMs: 60_000 });

    // Five times the stale age: a holder that stopped refreshing its file would be taken over.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(order).toEqual(["first started"]);

    finishFirst();
    await first;
    await vi.advanceTimersByTimeAsync(100);
    await second;
    expect(order).toEqual(["first started", "first finished", "second ran"]);
    expect(fs.existsSync(path.join(dir, "renew.lock"))).toBe(false);
  });

  it("leaves a later holder's lock file in place when it releases", async () => {
    const dir = lockDir();
    const lockPath = path.join(dir, "renew.lock");
    const laterHolder = { pid: 4242, nonce: "later-holder" };

    const result = await withCredentialRenewalLock(dir, "renew.lock", async () => {
      // Another process took the lock over while this renewal ran. (Written in
      // place: Windows refuses a new file over a deleted one that is still open.)
      fs.writeFileSync(lockPath, JSON.stringify(laterHolder));
      return "renewed";
    });

    expect(result).toBe("renewed");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(laterHolder);
  });
});
