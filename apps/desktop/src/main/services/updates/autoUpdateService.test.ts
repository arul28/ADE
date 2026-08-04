import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutoUpdateService } from "./autoUpdateService";
import {
  buildGithubReleaseUrl,
  buildReleaseNotesUrl,
  compareUpdateVersions,
} from "./autoUpdateVersions";
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
    flushSync: vi.fn(),
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
  it("points at the upstream GitHub release tag by default and supports an override", () => {
    expect(buildGithubReleaseUrl("1.2.18")).toBe("https://github.com/arul28/ADE/releases/tag/v1.2.18");
    expect(buildGithubReleaseUrl("v1.2.18")).toBe("https://github.com/arul28/ADE/releases/tag/v1.2.18");
    expect(buildGithubReleaseUrl("1.2.18", "acme/custom-ade")).toBe(
      "https://github.com/acme/custom-ade/releases/tag/v1.2.18",
    );
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

  it("keeps automatic installation off by default", async () => {
    vi.useFakeTimers();
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      autoCheckEnabled: false,
      autoApplyEnabled: true,
      autoApplyIdleMs: 1_000,
      autoApplyCountdownMs: 1_000,
      getRuntimeActivitySummary: vi.fn(async () => ({ idle: true })),
      updater,
    });

    updater.emit("update-downloaded", { version: "1.2.3" });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(service.getPreferences()).toEqual({
      automaticInstall: false,
      onlyWhenIdle: true,
    });
    expect(service.setPreferences({
      automaticInstall: "yes",
      onlyWhenIdle: 0,
    })).toEqual({
      automaticInstall: false,
      onlyWhenIdle: true,
    });
    expect(service.getSnapshot().autoApplyPending).toBeNull();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    service.dispose();
  });

  it("uses electron-builder app-update.yml as the packaged feed authority", () => {
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

    expect(updater.setFeedURL).not.toHaveBeenCalled();

    service.dispose();
  });

  it("ignores ADE_UPDATE_FEED_URL in packaged builds without replacing app-update.yml", () => {
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

    expect(updater.setFeedURL).not.toHaveBeenCalled();

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

  it("uses the packaged update repository for post-install GitHub links", () => {
    const globalStatePath = makeStatePath();
    fs.writeFileSync(globalStatePath, JSON.stringify({
      recentlyInstalledUpdate: {
        version: "1.2.3",
        installedAt: "2026-04-06T15:20:00.000Z",
        releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.2.3",
        githubReleaseUrl: "https://github.com/arul28/ADE/releases/tag/v1.2.3",
      },
    }), "utf8");

    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.3",
      globalStatePath,
      releaseRepository: "acme/custom-ade",
      startupDelayMs: 60_000,
      periodicCheckMs: 60_000,
      now: () => "2026-04-06T15:21:00.000Z",
      updater: new FakeAutoUpdater(),
    });

    expect(service.getSnapshot().recentlyInstalled?.githubReleaseUrl).toBe(
      "https://github.com/acme/custom-ade/releases/tag/v1.2.3",
    );
    const persisted = readState(globalStatePath) as {
      recentlyInstalledUpdate?: { githubReleaseUrl?: string | null };
    };
    expect(persisted.recentlyInstalledUpdate?.githubReleaseUrl).toBe(
      "https://github.com/acme/custom-ade/releases/tag/v1.2.3",
    );

    service.dispose();
  });

  // The archive is checksum-verified before the update is offered, so one
  // failed handoff does not make it suspect. Re-downloading the whole release
  // on every retry is what made a flaky install cost gigabytes.
  it("keeps the verified download when a requested install relaunches on the old version", () => {
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

    expect(readState(globalStatePath)).toEqual({
      failedInstallAttempts: {
        targetVersion: "1.2.3",
        count: 1,
        lastFailedAt: "2026-04-06T15:21:00.000Z",
      },
    });
    expect(fs.readdirSync(updaterCacheDir).sort()).toEqual(["pending", "update.zip"]);
    expect(logger.error).toHaveBeenCalledWith(
      "autoUpdate.install_did_not_land",
      expect.objectContaining({
        targetVersion: "1.2.3",
        attempt: 1,
        downloadPreserved: true,
      }),
    );

    service.dispose();
  });

  it("clears the cached download after a second failed install of the same version", () => {
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
      failedInstallAttempts: {
        targetVersion: "1.2.3",
        count: 1,
        lastFailedAt: "2026-04-06T15:10:00.000Z",
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

    expectCacheEmpty(updaterCacheDir);
    expect(logger.info).toHaveBeenCalledWith(
      "autoUpdate.cache_cleaned",
      expect.objectContaining({ reason: "failed_install", entriesRemoved: 2 }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "autoUpdate.install_did_not_land",
      expect.objectContaining({ attempt: 2, downloadPreserved: false }),
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
      latestKnownVersion: "1.2.3",
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

  it("refuses a macOS update whose archive would crash Squirrel.Mac", async () => {
    const updater = Object.assign(new FakeAutoUpdater(), {
      downloadUpdate: vi.fn(async () => undefined),
    });
    const updateInfo = {
      version: "1.2.53",
      files: [{ url: "ADE-1.2.53-arm64.zip", size: 1054 * 1024 * 1024, sha512: "test" }],
    };
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", updateInfo);
      return { updateInfo };
    });
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.52",
      globalStatePath: makeStatePath(),
      updaterCacheDir: "/Volumes/Test/ADE-updater",
      installTargetPath: "/Applications/ADE.app",
      platform: "darwin",
      // Ample space: the refusal must come from the archive size, not capacity.
      getDiskSpace: () => ({
        availableBytes: 500 * 1024 * 1024 * 1024,
        volumePath: "/Volumes/Test",
      }),
      autoCheckEnabled: false,
      updater,
    });

    service.checkForUpdates();

    await vi.waitFor(() => {
      expect(service.getSnapshot()).toMatchObject({
        status: "error",
        version: "1.2.53",
        error: "This update is too large for macOS to install safely.",
        errorDetails: {
          kind: "artifact_too_large",
          phase: "download",
          preservesDownload: false,
        },
      });
    });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();

    service.dispose();
  });

  it("downloads a macOS update that sits inside the archive size budget", async () => {
    const updater = Object.assign(new FakeAutoUpdater(), {
      downloadUpdate: vi.fn(async () => undefined),
    });
    const updateInfo = {
      version: "1.2.53",
      files: [{ url: "ADE-1.2.53-arm64.zip", size: 700 * 1024 * 1024, sha512: "test" }],
    };
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", updateInfo);
      return { updateInfo };
    });
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.52",
      globalStatePath: makeStatePath(),
      updaterCacheDir: "/Volumes/Test/ADE-updater",
      installTargetPath: "/Applications/ADE.app",
      platform: "darwin",
      getDiskSpace: () => ({
        availableBytes: 500 * 1024 * 1024 * 1024,
        volumePath: "/Volumes/Test",
      }),
      autoCheckEnabled: false,
      updater,
    });

    service.checkForUpdates();

    await vi.waitFor(() => {
      expect(updater.downloadUpdate).toHaveBeenCalled();
    });

    service.dispose();
  });

  // Windows streams the installer to disk and runs it as an external process,
  // so nothing buffers it whole and the macOS cliff does not apply.
  it("does not apply the macOS archive size guard on Windows", async () => {
    const updater = Object.assign(new FakeAutoUpdater(), {
      downloadUpdate: vi.fn(async () => undefined),
    });
    const updateInfo = {
      version: "1.2.53",
      files: [{ url: "ADE-1.2.53-win-x64.exe", size: 1054 * 1024 * 1024, sha512: "test" }],
    };
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", updateInfo);
      return { updateInfo };
    });
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.52",
      globalStatePath: makeStatePath(),
      updaterCacheDir: "C:/Users/test/AppData/Local/ade-updater",
      installTargetPath: "C:/Users/test/AppData/Local/Programs/ADE/ADE.exe",
      platform: "win32",
      getDiskSpace: () => ({
        availableBytes: 500 * 1024 * 1024 * 1024,
        volumePath: "C:/",
      }),
      autoCheckEnabled: false,
      updater,
    });

    service.checkForUpdates();

    await vi.waitFor(() => {
      expect(updater.downloadUpdate).toHaveBeenCalled();
    });

    service.dispose();
  });

  // Release metadata is advisory and CI already caps published artifacts, so a
  // manifest without a size must not block every update.
  it("allows a macOS update whose metadata omits the archive size", async () => {
    const updater = Object.assign(new FakeAutoUpdater(), {
      downloadUpdate: vi.fn(async () => undefined),
    });
    const updateInfo = { version: "1.2.53", files: [{ url: "ADE-1.2.53-arm64.zip", sha512: "test" }] };
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", updateInfo);
      return { updateInfo };
    });
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.52",
      globalStatePath: makeStatePath(),
      updaterCacheDir: "/Volumes/Test/ADE-updater",
      installTargetPath: "/Applications/ADE.app",
      platform: "darwin",
      getDiskSpace: () => ({
        availableBytes: 500 * 1024 * 1024 * 1024,
        volumePath: "/Volumes/Test",
      }),
      autoCheckEnabled: false,
      updater,
    });

    service.checkForUpdates();

    await vi.waitFor(() => {
      expect(updater.downloadUpdate).toHaveBeenCalled();
    });

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
      status: "ready",
      parked: { reason: "install_preflight_failed" },
    });
    expect(fs.readdirSync(updaterCacheDir).sort()).toEqual(["pending", "update.zip"]);

    service.dispose();
  });

  it("reuses a preserved verified archive after install-space recovery without a download-volume preflight", async () => {
    const updaterCacheDir = makeUpdaterCacheDir();
    const installTargetPath = "/Applications/ADE.app/Contents/MacOS/ADE";
    const updateInfo = {
      version: "1.2.3",
      files: [{ url: "ADE-1.2.3-mac.zip", size: 300 * 1024 * 1024, sha512: "test" }],
    };
    const updater = Object.assign(new FakeAutoUpdater(), {
      downloadUpdate: vi.fn(async () => undefined),
    });
    let installSpaceAvailable = false;
    const getDiskSpace = vi.fn((targetPath: string) => ({
      availableBytes: targetPath === installTargetPath
        ? (installSpaceAvailable ? 4 : 1) * 1024 * 1024 * 1024
        : 64 * 1024 * 1024,
      volumePath: targetPath === installTargetPath ? "/System/Volumes/Data" : "/Volumes/Cache",
    }));
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir,
      installTargetPath,
      getDiskSpace,
      autoCheckEnabled: false,
      updater,
    });
    updater.emit("update-downloaded", updateInfo);

    await expect(service.quitAndInstall()).resolves.toBe(false);
    expect(service.getSnapshot()).toMatchObject({
      status: "ready",
      version: "1.2.3",
      parked: { reason: "install_preflight_failed" },
    });
    installSpaceAvailable = true;
    await expect(service.quitAndInstall()).resolves.toBe(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(getDiskSpace).not.toHaveBeenCalledWith(updaterCacheDir);

    service.dispose();
  });

  it("preserves a verified archive and recovery metadata when its retry check has a transient feed failure", async () => {
    const updaterCacheDir = makeUpdaterCacheDir();
    const updater = new FakeAutoUpdater();
    const updateInfo = {
      version: "1.2.3",
      files: [{ url: "ADE-1.2.3-mac.zip", size: 300 * 1024 * 1024, sha512: "test" }],
    };
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir,
      installTargetPath: "/Applications/ADE.app/Contents/MacOS/ADE",
      getDiskSpace: () => ({
        availableBytes: 1024 * 1024 * 1024,
        volumePath: "/System/Volumes/Data",
      }),
      autoCheckEnabled: false,
      updater,
    });
    updater.emit("update-downloaded", updateInfo);

    await expect(service.quitAndInstall()).resolves.toBe(false);
    expect(service.getSnapshot()).toMatchObject({
      status: "ready",
      parked: { reason: "install_preflight_failed" },
    });

    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("checking-for-update");
      const error = new Error("network unavailable");
      updater.emit("error", error);
      throw error;
    });

    await expect(service.quitAndInstall()).resolves.toBe(false);
    expect(service.getSnapshot()).toMatchObject({
      status: "ready",
      version: "1.2.3",
      releaseNotesUrl: "https://www.ade-app.dev/docs/changelog/v1.2.3",
      parked: { reason: "refresh_failed" },
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
      status: "ready",
      parked: { reason: "handoff_failed" },
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
    expect(fs.readdirSync(updaterCacheDir).sort()).toEqual(["pending", "update.zip"]);
    expect(logger.info).not.toHaveBeenCalledWith(
      "autoUpdate.cache_cleaned",
      expect.objectContaining({ reason: "superseded_ready_update" }),
    );

    service.dispose();
  });

  it("allows a newer update download to outlive the install watchdog before starting handoff", async () => {
    vi.useFakeTimers();
    let finishDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
    const newerUpdate = {
      version: "1.2.4",
      files: [{ url: "ADE-1.2.4-mac.zip", size: 100 * 1024 * 1024, sha512: "test" }],
    };
    const updater = Object.assign(new FakeAutoUpdater(), {
      downloadUpdate: vi.fn(async () => undefined),
    });
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", newerUpdate);
      return { updateInfo: newerUpdate };
    });
    updater.downloadUpdate.mockImplementationOnce(async () => {
      await downloadGate;
      updater.emit("update-downloaded", newerUpdate);
    });
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      installWatchdogMs: 1_000,
      getDiskSpace: () => ({
        availableBytes: 20 * 1024 * 1024 * 1024,
        volumePath: "/System/Volumes/Data",
      }),
      autoCheckEnabled: false,
      updater,
    });
    updater.emit("update-downloaded", { version: "1.2.3" });

    const installPromise = service.quitAndInstall();
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.getSnapshot()).toMatchObject({
      status: "downloading",
      version: "1.2.4",
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    finishDownload();
    await expect(installPromise).resolves.toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(service.getSnapshot()).toMatchObject({
      status: "installing",
      version: "1.2.4",
    });

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
      status: "ready",
      parked: { reason: "refresh_failed" },
    });
    expect(fs.readdirSync(updaterCacheDir).sort()).toEqual(["pending", "update.zip"]);
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
      status: "ready",
      version: "1.2.3",
      latestKnownVersion: "1.2.4",
      parked: { reason: "refresh_failed" },
    });
    expect(fs.readdirSync(updaterCacheDir).sort()).toEqual(["pending", "update.zip"]);

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
      status: "ready",
      version: "1.2.3",
      latestKnownVersion: "1.2.4",
      parked: { reason: "refresh_failed" },
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
      status: "ready",
      version: "1.2.4",
      parked: { reason: "install_preflight_failed" },
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
      status: "ready",
      parked: { reason: "handoff_failed" },
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
    const rollbackQuitAndInstall = vi.fn(async () => {});
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
      rollbackQuitAndInstall,
    });

    updater.emit("update-downloaded", {
      version: "1.2.3",
    });

    await expect(service.quitAndInstall()).resolves.toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(readState(globalStatePath)).toEqual({});
    expect(service.getSnapshot()).toMatchObject({
      status: "ready",
      version: "1.2.3",
      parked: {
        reason: "prepare_failed",
        at: expect.any(Number),
      },
    });
    expect(rollbackQuitAndInstall).toHaveBeenCalledWith("prepare_failed");
    expect(logger.warn).toHaveBeenCalledWith(
      "autoUpdate.prepare_quit_and_install_failed",
      expect.objectContaining({
        version: "1.2.3",
        message: "Could not stop ADE service",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "autoUpdate.install_aborted",
      expect.objectContaining({ reason: "prepare_failed", version: "1.2.3" }),
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

    await vi.waitFor(() => {
      expect(service.getSnapshot()).toMatchObject({
        status: "ready",
        parked: { reason: "handoff_failed" },
      });
    });
    expect(readState(globalStatePath)).toEqual({});
    expect(fs.readdirSync(updaterCacheDir).sort()).toEqual(["pending", "update.zip"]);

    service.dispose();
  });

  it("auto-applies a ready update after two continuously idle minutes and the countdown", async () => {
    vi.useFakeTimers();
    const updater = new FakeAutoUpdater();
    const productAnalyticsService = { captureInternal: vi.fn() };
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir: makeUpdaterCacheDir(),
      getDiskSpace: () => ({
        availableBytes: 20 * 1024 * 1024 * 1024,
        volumePath: "/System/Volumes/Data",
      }),
      autoCheckEnabled: false,
      autoApplyEnabled: true,
      activityCheckMs: 5_000,
      autoApplyIdleMs: 2 * 60_000,
      autoApplyCountdownMs: 10_000,
      getRuntimeActivitySummary: vi.fn(async () => ({ idle: true })),
      productAnalyticsService: productAnalyticsService as never,
      updater,
    });
    service.setPreferences({ automaticInstall: true, onlyWhenIdle: true });
    updater.emit("update-downloaded", { version: "1.2.3" });

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(service.getSnapshot()).toMatchObject({
      status: "ready",
      autoApplyPending: { deadlineAt: expect.any(Number) },
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(productAnalyticsService.captureInternal).toHaveBeenCalledWith({
      event: "ade_update_auto_applied",
      surface: "desktop",
    });

    service.dispose();
  });

  it("starts a cancelable countdown without an idle wait when the safety option is off", async () => {
    vi.useFakeTimers();
    const globalStatePath = makeStatePath();
    const updater = new FakeAutoUpdater();
    const logger = makeLogger();
    const productAnalyticsService = { captureInternal: vi.fn() };
    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.2",
      globalStatePath,
      updaterCacheDir: makeUpdaterCacheDir(),
      getDiskSpace: () => ({
        availableBytes: 20 * 1024 * 1024 * 1024,
        volumePath: "/System/Volumes/Data",
      }),
      autoCheckEnabled: false,
      autoApplyEnabled: true,
      autoApplyCountdownMs: 10_000,
      productAnalyticsService: productAnalyticsService as never,
      updater,
    });

    expect(service.setPreferences({
      automaticInstall: true,
      onlyWhenIdle: false,
    })).toEqual({
      automaticInstall: true,
      onlyWhenIdle: false,
    });
    updater.emit("update-downloaded", { version: "1.2.3" });
    await vi.advanceTimersByTimeAsync(0);

    expect(service.getSnapshot().autoApplyPending).toEqual({
      deadlineAt: expect.any(Number),
    });
    expect(readState(globalStatePath)).toMatchObject({
      autoUpdatePreferences: {
        automaticInstall: true,
        onlyWhenIdle: false,
      },
    });
    expect(logger.info).toHaveBeenCalledWith("autoUpdate.preferences_updated", {
      automaticInstall: true,
      onlyWhenIdle: false,
    });
    expect(productAnalyticsService.captureInternal).toHaveBeenCalledWith({
      event: "ade_feature_used",
      surface: "desktop",
      properties: {
        feature: "updates",
        action: "preferences_changed",
        mode: "automatic",
        outcome: "immediate",
      },
      dedupeKey: "update_preferences:true:false",
      minimumIntervalMs: 24 * 60 * 60_000,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    service.dispose();
  });

  it("cancels a pending automatic install when the preference is turned off", async () => {
    vi.useFakeTimers();
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      autoCheckEnabled: false,
      autoApplyEnabled: true,
      autoApplyCountdownMs: 10_000,
      updater,
    });
    service.setPreferences({ automaticInstall: true, onlyWhenIdle: false });
    updater.emit("update-downloaded", { version: "1.2.3" });
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getSnapshot().autoApplyPending).not.toBeNull();

    service.setPreferences({ automaticInstall: false, onlyWhenIdle: true });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(service.getPreferences()).toEqual({
      automaticInstall: false,
      onlyWhenIdle: true,
    });
    expect(service.getSnapshot().autoApplyPending).toBeNull();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    service.dispose();
  });

  it("rechecks activity at the deadline and rearms after newly active work becomes idle", async () => {
    vi.useFakeTimers();
    let idle = true;
    const getRuntimeActivitySummary = vi.fn(async () => ({ idle }));
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir: makeUpdaterCacheDir(),
      autoCheckEnabled: false,
      autoApplyEnabled: true,
      activityCheckMs: 1_000,
      autoApplyIdleMs: 10_000,
      autoApplyCountdownMs: 2_000,
      getRuntimeActivitySummary,
      updater,
    });
    service.setPreferences({ automaticInstall: true, onlyWhenIdle: true });
    updater.emit("update-downloaded", { version: "1.2.3" });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.getSnapshot().autoApplyPending).toEqual({
      deadlineAt: expect.any(Number),
    });
    const checksBeforeDeadline = getRuntimeActivitySummary.mock.calls.length;
    idle = false;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(getRuntimeActivitySummary.mock.calls.length).toBeGreaterThan(checksBeforeDeadline);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(service.getSnapshot().autoApplyPending).toBeNull();

    idle = true;
    await vi.advanceTimersByTimeAsync(13_000);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);

    service.dispose();
  });

  it("restarts the idle window when runtime activity resumes", async () => {
    vi.useFakeTimers();
    let idle = true;
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir: makeUpdaterCacheDir(),
      autoCheckEnabled: false,
      autoApplyEnabled: true,
      activityCheckMs: 5_000,
      autoApplyIdleMs: 2 * 60_000,
      getRuntimeActivitySummary: vi.fn(async () => ({ idle })),
      updater,
    });
    service.setPreferences({ automaticInstall: true, onlyWhenIdle: true });
    updater.emit("update-downloaded", { version: "1.2.3" });

    await vi.advanceTimersByTimeAsync(60_000);
    idle = false;
    await vi.advanceTimersByTimeAsync(5_000);
    idle = true;
    await vi.advanceTimersByTimeAsync(124_999);

    expect(service.getSnapshot().autoApplyPending).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(service.getSnapshot().autoApplyPending).toEqual({
      deadlineAt: expect.any(Number),
    });

    service.dispose();
  });

  it("cancels an idle auto-apply countdown and suppresses it for four hours", async () => {
    vi.useFakeTimers();
    const updater = new FakeAutoUpdater();
    const productAnalyticsService = { captureInternal: vi.fn() };
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir: makeUpdaterCacheDir(),
      autoCheckEnabled: false,
      autoApplyEnabled: true,
      activityCheckMs: 5_000,
      autoApplyIdleMs: 2 * 60_000,
      autoApplyCountdownMs: 10_000,
      autoApplySuppressionMs: 4 * 60 * 60_000,
      getRuntimeActivitySummary: vi.fn(async () => ({ idle: true })),
      productAnalyticsService: productAnalyticsService as never,
      updater,
    });
    service.setPreferences({ automaticInstall: true, onlyWhenIdle: true });
    updater.emit("update-downloaded", { version: "1.2.3" });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const beforeCancel = Date.now();

    expect(service.cancelAutoApply()).toBe(true);

    expect(service.getSnapshot()).toMatchObject({
      status: "ready",
      autoApplyPending: null,
      autoApplySuppressedUntil: beforeCancel + 4 * 60 * 60_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(productAnalyticsService.captureInternal).toHaveBeenCalledWith({
      event: "ade_update_auto_apply_cancelled",
      surface: "desktop",
    });

    service.dispose();
  });

  it("preserves the latest known version when an updater download is cancelled", () => {
    const updater = new FakeAutoUpdater();
    const service = createAutoUpdateService({
      logger: makeLogger(),
      currentVersion: "1.2.2",
      globalStatePath: makeStatePath(),
      updaterCacheDir: makeUpdaterCacheDir(),
      autoCheckEnabled: false,
      updater,
    });
    updater.emit("update-downloaded", { version: "1.2.3" });

    updater.emit("update-cancelled", { version: "1.2.3" });

    expect(service.getSnapshot()).toMatchObject({
      status: "idle",
      latestKnownVersion: "1.2.3",
    });

    service.dispose();
  });

  // Regression: the soft deadline used to force-quit, which killed the process
  // mid-staging. Squirrel needs ~10s to expand and code-sign verify a ~750 MB
  // bundle, so that raced — and usually beat — a healthy install.
  it("does not force-quit while the native installer is still staging", async () => {
    vi.useFakeTimers();
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const updater = new FakeAutoUpdater();
    const nativeUpdater = new EventEmitter();
    const logger = makeLogger();
    const forceQuit = vi.fn();
    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.2",
      globalStatePath,
      updaterCacheDir,
      installWatchdogMs: 1_000,
      quitStagingSlowWarnMs: 5_000,
      quitHardDeadlineMs: 300_000,
      nativeUpdater,
      forceQuit,
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

    // Well past the soft deadline: noted, never fatal.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(forceQuit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("autoUpdate.quit_staging_slow", {
      blockedMs: 5_000,
    });
    expect(service.getSnapshot().status).toBe("installing");
    expect(readState(globalStatePath)).toMatchObject({
      pendingInstallUpdate: { targetVersion: "1.2.3" },
    });
    expect(fs.readdirSync(updaterCacheDir).sort()).toEqual(["pending", "update.zip"]);

    service.dispose();
  });

  it("force-quits once staging finished but the process never exited", async () => {
    vi.useFakeTimers();
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const updater = new FakeAutoUpdater();
    const nativeUpdater = new EventEmitter();
    const logger = makeLogger();
    const forceQuit = vi.fn();
    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.2",
      globalStatePath,
      updaterCacheDir,
      installWatchdogMs: 1_000,
      quitStagingSlowWarnMs: 5_000,
      quitHardDeadlineMs: 300_000,
      quitPostStagingDeadlineMs: 15_000,
      nativeUpdater,
      forceQuit,
      getDiskSpace: () => ({
        availableBytes: 20 * 1024 * 1024 * 1024,
        volumePath: "/System/Volumes/Data",
      }),
      autoCheckEnabled: false,
      updater,
    });
    updater.emit("update-downloaded", { version: "1.2.3" });

    await expect(service.quitAndInstall()).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);
    nativeUpdater.emit("update-downloaded");
    expect(forceQuit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(forceQuit).toHaveBeenCalledWith({
      blockedPhase: "app_quit",
      blockedMs: 35_000,
    });
    expect(logger.error).toHaveBeenCalledWith("autoUpdate.quit_escalated", {
      blockedPhase: "app_quit",
      blockedMs: 35_000,
      reason: "post_staging",
      nativeStagingCompleted: true,
    });
    // The escalation record has to survive the app.exit() that follows.
    expect(logger.flushSync).toHaveBeenCalled();

    service.dispose();
  });

  // Regression: the staged deadline is Squirrel.Mac-specific. Only MacUpdater
  // drives the native updater, so on Windows/Linux the staging signal can never
  // arrive — the long bound would strand the app in "installing" for five
  // minutes where the previous code force-quit in ten seconds.
  it("falls back to the short hard bound when no staging signal can arrive", async () => {
    vi.useFakeTimers();
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const updater = new FakeAutoUpdater();
    const logger = makeLogger();
    const forceQuit = vi.fn();
    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.2",
      globalStatePath,
      updaterCacheDir,
      installWatchdogMs: 1_000,
      // No hard bound supplied: the default must come from whether a staging
      // signal is possible at all, not from the macOS-only five-minute value.
      nativeUpdater: null,
      forceQuit,
      getDiskSpace: () => ({
        availableBytes: 20 * 1024 * 1024 * 1024,
        volumePath: "/System/Volumes/Data",
      }),
      autoCheckEnabled: false,
      updater,
    });
    updater.emit("update-downloaded", { version: "1.2.3" });

    await expect(service.quitAndInstall()).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(forceQuit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(forceQuit).toHaveBeenCalledWith({
      blockedPhase: "app_quit",
      blockedMs: 60_000,
    });

    service.dispose();
  });

  it("force-quits a handoff that never stages at all, at the hard deadline", async () => {
    vi.useFakeTimers();
    const globalStatePath = makeStatePath();
    const updaterCacheDir = makeUpdaterCacheDir();
    const updater = new FakeAutoUpdater();
    const logger = makeLogger();
    const forceQuit = vi.fn();
    const service = createAutoUpdateService({
      logger,
      currentVersion: "1.2.2",
      globalStatePath,
      updaterCacheDir,
      installWatchdogMs: 1_000,
      quitStagingSlowWarnMs: 5_000,
      quitHardDeadlineMs: 300_000,
      nativeUpdater: null,
      forceQuit,
      getDiskSpace: () => ({
        availableBytes: 20 * 1024 * 1024 * 1024,
        volumePath: "/System/Volumes/Data",
      }),
      autoCheckEnabled: false,
      updater,
    });
    updater.emit("update-downloaded", { version: "1.2.3" });

    await expect(service.quitAndInstall()).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(300_000);

    expect(forceQuit).toHaveBeenCalledWith({
      blockedPhase: "app_quit",
      blockedMs: 300_000,
    });
    expect(logger.error).toHaveBeenCalledWith("autoUpdate.quit_escalated", {
      blockedPhase: "app_quit",
      blockedMs: 300_000,
      reason: "hard_deadline",
      nativeStagingCompleted: false,
    });
    expect(service.getSnapshot().status).toBe("installing");
    expect(readState(globalStatePath)).toMatchObject({
      pendingInstallUpdate: { targetVersion: "1.2.3" },
    });

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
