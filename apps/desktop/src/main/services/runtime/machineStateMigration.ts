import fs from "node:fs";
import path from "node:path";

import type { MachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { ProjectRegistry, type ProjectRegistry as ProjectRegistryType } from "../../../../../ade-cli/src/services/projects/projectRegistry";
import type { RecentProject } from "../state/globalState";

export const MACHINE_STATE_MIGRATION_MARKER = ".migrated-v2";

export type MachineStateMigrationResult = {
  didRun: boolean;
  shouldShowNotice: boolean;
  markerPath: string;
};

type MachineStateMigrationArgs = {
  layout: MachineAdeLayout;
  recentProjects: RecentProject[];
  projectRegistry?: Pick<ProjectRegistryType, "add">;
};

function readObjectFile(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function markerPath(layout: MachineAdeLayout): string {
  return path.join(layout.adeDir, MACHINE_STATE_MIGRATION_MARKER);
}

function copyFirstLegacySecret(args: {
  layout: MachineAdeLayout;
  recentProjects: RecentProject[];
  fileName: string;
}): void {
  const target = path.join(args.layout.secretsDir, args.fileName);
  if (fs.existsSync(target)) return;
  for (const project of args.recentProjects) {
    const source = path.join(project.rootPath, ".ade", "secrets", args.fileName);
    if (!fs.existsSync(source)) continue;
    try {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
    } catch {
      // Best effort migration; the project-local copy remains for rollback.
    }
    return;
  }
}

function mergePairedDevices(args: {
  layout: MachineAdeLayout;
  recentProjects: RecentProject[];
}): void {
  const pairedDevicesPath = path.join(args.layout.secretsDir, "sync-paired-devices.json");
  const pairedDevices = fs.existsSync(pairedDevicesPath)
    ? readObjectFile(pairedDevicesPath)
    : {};
  let pairedDevicesChanged = false;
  for (const project of args.recentProjects) {
    const source = path.join(project.rootPath, ".ade", "secrets", "sync-paired-devices.json");
    if (!fs.existsSync(source)) continue;
    const legacy = readObjectFile(source);
    for (const [deviceId, record] of Object.entries(legacy)) {
      if (!deviceId.trim() || Object.prototype.hasOwnProperty.call(pairedDevices, deviceId)) continue;
      pairedDevices[deviceId] = record;
      pairedDevicesChanged = true;
    }
  }
  if (pairedDevicesChanged || !fs.existsSync(pairedDevicesPath)) {
    fs.writeFileSync(pairedDevicesPath, `${JSON.stringify(pairedDevices, null, 2)}\n`, { mode: 0o600 });
  }
}

export function runMachineStateMigration(args: MachineStateMigrationArgs): MachineStateMigrationResult {
  const marker = markerPath(args.layout);
  if (fs.existsSync(marker)) {
    return { didRun: false, shouldShowNotice: false, markerPath: marker };
  }

  const hadExistingUserState =
    args.recentProjects.length > 0 || fs.existsSync(args.layout.secretsDir);
  fs.mkdirSync(args.layout.secretsDir, { recursive: true, mode: 0o700 });

  copyFirstLegacySecret({ layout: args.layout, recentProjects: args.recentProjects, fileName: "sync-bootstrap-token" });
  copyFirstLegacySecret({ layout: args.layout, recentProjects: args.recentProjects, fileName: "sync-pin.json" });
  mergePairedDevices({ layout: args.layout, recentProjects: args.recentProjects });

  const projectRegistry = args.projectRegistry ?? new ProjectRegistry(args.layout);
  for (const project of args.recentProjects) {
    if (!fs.existsSync(path.join(project.rootPath, ".ade"))) continue;
    try {
      projectRegistry.add(project.rootPath);
    } catch {
      // Ignore projects that disappeared or became unreadable during startup.
    }
  }

  return { didRun: true, shouldShowNotice: hadExistingUserState, markerPath: marker };
}

export function markMachineStateMigrationComplete(args: {
  layout: MachineAdeLayout;
  completedAt?: Date;
}): void {
  const marker = markerPath(args.layout);
  fs.mkdirSync(args.layout.adeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(marker, `${(args.completedAt ?? new Date()).toISOString()}\n`, { mode: 0o600 });
}
