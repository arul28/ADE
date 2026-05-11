import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADE_RUNTIME_SERVICE_NAME,
  type AdeServiceCommand,
  renderCommand,
  resolveAdeServeCommand,
  serviceManagerResultText,
  type ServiceManagerResult,
  type ServiceManagerSpawnSync,
  type ServiceManagerStatusResult,
} from "./common";

type SystemdServiceManagerDeps = {
  command?: AdeServiceCommand;
  spawnSync?: ServiceManagerSpawnSync;
  homeDir?: string;
};

export function servicePath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".config", "systemd", "user", "ade-runtime.service");
}

function escapeSystemdQuotedValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/%/g, "%%");
}

export function renderSystemdEnvironment(key: string, value: string): string {
  return `Environment="${key}=${escapeSystemdQuotedValue(value)}"`;
}

export function renderSystemdUnit(command: AdeServiceCommand): string {
  const envLines = Object.entries(command.env ?? {})
    .map(([key, value]) => renderSystemdEnvironment(key, value))
    .join("\n");
  return `[Unit]
Description=ADE service daemon

[Service]
Type=simple
ExecStart=${renderCommand(command)}
Restart=always
RestartSec=2
${envLines}

[Install]
WantedBy=default.target
`;
}

export function installSystemdService(deps: SystemdServiceManagerDeps = {}): ServiceManagerResult {
  const run = deps.spawnSync ?? spawnSync;
  const targetPath = servicePath(deps.homeDir);
  const command = deps.command ?? resolveAdeServeCommand();
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const unit = renderSystemdUnit(command);
  fs.writeFileSync(targetPath, unit, "utf8");
  const reload = run("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  if (reload.status !== 0) {
    return {
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: targetPath,
      message: serviceManagerResultText(reload) || "systemctl daemon-reload failed.",
    };
  }
  const enable = run("systemctl", ["--user", "enable", "--now", "ade-runtime.service"], { encoding: "utf8" });
  return {
    ok: enable.status === 0,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "install",
    path: targetPath,
    message: enable.status === 0
      ? "ADE service systemd user service installed."
      : serviceManagerResultText(enable) || "systemctl enable --now failed.",
  };
}

export function uninstallSystemdService(): ServiceManagerResult {
  const targetPath = servicePath();
  spawnSync("systemctl", ["--user", "disable", "--now", "ade-runtime.service"], { stdio: "ignore" });
  try { fs.unlinkSync(targetPath); } catch {}
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  return {
    ok: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "uninstall",
    path: targetPath,
    message: "ADE service systemd user service removed.",
  };
}

export function getSystemdServiceStatus(): ServiceManagerStatusResult {
  const targetPath = servicePath();
  const enabled = spawnSync("systemctl", ["--user", "is-enabled", "ade-runtime.service"], { encoding: "utf8" });
  const active = spawnSync("systemctl", ["--user", "is-active", "ade-runtime.service"], { encoding: "utf8" });
  const installed = fs.existsSync(targetPath) || enabled.status === 0;
  if (!installed) {
    return {
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "status",
      installed: false,
      running: false,
      path: targetPath,
      message: "ADE service systemd user service is not installed.",
    };
  }

  const running = active.status === 0;
  return {
    ok: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "status",
    installed: true,
    running,
    path: targetPath,
    message: running
      ? "ADE service systemd user service is running."
      : serviceManagerResultText(active) || "ADE service systemd user service is installed but not running.",
  };
}
