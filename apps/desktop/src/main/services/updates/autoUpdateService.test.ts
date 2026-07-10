import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGithubReleaseUrl, buildReleaseNotesUrl, compareUpdateVersions, createAutoUpdateService } from "./autoUpdateService";
import { classifyUpdateError, estimateUpdateRequiredBytes } from "./autoUpdateErrors";
import type { Logger } from "../logging/logger";

const electronAppMock = vi.hoisted(() => ({ isPackaged: false }));
vi.mock("electron", () => ({ app: electronAppMock }));

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

describe("buildReleaseNotesUrl", () => {
  it("points release notes at the docs changelog route", () => {
    expect(buildReleaseNotesUrl("v1.2.11")).toBe("https://www.ade-app.dev/docs/changelog/v1.2.11");
    expect(buildReleaseNotesUrl("1.2.11", "https://staging.ade-app.dev/")).toBe("https://staging.ade-app.dev/docs/changelog/v1.2.11");
    expect(buildReleaseNotesUrl(" ", "https://www.ade-app.dev")).toBeNull();
  });
});

describe("buildGithubReleaseUrl", () => {
  it("points at the GitHub release tag and normalizes the version", () => {
    expect(buildGithubReleaseUrl("1.2.18")).toBe("https://github.com/arul28/ADE/releases/tag/v1.2.18");
    expect(buildGithubReleaseUrl("v1.2.18")).toBe("https://github.com/arul28/ADE/releases/tag/v1.2.18");
    expect(buildGithubReleaseUrl(" ")).toBeNull();
  });
});

describe("auto-update error classification", () => {
  it("classifies read-only filesystem failures as permission errors in each phase", () => {
    const downloadError = new Error("read-only file system") as NodeJS.ErrnoException;
    downloadError.code = "EROFS";
    expect(classifyUpdateError(downloadError, "download")).toEqual({
      kind: "permission",
      phase: "download",
    });
    expect(classifyUpdateError(new Error("Cannot write: read-only file system"), "install")).toEqual({
      kind: "permission",
      phase: "install",
    });
  });

  it("recognizes extraction failures as staging failures", () => {
    const error = new Error("ShipIt could not extract archive: no space left") as NodeJS.ErrnoException;
    error.code = "ENOSPC";
    expect(classifyUpdateError(error, "install")).toEqual({
      kind: "disk_full",
      phase: "staging",
    });
  });

  it("uses conservative compressed-size defaults", () => {
    expect(estimateUpdateRequiredBytes("download", null)).toBe(1536 * 1024 * 1024);
    expect(estimateUpdateRequiredBytes("install", null)).toBe(3072 * 1024 * 1024);
  });
});

describe("createAutoUpdateService", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    electronAppMock.isPackaged = false;
    delete process.env.ADE_UPDATE_FEED_URL;
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

  it("ignores ADE_UPDATE_FEED_URL in packaged builds and uses the GitHub feed", () => {
    electronAppMock.isPackaged = true;
    process.env.ADE_UPDATE_FEED_URL = "https://attacker.example.com/feed";
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
    expect(updater.setFeedURL).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "generic" }),
    );

    service.dispose();
  });

  it("honors ADE_UPDATE_FEED_URL in non-packaged builds", () => {
    electronAppMock.isPackaged = false;
    process.env.ADE_UPDATE_FEED_URL = "https://localhost:9999/feed";
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
      provider: "generic",
      url: "https://localhost:9999/feed",
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
      releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.2.3",
      githubReleaseUrl: "https://github.com/arul28/ADE/releases/tag/v1.2.3",
    });

    expect(JSON.parse(fs.readFileSync(globalStatePath, "utf8"))).toEqual({
      recentlyInstalledUpdate: {
        version: "1.2.3",
        installedAt: "2026-04-06T15:21:00.000Z",
        releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.2.3",
        githubReleaseUrl: "https://github.com/arul28/ADE/releases/tag/v1.2.3",
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
        releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.2.3",
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
      releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.2.3",
    });

    updater.emit("update-downloaded", {
      version: "1.2.3",
    });

    expect(service.getSnapshot()).toMatchObject({
      status: "ready",
      version: "1.2.3",
      progressPercent: 100,
      releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.2.3",
    });

    await expect(service.quitAndInstall()).resolves.toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);

    expect(readState(globalStatePath)).toEqual({
      pendingInstallUpdate: {
        fromVersion: "1.2.2",
        targetVersion: "1.2.3",
        releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.2.3",
        requestedAt: "2026-04-06T15:21:00.000Z",
      },
    });

    service.dispose();
  });

  it("blocks a download when the updater cache volume has insufficient space", async () => {
    const updater = Object.assign(new FakeAutoUpdater(), {
      downloadUpdate: vi.fn(async () => undefined),
    });
    const updateInfo = {
      version: "1.2.3",
      files: [{ url: "ADE-1.2.3-mac.zip", size: 200 * 1024 * 1024, sha512: "test" }],
    };
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", updateInfo);
      return { updateInfo };
    });
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir: "/Volumes/Test/ADE-updater",
      installTargetPath: "/Applications/ADE.app",
      getDiskSpace: () => ({
        availableBytes: 128 * 1024 * 1024,
        volumePath: "/Volumes/Test",
      }),
      autoCheckEnabled: false,
      updater,
    });

    service.checkForUpdates();

    await vi.waitFor(() => {
      expect(service.getSnapshot()).toMatchObject({
        status: "error",
        currentVersion: "1.2.2",
        version: "1.2.3",
        error: "Not enough space to update ADE.",
        errorDetails: {
          kind: "insufficient_space",
          phase: "download",
          availableBytes: 128 * 1024 * 1024,
          requiredBytes: 912 * 1024 * 1024,
          volumePath: "/Volumes/Test",
          preservesDownload: false,
        },
      });
    });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();

    service.dispose();
  });

  it("preflights the install volume and preserves the verified download when space is low", async () => {
    const updaterCacheDir = makeUpdaterCacheDir();
    const updater = new FakeAutoUpdater();
    const getDiskSpace = vi.fn(() => ({
      availableBytes: 1024 * 1024 * 1024,
      volumePath: "/System/Volumes/Data",
    }));
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir,
      installTargetPath: "/Applications/ADE.app/Contents/MacOS/ADE",
      getDiskSpace,
      autoCheckEnabled: false,
      updater,
    });
    updater.emit("update-downloaded", {
      version: "1.2.3",
      files: [{ url: "ADE-1.2.3-mac.zip", size: 300 * 1024 * 1024, sha512: "test" }],
    });

    await expect(service.quitAndInstall()).resolves.toBe(false);

    expect(getDiskSpace).toHaveBeenCalledWith("/Applications/ADE.app/Contents/MacOS/ADE");
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toMatchObject({
      status: "error",
      errorDetails: {
        kind: "insufficient_space",
        phase: "install",
        availableBytes: 1024 * 1024 * 1024,
        requiredBytes: 2012 * 1024 * 1024,
        volumePath: "/System/Volumes/Data",
        preservesDownload: true,
      },
    });
    expect(fs.readdirSync(updaterCacheDir).sort()).toEqual(["pending", "update.zip"]);

    service.dispose();
  });

  it("classifies a synchronous ENOSPC handoff failure and keeps the downloaded update", async () => {
    const updaterCacheDir = makeUpdaterCacheDir();
    const updater = new FakeAutoUpdater();
    updater.quitAndInstall = vi.fn(() => {
      const error = new Error("no space left on device") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    });
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir,
      getDiskSpace: () => ({
        availableBytes: 20 * 1024 * 1024 * 1024,
        volumePath: "/System/Volumes/Data",
      }),
      autoCheckEnabled: false,
      updater,
    });
    updater.emit("update-downloaded", { version: "1.2.3" });

    await expect(service.quitAndInstall()).resolves.toBe(false);

    expect(service.getSnapshot()).toMatchObject({
      status: "error",
      errorDetails: {
        kind: "disk_full",
        phase: "install",
        preservesDownload: true,
      },
    });
    expect(fs.readdirSync(updaterCacheDir).sort()).toEqual(["pending", "update.zip"]);

    service.dispose();
  });

  it("classifies EDQUOT during download separately from generic updater failures", async () => {
    const updater = Object.assign(new FakeAutoUpdater(), {
      downloadUpdate: vi.fn(async () => undefined),
    });
    const updateInfo = {
      version: "1.2.3",
      files: [{ url: "ADE-1.2.3-mac.zip", size: 100 * 1024 * 1024, sha512: "test" }],
    };
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", updateInfo);
      return { updateInfo };
    });
    updater.downloadUpdate.mockImplementation(async () => {
      const error = new Error("disk quota exceeded") as NodeJS.ErrnoException;
      error.code = "EDQUOT";
      throw error;
    });
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir: "/Volumes/Test/ADE-updater",
      getDiskSpace: () => ({
        availableBytes: 4 * 1024 * 1024 * 1024,
        volumePath: "/Volumes/Test",
      }),
      autoCheckEnabled: false,
      updater,
    });

    service.checkForUpdates();

    await vi.waitFor(() => {
      expect(service.getSnapshot()).toMatchObject({
        status: "error",
        errorDetails: {
          kind: "quota",
          phase: "download",
          preservesDownload: false,
        },
      });
    });

    service.dispose();
  });

  it("retries after space is freed without creating concurrent downloads", async () => {
    let availableBytes = 64 * 1024 * 1024;
    const updater = Object.assign(new FakeAutoUpdater(), {
      downloadUpdate: vi.fn(async () => undefined),
    });
    const updateInfo = {
      version: "1.2.3",
      files: [{ url: "ADE-1.2.3-mac.zip", size: 100 * 1024 * 1024, sha512: "test" }],
    };
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", updateInfo);
      return { updateInfo };
    });
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit("update-downloaded", updateInfo);
    });
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir: "/Volumes/Test/ADE-updater",
      getDiskSpace: () => ({ availableBytes, volumePath: "/Volumes/Test" }),
      autoCheckEnabled: false,
      updater,
    });

    service.checkForUpdates();
    service.checkForUpdates();
    await vi.waitFor(() => expect(service.getSnapshot().status).toBe("error"));
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();

    availableBytes = 4 * 1024 * 1024 * 1024;
    service.checkForUpdates();
    service.checkForUpdates();
    await vi.waitFor(() => expect(service.getSnapshot().status).toBe("ready"));
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);

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
        releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.2.4",
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

  it("classifies ENOSPC while refreshing to a newer release as a download failure", async () => {
    const updaterCacheDir = makeUpdaterCacheDir();
    const updater = Object.assign(new FakeAutoUpdater(), {
      downloadUpdate: vi.fn(async () => undefined),
    });
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir,
      getDiskSpace: () => ({
        availableBytes: 20 * 1024 * 1024 * 1024,
        volumePath: "/System/Volumes/Data",
      }),
      autoCheckEnabled: false,
      updater,
    });
    updater.emit("update-downloaded", { version: "1.2.3" });
    const newerUpdate = {
      version: "1.2.4",
      files: [{ url: "ADE-1.2.4-mac.zip", size: 100 * 1024 * 1024, sha512: "test" }],
    };
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", newerUpdate);
      return { updateInfo: newerUpdate };
    });
    updater.downloadUpdate.mockImplementationOnce(async () => {
      const error = new Error("no space left on device") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    });

    await expect(service.quitAndInstall()).resolves.toBe(false);

    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toMatchObject({
      status: "error",
      version: "1.2.4",
      errorDetails: {
        kind: "disk_full",
        phase: "download",
        preservesDownload: false,
      },
    });
    expectCacheEmpty(updaterCacheDir);

    service.dispose();
  });

  it("uses the conservative default when a newer release omits archive size", async () => {
    const updater = Object.assign(new FakeAutoUpdater(), {
      downloadUpdate: vi.fn(async () => undefined),
    });
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir: "/Volumes/Test/ADE-updater",
      getDiskSpace: () => ({
        availableBytes: 1024 * 1024 * 1024,
        volumePath: "/Volumes/Test",
      }),
      autoCheckEnabled: false,
      updater,
    });
    updater.emit("update-downloaded", {
      version: "1.2.3",
      files: [{ url: "ADE-1.2.3-mac.zip", size: 100 * 1024 * 1024, sha512: "old" }],
    });
    const newerUpdateWithoutSize = {
      version: "1.2.4",
      files: [{ url: "ADE-1.2.4-mac.zip", sha512: "new" }],
    };
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", newerUpdateWithoutSize);
      return { updateInfo: newerUpdateWithoutSize };
    });

    await expect(service.quitAndInstall()).resolves.toBe(false);

    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toMatchObject({
      status: "error",
      version: "1.2.4",
      errorDetails: {
        kind: "insufficient_space",
        phase: "download",
        requiredBytes: 1536 * 1024 * 1024,
      },
    });

    service.dispose();
  });

  it("does not replace a ready update or its size estimate with an older downloaded event", async () => {
    const globalStatePath = makeStatePath();
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath,
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      getDiskSpace: () => ({
        availableBytes: 1024 * 1024 * 1024,
        volumePath: "/System/Volumes/Data",
      }),
      updater,
    });

    updater.emit("update-downloaded", {
      version: "1.2.4",
      files: [{ url: "ADE-1.2.4-mac.zip", size: 300 * 1024 * 1024, sha512: "new" }],
    });
    updater.emit("update-available", {
      version: "1.2.3",
      files: [{ url: "ADE-1.2.3-mac.zip", size: 10 * 1024 * 1024, sha512: "old" }],
    });
    updater.emit("download-progress", {
      percent: 25,
      bytesPerSecond: 128_000,
      transferred: 2_500_000,
      total: 10_000_000,
    });
    updater.emit("update-downloaded", {
      version: "1.2.3",
      files: [{ url: "ADE-1.2.3-mac.zip", size: 10 * 1024 * 1024, sha512: "old" }],
    });

    expect(service.getSnapshot()).toMatchObject({
      status: "ready",
      version: "1.2.4",
      releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.2.4",
    });

    await expect(service.quitAndInstall()).resolves.toBe(false);
    expect(service.getSnapshot()).toMatchObject({
      status: "error",
      version: "1.2.4",
      errorDetails: {
        kind: "insufficient_space",
        phase: "install",
        requiredBytes: 2012 * 1024 * 1024,
      },
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

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
    expect(fs.readdirSync(updaterCacheDir).sort()).toEqual(["pending", "update.zip"]);
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
      errorDetails: {
        kind: "installer",
        phase: "install",
        preservesDownload: true,
      },
    });
    expect(readState(globalStatePath)).toEqual({});
    expect(fs.readdirSync(updaterCacheDir).sort()).toEqual(["pending", "update.zip"]);

    service.dispose();
  });

  it("falls back to an actionable error when quit-and-install stalls", async () => {
    vi.useFakeTimers();
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath,
      updaterCacheDir,
      installWatchdogMs: 1_000,
      getDiskSpace: () => ({
        availableBytes: 20 * 1024 * 1024 * 1024,
        volumePath: "/System/Volumes/Data",
      }),
      autoCheckEnabled: false,
      updater,
    });
    updater.emit("update-downloaded", { version: "1.2.3" });

    await expect(service.quitAndInstall()).resolves.toBe(true);
    expect(service.getSnapshot().status).toBe("installing");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.getSnapshot()).toMatchObject({
      status: "error",
      error: "ADE did not quit for the update. Free space if needed, then try again.",
      errorDetails: {
        kind: "installer",
        phase: "install",
        preservesDownload: true,
      },
    });
    expect(readState(globalStatePath)).toEqual({});
    expect(fs.readdirSync(updaterCacheDir).sort()).toEqual(["pending", "update.zip"]);

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
        releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.2.3",
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
      releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.2.4",
      githubReleaseUrl: "https://github.com/arul28/ADE/releases/tag/v1.2.4",
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
