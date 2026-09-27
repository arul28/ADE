import fs from "node:fs";
import path from "node:path";
import type { AppleInstalledSimulator, AppleSimulatorOwnershipInfo } from "../../../shared/types/iosSimulator";
import { pathsEqual } from "../shared/pathCompare";

/**
 * The file that proves a simulator is ADE's.
 *
 * ADE writes it into the directory of every device it makes. The marker, not
 * only the lane row, is the evidence: a row can be lost, and an unmarked
 * leaked device looks exactly like the user's own and is kept forever. The
 * cleanup pass deletes a marked device of this project that no live lane
 * holds. CoreSimulator deletes the whole directory with the device, marker
 * included.
 */

const APPLE_DEVICE_MARKER_FILE = "ade-lane-device.json" as const;

/**
 * A marked device younger than this is never deleted by the cleanup pass.
 * Create writes the marker before the lane row, so a create in flight has a
 * marker and no row for a moment. A detach restarts the clock, so the user
 * can still pick the device again before it goes.
 */
export const APPLE_DEVICE_MARKER_GRACE_MS = 5 * 60_000;

export type AppleDeviceMarker = {
  version: 1;
  projectRoot: string;
  laneId: string;
  name: string;
  createdAt: string;
  /**
   * Set when the lane gave the device up without deleting it (`deviceDetach`).
   * The device is then a leftover: the cleanup pass never gives it back to the
   * lane, and deletes it after the grace period unless a lane picks it again.
   */
  detachedAt?: string | null;
};

export function appleDeviceMarkerPath(dataRoot: string, udid: string): string {
  return path.join(dataRoot, udid, APPLE_DEVICE_MARKER_FILE);
}

export function readAppleDeviceMarker(dataRoot: string, udid: string): AppleDeviceMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(appleDeviceMarkerPath(dataRoot, udid), "utf8")) as Partial<AppleDeviceMarker>;
    if (typeof raw.projectRoot !== "string" || typeof raw.laneId !== "string") return null;
    return {
      version: 1,
      projectRoot: raw.projectRoot,
      laneId: raw.laneId,
      name: typeof raw.name === "string" ? raw.name : "",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
      detachedAt: typeof raw.detachedAt === "string" ? raw.detachedAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * Write the marker. Only into a directory that exists: CoreSimulator creates it
 * with the device, and a marker without its device would describe nothing.
 */
export function writeAppleDeviceMarker(dataRoot: string, udid: string, marker: AppleDeviceMarker): boolean {
  const directory = path.join(dataRoot, udid);
  if (!fs.existsSync(directory)) return false;
  fs.writeFileSync(appleDeviceMarkerPath(dataRoot, udid), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return true;
}

/** Every marked device directory under the device store. Unreadable entries are skipped. */
export function listAppleDeviceMarkers(dataRoot: string): Array<{ udid: string; marker: AppleDeviceMarker }> {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dataRoot);
  } catch {
    return [];
  }
  const found: Array<{ udid: string; marker: AppleDeviceMarker }> = [];
  for (const udid of entries) {
    if (!/^[0-9A-F-]{20,}$/iu.test(udid)) continue;
    const marker = readAppleDeviceMarker(dataRoot, udid);
    if (marker) found.push({ udid, marker });
  }
  return found;
}

/** The marker belongs to the project at `projectRoot`. */
export function appleMarkerIsProject(marker: AppleDeviceMarker, projectRoot: string): boolean {
  return pathsEqual(path.resolve(marker.projectRoot), path.resolve(projectRoot));
}

/** `ADE · lane`, `ADE Repro`: a name ADE made, or a person named after it. Evidence only for the storage view. */
export function looksLikeAdeDeviceName(name: string): boolean {
  return /^ADE(\s|·|$)/u.test(name.trim());
}

/** Remove the marker: the device stops being ADE's, and no cleanup pass will delete it. */
export function removeAppleDeviceMarker(dataRoot: string, udid: string): void {
  fs.rmSync(appleDeviceMarkerPath(dataRoot, udid), { force: true });
}

/** Who each installed simulator belongs to, for the storage view: a lane, ADE (this or another project), or unknown. */
export function appleSimulatorOwnership(input: {
  installed: readonly AppleInstalledSimulator[];
  heldUdids: ReadonlySet<string>;
  dataRoot: string;
  projectRoot: string | null;
}): AppleSimulatorOwnershipInfo[] {
  return input.installed.map((device) => {
    const marker = readAppleDeviceMarker(input.dataRoot, device.udid);
    let ownership: AppleSimulatorOwnershipInfo["ownership"] = "unknown";
    if (input.heldUdids.has(device.udid)) ownership = "lane";
    else if (marker && input.projectRoot && !appleMarkerIsProject(marker, input.projectRoot)) ownership = "ade-other-project";
    else if (marker) ownership = "ade-orphan";
    return {
      udid: device.udid,
      ownership,
      markerLaneId: marker?.laneId ?? null,
      looksLikeAde: !marker && looksLikeAdeDeviceName(device.name),
    };
  });
}
