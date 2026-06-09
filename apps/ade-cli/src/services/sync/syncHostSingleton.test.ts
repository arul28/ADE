import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireSyncHostSingleton,
  detectSyncHostSingletonConflict,
  formatSyncHostSingletonConflictMessage,
  isSameChannelSyncHostOwner,
  type SyncHostSingletonOwner,
} from "./syncHostSingleton";

const originalTestMode = process.env.ADE_SYNC_HOST_SINGLETON_TEST_MODE;
const originalLockPath = process.env.ADE_SYNC_HOST_LOCK_PATH;
const tempDirs: string[] = [];

beforeEach(() => {
  process.env.ADE_SYNC_HOST_SINGLETON_TEST_MODE = "1";
  delete process.env.ADE_SYNC_HOST_LOCK_PATH;
});

afterEach(() => {
  if (originalTestMode === undefined) delete process.env.ADE_SYNC_HOST_SINGLETON_TEST_MODE;
  else process.env.ADE_SYNC_HOST_SINGLETON_TEST_MODE = originalTestMode;
  if (originalLockPath === undefined) delete process.env.ADE_SYNC_HOST_LOCK_PATH;
  else process.env.ADE_SYNC_HOST_LOCK_PATH = originalLockPath;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempLockPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sync-host-singleton-"));
  tempDirs.push(dir);
  return path.join(dir, "sync-host.json");
}

function owner(overrides: Partial<SyncHostSingletonOwner> = {}): SyncHostSingletonOwner {
  const now = "2026-06-09T00:00:00.000Z";
  return {
    id: "owner-1",
    pid: 1234,
    port: 8801,
    appName: "ADE",
    packageChannel: null,
    adeHome: path.join(os.homedir(), ".ade"),
    serviceName: "com.ade.runtime",
    socketPath: path.join(os.homedir(), ".ade", "sock", "ade.sock"),
    projectRoot: "/Users/admin/Projects/ADE",
    commandLine: "/Applications/ADE.app/Contents/MacOS/ADE /Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs serve",
    quitCommand: `ADE_HOME='${path.join(os.homedir(), ".ade")}' '/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade' brain stop --text`,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function writeLock(lockPath: string, lockOwner: SyncHostSingletonOwner): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({ version: 1, owner: lockOwner }, null, 2)}\n`,
    "utf8",
  );
}

describe("sync host singleton", () => {
  it("reports an active lock conflict with the command to stop the existing brain", () => {
    const lockPath = tempLockPath();
    const lockOwner = owner();
    writeLock(lockPath, lockOwner);

    const conflict = detectSyncHostSingletonConflict({
      lockPath,
      pidAlive: (pid) => pid === lockOwner.pid,
      scanListeners: () => [],
    });

    expect(conflict).toMatchObject({
      reason: "lock",
      owner: {
        pid: lockOwner.pid,
        port: lockOwner.port,
        appName: "ADE",
      },
    });
    expect(formatSyncHostSingletonConflictMessage(conflict!)).toContain(
      "Another ADE brain is already hosting mobile sync on port 8801.",
    );
    expect(formatSyncHostSingletonConflictMessage(conflict!)).toContain(
      "/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade' brain stop --text",
    );
    expect(formatSyncHostSingletonConflictMessage(conflict!)).toContain(
      `/bin/kill ${lockOwner.pid} 2>/dev/null || true`,
    );
  });

  it("reports an ADE listener conflict when no lock exists", () => {
    const lockPath = tempLockPath();
    const betaOwner = owner({
      id: "legacy-4321-8804",
      pid: 4321,
      port: 8804,
      appName: "ADE Beta",
      packageChannel: "beta",
      quitCommand: "ADE_PACKAGE_CHANNEL=beta ADE_HOME='/Users/example/.ade-beta' '/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin/ade-beta' brain stop --text",
    });

    const conflict = detectSyncHostSingletonConflict({
      lockPath,
      pidAlive: (pid) => pid === betaOwner.pid,
      scanListeners: () => [betaOwner],
    });

    expect(conflict).toMatchObject({
      reason: "listener",
      owner: {
        pid: betaOwner.pid,
        port: betaOwner.port,
        appName: "ADE Beta",
      },
    });
  });

  it("cleans malformed stale locks before acquiring a new lease", () => {
    const lockPath = tempLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "not-json\n", "utf8");

    const lease = acquireSyncHostSingleton(
      { projectRoot: "/Users/admin/Projects/ADE" },
      {
        lockPath,
        pidAlive: () => false,
        scanListeners: () => [],
      },
    );

    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { owner: SyncHostSingletonOwner };
    expect(parsed.owner.pid).toBe(process.pid);
    expect(parsed.owner.projectRoot).toBe(path.resolve("/Users/admin/Projects/ADE"));

    lease.dispose();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("updates the owned lock with the resolved port", () => {
    const lockPath = tempLockPath();
    const lease = acquireSyncHostSingleton(
      { projectRoot: "/Users/admin/Projects/ADE" },
      {
        lockPath,
        pidAlive: () => false,
        scanListeners: () => [],
      },
    );

    lease.updatePort(8804);

    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { owner: SyncHostSingletonOwner };
    expect(parsed.owner.port).toBe(8804);
    expect(parsed.owner.id).toBe(lease.owner.id);

    lease.dispose();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe("isSameChannelSyncHostOwner", () => {
  const betaEnv = {
    ADE_PACKAGE_CHANNEL: "beta",
    ADE_HOME: "/Users/example/.ade-beta",
  } as NodeJS.ProcessEnv;

  it("matches owners by ADE home when recorded", () => {
    expect(isSameChannelSyncHostOwner(owner({ adeHome: "/Users/example/.ade-beta" }), betaEnv)).toBe(true);
    expect(isSameChannelSyncHostOwner(owner({ adeHome: "/Users/example/.ade" }), betaEnv)).toBe(false);
  });

  it("falls back to service name, then channel, when the home is unknown", () => {
    expect(isSameChannelSyncHostOwner(
      owner({ adeHome: null, serviceName: "com.ade.runtime.beta" }),
      betaEnv,
    )).toBe(true);
    expect(isSameChannelSyncHostOwner(
      owner({ adeHome: null, serviceName: "com.ade.runtime" }),
      betaEnv,
    )).toBe(false);
    expect(isSameChannelSyncHostOwner(
      owner({ adeHome: null, serviceName: null, packageChannel: "beta" }),
      betaEnv,
    )).toBe(true);
    expect(isSameChannelSyncHostOwner(
      owner({ adeHome: null, serviceName: null, packageChannel: null }),
      betaEnv,
    )).toBe(false);
  });

  it("treats stable defaults as same-channel for a stable install", () => {
    const stableEnv = {} as NodeJS.ProcessEnv;
    expect(isSameChannelSyncHostOwner(owner(), stableEnv)).toBe(true);
    expect(isSameChannelSyncHostOwner(owner({ adeHome: "/Users/example/.ade-beta" }), stableEnv)).toBe(false);
  });
});
