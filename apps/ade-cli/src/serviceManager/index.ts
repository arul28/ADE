import type { ServiceManagerResult, ServiceManagerStatusResult } from "./common";
import { getLaunchdServiceStatus, installLaunchdService, uninstallLaunchdService } from "./installLaunchd";
import { getSystemdServiceStatus, installSystemdService, uninstallSystemdService } from "./installSystemd";
import { getWindowsServiceStatus, installWindowsService, uninstallWindowsService } from "./installWindows";

export type { ServiceManagerResult, ServiceManagerStatusResult } from "./common";

export function installRuntimeService(): ServiceManagerResult {
  if (process.platform === "darwin") return installLaunchdService();
  if (process.platform === "linux") return installSystemdService();
  if (process.platform === "win32") return installWindowsService();
  return {
    ok: false,
    serviceName: "com.ade.runtime",
    action: "install",
    path: null,
    message: `ADE service installation is not supported on ${process.platform}.`,
  };
}

export function uninstallRuntimeService(): ServiceManagerResult {
  if (process.platform === "darwin") return uninstallLaunchdService();
  if (process.platform === "linux") return uninstallSystemdService();
  if (process.platform === "win32") return uninstallWindowsService();
  return {
    ok: false,
    serviceName: "com.ade.runtime",
    action: "uninstall",
    path: null,
    message: `ADE service removal is not supported on ${process.platform}.`,
  };
}

export function getRuntimeServiceStatus(): ServiceManagerStatusResult {
  if (process.platform === "darwin") return getLaunchdServiceStatus();
  if (process.platform === "linux") return getSystemdServiceStatus();
  if (process.platform === "win32") return getWindowsServiceStatus();
  return {
    ok: false,
    serviceName: "com.ade.runtime",
    action: "status",
    installed: null,
    running: null,
    path: null,
    message: `ADE service status is not supported on ${process.platform}.`,
  };
}
