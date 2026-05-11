import type { ServiceManagerResult, ServiceManagerStatusResult } from "./common";
import { ADE_RUNTIME_SERVICE_NAME } from "./common";
import { getLaunchdServiceStatus, installLaunchdService, uninstallLaunchdService } from "./installLaunchd";
import { getSystemdServiceStatus, installSystemdService, uninstallSystemdService } from "./installSystemd";
import { getWindowsServiceStatus, installWindowsService, uninstallWindowsService } from "./installWindows";

export type { ServiceManagerResult, ServiceManagerStatusResult } from "./common";

export function installRuntimeService(): ServiceManagerResult {
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
