import fs from "node:fs";
import path from "node:path";

import type { MachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";

export const MACHINE_TRUST_RESET_MARKER = ".machine-trust-reset-v1";
export const MACHINE_TRUST_RESET_PENDING_MARKER = ".machine-trust-reset-v1.pending";

const RESET_SECRET_FILES = [
  "remote-machines.json",
  "desktop-paired-machines.json",
  "sync-paired-devices.json",
  "sync-paired-devices.json.runtime-host-grants",
] as const;

export type MachineTrustResetResult = {
  didRun: boolean;
  restartRequired: boolean;
  markerPath: string;
  pendingMarkerPath: string;
  removedFiles: string[];
};

/**
 * One-time reset for the pre-account machine trust model. This intentionally
 * names only connection grants; account sessions, machine identity, pairing
 * PINs, project state, and the user's SSH files are outside this boundary.
 */
export function runMachineTrustResetMigration(
  layout: Pick<MachineAdeLayout, "adeDir" | "secretsDir">,
): MachineTrustResetResult {
  const markerPath = path.join(layout.adeDir, MACHINE_TRUST_RESET_MARKER);
  const pendingMarkerPath = path.join(layout.adeDir, MACHINE_TRUST_RESET_PENDING_MARKER);
  if (fs.existsSync(markerPath)) {
    return {
      didRun: false,
      restartRequired: false,
      markerPath,
      pendingMarkerPath,
      removedFiles: [],
    };
  }

  // The files were already cleared, but the background service restart did
  // not finish (or ADE exited before it could be confirmed). Keep retrying the
  // restart without repeatedly erasing pairings the user may have created in
  // the meantime.
  if (fs.existsSync(pendingMarkerPath)) {
    return {
      didRun: false,
      restartRequired: true,
      markerPath,
      pendingMarkerPath,
      removedFiles: [],
    };
  }

  const removedFiles: string[] = [];
  for (const fileName of RESET_SECRET_FILES) {
    const filePath = path.join(layout.secretsDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    fs.rmSync(filePath, { force: true });
    removedFiles.push(fileName);
  }

  fs.mkdirSync(layout.adeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(pendingMarkerPath, `${new Date().toISOString()}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return {
    didRun: true,
    restartRequired: true,
    markerPath,
    pendingMarkerPath,
    removedFiles,
  };
}

/**
 * Commit the reset only after the forced service restart reports success.
 * Renaming the pending marker makes the transition atomic; if ADE crashes
 * before this point, the next launch retries the restart.
 */
export function markMachineTrustResetComplete(
  layout: Pick<MachineAdeLayout, "adeDir">,
): void {
  const markerPath = path.join(layout.adeDir, MACHINE_TRUST_RESET_MARKER);
  const pendingMarkerPath = path.join(layout.adeDir, MACHINE_TRUST_RESET_PENDING_MARKER);
  if (fs.existsSync(markerPath)) {
    fs.rmSync(pendingMarkerPath, { force: true });
    return;
  }
  if (!fs.existsSync(pendingMarkerPath)) return;
  fs.renameSync(pendingMarkerPath, markerPath);
}
