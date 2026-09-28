import type {
  AppleDeviceDiskUsage,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleSimulatorOwner,
} from "../../../shared/types/iosSimulator";

/**
 * Which group each installed device is in, computed over
 * `deviceList().owners`. The picker only renders it: the lane's own device (no
 * fallback), free devices, and devices another lane holds (never offered an
 * Open).
 */

export type ApplePickerElsewhereEntry = {
  simulator: AppleInstalledSimulator;
  owner: AppleSimulatorOwner;
};

export type ApplePickerPartition = {
  /** This lane's own device, and only ever this lane's own device. */
  mine: AppleInstalledSimulator | null;
  /**
   * The lane owns a device record whose simulator is not installed any more.
   *
   * A real state — the user deleted it in Xcode — and one that must not read
   * as "this lane has no device", because the lane's registry row is still
   * there and still points at a udid.
   */
  laneDeviceMissing: boolean;
  /** Installed, and no lane holds it. */
  available: AppleInstalledSimulator[];
  /** Installed, and another lane holds it. Never offered an Open. */
  elsewhere: ApplePickerElsewhereEntry[];
};

export type ApplePickerPartitionInput = {
  installed: readonly AppleInstalledSimulator[];
  owners?: readonly AppleSimulatorOwner[] | null;
  laneDevice?: AppleLaneDevice | null;
};

/**
 * The lane's own udid.
 *
 * `laneDevice` is the direct answer; `owners`' own `mine` flag is the fallback
 * for a caller that has one and not the other. Both come from the same
 * `deviceList` payload, so they cannot disagree — and if they ever do, the
 * lane record wins, because it is the row the service starts from.
 */
export function appleLaneOwnedUdid(input: ApplePickerPartitionInput): string | null {
  const direct = input.laneDevice?.udid?.trim();
  if (direct) return direct;
  const flagged = (input.owners ?? []).find((owner) => owner.mine);
  return flagged?.udid?.trim() || null;
}

export function partitionApplePickerDevices(input: ApplePickerPartitionInput): ApplePickerPartition {
  const owners = new Map<string, AppleSimulatorOwner>();
  for (const owner of input.owners ?? []) owners.set(owner.udid, owner);

  const mineUdid = appleLaneOwnedUdid(input);
  let mine: AppleInstalledSimulator | null = null;
  const available: AppleInstalledSimulator[] = [];
  const elsewhere: ApplePickerElsewhereEntry[] = [];

  for (const simulator of input.installed) {
    if (mineUdid && simulator.udid === mineUdid) {
      mine = simulator;
      continue;
    }
    const owner = owners.get(simulator.udid);
    // `mine` on a udid that is not this lane's own record would be a payload
    // contradiction; treat it as free rather than inventing a fourth group.
    if (owner && !owner.mine) {
      elsewhere.push({ simulator, owner });
      continue;
    }
    available.push(simulator);
  }

  return {
    mine,
    laneDeviceMissing: Boolean(mineUdid) && mine === null,
    available,
    elsewhere,
  };
}

/**
 * Bytes as the owner reads them: `18.2 GB`, `612 MB`.
 *
 * One decimal from a gigabyte up, none below it — the number that matters to
 * someone at 15 GB free is the gigabytes, and `18.23 GB` spends two digits
 * saying nothing. Anything under a kilobyte is `0 KB` rather than a byte
 * count, because a device directory measured in bytes is a directory that is
 * not really there.
 */
export function appleDiskLabel(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const KIB = 1024;
  if (bytes < KIB) return "0 KB";
  if (bytes < KIB ** 2) return `${Math.round(bytes / KIB)} KB`;
  if (bytes < KIB ** 3) return `${Math.round(bytes / KIB ** 2)} MB`;
  if (bytes < KIB ** 4) return `${(bytes / KIB ** 3).toFixed(1)} GB`;
  return `${(bytes / KIB ** 4).toFixed(1)} TB`;
}

/** The store's measured total, or null when nothing measured it. */
export function appleDiskTotalLabel(disk: AppleDeviceDiskUsage | null | undefined): string | null {
  return disk ? appleDiskLabel(disk.totalBytes) : null;
}

/** One device's measured cost, or null when nothing measured it. */
export function appleDeviceDiskLabel(
  disk: AppleDeviceDiskUsage | null | undefined,
  udid: string,
): string | null {
  const row = disk?.devices.find((entry) => entry.udid === udid);
  return row ? appleDiskLabel(row.bytes) : null;
}

/**
 * How to name the lane holding a device.
 *
 * The display name when there is one. Never the raw id: "in use by lane
 * dca9f144" names nothing a person recognises, and a lane whose name cannot be
 * resolved is better described as "another lane" than as a hex string the
 * reader has to go and look up.
 */
export function appleOwnerLaneLabel(owner: Pick<AppleSimulatorOwner, "laneName">): string {
  const name = owner.laneName?.trim();
  return name ? `lane ${name}` : "another lane";
}
