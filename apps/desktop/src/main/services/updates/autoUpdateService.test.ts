import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutoUpdateService } from "./autoUpdateService";
import type { Logger } from "../logging/logger";

class FakeAutoUpdater extends EventEmitter {
  logger: Logger | null = null;
  autoDownload = false;
  autoInstallOnAppQuit = true;
  checkForUpdates = vi.fn(async () => null);
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
  return JSON.parse(fs.readFileSync(globalStatePath, "utf8"));
}

function expectCacheEmpty(updaterCacheDir: string): void {
  expect(fs.readdirSync(updaterCacheDir)).toEqual([]);
}

describe("createAutoUpdateService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("tracks download progress and persists the target version before quit-and-install", () => {
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

    expect(service.quitAndInstall()).toBe(true);
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

  it("rolls back pending install state when quit-and-install fails synchronously", () => {
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

    expect(service.quitAndInstall()).toBe(false);
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
});
