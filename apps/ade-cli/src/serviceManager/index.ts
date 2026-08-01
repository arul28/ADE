import { spawnSync } from "node:child_process";
import type { ServiceManagerResult, ServiceManagerStatusResult } from "./common";
import { ADE_RUNTIME_SERVICE_NAME } from "./common";
import { getLaunchdServiceMainPid, getLaunchdServiceStatus, installLaunchdService, uninstallLaunchdService } from "./installLaunchd";
import { getSystemdServiceStatus, installSystemdService, uninstallSystemdService } from "./installSystemd";
import {
  getWindowsServiceStatus,
  installWindowsService,
  readWindowsServicePidRecord,
  uninstallWindowsService,
} from "./installWindows";

export type { ServiceManagerResult, ServiceManagerStatusResult } from "./common";

// Main pid of the channel's installed runtime service, or null when the
// platform/service does not expose one. Used by the brain to decide whether
// it is the service-owned process with authority to take over the mobile
// sync singleton from a stale same-channel sibling.
export function getRuntimeServiceMainPid(): number | null {
  switch (process.platform) {
    case "darwin":
      return getLaunchdServiceMainPid();
    case "linux": {
      const result = spawnSync(
        "systemctl",
        ["--user", "show", ADE_RUNTIME_SERVICE_NAME, "-p", "MainPID", "--value"],
        { encoding: "utf8" },
      );
      if (result.status !== 0) return null;
      const pid = Number(String(result.stdout ?? "").trim());
      return Number.isFinite(pid) && pid > 0 ? Math.floor(pid) : null;
    }
    case "win32":
      return readWindowsServicePidRecord()?.runtimePid ?? null;
    default:
      return null;
  }
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

export function uninstallRuntimeService(): ServiceManagerResult {
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
