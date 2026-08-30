import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncRoleSnapshot } from "../../shared/types";
import {
  LOCAL_SYNC_STATUS_BACKOFF_MAX_MS,
  localSyncStatusBackoffMs,
  readLocalSyncStatus,
  resetLocalSyncStatusReaderForTests,
} from "./localSyncStatusReader";

function snapshot(degradedReason?: string): SyncRoleSnapshot {
  return {
    ...(degradedReason ? { degradedReason } : {}),
    localDevice: { deviceId: "dev-1" },
  } as unknown as SyncRoleSnapshot;
}

let nowMs = 0;
let getLocalStatus: ReturnType<typeof vi.fn>;

beforeEach(() => {
  nowMs = 1_000_000;
  resetLocalSyncStatusReaderForTests(() => nowMs);
  getLocalStatus = vi.fn(async () => snapshot());
  (globalThis as unknown as { window: unknown }).window = {
    ade: { sync: { getLocalStatus: (...args: unknown[]) => getLocalStatus(...args) } },
  };
});

afterEach(() => {
  resetLocalSyncStatusReaderForTests();
});

describe("localSyncStatusBackoffMs", () => {
  it("is zero while healthy and doubles per consecutive failure up to the cap", () => {
    expect(localSyncStatusBackoffMs(0)).toBe(0);
    expect(localSyncStatusBackoffMs(1)).toBe(1_000);
    expect(localSyncStatusBackoffMs(2)).toBe(2_000);
    expect(localSyncStatusBackoffMs(3)).toBe(4_000);
    expect(localSyncStatusBackoffMs(6)).toBe(LOCAL_SYNC_STATUS_BACKOFF_MAX_MS);
    // A day-long outage must not overflow past the cap.
    expect(localSyncStatusBackoffMs(5_000)).toBe(LOCAL_SYNC_STATUS_BACKOFF_MAX_MS);
  });
});

describe("readLocalSyncStatus", () => {
  it("coalesces concurrent readers into one invoke", async () => {
    let release: (value: SyncRoleSnapshot) => void = () => {};
    getLocalStatus.mockImplementation(
      () => new Promise<SyncRoleSnapshot>((resolve) => { release = resolve; }),
    );
    const reads = [readLocalSyncStatus(), readLocalSyncStatus(), readLocalSyncStatus()];
    // The reader defers the invoke by a microtask, so let it start first.
    await Promise.resolve();
    await Promise.resolve();
    release(snapshot());
    const results = await Promise.all(reads);
    expect(getLocalStatus).toHaveBeenCalledTimes(1);
    expect(results.every((value) => value === results[0])).toBe(true);
  });

  it("keeps the healthy cadence: every sequential read hits the runtime", async () => {
    await readLocalSyncStatus();
    await readLocalSyncStatus();
    await readLocalSyncStatus();
    expect(getLocalStatus).toHaveBeenCalledTimes(3);
  });

  it("backs off after a rejected read and retries once the window elapses", async () => {
    getLocalStatus.mockRejectedValueOnce(new Error("runtime unreachable"));
    await expect(readLocalSyncStatus()).rejects.toThrow("runtime unreachable");
    // Inside the 1s window the cached rejection is replayed with no invoke.
    nowMs += 500;
    await expect(readLocalSyncStatus()).rejects.toThrow("runtime unreachable");
    expect(getLocalStatus).toHaveBeenCalledTimes(1);
    nowMs += 600;
    await expect(readLocalSyncStatus()).resolves.toBeTruthy();
    expect(getLocalStatus).toHaveBeenCalledTimes(2);
  });

  it("backs off on a degraded snapshot and replays it instead of re-invoking", async () => {
    getLocalStatus.mockResolvedValue(snapshot("The ADE background service is not reachable."));
    const first = await readLocalSyncStatus();
    expect(first.degradedReason).toBeTruthy();
    nowMs += 200;
    await expect(readLocalSyncStatus()).resolves.toBe(first);
    expect(getLocalStatus).toHaveBeenCalledTimes(1);
  });

  it("lets a forced read through the backoff window", async () => {
    getLocalStatus.mockResolvedValue(snapshot("still down"));
    await readLocalSyncStatus();
    nowMs += 100;
    await readLocalSyncStatus();
    expect(getLocalStatus).toHaveBeenCalledTimes(1);
    await readLocalSyncStatus(undefined, { force: true });
    expect(getLocalStatus).toHaveBeenCalledTimes(2);
  });

  it("grows the window while degradation persists and resets it on recovery", async () => {
    getLocalStatus.mockResolvedValue(snapshot("still down"));
    await readLocalSyncStatus();
    nowMs += 1_001;
    await readLocalSyncStatus();
    // Second failure -> 2s window, so a 1.5s wait is still suppressed.
    nowMs += 1_500;
    await readLocalSyncStatus();
    expect(getLocalStatus).toHaveBeenCalledTimes(2);
    nowMs += 600;
    getLocalStatus.mockResolvedValue(snapshot());
    await readLocalSyncStatus();
    expect(getLocalStatus).toHaveBeenCalledTimes(3);
    // Healthy again: no suppression at all.
    await readLocalSyncStatus();
    await readLocalSyncStatus();
    expect(getLocalStatus).toHaveBeenCalledTimes(5);
  });
});
