import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireSyncHostSingleton,
  buildQuitCommand,
  detectSyncHostSingletonConflict,
  formatSyncHostSingletonConflictMessage,
  holdsSyncHostSingleton,
  isSameChannelSyncHostOwner,
  onSyncHostSingletonAuthorityChanged,
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
    processStartedAt: "2026-06-09T00:00:00.000Z",
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
      platform: "darwin",
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

describe("sync host authority", () => {
  const acquire = (lockPath: string) =>
    acquireSyncHostSingleton(
      { projectRoot: "/Users/admin/Projects/ADE" },
      { lockPath, pidAlive: () => false, scanListeners: () => [] },
    );

  it("reports authority only while a lease is held", () => {
    expect(holdsSyncHostSingleton()).toBe(false);
    const lease = acquire(tempLockPath());
    expect(holdsSyncHostSingleton()).toBe(true);
    lease.dispose();
    expect(holdsSyncHostSingleton()).toBe(false);
  });

  it("notifies subscribers on authority transitions only", () => {
    const seen: boolean[] = [];
    const unsubscribe = onSyncHostSingletonAuthorityChanged((held) => seen.push(held));

    const first = acquire(tempLockPath());
    const second = acquire(tempLockPath());
    // Two leases, one transition: subsystems care about "is it me", not "how
    // many scopes".
    expect(seen).toEqual([true]);

    first.dispose();
    expect(seen).toEqual([true]);
    second.dispose();
    expect(seen).toEqual([true, false]);

    unsubscribe();
    acquire(tempLockPath()).dispose();
    expect(seen).toEqual([true, false]);
  });

  it("survives a throwing subscriber", () => {
    const unsubscribe = onSyncHostSingletonAuthorityChanged(() => {
      throw new Error("subscriber exploded");
    });
    const lease = acquire(tempLockPath());
    expect(holdsSyncHostSingleton()).toBe(true);
    lease.dispose();
    expect(holdsSyncHostSingleton()).toBe(false);
    unsubscribe();
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

describe("buildQuitCommand (launch-gate stop command)", () => {
  it("uses a PowerShell-native process stop on Windows", () => {
    const command = buildQuitCommand({
      pid: 4242,
      commandLine: "C:\\Program Files\\ADE\\ADE.exe cli.cjs serve",
      appName: "ADE",
      packageChannel: null,
      adeHome: "C:\\Users\\example\\.ade",
      platform: "win32",
    });
    expect(command).toBe(
      "Stop-Process -Id 4242 -Force -ErrorAction SilentlyContinue",
    );
    expect(command).not.toContain("launchctl");
    expect(command).not.toContain("/bin/kill");
  });

  it("clears a Windows lock when the PID was reused by another process", () => {
    const lockPath = tempLockPath();
    const lockOwner = owner({
      pid: 21_556,
      socketPath: "\\\\.\\pipe\\ade-runtime-dev-test",
      commandLine:
        "C:\\Program Files\\nodejs\\node.exe C:\\dev\\ADE\\apps\\ade-cli\\dist\\cli.cjs serve --socket \\\\.\\pipe\\ade-runtime-dev-test",
    });
    writeLock(lockPath, lockOwner);

    const conflict = detectSyncHostSingletonConflict({
      lockPath,
      pidAlive: () => true,
      processMatchesOwner: () => false,
      scanListeners: () => [],
      platform: "win32",
    });

    expect(conflict).toBeNull();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("stops a launchd-managed brain via launchctl bootout, not a hardcoded app path", () => {
    const command = buildQuitCommand({
      pid: 4242,
      commandLine: "/Applications/ADE.app/Contents/MacOS/ADE /Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs serve",
      appName: "ADE",
      packageChannel: null,
      adeHome: "/Users/example/.ade",
      platform: "darwin",
    });
    expect(command).toContain("launchctl bootout gui/$(id -u)/com.ade.runtime");
    expect(command).toContain("/bin/kill 4242");
    // Must NOT depend on a hardcoded /Applications path (that broke worktree
    // installs) and no longer shells out to the channel CLI `brain stop`.
    expect(command).not.toContain("/Applications/");
    expect(command).not.toContain("brain stop");
  });

  it("derives the per-channel launchd label", () => {
    expect(
      buildQuitCommand({ pid: 1, commandLine: null, appName: "ADE Beta", packageChannel: "beta", adeHome: null, platform: "darwin" }),
    ).toContain("com.ade.runtime.beta");
    expect(
      buildQuitCommand({ pid: 1, commandLine: null, appName: "ADE Alpha", packageChannel: "alpha", adeHome: null, platform: "darwin" }),
    ).toContain("com.ade.runtime.alpha");
  });

  it("prefers an explicit service name (launchd label) when recorded", () => {
    const command = buildQuitCommand({
      pid: 7,
      commandLine: null,
      appName: "ADE",
      packageChannel: null,
      adeHome: null,
      serviceName: "com.ade.runtime.custom",
      platform: "darwin",
    });
    expect(command).toContain("launchctl bootout gui/$(id -u)/com.ade.runtime.custom");
  });

  it("infers the channel from a worktree command line and never hardcodes /Applications", () => {
    const command = buildQuitCommand({
      pid: 35709,
      commandLine:
        "/Users/admin/Projects/ADE/.ade/worktrees/x/apps/desktop/release-alpha/mac-arm64/ADE Alpha.app/Contents/MacOS/ADE Alpha /…/cli.cjs serve",
      appName: "ADE Alpha",
      packageChannel: null,
      adeHome: null,
      platform: "darwin",
    });
    expect(command).toContain("launchctl bootout gui/$(id -u)/com.ade.runtime.alpha");
    expect(command).not.toContain("/Applications/");
  });
});
