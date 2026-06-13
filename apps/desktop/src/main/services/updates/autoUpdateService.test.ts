import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareUpdateVersions, createAutoUpdateService } from "./autoUpdateService";
import type { Logger } from "../logging/logger";

class FakeAutoUpdater extends EventEmitter {
  logger: Logger | null = null;
  autoDownload = false;
  autoInstallOnAppQuit = true;
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn<[], Promise<unknown>>(async () => null);
  quitAndInstall = vi.fn();
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-auto-update-"));
  return path.join(dir, "ade-state.json");
}

function makeUpdaterCacheDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-updater-cache-"));
  fs.writeFileSync(path.join(dir, "update.zip"), "cached update", "utf8");
  fs.mkdirSync(path.join(dir, "pending"));
  fs.writeFileSync(
    path.join(dir, "pending", "ADE-1.2.3-universal-mac.zip"),
    "pending update",
    "utf8",
  );
  return dir;
}

function readState(globalStatePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(globalStatePath, "utf8"));
  } catch {
    return {};
  }
}

function expectCacheEmpty(updaterCacheDir: string): void {
  expect(fs.readdirSync(updaterCacheDir)).toEqual([]);
}

describe("createAutoUpdateService", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not schedule startup or periodic update checks when automatic checks are disabled", () => {
    vi.useFakeTimers();
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      startupDelayMs: 5_000,
      periodicCheckMs: 30 * 60_000,
      autoCheckEnabled: false,
      updater,
    });

    vi.advanceTimersByTime(60 * 60_000);

    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    service.dispose();
  });

  it("configures the GitHub update feed explicitly", () => {
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      autoCheckEnabled: false,
      updater,
    });

    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: "github",
      owner: "arul28",
      repo: "ADE",
    });

    service.dispose();
  });

  it("converts a pending install into a post-install notice on matching relaunch", () => {
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const logger = makeLogger();
    fs.writeFileSync(globalStatePath, JSON.stringify({
      pendingInstallUpdate: {
        fromVersion: "1.2.2",
        targetVersion: "1.2.3",
        releaseNotesUrl: "https://www.ade-app.dev/changelog/v1.2.3",
        requestedAt: "2026-04-06T15:20:00.000Z",
      },
    }), "utf8");

    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.3",
      globalStatePath,
      updaterCacheDir,
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      now: () => "2026-04-06T15:21:00.000Z",
      updater: new FakeAutoUpdater(),
    });

    expect(service.getSnapshot().recentlyInstalled).toEqual({
      version: "1.2.3",
      installedAt: "2026-04-06T15:21:00.000Z",
      releaseNotesUrl: "https://www.ade-app.dev/changelog/v1.2.3",
    });

    expect(JSON.parse(fs.readFileSync(globalStatePath, "utf8"))).toEqual({
      recentlyInstalledUpdate: {
        version: "1.2.3",
        installedAt: "2026-04-06T15:21:00.000Z",
        releaseNotesUrl: "https://www.ade-app.dev/changelog/v1.2.3",
      },
    });
    expectCacheEmpty(updaterCacheDir);
    expect(logger.info).toHaveBeenCalledWith(
      "autoUpdate.cache_cleaned",
      expect.objectContaining({ reason: "installed", entriesRemoved: 2 }),
    );

    service.dispose();
  });

  it("cleans cached downloads when a requested install relaunches on the old version", () => {
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const logger = makeLogger();
    fs.writeFileSync(globalStatePath, JSON.stringify({
      pendingInstallUpdate: {
        fromVersion: "1.2.2",
        targetVersion: "1.2.3",
        releaseNotesUrl: "https://www.ade-app.dev/changelog/v1.2.3",
        requestedAt: "2026-04-06T15:20:00.000Z",
      },
    }), "utf8");

    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.2",
      globalStatePath,
      updaterCacheDir,
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      now: () => "2026-04-06T15:21:00.000Z",
      updater: new FakeAutoUpdater(),
    });

    expect(readState(globalStatePath)).toEqual({});
    expectCacheEmpty(updaterCacheDir);
    expect(logger.info).toHaveBeenCalledWith(
      "autoUpdate.cache_cleaned",
      expect.objectContaining({ reason: "failed_install", entriesRemoved: 2 }),
    );

    service.dispose();
  });

  it("tracks download progress and persists the target version before quit-and-install", async () => {
    const globalStatePath = makeStatePath();
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath,
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      now: () => "2026-04-06T15:21:00.000Z",
      updater,
    });

    updater.emit("update-available", {
      version: "1.2.3",
    });
    updater.emit("download-progress", {
      percent: 62.4,
      bytesPerSecond: 128_000,
      transferred: 6_240_000,
      total: 10_000_000,
    });

    expect(service.getSnapshot()).toMatchObject({
      status: "downloading",
      version: "1.2.3",
      progressPercent: 62.4,
      bytesPerSecond: 128_000,
      transferredBytes: 6_240_000,
      totalBytes: 10_000_000,
      releaseNotesUrl: "https://www.ade-app.dev/changelog/v1.2.3",
    });

    updater.emit("update-downloaded", {
      version: "1.2.3",
    });

    expect(service.getSnapshot()).toMatchObject({
      status: "ready",
      version: "1.2.3",
      progressPercent: 100,
      releaseNotesUrl: "https://www.ade-app.dev/changelog/v1.2.3",
    });

    await expect(service.quitAndInstall()).resolves.toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);

    expect(readState(globalStatePath)).toEqual({
      pendingInstallUpdate: {
        fromVersion: "1.2.2",
        targetVersion: "1.2.3",
        releaseNotesUrl: "https://www.ade-app.dev/changelog/v1.2.3",
        requestedAt: "2026-04-06T15:21:00.000Z",
      },
    });

    service.dispose();
  });

  it("refreshes a stale ready update before installing so the target is the newest version", async () => {
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const logger = makeLogger();
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.2",
      globalStatePath,
      updaterCacheDir,
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      now: () => "2026-04-06T15:21:00.000Z",
      updater,
    });

    updater.emit("update-downloaded", {
      version: "1.2.3",
    });
    expect(service.getSnapshot()).toMatchObject({
      status: "ready",
      version: "1.2.3",
    });

    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("update-available", {
        version: "1.2.4",
      });
      return {
        downloadPromise: Promise.resolve().then(() => {
          updater.emit("update-downloaded", {
            version: "1.2.4",
          });
        }),
      };
    });

    await expect(service.quitAndInstall()).resolves.toBe(true);

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(readState(globalStatePath)).toEqual({
      pendingInstallUpdate: {
        fromVersion: "1.2.2",
        targetVersion: "1.2.4",
        releaseNotesUrl: "https://www.ade-app.dev/changelog/v1.2.4",
        requestedAt: "2026-04-06T15:21:00.000Z",
      },
    });
    expect(service.getSnapshot()).toMatchObject({
      status: "installing",
      version: "1.2.4",
    });
    expectCacheEmpty(updaterCacheDir);
    expect(logger.info).toHaveBeenCalledWith(
      "autoUpdate.cache_cleaned",
      expect.objectContaining({ reason: "superseded_ready_update", entriesRemoved: 2 }),
    );

    service.dispose();
  });

  it("does not install a ready update when latest-version verification fails", async () => {
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const logger = makeLogger();
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.2",
      globalStatePath,
      updaterCacheDir,
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      updater,
    });

    updater.emit("update-downloaded", {
      version: "1.2.3",
    });
    updater.checkForUpdates.mockRejectedValueOnce(new Error("network unavailable"));

    await expect(service.quitAndInstall()).resolves.toBe(false);

    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(readState(globalStatePath)).toEqual({});
    expect(service.getSnapshot()).toMatchObject({
      status: "error",
      error: "Could not verify the latest update before installing: network unavailable",
    });
    expectCacheEmpty(updaterCacheDir);
    expect(logger.warn).toHaveBeenCalledWith(
      "autoUpdate.refresh_ready_before_install_failed",
      expect.objectContaining({
        version: "1.2.3",
        message: "network unavailable",
      }),
    );

    service.dispose();
  });

  it("does not replace a ready update with an older downloaded event", () => {
    const globalStatePath = makeStatePath();
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath,
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      updater,
    });

    updater.emit("update-downloaded", {
      version: "1.2.4",
    });
    updater.emit("update-available", {
      version: "1.2.3",
    });
    updater.emit("download-progress", {
      percent: 25,
      bytesPerSecond: 128_000,
      transferred: 2_500_000,
      total: 10_000_000,
    });
    updater.emit("update-downloaded", {
      version: "1.2.3",
    });

    expect(service.getSnapshot()).toMatchObject({
      status: "ready",
      version: "1.2.4",
      releaseNotesUrl: "https://www.ade-app.dev/changelog/v1.2.4",
    });

    service.dispose();
  });

  it("cleans stale updater cache when no update is available", () => {
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const logger = makeLogger();
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.3",
      globalStatePath,
      updaterCacheDir,
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      updater,
    });

    updater.emit("update-not-available", {
      version: "1.2.3",
    });

    expectCacheEmpty(updaterCacheDir);
    expect(logger.info).toHaveBeenCalledWith(
      "autoUpdate.cache_cleaned",
      expect.objectContaining({ reason: "not_available", entriesRemoved: 2 }),
    );

    service.dispose();
  });

  it("rolls back pending install state when quit-and-install fails synchronously", async () => {
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const logger = makeLogger();
    const updater = new FakeAutoUpdater();
    updater.quitAndInstall = vi.fn(() => {
      throw new Error("The command is disabled and cannot be executed");
    });
    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.2",
      globalStatePath,
      updaterCacheDir,
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      now: () => "2026-04-06T15:21:00.000Z",
      updater,
    });

    updater.emit("update-downloaded", {
      version: "1.2.3",
    });

    await expect(service.quitAndInstall()).resolves.toBe(false);
    expect(service.getSnapshot()).toMatchObject({
      status: "error",
      error: "The command is disabled and cannot be executed",
    });
    expect(readState(globalStatePath)).toEqual({});
    expectCacheEmpty(updaterCacheDir);
    expect(logger.warn).toHaveBeenCalledWith(
      "autoUpdate.quit_and_install_failed",
      expect.objectContaining({
        version: "1.2.3",
        message: "The command is disabled and cannot be executed",
      }),
    );

    service.dispose();
  });

  it("runs the pre-install cleanup hook before handing off to the updater", async () => {
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const logger = makeLogger();
    const updater = new FakeAutoUpdater();
    const beforeQuitAndInstall = vi.fn(async () => {});
    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.2",
      globalStatePath,
      updaterCacheDir,
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      now: () => "2026-04-06T15:21:00.000Z",
      updater,
      beforeQuitAndInstall,
    });

    updater.emit("update-downloaded", {
      version: "1.2.3",
    });

    await expect(service.quitAndInstall()).resolves.toBe(true);
    expect(beforeQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(beforeQuitAndInstall.mock.invocationCallOrder[0]).toBeLessThan(
      updater.quitAndInstall.mock.invocationCallOrder[0],
    );
    expect(readState(globalStatePath)).toMatchObject({
      pendingInstallUpdate: {
        targetVersion: "1.2.3",
      },
    });

    service.dispose();
  });

  it("aborts install when pre-install cleanup fails", async () => {
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const logger = makeLogger();
    const updater = new FakeAutoUpdater();
    const beforeQuitAndInstall = vi.fn(async () => {
      throw new Error("Could not stop ADE service");
    });
    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.2",
      globalStatePath,
      updaterCacheDir,
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      updater,
      beforeQuitAndInstall,
    });

    updater.emit("update-downloaded", {
      version: "1.2.3",
    });

    await expect(service.quitAndInstall()).resolves.toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(readState(globalStatePath)).toEqual({});
    expect(service.getSnapshot()).toMatchObject({
      status: "error",
      error: "Could not stop ADE service",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "autoUpdate.prepare_quit_and_install_failed",
      expect.objectContaining({
        version: "1.2.3",
        message: "Could not stop ADE service",
      }),
    );

    service.dispose();
  });

  it("rolls back pending install state when an async install error arrives", async () => {
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const logger = makeLogger();
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.2",
      globalStatePath,
      updaterCacheDir,
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      now: () => "2026-04-06T15:21:00.000Z",
      updater,
    });

    updater.emit("update-downloaded", {
      version: "1.2.3",
    });

    await expect(service.quitAndInstall()).resolves.toBe(true);
    expect(readState(globalStatePath)).toMatchObject({
      pendingInstallUpdate: {
        targetVersion: "1.2.3",
      },
    });

    updater.emit("error", new Error("installer failed after launch"));

    expect(service.getSnapshot()).toMatchObject({
      status: "error",
      error: "installer failed after launch",
    });
    expect(readState(globalStatePath)).toEqual({});
    expectCacheEmpty(updaterCacheDir);

    service.dispose();
  });

  it("treats a relaunch on a version newer than the pending target as installed", () => {
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const logger = makeLogger();
    fs.writeFileSync(globalStatePath, JSON.stringify({
      pendingInstallUpdate: {
        fromVersion: "1.2.2",
        targetVersion: "1.2.3",
        releaseNotesUrl: "https://www.ade-app.dev/changelog/v1.2.3",
        requestedAt: "2026-04-06T15:20:00.000Z",
      },
    }), "utf8");

    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.4",
      globalStatePath,
      updaterCacheDir,
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      now: () => "2026-04-06T15:21:00.000Z",
      updater: new FakeAutoUpdater(),
    });

    expect(service.getSnapshot().recentlyInstalled).toEqual({
      version: "1.2.4",
      installedAt: "2026-04-06T15:21:00.000Z",
      releaseNotesUrl: "https://www.ade-app.dev/changelog/v1.2.4",
    });
    expectCacheEmpty(updaterCacheDir);

    service.dispose();
  });
});

describe("compareUpdateVersions", () => {
  it("orders semver versions including prereleases", () => {
    expect(compareUpdateVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareUpdateVersions("v1.2.4-beta.2", "1.2.4-beta.1")).toBeGreaterThan(0);
    expect(compareUpdateVersions("1.2.4", "1.2.4-beta.2")).toBeGreaterThan(0);
    expect(compareUpdateVersions("1.2.4", "v1.2.4")).toBe(0);
  });
});
