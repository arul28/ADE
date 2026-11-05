import { spawnSync } from "node:child_process";
import type { ServiceManagerResult, ServiceManagerSpawnSync, ServiceManagerStatusResult } from "./common";
import { ADE_RUNTIME_SERVICE_NAME, isPidAlive } from "./common";
import { getLaunchdServiceMainPid, getLaunchdServiceStatus, installLaunchdService, uninstallLaunchdService } from "./installLaunchd";
import { getSystemdServiceStatus, installSystemdService, uninstallSystemdService } from "./installSystemd";
import { readDetachedSupervisedBrainPid } from "./detachedSupervisor";
import {
  getWindowsServiceStatus,
  installWindowsService,
  checkWindowsServiceRemovable,
  readWindowsServicePidRecord,
  uninstallWindowsService,
} from "./installWindows";

export type { ServiceManagerResult, ServiceManagerStatusResult } from "./common";

/** `systemctl` and `launchctl` answer at once; a hung one must not hold the caller (a brain's start). */
const SERVICE_LOOKUP_TIMEOUT_MS = 2_000;
const boundedSpawnSync: ServiceManagerSpawnSync = (command, args, options) =>
  spawnSync(command, args, { ...options, timeout: SERVICE_LOOKUP_TIMEOUT_MS });

// Main pid of the channel's installed runtime service, or null when the
// platform/service does not expose one, or its manager did not answer in time. Used by the brain to decide whether
// it is the service-owned process with authority to take over the mobile
// sync singleton from a stale same-channel sibling.
export function getRuntimeServiceMainPid(): number | null {
  switch (process.platform) {
    case "darwin":
      return getLaunchdServiceMainPid(boundedSpawnSync);
    case "linux": {
      const result = spawnSync(
        "systemctl",
        ["--user", "show", ADE_RUNTIME_SERVICE_NAME, "-p", "MainPID", "--value"],
        { encoding: "utf8", timeout: SERVICE_LOOKUP_TIMEOUT_MS },
      );
      const pid = result.status === 0 ? Number(String(result.stdout ?? "").trim()) : 0;
      if (Number.isFinite(pid) && pid > 0) return Math.floor(pid);
      // No systemd unit running: the brain ADE supervises itself on a machine
      // without a usable systemd, if there is one.
      return readDetachedSupervisedBrainPid();
    }
    case "win32":
      return readWindowsServicePidRecord()?.runtimePid ?? null;
    default:
      return null;
  }
}

/**
 * Whether this process was started by the channel's installed service, read
 * without spawning anything: launchd is the parent of a LaunchAgent's process,
 * and the Windows supervisor records its own pid before it starts the brain.
 * `null` where that cannot be told cheaply (systemd's user manager is not pid 1).
 */
export function isStartedByRuntimeService(): boolean | null {
  switch (process.platform) {
    case "darwin":
      return process.ppid === 1;
    case "win32": {
      // No readable record (an older supervisor, a write in progress) is unknown, not "no".
      const record = readWindowsServicePidRecord();
      return record ? record.supervisorPid === process.ppid : null;
    }
    default:
      return null;
  }
}

/**
 * The pid of the channel's running service brain when this process is a brain
 * the service did not start (an agent's or a test's `ade serve`), else null.
 * Such a brain leaves phone sync to the service brain: on 2026-11-04 four of
 * them took the machine-wide sync lock in turn, and the phone dropped each
 * time the installed brain took it back. Null when no service brain runs, in
 * the service brain itself, and when the service manager does not answer in
 * time (the service brain makes this call too, and must keep sync).
 */
export function serviceBrainPidBesideHandRunBrain(): number | null {
  // The Windows supervisor records the brain's pid only after the brain has
  // started, but its own pid (the brain's parent) before.
  if (process.platform === "win32" && isStartedByRuntimeService() === true) return null;
  const servicePid = getRuntimeServiceMainPid();
  if (servicePid == null || servicePid === process.pid || !isPidAlive(servicePid)) return null;
  // On Linux the unit can start the brain through a wrapper, whose pid it
  // reports. A macOS parent proves nothing: launchd adopts every orphan, so a
  // hand-run brain whose shell has exited has pid 1 for a parent too.
  if (process.platform === "linux" && servicePid === process.ppid) return null;
  return servicePid;
}

export async function installRuntimeService(): Promise<ServiceManagerResult> {
  switch (process.platform) {
    case "darwin":
      return installLaunchdService();
    case "linux":
      return installSystemdService();
    case "win32":
      return installWindowsService();
    default:
      return {
        ok: false,
        serviceName: ADE_RUNTIME_SERVICE_NAME,
        action: "install",
        path: null,
        message: `ADE service installation is not supported on ${process.platform}.`,
      };
  }
}

// Async only because of win32: the Windows teardown talks the brain down over
// its JSON-RPC endpoint before forcing anything, and that is a socket round
// trip. The launchd/systemd branches stay synchronous underneath.
export async function uninstallRuntimeService(): Promise<ServiceManagerResult> {
  switch (process.platform) {
    case "darwin":
      return uninstallLaunchdService();
    case "linux":
      return uninstallSystemdService();
    case "win32":
      return uninstallWindowsService();
    default:
      return {
        ok: false,
        serviceName: ADE_RUNTIME_SERVICE_NAME,
        action: "uninstall",
        path: null,
        message: `ADE service removal is not supported on ${process.platform}.`,
      };
  }
}

/**
 * Whether `uninstallRuntimeService` would go ahead, changing nothing. Only the
 * Windows uninstall can refuse after identifying what it would stop; the
 * launchd and systemd uninstalls have no such step.
 */
export async function checkRuntimeServiceRemovable(): Promise<{ ok: true } | { ok: false; message: string }> {
  return process.platform === "win32" ? checkWindowsServiceRemovable() : { ok: true };
}

export function getRuntimeServiceStatus(): ServiceManagerStatusResult {
  switch (process.platform) {
    case "darwin":
      return getLaunchdServiceStatus();
    case "linux":
      return getSystemdServiceStatus();
    case "win32":
      return getWindowsServiceStatus();
    default:
      return {
        ok: false,
        serviceName: ADE_RUNTIME_SERVICE_NAME,
        action: "status",
        installed: null,
        running: null,
        path: null,
        message: `ADE service status is not supported on ${process.platform}.`,
      };
  }
}
