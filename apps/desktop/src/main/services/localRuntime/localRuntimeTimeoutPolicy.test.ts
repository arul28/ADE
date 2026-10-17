import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_RUNTIME_SYNC_STATUS_FALLBACK_HEADROOM_MS,
  LOCAL_RUNTIME_SYNC_STATUS_READ_TIMEOUT_MS,
  localRuntimeStartupConnectMaxMs,
  localRuntimeSyncStatusIpcTimeoutMs,
  localRuntimeSyncStatusOverallTimeoutMs,
} from "./localRuntimeTimeoutPolicy";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("sync status read budgets", () => {
  it.each(["darwin", "win32", "linux"] as const)(
    "keeps the chain ordered on %s: a cold connect plus the read fits under the cap, and the IPC timer outlives it",
    (platform) => {
      const overall = localRuntimeSyncStatusOverallTimeoutMs(platform);

      expect(overall).toBeGreaterThanOrEqual(
        localRuntimeStartupConnectMaxMs(platform) + LOCAL_RUNTIME_SYNC_STATUS_READ_TIMEOUT_MS,
      );
      expect(localRuntimeSyncStatusIpcTimeoutMs(platform) - overall).toBe(
        LOCAL_RUNTIME_SYNC_STATUS_FALLBACK_HEADROOM_MS,
      );
    },
  );

  it("keeps macOS at its existing values, so a dead runtime there still answers in 25s", () => {
    expect(localRuntimeSyncStatusOverallTimeoutMs("darwin")).toBe(25_000);
    expect(localRuntimeSyncStatusIpcTimeoutMs("darwin")).toBe(30_000);
  });

  it("gives Windows its full 30s cold-start connect before the read", () => {
    expect(localRuntimeStartupConnectMaxMs("win32")).toBe(30_000);
    expect(localRuntimeSyncStatusOverallTimeoutMs("win32")).toBe(45_000);
    expect(localRuntimeSyncStatusIpcTimeoutMs("win32")).toBe(50_000);
  });

  describe("as a Windows process loads them", () => {
    afterEach(() => {
      setPlatform(originalPlatform);
      vi.resetModules();
    });

    it("gives the cap a value that outlives a cold 30s connect plus the read", async () => {
      setPlatform("win32");
      vi.resetModules();
      const policy = await import("./localRuntimeTimeoutPolicy");

      expect(policy.LOCAL_RUNTIME_SYNC_STATUS_OVERALL_TIMEOUT_MS).toBeGreaterThan(30_000 + 8_000);
      expect(policy.LOCAL_RUNTIME_SYNC_STATUS_IPC_TIMEOUT_MS).toBeGreaterThan(
        policy.LOCAL_RUNTIME_SYNC_STATUS_OVERALL_TIMEOUT_MS,
      );
    });
  });
});
