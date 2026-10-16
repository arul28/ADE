import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutoUpdateSnapshot } from "../../../shared/types";
import { createRemoteUpdateInstaller } from "./remoteUpdateInstall";

/**
 * Stands in for the auto-update service, which wraps electron-updater (the
 * network feed and the native installer). `onCheck` scripts what the feed does.
 */
function createUpdateService(
  initial: Partial<AutoUpdateSnapshot>,
  onCheck: (set: (patch: Partial<AutoUpdateSnapshot>) => void) => Promise<void> | void = () => {},
) {
  let snapshot = {
    status: "idle",
    currentVersion: "1.2.90",
    latestKnownVersion: null,
    version: null,
    error: null,
    ...initial,
  } as AutoUpdateSnapshot;
  const listeners = new Set<(next: AutoUpdateSnapshot) => void>();
  const set = (patch: Partial<AutoUpdateSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener(snapshot);
  };
  const quitAndInstall = vi.fn(async () => true);
  return {
    set,
    quitAndInstall,
    service: {
      getSnapshot: () => snapshot,
      checkForUpdates: vi.fn(async () => {
        await onCheck(set);
      }),
      quitAndInstall,
      onStateChange: (cb: (next: AutoUpdateSnapshot) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
  };
}

const logger = { info: vi.fn(), warn: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
});

describe("createRemoteUpdateInstaller", () => {
  it("installs a staged update, but only after the brain has had time to reply", async () => {
    vi.useFakeTimers();
    const updates = createUpdateService({ status: "ready", version: "1.2.91" });
    const installer = createRemoteUpdateInstaller({
      getService: () => updates.service,
      supported: true,
      logger,
      installDelayMs: 1_500,
    });

    const answer = await installer.install({ targetVersion: "1.2.91" });

    expect(answer).toMatchObject({ outcome: "installing", version: "1.2.91" });
    // The service uninstall inside the install kills the brain that asked.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.quitAndInstall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(updates.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("downloads first and installs once the download lands", async () => {
    vi.useFakeTimers();
    const updates = createUpdateService({ status: "idle" }, (set) => {
      set({ status: "downloading", version: "1.2.91" });
    });
    const installer = createRemoteUpdateInstaller({
      getService: () => updates.service,
      supported: true,
      logger,
      installDelayMs: 1_000,
    });

    const answer = await installer.install({ targetVersion: "1.2.91" });
    expect(answer.outcome).toBe("downloading");

    updates.set({ status: "ready", version: "1.2.91" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("does not install a download that failed", async () => {
    vi.useFakeTimers();
    const updates = createUpdateService({ status: "downloading", version: "1.2.91" });
    const installer = createRemoteUpdateInstaller({
      getService: () => updates.service,
      supported: true,
      logger,
      installDelayMs: 1_000,
    });

    expect((await installer.install({ targetVersion: "1.2.91" })).outcome).toBe("downloading");
    updates.set({ status: "error", error: "network" });
    updates.set({ status: "ready", version: "1.2.91" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updates.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each([
    ["the app already runs the target", { status: "idle", currentVersion: "1.2.91" }, true, () => {}, "already_current"],
    ["this build cannot update itself", { status: "ready", version: "1.2.91" }, false, () => {}, "unsupported"],
    ["the feed has nothing newer", { status: "idle" }, true, () => {}, "no_update"],
    ["the feed only has an older build", { status: "idle" }, true,
      (set: (patch: Partial<AutoUpdateSnapshot>) => void) => set({ status: "ready", version: "1.2.90" }), "no_update"],
    ["the check fails", { status: "idle" }, true,
      (set: (patch: Partial<AutoUpdateSnapshot>) => void) => set({ status: "error", error: "offline" }), "failed"],
  ] as const)("declines without installing when %s", async (_label, initial, supported, onCheck, outcome) => {
    vi.useFakeTimers();
    const updates = createUpdateService(initial as Partial<AutoUpdateSnapshot>, onCheck);
    const installer = createRemoteUpdateInstaller({
      getService: () => updates.service,
      supported,
      logger,
      installDelayMs: 1_000,
    });

    const answer = await installer.install({ targetVersion: "1.2.91" });
    expect(answer.outcome).toBe(outcome);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updates.quitAndInstall).not.toHaveBeenCalled();
  });
});
