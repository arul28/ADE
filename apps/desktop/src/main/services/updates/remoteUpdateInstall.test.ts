import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateTrack } from "../../../shared/updateTrack";
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
      startTrackSwitch: vi.fn((target: UpdateTrack) => ({ ok: true as const, target })),
      onStateChange: (cb: (next: AutoUpdateSnapshot) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
  };
}

const logger = { info: vi.fn(), warn: vi.fn() };
const allowTrackSwitch = async (target: UpdateTrack) => ({ allowed: true as const, target, targetVersion: null });

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
      checkTrackSwitch: allowTrackSwitch,
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
    // Marked as remote, so the updated machine does not open "What's new" for nobody.
    expect(updates.quitAndInstall).toHaveBeenCalledWith(true, { requestedRemotely: true });
  });

  it("downloads first and installs once the download lands", async () => {
    vi.useFakeTimers();
    const updates = createUpdateService({ status: "idle" }, (set) => {
      set({ status: "downloading", version: "1.2.91" });
    });
    const installer = createRemoteUpdateInstaller({
      getService: () => updates.service,
      supported: true,
      checkTrackSwitch: allowTrackSwitch,
      logger,
      installDelayMs: 1_000,
    });

    const answer = await installer.install({ targetVersion: "1.2.91" });
    expect(answer.outcome).toBe("downloading");

    updates.set({ status: "ready", version: "1.2.91" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["1.2.90", "installing", 1],
    ["1.3.0-beta.3", "no_update", 0],
  ] as const)("only installs a Stable build during a switch from Beta, with %s offered", async (version, outcome, installs) => {
    vi.useFakeTimers();
    const updates = createUpdateService({ currentVersion: "1.3.0-beta.2" }, (set) => {
      set({ status: "ready", version });
    });
    const installer = createRemoteUpdateInstaller({
      getService: () => updates.service,
      supported: true,
      checkTrackSwitch: allowTrackSwitch,
      logger,
      installDelayMs: 1_000,
    });

    expect((await installer.switchTrack({ track: "stable" })).outcome).toBe(outcome);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.quitAndInstall).toHaveBeenCalledTimes(installs);
  });

  it("does not install a download that failed", async () => {
    vi.useFakeTimers();
    const updates = createUpdateService({ status: "downloading", version: "1.2.91" });
    const installer = createRemoteUpdateInstaller({
      getService: () => updates.service,
      supported: true,
      checkTrackSwitch: allowTrackSwitch,
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
      checkTrackSwitch: allowTrackSwitch,
      logger,
      installDelayMs: 1_000,
    });

    const answer = await installer.install({ targetVersion: "1.2.91" });
    expect(answer.outcome).toBe(outcome);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updates.quitAndInstall).not.toHaveBeenCalled();
  });
});
